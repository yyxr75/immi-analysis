/**
 * Cloudflare Worker: signed-in occupation matching for the public site.
 *
 * The point of this file is that the API key lives here as a Wrangler secret,
 * never in the page. A static site cannot hold a credential -- anything it can
 * read, so can every visitor.
 *
 * It is deliberately NOT a general proxy. The browser sends only the redacted
 * resume text; this Worker builds the whole upstream request itself, with a
 * fixed model, a fixed prompt and a fixed schema. So a leaked token buys an
 * attacker one thing: occupation extraction, rate-limited, on your budget --
 * not free access to the model.
 *
 * Routes:
 *   POST /auth/request  {email}          -> mail a 6-digit code
 *   POST /auth/verify   {email, code}    -> exchange it for a 30-day token
 *   POST /auth/me       (Bearer)         -> who am I, what plan, quota left
 *   POST /              (Bearer) {text}  -> the occupation match
 */
import { SYSTEM, SCHEMA } from "./spec.generated.js";
import {
  CODE_TTL, CODE_TRIES, PLANS, account, bearer, emailKey, issueToken,
  looksLikeEmail, newCode, normEmail, planLimit, readToken, sendCode,
} from "./auth.js";

const UPSTREAM = "https://api.deepseek.com/v1/chat/completions";
const MODEL = "deepseek-chat";
// A ceiling, not a typical size. Real resumes run 2-6k chars; PDF extraction
// adds headers, footers and page furniture, and an English CV needs roughly
// twice the characters of a Chinese one for the same content. This is set to
// swallow all of that and still leave deepseek-chat's 64K context comfortable
// room for the reply. It is also the cost guard: worst case is
// GLOBAL_PER_DAY x this, so raising one means re-checking the other.
const MAX_CHARS = 40000;
const MAX_TOKENS = 3000;
const GLOBAL_PER_DAY = 400;   // the budget backstop, across every account

// Sign-in abuse guards. Without these the endpoint is a free way to mail
// arbitrary people: one address can only be asked for a few codes an hour, and
// one source address can only start a few sign-ins an hour.
const CODES_PER_EMAIL_HOUR = 3;
const CODES_PER_IP_HOUR = 8;

const cors = (origin, allowed) => ({
  "Access-Control-Allow-Origin": allowed ? origin : "null",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, authorization",
  "Access-Control-Max-Age": "86400",
  Vary: "Origin",
});

const json = (obj, status, headers) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });

async function bump(env, key, ttl) {
  const cur = parseInt((await env.RATE.get(key)) || "0", 10);
  await env.RATE.put(key, String(cur + 1), { expirationTtl: ttl });
  return cur + 1;
}

const read = async (env, key) => parseInt((await env.RATE.get(key)) || "0", 10);

export default {
  async fetch(req, env) {
    const origin = req.headers.get("Origin") || "";
    const allowlist = (env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
    const allowed = allowlist.length === 0 || allowlist.includes(origin);
    const H = cors(origin, allowed);

    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: H });
    if (!allowed) return json({ error: "origin not allowed" }, 403, H);
    if (req.method !== "POST") return json({ error: "POST only" }, 405, H);
    if (!env.AUTH_SECRET)
      return json({ error: "服务端未配置 AUTH_SECRET" }, 503, H);

    let body;
    try { body = await req.json(); } catch { return json({ error: "bad json" }, 400, H); }

    const path = new URL(req.url).pathname.replace(/\/+$/, "");
    const day = new Date().toISOString().slice(0, 10);
    const hour = new Date().toISOString().slice(0, 13);
    const ip = req.headers.get("CF-Connecting-IP") || "unknown";

    /* ---------------- sign-in: ask for a code ---------------- */
    if (path === "/auth/request") {
      const email = normEmail(body.email);
      if (!looksLikeEmail(email)) return json({ error: "邮箱地址看起来不对。" }, 400, H);

      const ek = await emailKey(env, email);
      if (await read(env, `ch:${hour}:${ek}`) >= CODES_PER_EMAIL_HOUR)
        return json({ error: "这个邮箱刚要过验证码，请等几分钟再试。" }, 429, H);
      if (await read(env, `ci:${hour}:${ip}`) >= CODES_PER_IP_HOUR)
        return json({ error: "请求太频繁，请稍后再试。" }, 429, H);

      const code = newCode();
      const sent = await sendCode(env, email, code);
      if (!sent.ok) return json({ error: sent.error, detail: sent.detail }, sent.status, H);

      await env.RATE.put(`code:${ek}`, JSON.stringify({ code, tries: 0 }),
                         { expirationTtl: CODE_TTL });
      await bump(env, `ch:${hour}:${ek}`, 3600);
      await bump(env, `ci:${hour}:${ip}`, 3600);
      return json({ ok: true, ttl: CODE_TTL }, 200, H);
    }

    /* ---------------- sign-in: redeem the code ---------------- */
    if (path === "/auth/verify") {
      const email = normEmail(body.email);
      const code = String(body.code || "").trim();
      if (!looksLikeEmail(email) || !/^\d{6}$/.test(code))
        return json({ error: "邮箱或验证码格式不对。" }, 400, H);

      const ek = await emailKey(env, email);
      const raw = await env.RATE.get(`code:${ek}`);
      if (!raw) return json({ error: "验证码已过期，请重新获取。" }, 400, H);

      const rec = JSON.parse(raw);
      if (rec.tries >= CODE_TRIES) {
        await env.RATE.delete(`code:${ek}`);
        return json({ error: "验证码错误次数太多，请重新获取。" }, 429, H);
      }
      if (rec.code !== code) {
        await env.RATE.put(`code:${ek}`, JSON.stringify({ ...rec, tries: rec.tries + 1 }),
                           { expirationTtl: CODE_TTL });
        return json({ error: `验证码不对，还可以试 ${CODE_TRIES - rec.tries - 1} 次。` }, 400, H);
      }

      await env.RATE.delete(`code:${ek}`);          // single use
      const acct = await account(env, ek);
      if (!acct.since) {
        await env.RATE.put("acct:" + ek,
          JSON.stringify({ plan: "free", since: new Date().toISOString() }));
      }
      return json({ ok: true, token: await issueToken(env, email), email,
                    plan: acct.plan, perDay: planLimit(acct) }, 200, H);
    }

    /* ---------------- operator: put an account on the paid plan ----------------
       Accounts are keyed by an HMAC of the address, which only this Worker can
       compute, so granting has to happen in here rather than by hand-editing
       KV. Guarded by its own secret, separate from the sign-in one. */
    if (path === "/auth/grant") {
      if (!env.ADMIN_TOKEN || bearer(req) !== env.ADMIN_TOKEN)
        return json({ error: "nope" }, 403, H);
      const email = normEmail(body.email);
      if (!looksLikeEmail(email)) return json({ error: "bad email" }, 400, H);
      const ek = await emailKey(env, email);
      const rec = { plan: body.plan === "free" ? "free" : "paid",
                    until: body.until || null,
                    since: (await account(env, ek)).since || new Date().toISOString() };
      await env.RATE.put("acct:" + ek, JSON.stringify(rec));
      // Also hand back a token for that address. Anyone holding ADMIN_TOKEN can
      // already rewrite any account, so this adds no reach -- it is how you comp
      // someone who cannot receive mail, and how the flow gets tested without
      // sending any.
      return json({ ok: true, email, ...rec, token: await issueToken(env, email) }, 200, H);
    }

    /* ---------------- who am I ---------------- */
    if (path === "/auth/me" || body.ping === true) {
      const p = await readToken(env, bearer(req));
      if (!p) return json({ ok: false, signedIn: false }, 200, H);
      const acct = await account(env, p.sub);
      const used = await read(env, `q:${day}:${p.sub}`);
      return json({ ok: true, signedIn: true, email: p.eml, model: MODEL,
                    maxChars: MAX_CHARS,
                    plan: acct.plan, until: acct.until || null,
                    quota: { used, perDay: planLimit(acct) } }, 200, H);
    }

    /* ---------------- the occupation match ---------------- */
    const p = await readToken(env, bearer(req));
    if (!p)
      return json({ error: "请先用邮箱登录再使用 AI 功能。", needAuth: true }, 401, H);

    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) return json({ error: "text required" }, 400, H);
    if (text.length > MAX_CHARS)
      return json({ error: `简历太长：${text.length} 字，上限 ${MAX_CHARS} 字。` +
                           "请只保留学历和工作经历，去掉获奖、项目清单等与职业匹配无关的部分。",
                    maxChars: MAX_CHARS }, 413, H);

    const acct = await account(env, p.sub);
    const limit = planLimit(acct);

    const g = await bump(env, `g:${day}`, 172800);
    if (g > GLOBAL_PER_DAY)
      return json({ error: "今日全站额度已用完，请明天再来，或在设置里换成自己的 API Key" },
                  429, H);
    const n = await bump(env, `q:${day}:${p.sub}`, 172800);
    if (n > limit)
      return json({ error: acct.plan === "paid"
                      ? `今天已用满 ${limit} 次，请明天再来。`
                      : `免费额度每天 ${limit} 次，已经用完了。`,
                    plan: acct.plan, perDay: limit }, 429, H);

    // Providers disagree about structured output: DeepSeek rejects json_schema
    // outright ("response_format type is unavailable"), others accept it. Step
    // down rather than fail -- the caller already tolerates prose around the
    // JSON, and the schema is a nicety here, not a correctness requirement.
    const base = {
      model: MODEL,
      max_tokens: MAX_TOKENS,
      temperature: 0.2,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: text },
      ],
    };
    const shapes = [
      { ...base, response_format: { type: "json_schema",
          json_schema: { name: "occupation_match", strict: true, schema: SCHEMA } } },
      { ...base, response_format: { type: "json_object" } },
      base,
    ];

    let upstream = null, lastBody = "";
    for (const shape of shapes) {
      upstream = await fetch(UPSTREAM, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${env.PROVIDER_API_KEY}`,
        },
        body: JSON.stringify(shape),
      });
      if (upstream.ok) break;
      lastBody = await upstream.text();
      if (upstream.status !== 400 || !/response_format|schema|format/i.test(lastBody)) {
        return json({ error: `upstream ${upstream.status}`,
                      detail: lastBody.slice(0, 300) }, 502, H);
      }
    }

    if (!upstream || !upstream.ok)
      return json({ error: `upstream ${upstream ? upstream.status : "?"}`,
                    detail: lastBody.slice(0, 300) }, 502, H);

    const d = await upstream.json();
    const content = d?.choices?.[0]?.message?.content || "";
    return json({ content,
                  usage: d.usage || null,
                  plan: acct.plan,
                  quota: { used: n, perDay: limit } }, 200, H);
  },
};
