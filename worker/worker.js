/**
 * Cloudflare Worker: shared occupation-matching endpoint for the public site.
 *
 * The point of this file is that the API key lives here as a Wrangler secret,
 * never in the page. A static site cannot hold a credential -- anything it can
 * read, so can every visitor.
 *
 * It is deliberately NOT a general proxy. The browser sends only the redacted
 * resume text; this Worker builds the whole upstream request itself, with a
 * fixed model, a fixed prompt and a fixed schema. So a leaked endpoint URL buys
 * an attacker one thing: occupation extraction, rate-limited, on your budget --
 * not free access to the model.
 */
import { SYSTEM, SCHEMA } from "./spec.generated.js";

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
const PER_IP_PER_DAY = 20;
const GLOBAL_PER_DAY = 500;   // the real budget guard

const cors = (origin, allowed) => ({
  "Access-Control-Allow-Origin": allowed ? origin : "null",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
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

export default {
  async fetch(req, env) {
    const origin = req.headers.get("Origin") || "";
    const allowlist = (env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
    const allowed = allowlist.length === 0 || allowlist.includes(origin);
    const H = cors(origin, allowed);

    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: H });
    if (!allowed) return json({ error: "origin not allowed" }, 403, H);
    if (req.method !== "POST") return json({ error: "POST only" }, 405, H);

    let body;
    try { body = await req.json(); } catch { return json({ error: "bad json" }, 400, H); }

    const day = new Date().toISOString().slice(0, 10);
    const ip = req.headers.get("CF-Connecting-IP") || "unknown";

    // The page's "test connection" button. Reads the counters without bumping
    // them and never touches the upstream, so checking your setup does not eat
    // one of your 20 daily calls -- and so a probe costs no money.
    if (body.ping === true) {
      const used = parseInt((await env.RATE.get(`i:${day}:${ip}`)) || "0", 10);
      const gUsed = parseInt((await env.RATE.get(`g:${day}`)) || "0", 10);
      return json({ ok: true, model: MODEL, maxChars: MAX_CHARS,
                    quota: { used, perDay: PER_IP_PER_DAY,
                             globalUsed: gUsed, globalPerDay: GLOBAL_PER_DAY } }, 200, H);
    }

    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) return json({ error: "text required" }, 400, H);
    if (text.length > MAX_CHARS)
      return json({ error: `简历太长：${text.length} 字，上限 ${MAX_CHARS} 字。` +
                           "请只保留学历和工作经历，去掉获奖、项目清单等与职业匹配无关的部分。",
                    maxChars: MAX_CHARS }, 413, H);

    const g = await bump(env, `g:${day}`, 172800);
    if (g > GLOBAL_PER_DAY)
      return json({ error: "今日公共额度已用完，请在设置里填自己的 API Key" }, 429, H);
    const n = await bump(env, `i:${day}:${ip}`, 172800);
    if (n > PER_IP_PER_DAY)
      return json({ error: `每天最多 ${PER_IP_PER_DAY} 次，请明天再来或填自己的 API Key` }, 429, H);

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
                  quota: { used: n, perDay: PER_IP_PER_DAY } }, 200, H);
  },
};
