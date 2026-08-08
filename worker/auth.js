/**
 * Email-code sign-in for the shared AI endpoint.
 *
 * The site is static, so the browser cannot be trusted with anything: the plan
 * a caller is on and the quota they have left are both looked up server-side on
 * every request. The token the browser holds only says "this email proved it
 * can receive mail"; it never carries an entitlement the client could edit.
 *
 * Emails are never stored in the clear. KV keys use an HMAC of the address
 * under AUTH_SECRET, so a dump of the namespace is not a mailing list.
 */

export const CODE_TTL = 600;          // 10 minutes to type a 6-digit code
export const CODE_TRIES = 5;          // then the code is burned
export const TOKEN_DAYS = 30;

// Daily AI calls. "paid" is set by hand today (see markPaid below); wiring a
// payment provider later only has to write that same record.
export const PLANS = { free: 10, paid: 200 };

const enc = new TextEncoder();
const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf)))
  .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", key, enc.encode(msg)));
}

/** Constant-time compare: a timing oracle on a 6-digit code is worth having. */
function same(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export const normEmail = e => String(e || "").trim().toLowerCase();

// Deliberately permissive: the real check is whether the code arrives. This
// only rejects things that cannot be an address at all.
export const looksLikeEmail = e =>
  /^[^\s@]+@[^\s@.]+\.[^\s@]{2,}$/.test(e) && e.length <= 254;

export const emailKey = (env, email) => hmac(env.AUTH_SECRET, "e:" + normEmail(email));

export function newCode() {
  // 6 digits from the CSPRNG, not Math.random.
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return String(a[0] % 1000000).padStart(6, "0");
}

export async function issueToken(env, email) {
  const payload = {
    sub: await emailKey(env, email),
    eml: normEmail(email),
    exp: Math.floor(Date.now() / 1000) + TOKEN_DAYS * 86400,
  };
  const body = b64url(enc.encode(JSON.stringify(payload)));
  return body + "." + await hmac(env.AUTH_SECRET, body);
}

/** Returns the payload, or null. Never throws on malformed input. */
export async function readToken(env, token) {
  if (typeof token !== "string" || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  if (!same(sig, await hmac(env.AUTH_SECRET, body))) return null;
  try {
    const p = JSON.parse(atob(body.replace(/-/g, "+").replace(/_/g, "/")));
    if (!p || !p.sub || !p.exp || p.exp < Math.floor(Date.now() / 1000)) return null;
    return p;
  } catch (e) { return null; }
}

export const bearer = req => {
  const h = req.headers.get("Authorization") || "";
  return h.startsWith("Bearer ") ? h.slice(7).trim() : "";
};

/** The account record is the authority on the plan -- never the token. */
export async function account(env, sub) {
  try {
    const raw = await env.RATE.get("acct:" + sub);
    const a = raw ? JSON.parse(raw) : null;
    if (a && a.plan === "paid" && a.until && Date.parse(a.until) < Date.now()) {
      return { ...a, plan: "free", expired: true };   // lapsed, not deleted
    }
    return a || { plan: "free" };
  } catch (e) { return { plan: "free" }; }
}

export const planLimit = a => PLANS[(a && a.plan) || "free"] || PLANS.free;

/**
 * Send the code. Resend is the default because it is the least ceremony to set
 * up; swapping providers is this function and nothing else. With no key
 * configured it fails closed -- printing the code to the log would turn every
 * viewer of the log into a valid sign-in.
 */
export async function sendCode(env, email, code) {
  if (!env.RESEND_API_KEY || !env.MAIL_FROM) {
    return { ok: false, status: 503,
             error: "登录服务还没配置好（缺邮件服务密钥），请联系站点维护者。" };
  }
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`,
               "content-type": "application/json" },
    body: JSON.stringify({
      from: env.MAIL_FROM,
      to: [normEmail(email)],
      subject: `澳洲移民工具箱 验证码 ${code}`,
      text: `你的验证码是 ${code}，${Math.round(CODE_TTL / 60)} 分钟内有效。\n\n`
          + `如果不是你本人操作，忽略这封邮件即可——没有验证码谁也进不去。\n`,
    }),
  });
  if (!r.ok) {
    const detail = (await r.text()).slice(0, 200);
    return { ok: false, status: 502, error: "验证码发送失败，请稍后再试。", detail };
  }
  return { ok: true };
}
