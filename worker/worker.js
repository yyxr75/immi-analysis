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
const MAX_CHARS = 12000;      // a resume; anything larger is not one
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
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) return json({ error: "text required" }, 400, H);
    if (text.length > MAX_CHARS)
      return json({ error: `text too long (${text.length} > ${MAX_CHARS})` }, 413, H);

    const day = new Date().toISOString().slice(0, 10);
    const ip = req.headers.get("CF-Connecting-IP") || "unknown";
    const g = await bump(env, `g:${day}`, 172800);
    if (g > GLOBAL_PER_DAY)
      return json({ error: "今日公共额度已用完，请在设置里填自己的 API Key" }, 429, H);
    const n = await bump(env, `i:${day}:${ip}`, 172800);
    if (n > PER_IP_PER_DAY)
      return json({ error: `每天最多 ${PER_IP_PER_DAY} 次，请明天再来或填自己的 API Key` }, 429, H);

    const upstream = await fetch(UPSTREAM, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.PROVIDER_API_KEY}`,
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        temperature: 0.2,
        response_format: {
          type: "json_schema",
          json_schema: { name: "occupation_match", strict: true, schema: SCHEMA },
        },
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: text },
        ],
      }),
    });

    if (!upstream.ok)
      return json({ error: `upstream ${upstream.status}`,
                    detail: (await upstream.text()).slice(0, 300) }, 502, H);

    const d = await upstream.json();
    const content = d?.choices?.[0]?.message?.content || "";
    return json({ content,
                  usage: d.usage || null,
                  quota: { used: n, perDay: PER_IP_PER_DAY } }, 200, H);
  },
};
