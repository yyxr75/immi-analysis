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
 *   POST /plan          (Bearer) {facts} -> plain-words read-out of a computed plan
 */
import { SYSTEM, SCHEMA } from "./spec.generated.js";
import {
  CODE_TTL, CODE_TRIES, PLANS, account, bearer, emailKey, issueToken,
  looksLikeEmail, newCode, normEmail, planLimit, readToken, sendCode,
} from "./auth.js";
import {
  MAILS_PER_IP_DAY, PENDING_TTL, REPORTS_PER_IP_DAY, REPORT_TTL, clean, dispatch,
  looksLikeEmail as looksLikeMailTo, mailSubject, mailText, newId, render, tooBig,
} from "./report.js";

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
const GLOBAL_PER_DAY = 400;   // the budget backstop, across everyone

// /plan: the page's fact pack and the rules the read-out must follow. The
// page keeps the same prompt and check for bring-your-own-key providers.
const PLAN_MAX_CHARS = 8000;
const PLAN_SYSTEM =
  "你是一个解读员。用户会给你一份 JSON 事实包，是本站按澳洲 Schedule 6D 打分规则和官方公开数据算好的结果。" +
  "请用 3 到 5 段大白话中文，向用户解释这条路线：现在多少分、递 EOI 时多少分、和上一次最低分比如何、最需要注意的条件、还能怎么加分。\n" +
  "硬性规则：\n" +
  "1. 只能使用事实包里出现过的数字，不许自己计算或编造任何新数字（包括年份、月份、分数、人数、费用、百分比）。\n" +
  "2. 不许说概率、几率、成功率、把握、保证、一定能之类的话；历史邀请不代表下一轮。\n" +
  "3. 不许推荐事实包以外的职业、课程、学校或签证。\n" +
  "4. 不给移民法律建议；不需要写免责声明，页面已经有。\n" +
  "5. 每段不超过 90 个字，不用标题、不用列表符号、不用 Markdown。";
const PLAN_BAN = /概率|几率|成功率|把握|保证|一定|肯定|稳拿|稳了|包过|有望|很可能|大概率|应该能|胜算|%|％/;
const PLAN_FMT = /\*\*|^\s*(#|[-*•]\s|\d+[.、)]\s?)/m;
const planNums = t => (String(t).replace(/(\d),(?=\d{3})/g, "$1").match(/\d+(?:\.\d+)?/g) || []).map(Number);

// Whether the AI endpoint demands a signed-in account. Off: anyone may call it,
// metered per source address. The whole sign-in path stays wired underneath, so
// turning this on is one line -- and a signed-in caller is already metered by
// plan rather than by IP either way.
const REQUIRE_AUTH = false;
const ANON_PER_IP_PER_DAY = 10;
// How long a saved resume stays. The page tells visitors this number.
const CV_TTL = 180 * 86400;

// Sign-in abuse guards. Without these the endpoint is a free way to mail
// arbitrary people: one address can only be asked for a few codes an hour, and
// one source address can only start a few sign-ins an hour.
// Campaign tags the page may report (?src=...). Add one before using a new tag.
const SOURCES = ["xhs", "wechat", "zhihu", "reddit", "other",
                 "login-view", "login-skip", "login-ok"];   // the sign-in gate's funnel

const CODES_PER_EMAIL_HOUR = 3;
const CODES_PER_IP_HOUR = 8;

const cors = (origin, allowed) => ({
  "Access-Control-Allow-Origin": allowed ? origin : "null",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, authorization",
  "Access-Control-Max-Age": "86400",
  Vary: "Origin",
});

const page = (title, body) => `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<body style="margin:0;display:grid;place-items:center;min-height:100vh;background:#f9f9f7;
color:#0b0b0b;font:15px/1.6 system-ui,-apple-system,'PingFang SC',sans-serif">
<div style="max-width:420px;padding:24px;text-align:center">
<h1 style="font-size:19px;margin:0 0 8px">${title}</h1>
<p style="color:#52514e;font-size:13.5px;margin:0">${body}</p></div></html>`;

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

    // A report link is opened directly, typed or clicked out of an email, so it
    // is a plain GET with no Origin to check. It is only ever a read of one
    // opaque id, and the id is the whole credential.
    const url = new URL(req.url);
    if (req.method === "GET" || req.method === "HEAD") {
      const m = url.pathname.match(/^\/r\/([0-9a-f]{32})$/);
      if (!m) return new Response("not found", { status: 404 });
      const raw = await env.RATE.get("rep:" + m[1]);
      if (!raw)
        return new Response(page("报告不存在或已过期",
          `报告链接有效期 ${Math.round(REPORT_TTL / 86400)} 天，过期后会自动删除。回工具箱重新生成一份即可。`),
          { status: 404, headers: { "content-type": "text/html; charset=utf-8" } });
      return new Response(render(JSON.parse(raw), env.SITE_URL || ""), {
        headers: { "content-type": "text/html; charset=utf-8",
                   "cache-control": "private, max-age=300",
                   "x-robots-tag": "noindex, nofollow" },
      });
    }

    // The origin allowlist is a browser control: it stops another site's page
    // from spending this Worker's budget. A server has no Origin header at all
    // -- the GitHub runner that sends the mail sends none -- so applying it to
    // the machine-to-machine routes rejects them before they reach any handler,
    // with a message ("origin not allowed") that points nowhere near the truth.
    // Those routes carry their own shared secret instead.
    const SERVER_PATHS = new Set(["/pending", "/pending/done", "/pending/fail",
                                  "/pending/fp"]);
    const pathNow = url.pathname.replace(/\/+$/, "");
    if (!allowed && !SERVER_PATHS.has(pathNow))
      return json({ error: "origin not allowed" }, 403, H);
    if (req.method !== "POST") return json({ error: "POST only" }, 405, H);
    if (!env.AUTH_SECRET)
      return json({ error: "服务端未配置 AUTH_SECRET" }, 503, H);

    let body;
    try { body = await req.json(); } catch { return json({ error: "bad json" }, 400, H); }

    const path = pathNow;
    const day = new Date().toISOString().slice(0, 10);
    const hour = new Date().toISOString().slice(0, 13);
    const ip = req.headers.get("CF-Connecting-IP") || "unknown";

    /* ---------------- where visitors came from ----------------
       Web Analytics drops query strings, so the page reports ?src= here. A fixed
       set of tags keeps the KV keys bounded, and one count per address per tag
       per day means a reload is not a new visitor. */
    if (path === "/hit") {
      const src = String(body.src || "").toLowerCase();
      if (!SOURCES.includes(src)) return json({ ok: false }, 200, H);
      const seen = `hs:${day}:${src}:${ip}`;
      if (!(await env.RATE.get(seen))) {
        await env.RATE.put(seen, "1", { expirationTtl: 172800 });
        await bump(env, `hit:${day}:${src}`, 90 * 86400);
      }
      return json({ ok: true }, 200, H);
    }

    /* ---------------- which occupations people look up ----------------
       Code + route only. One count per address per code per day, like /hit.
       The running count also rides in the key's metadata, so /admin/looks
       can total a fortnight from one list() instead of a read per key. */
    if (path === "/look") {
      const code = String(body.code || "");
      const via = body.via === "name" ? "name" : "pick";
      if (!/^\d{6}$/.test(code)) return json({ ok: false }, 200, H);
      const seen = `ls:${day}:${code}:${ip}`;
      if (!(await env.RATE.get(seen))) {
        await env.RATE.put(seen, "1", { expirationTtl: 172800 });
        const key = `lk:${day}:${code}:${via}`;
        const n = (await read(env, key)) + 1;
        await env.RATE.put(key, String(n), { expirationTtl: 90 * 86400, metadata: { n } });
      }
      return json({ ok: true }, 200, H);
    }

    /* ---------------- operator: most looked-up occupations ---------------- */
    if (path === "/admin/looks") {
      if (!env.ADMIN_TOKEN || bearer(req) !== env.ADMIN_TOKEN)
        return json({ error: "nope" }, 403, H);
      const since = new Date(Date.now() - (parseInt(body.days, 10) || 14) * 86400000)
        .toISOString().slice(0, 10);
      const tot = {};
      let cursor;
      do {
        const l = await env.RATE.list({ prefix: "lk:", cursor });
        for (const k of l.keys) {
          const [, d, code, via] = k.name.split(":");
          if (d < since) continue;
          const t = tot[code] || (tot[code] = { code, name: 0, pick: 0 });
          t[via] += (k.metadata && k.metadata.n) || 0;
        }
        cursor = l.list_complete ? null : l.cursor;
      } while (cursor);
      const rows = Object.values(tot).sort((a, b) => (b.name + b.pick) - (a.name + a.pick));
      return json({ ok: true, since, rows }, 200, H);
    }

    /* ---------------- operator: visitors by source + AI calls, last 14 days -- */
    if (path === "/admin/stats") {
      if (!env.ADMIN_TOKEN || bearer(req) !== env.ADMIN_TOKEN)
        return json({ error: "nope" }, 403, H);
      const days = [...Array(14)].map((_, i) =>
        new Date(Date.now() - i * 86400000).toISOString().slice(0, 10));
      const rows = await Promise.all(days.map(async d => {
        const row = { day: d, ai: await read(env, `g:${d}`) };
        for (const src of SOURCES) row[src] = await read(env, `hit:${d}:${src}`);
        return row;
      }));
      return json({ ok: true, rows }, 200, H);
    }

    /* ---------------- operator: saved resumes ----------------
       {} lists keys (KV lists in key order, which is time order);
       {cursor} continues a long list; {key} returns one record. */
    if (path === "/admin/cvs") {
      if (!env.ADMIN_TOKEN || bearer(req) !== env.ADMIN_TOKEN)
        return json({ error: "nope" }, 403, H);
      if (body.key) {
        if (!/^cv:/.test(body.key)) return json({ error: "bad key" }, 400, H);
        const raw = await env.RATE.get(body.key);
        return raw ? json({ ok: true, ...JSON.parse(raw) }, 200, H)
                   : json({ error: "gone" }, 404, H);
      }
      const l = await env.RATE.list({ prefix: "cv:", cursor: body.cursor || undefined });
      return json({ ok: true, keys: l.keys.map(k => ({ key: k.name, ...k.metadata })),
                    cursor: l.list_complete ? null : l.cursor }, 200, H);
    }

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

    /* ---------------- store a report, hand back its link ---------------- */
    if (path === "/report") {
      if (tooBig(body)) return json({ error: "报告数据过大。" }, 413, H);
      const n = await bump(env, `rp:${day}:${ip}`, 172800);
      if (n > REPORTS_PER_IP_DAY)
        return json({ error: `每天最多生成 ${REPORTS_PER_IP_DAY} 份报告。` }, 429, H);
      const id = newId();
      await env.RATE.put("rep:" + id, JSON.stringify(clean(body)),
                         { expirationTtl: REPORT_TTL });
      const link = url.origin + "/r/" + id;
      const days = Math.round(REPORT_TTL / 86400);
      const out = { ok: true, id, url: link, days };

      // Optional: also mail the link. The report exists either way, so a mail
      // failure degrades to "here is your link" rather than losing the report.
      const to = String(body.email || "").trim().toLowerCase();
      if (to) {
        if (!looksLikeMailTo(to)) { out.mail = { ok: false, error: "邮箱地址看起来不对。" }; }
        else if (await bump(env, `mp:${day}:${ip}`, 172800) > MAILS_PER_IP_DAY) {
          out.mail = { ok: false, error: `每天最多发送 ${MAILS_PER_IP_DAY} 封邮件。` };
        } else {
          await env.RATE.put("pend:" + id, JSON.stringify({ to, url: link, days }),
                             { expirationTtl: PENDING_TTL });
          const d = await dispatch(env, id);
          // Nothing will come and collect it if the trigger failed, so do not
          // sit on someone's address for an hour for no reason.
          if (!d.ok) await env.RATE.delete("pend:" + id);
          out.mail = d.ok ? { ok: true, to } : { ok: false, error: d.error, detail: d.detail };
        }
      }
      return json(out, 200, H);
    }

    /* ---------------- the runner collects the address ----------------
       Called by the GitHub Action, not by a browser. The recipient lives here
       rather than in the dispatch payload because the repo is public and so is
       everything attached to a workflow run. Guarded by a shared secret, and
       the record is one-shot: /pending/done deletes it. */
    /* Does the caller hold the same DISPATCH_SECRET we do? Answers yes/no about
       a hash prefix and nothing else -- no value, no length, and the secret is
       264 random bits, so an oracle on 12 hex characters buys an attacker
       nothing. Unauthenticated on purpose: the whole point is to be reachable
       when the secret is the thing that is wrong. */
    if (path === "/pending/fp") {
      if (!env.DISPATCH_SECRET) return json({ error: "not configured" }, 503, H);
      const buf = await crypto.subtle.digest("SHA-256",
        new TextEncoder().encode(env.DISPATCH_SECRET));
      const mine = [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0"))
        .join("").slice(0, 12);
      const got = String(body.fp || "");
      const match = got === mine;
      // Record the attempt so the operator can tell "not set at all" from "set
      // to something else" without reading a workflow log they cannot read.
      // A hash prefix and a length, never the value.
      await env.RATE.put("fpcheck", JSON.stringify({
        at: new Date().toISOString(), match,
        callerFp: got.slice(0, 12), callerLen: parseInt(body.len, 10) || 0,
        workerFp: mine, workerLen: env.DISPATCH_SECRET.length,
      }), { expirationTtl: 7 * 86400 });
      return match
        ? json({ ok: true }, 200, H)
        : json({ ok: false, error: "shared secret mismatch" }, 409, H);
    }

    if (path === "/pending" || path === "/pending/done" || path === "/pending/fail") {
      if (!env.DISPATCH_SECRET || bearer(req) !== env.DISPATCH_SECRET)
        return json({ error: "nope" }, 403, H);
      const id = String(body.id || "");
      if (!/^[0-9a-f]{32}$/.test(id)) return json({ error: "bad id" }, 400, H);
      if (path === "/pending/done") {
        await env.RATE.delete("pend:" + id);
        await env.RATE.delete("mailerr");
        return json({ ok: true }, 200, H);
      }
      // The runner reports why it could not send. Without this the only record
      // of a failure is a workflow log, which is not readable anonymously even
      // on a public repo -- so a silently undelivered report would have nowhere
      // to surface. Message only; the runner never sends anything sensitive.
      if (path === "/pending/fail") {
        await env.RATE.put("mailerr", JSON.stringify({
          id, at: new Date().toISOString(),
          error: String(body.error || "").slice(0, 400),
        }), { expirationTtl: 7 * 86400 });
        return json({ ok: true }, 200, H);
      }
      const raw = await env.RATE.get("pend:" + id);
      if (!raw) return json({ error: "not pending" }, 404, H);
      const pend = JSON.parse(raw);
      // The body is composed here too, so the wording lives in one file rather
      // than drifting between the Worker and the runner that sends it.
      return json({ ok: true, to: pend.to, subject: mailSubject,
                    text: mailText(pend.url, pend.days) }, 200, H);
    }

    /* ---------------- operator: what is actually configured ----------------
       Secret names are typed by hand and a typo is silent: the value is stored,
       the code reads a different name, and everything behaves as if nothing was
       ever set. This reports presence only -- never a value, not even a prefix. */
    if (path === "/admin/config") {
      if (!env.ADMIN_TOKEN || bearer(req) !== env.ADMIN_TOKEN)
        return json({ error: "nope" }, 403, H);
      const names = ["PROVIDER_API_KEY", "AUTH_SECRET", "ADMIN_TOKEN",
                     "DISPATCH_SECRET", "GH_REPO", "GH_DISPATCH_TOKEN",
                     "RESEND_API_KEY", "MAIL_FROM", "MAIL_REPLY_TO"];
      const present = {}; names.forEach(n => { present[n] = !!env[n]; });
      const lastMailError = await env.RATE.get("mailerr");
      const fpcheck = await env.RATE.get("fpcheck");
      return json({ ok: true, present,
                    lastMailError: lastMailError ? JSON.parse(lastMailError) : null,
                    lastSecretCheck: fpcheck ? JSON.parse(fpcheck) : null,
                    features: {
                      ai: !!env.PROVIDER_API_KEY,
                      requireAuth: REQUIRE_AUTH,
                      signInByEmail: !!(env.RESEND_API_KEY && env.MAIL_FROM),
                      reportByEmail: !!(env.GH_DISPATCH_TOKEN && env.GH_REPO && env.DISPATCH_SECRET),
                    } }, 200, H);
    }

    /* ---------------- a signed-in user's watchlist + score ----------------
       {} reads, {prefs} replaces. Keyed by the account's HMAC like acct:, so
       the address itself is never a KV key. Shape is re-typed and capped
       here: the browser's copy is a convenience, not trusted input. */
    if (path === "/me/prefs") {
      const p = await readToken(env, bearer(req));
      if (!p) return json({ error: "请先登录。", needAuth: true }, 401, H);
      const key = "prefs:" + p.sub;
      if (!body.prefs) {
        const raw = await env.RATE.get(key);
        // Sliding sign-in: the page reads prefs on every visit, so hand back a
        // fresh token once the old one is past a third of its life. Someone
        // who keeps coming back never sees a code again; each code costs a
        // mail from a monthly allowance.
        const left = p.exp - Math.floor(Date.now() / 1000);
        const token = left < 120 * 86400 && p.eml ? await issueToken(env, p.eml) : undefined;
        return json({ ok: true, prefs: raw ? JSON.parse(raw) : null, token }, 200, H);
      }
      const q = body.prefs || {};
      const list = Array.isArray(q.list)
        ? [...new Set(q.list.map(String).filter(c => /^\d{6}$/.test(c)))].slice(0, 60) : [];
      const me = Number.isFinite(+q.me) ? Math.max(0, Math.min(150, Math.round(+q.me))) : null;
      const visa = ["189", "190", "491"].includes(q.visa) ? q.visa : "189";
      const prefs = { list, me, visa, at: new Date().toISOString() };
      await env.RATE.put(key, JSON.stringify(prefs));
      return json({ ok: true, prefs }, 200, H);
    }

    /* ---------------- who am I ---------------- */
    if (path === "/auth/me" || body.ping === true) {
      const p = await readToken(env, bearer(req));
      if (!p) {
        const used = await read(env, `q:${day}:ip:${ip}`);
        return json({ ok: false, signedIn: false, requireAuth: REQUIRE_AUTH,
                      model: MODEL, maxChars: MAX_CHARS,
                      quota: REQUIRE_AUTH ? null
                             : { used, perDay: ANON_PER_IP_PER_DAY } }, 200, H);
      }
      const acct = await account(env, p.sub);
      const used = await read(env, `q:${day}:${p.sub}`);
      return json({ ok: true, signedIn: true, requireAuth: REQUIRE_AUTH,
                    email: p.eml, model: MODEL, maxChars: MAX_CHARS,
                    plan: acct.plan, until: acct.until || null,
                    quota: { used, perDay: planLimit(acct) } }, 200, H);
    }

    /* ---------------- the plan read-out ----------------
       The page sends the facts it has already computed (Schedule 6D score,
       official rounds, hand-checked conditions); the model may only restate
       them. Any number in the reply that is not in the facts, or any odds
       wording, fails the check: one stricter retry, then a 422 rather than an
       unchecked answer. Metered on the same daily quota as the match. */
    if (path === "/plan") {
      const p = await readToken(env, bearer(req));
      if (!p && REQUIRE_AUTH)
        return json({ error: "请先用邮箱登录再使用 AI 功能。", needAuth: true }, 401, H);
      const facts = body.facts;
      const factsText = facts && typeof facts === "object" ? JSON.stringify(facts) : "";
      if (!factsText || factsText.length > PLAN_MAX_CHARS)
        return json({ error: "facts required (at most " + PLAN_MAX_CHARS + " chars)" }, 400, H);
      const acct = p ? await account(env, p.sub) : { plan: "anon" };
      const limit = p ? planLimit(acct) : ANON_PER_IP_PER_DAY;
      const quotaKey = p ? `q:${day}:${p.sub}` : `q:${day}:ip:${ip}`;
      if (await bump(env, `g:${day}`, 172800) > GLOBAL_PER_DAY)
        return json({ error: "今日全站额度已用完，请明天再来，或换成自己的 API Key" }, 429, H);
      const n = await bump(env, quotaKey, 172800);
      if (n > limit)
        return json({ error: `每天 ${limit} 次的额度已经用完了，明天再来，或换成自己的 API Key。` }, 429, H);

      const allow = new Set(planNums(factsText));
      let last = null;
      for (const extra of ["", "\n上一次的回答里出现了事实包以外的数字或概率说法，被系统丢弃了。这次请只照抄事实包里的数字。"]) {
        const up = await fetch(UPSTREAM, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${env.PROVIDER_API_KEY}` },
          body: JSON.stringify({ model: MODEL, max_tokens: 1200, temperature: 0.3,
            messages: [{ role: "system", content: PLAN_SYSTEM + extra },
                       { role: "user", content: factsText }] }),
        });
        if (!up.ok) return json({ error: `upstream ${up.status}`, detail: (await up.text()).slice(0, 300) }, 502, H);
        const d = await up.json();
        const content = (d?.choices?.[0]?.message?.content || "").trim();
        const bad = [...new Set(planNums(content).filter(x => !allow.has(x)))];
        const ban = content.match(PLAN_BAN) || (PLAN_FMT.test(content) ? ["标题或列表格式"] : null);
        if (content && !bad.length && !ban)
          return json({ content, usage: d.usage || null, quota: { used: n, perDay: limit } }, 200, H);
        last = { bad, ban: ban && ban[0] };
      }
      return json({ error: "AI 的回答两次都没通过核对（" +
                    (last.bad.length ? "出现了事实以外的数字 " + last.bad.slice(0, 5).join("、") : "出现了「" + last.ban + "」") +
                    "），已丢弃。以页面上算出的数字为准。" }, 422, H);
    }

    /* ---------------- the occupation match ---------------- */
    const p = await readToken(env, bearer(req));
    if (!p && REQUIRE_AUTH)
      return json({ error: "请先用邮箱登录再使用 AI 功能。", needAuth: true }, 401, H);

    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) return json({ error: "text required" }, 400, H);
    if (text.length > MAX_CHARS)
      return json({ error: `简历太长：${text.length} 字，上限 ${MAX_CHARS} 字。` +
                           "请只保留学历和工作经历，去掉获奖、项目清单等与职业匹配无关的部分。",
                    maxChars: MAX_CHARS }, 413, H);

    // Signed in: metered by plan, keyed to the account. Anonymous: metered by
    // source address, which is weaker but is the only handle there is.
    const acct = p ? await account(env, p.sub) : { plan: "anon" };
    const limit = p ? planLimit(acct) : ANON_PER_IP_PER_DAY;
    const quotaKey = p ? `q:${day}:${p.sub}` : `q:${day}:ip:${ip}`;

    const g = await bump(env, `g:${day}`, 172800);
    if (g > GLOBAL_PER_DAY)
      return json({ error: "今日全站额度已用完，请明天再来，或在设置里换成自己的 API Key" },
                  429, H);
    const n = await bump(env, quotaKey, 172800);
    if (n > limit)
      return json({ error: acct.plan === "paid"
                      ? `今天已用满 ${limit} 次，请明天再来。`
                      : `每天 ${limit} 次的额度已经用完了，明天再来，或在第 1 步换成自己的 API Key。`,
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

    // Keep the (already redacted) text and the model's answer for the operator,
    // only when the visitor left the consent box ticked. `=== true`, not
    // `!== false`: a cached page from before the box existed sends no flag,
    // and its visitor was never asked. The page strips email, phone and ID
    // numbers before sending. Metadata rides on the key so /admin/cvs can list
    // without one read per row.
    if (body.keep === true) {
      const at = new Date().toISOString();
      const key = `cv:${at}:${crypto.randomUUID().slice(0, 8)}`;
      await env.RATE.put(key, JSON.stringify({ at, text, result: content }),
        { expirationTtl: CV_TTL, metadata: { at, len: text.length } });
    }

    return json({ content,
                  usage: d.usage || null,
                  plan: acct.plan,
                  quota: { used: n, perDay: limit } }, 200, H);
  },
};
