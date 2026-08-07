/* ---------- AI 分析：调用用户自己的 OpenAI 兼容端点 ----------
   Division of labour is the whole point here. The model is only ever asked for
   raw facts it can read off the page -- a birth year, a test name and score, a
   count of months. Every conversion into Schedule 6D points happens below in
   plain JavaScript, because the points test is a legal instrument and a model
   that quietly gets it wrong produces a number the user cannot check.

   This is not hypothetical: on the first trial run the model turned "born 1996"
   into age 27 and graded PTE 79 as Proficient when it is Superior. Both are
   conversions, and both are now done here instead. */
const AI_KEY = "immi.ai.cfg.v2";
let AI_RESULT = null, AI_BODY = null, AI_RAW = "";
// Mirror of the shared endpoint's MAX_CHARS, used only to fail fast in the
// page. The Worker is the authority; this is refreshed from its ping and 413
// replies, so raising it there does not require another site build.
let PROXY_MAX_CHARS = 40000;

/* Providers differ in two ways that matter: the wire format (OpenAI-style
   /v1/chat/completions vs Anthropic's /v1/messages) and whether the browser is
   allowed to call them at all. Anthropic requires an explicit opt-in header;
   without it the preflight 400s. Everything else here speaks OpenAI. */
const PROVIDERS = {
  // Filled in by build_site.py from PUBLIC_PROXY_URL. The endpoint is a plain
  // URL, safe to publish; the key it uses lives as a secret inside the Worker.
  public: { label: "公共服务（无需填 Key）", api: "proxy", base: "", models: ["（由服务端固定）"],
            note: "由站点方代付，有每日额度。想不受限就在下面换成自己的 Key。" },
  local: { label: "本机 / 局域网（OpenAI 兼容）", api: "openai",
           base: "http://localhost:8080", models: [],
           note: "llama.cpp / vLLM / Ollama 等。密钥通常留空。" },
  deepseek: { label: "DeepSeek", api: "openai",
              base: "https://api.deepseek.com",
              models: ["deepseek-chat", "deepseek-reasoner"],
              note: "官方接口，按量计费。" },
  anthropic: { label: "Anthropic（Claude）", api: "anthropic",
               base: "https://api.anthropic.com",
               models: ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"],
               note: "浏览器直连需要 anthropic-dangerous-direct-browser-access 头，本页会自动带上。" },
  openrouter: { label: "OpenRouter", api: "openai",
                base: "https://openrouter.ai/api",
                models: ["anthropic/claude-sonnet-5", "deepseek/deepseek-chat"],
                note: "一个 key 转发到多家模型。" },
  custom: { label: "自定义（OpenAI 兼容）", api: "openai", base: "", models: [],
            note: "OpenAI、Kimi、通义等任何 OpenAI 兼容服务填这里。" },
};

// Default to the shared endpoint when one is deployed, so a first-time visitor
// can use the page without owning a key; aiLoadCfg() falls back to "local" if
// PUBLIC_PROXY_URL is empty, and any saved choice overrides this.
let AICFG = {
  provider: (typeof PUBLIC_PROXY_URL === "string" && PUBLIC_PROXY_URL)
    ? "public" : "local",
  profiles: {},
};
const aiProv = () => PROVIDERS[AICFG.provider] || PROVIDERS.custom;
const aiProf = () => (AICFG.profiles[AICFG.provider] =
  AICFG.profiles[AICFG.provider] || { endpoint: "", model: "", key: "" });

const $ai = id => document.getElementById(id);

function aiLoadCfg() {
  if (typeof PUBLIC_PROXY_URL === "string" && PUBLIC_PROXY_URL) {
    PROVIDERS.public.base = PUBLIC_PROXY_URL;
  } else {
    delete PROVIDERS.public;          // nothing deployed -> do not offer it
    if (AICFG.provider === "public") AICFG.provider = "local";
  }
  try {
    const raw = JSON.parse(localStorage.getItem(AI_KEY));
    if (raw && raw.profiles) AICFG = raw;
    else {
      // migrate the single-endpoint shape this page shipped with
      const old = JSON.parse(localStorage.getItem("immi.ai.cfg.v1"));
      if (old && old.endpoint) AICFG = { provider: "local", profiles: { local: old } };
    }
  } catch (e) {}
  const sel = $ai("aiProvider");
  if (sel) {
    if (!sel.childElementCount) {
      Object.entries(PROVIDERS).forEach(([k, v]) => {
        const o = document.createElement("option");
        o.value = k; o.textContent = v.label; sel.appendChild(o);
      });
    }
    if (!PROVIDERS[AICFG.provider]) AICFG.provider = Object.keys(PROVIDERS)[0];
    sel.value = AICFG.provider;
  }
  aiFillProfile();
}
function aiFillProfile() {
  const prof = aiProf(), prov = aiProv();
  const proxy = prov.api === "proxy";
  if (proxy) prof.endpoint = prov.base;
  ["aiEndpointField", "aiModelField", "aiKeyField"].forEach(id => {
    const el = $ai(id); if (el) el.hidden = proxy;
  });
  $ai("aiEndpoint").value = prof.endpoint || prov.base || "";
  $ai("aiModel").value = prof.model || prov.models[0] || "";
  $ai("aiKey").value = prof.key || "";
  $ai("aiProvNote").textContent = prov.note || "";
  const dl = $ai("aiModelList");
  dl.textContent = "";
  prov.models.forEach(m => {
    const o = document.createElement("option"); o.value = m; dl.appendChild(o);
  });
  $ai("aiKeyLabel").textContent =
    AICFG.provider === "local" ? "API Key（本地服务通常留空）" : "API Key";
}
function aiSaveCfg() {
  const sel = $ai("aiProvider");
  if (sel && sel.value) AICFG.provider = sel.value;
  const prof = aiProf();
  prof.endpoint = ($ai("aiEndpoint").value || "").trim()
    .replace(/\/+$/, "").replace(/\/v1$/, "");
  prof.model = ($ai("aiModel").value || "").trim();
  prof.key = ($ai("aiKey").value || "").trim();
  try { localStorage.setItem(AI_KEY, JSON.stringify(AICFG)); } catch (e) {}
}

/* ---- the two wire formats ---- */
function aiHeaders() {
  const prof = aiProf();
  if (aiProv().api === "proxy") return { "Content-Type": "application/json" };
  if (aiProv().api === "anthropic") {
    return { "content-type": "application/json",
             "x-api-key": prof.key || "",
             "anthropic-version": "2023-06-01",
             // without this the browser preflight is rejected outright
             "anthropic-dangerous-direct-browser-access": "true" };
  }
  return Object.assign({ "Content-Type": "application/json" },
    prof.key ? { Authorization: "Bearer " + prof.key } : {});
}
const aiChatUrl = () => aiProv().api === "proxy" ? aiProf().endpoint
  : aiProf().endpoint + (aiProv().api === "anthropic" ? "/v1/messages" : "/v1/chat/completions");
const aiModelsUrl = () => aiProf().endpoint + "/v1/models";

/* Build the provider's own request shape from one neutral description. */
function aiWireBody({ model, system, user, schema, maxTokens }) {
  // The shared endpoint takes only the redacted text -- it builds the prompt,
  // schema and model itself, so it cannot be repurposed as a free model proxy.
  if (aiProv().api === "proxy") return { text: user };
  if (aiProv().api === "anthropic") {
    return { model, max_tokens: maxTokens, system,
             messages: [{ role: "user", content: user }],
             output_config: { format: { type: "json_schema", schema } } };
  }
  return { model, max_tokens: maxTokens, temperature: 0.2,
           response_format: { type: "json_schema",
             json_schema: { name: "occupation_match", strict: true, schema } },
           messages: [{ role: "system", content: system },
                      { role: "user", content: user }] };
}

/* Pull text, reasoning and usage out of either response shape. */
function aiWireRead(d) {
  if (aiProv().api === "proxy") {
    if (d.error) throw new Error(d.error + (d.detail ? "：" + d.detail : ""));
    return { text: d.content || "", think: "",
             tokens: d.usage && d.usage.completion_tokens,
             finish: d.quota ? `今日已用 ${d.quota.used}/${d.quota.perDay}` : "" };
  }
  if (aiProv().api === "anthropic") {
    if (d.stop_reason === "refusal") {
      throw new Error("模型基于安全策略拒绝了这次请求（stop_reason=refusal）");
    }
    const blocks = d.content || [];
    return { text: blocks.filter(b => b.type === "text").map(b => b.text).join(""),
             think: blocks.filter(b => b.type === "thinking").map(b => b.thinking || "").join(""),
             tokens: d.usage && d.usage.output_tokens,
             finish: d.stop_reason };
  }
  const msg = (d.choices && d.choices[0] && d.choices[0].message) || {};
  return { text: msg.content || "", think: msg.reasoning_content || "",
           tokens: d.usage && d.usage.completion_tokens,
           finish: d.choices && d.choices[0] && d.choices[0].finish_reason };
}

/* A page served over https cannot fetch an http endpoint -- browsers block
   active mixed content outright, with no user override. Say so up front
   instead of letting it surface as an unexplained "Failed to fetch". */
function aiEnvCheck() {
  const w = $ai("aiEnvWarn");
  if (!w) return;
  const ep = aiProf().endpoint || aiProv().base || "";
  const httpsPage = location.protocol === "https:";
  const httpEp = /^http:\/\//i.test(ep);
  if (httpsPage && httpEp) {
    w.hidden = false; w.textContent = "";
    const b = document.createElement("b");
    b.textContent = "这个页面走 https，而端点是 http —— 浏览器会直接拦截，无法绕过。";
    w.append(b, document.createTextNode(
      "本机模型请在本机用 http 打开本站（例如 python -m http.server），" +
      "或改用上面的云端服务商——它们都是 https。"));
  } else { w.hidden = true; }
}

async function aiTest() {
  aiSaveCfg(); aiEnvCheck(); aiFillProfile();
  const out = $ai("aiTestOut"), prof = aiProf();
  if (!prof.endpoint) { out.textContent = "先填端点地址。"; return; }
  out.textContent = "连接中…";
  try {
    // The shared endpoint is not an OpenAI-compatible server: it has no
    // /v1/models and answers GET with 405. It takes a ping that reads the
    // counters without bumping them, so checking your setup is free and does
    // not spend one of your daily calls.
    if (aiProv().api === "proxy") {
      const r = await fetch(prof.endpoint, {
        method: "POST", headers: aiHeaders(),
        body: JSON.stringify({ ping: true }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error("HTTP " + r.status + " " + (d.error || ""));
      if (d.maxChars) PROXY_MAX_CHARS = d.maxChars;
      const q = d.quota || {};
      out.textContent = `连接成功，公共服务可用（模型 ${d.model || "由服务端固定"}）。` +
        (q.perDay ? `你今天已用 ${q.used || 0}/${q.perDay} 次，` : "") +
        `简历上限 ${PROXY_MAX_CHARS} 字。`;
      return;
    }
    const r = await fetch(aiModelsUrl(), { headers: aiHeaders() });
    if (!r.ok) throw new Error("HTTP " + r.status + " " + (await r.text()).slice(0, 160));
    const d = await r.json();
    const ids = (d.data || d.models || []).map(m => m.id || m.name).filter(Boolean);
    out.textContent = `连接成功。当前模型：${prof.model || "（未填）"}。` +
      (ids.length ? `服务列出 ${ids.length} 个模型，例如：${ids.slice(0, 6).join("、")}` : "");
  } catch (e) {
    out.textContent = `连接失败：${e.message}。` + (location.protocol === "https:" &&
      /^http:\/\//i.test(prof.endpoint)
      ? "本页是 https，无法调用 http 端点——这是最常见的原因。"
      : "检查端点、密钥，以及该服务是否允许浏览器跨域调用。");
  }
}

/* ---------- reading a file without shipping it anywhere ---------- */
async function docxToText(buf) {
  // A .docx is a zip; word/document.xml holds the text. Browsers can inflate
  // natively now, so this needs no library.
  const dv = new DataView(buf), u8 = new Uint8Array(buf);
  const dec = new TextDecoder();
  for (let i = u8.length - 22; i >= 0; i--) {                 // find end-of-central-directory
    if (dv.getUint32(i, true) !== 0x06054b50) continue;
    let off = dv.getUint32(i + 16, true);
    const n = dv.getUint16(i + 10, true);
    for (let k = 0; k < n; k++) {
      const nameLen = dv.getUint16(off + 28, true),
            extLen = dv.getUint16(off + 30, true),
            cmtLen = dv.getUint16(off + 32, true),
            lho = dv.getUint32(off + 42, true),
            method = dv.getUint16(off + 10, true),
            csize = dv.getUint32(off + 20, true),
            name = dec.decode(u8.subarray(off + 46, off + 46 + nameLen));
      if (name === "word/document.xml") {
        const lnl = dv.getUint16(lho + 26, true), lel = dv.getUint16(lho + 28, true);
        const start = lho + 30 + lnl + lel;
        const raw = u8.subarray(start, start + csize);
        let xml;
        if (method === 0) xml = dec.decode(raw);
        else {
          const ds = new DecompressionStream("deflate-raw");
          const ab = await new Response(new Blob([raw]).stream().pipeThrough(ds)).arrayBuffer();
          xml = dec.decode(ab);
        }
        return xml.replace(/<\/w:p>/g, "\n").replace(/<[^>]+>/g, "")
                  .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
                  .replace(/\n{3,}/g, "\n\n").trim();
      }
      off += 46 + nameLen + extLen + cmtLen;
    }
    break;
  }
  throw new Error("这个 .docx 里找不到 word/document.xml");
}

/* PDF text needs a real parser: Chinese resumes almost always use CID fonts
   with a ToUnicode CMap, and a naive stream reader returns plausible-looking
   garbage -- which would then be fed to the model silently. pdf.js is vendored
   into site/vendor and imported only when a PDF is actually chosen, so the
   1.4 MB is never on the critical path. */
let PDFJS = null;
async function loadPdfJs() {
  if (PDFJS) return PDFJS;
  const base = new URL("vendor/", document.baseURI).href;
  PDFJS = await import(base + "pdf.min.mjs");
  PDFJS.GlobalWorkerOptions.workerSrc = base + "pdf.worker.min.mjs";
  return PDFJS;
}

async function pdfToText(buf, onProgress) {
  const pdfjs = await loadPdfJs();
  const doc = await pdfjs.getDocument({ data: buf, isEvalSupported: false }).promise;
  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    if (onProgress) onProgress(p, doc.numPages);
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    // Items carry their own transform; group them into lines by baseline y,
    // then order left to right, so a two-column resume does not interleave.
    const lines = [];
    tc.items.forEach(it => {
      if (!it.str) return;
      const x = it.transform[4], y = Math.round(it.transform[5]);
      let line = lines.find(l => Math.abs(l.y - y) <= 2);
      if (!line) { line = { y, parts: [] }; lines.push(line); }
      line.parts.push({ x, s: it.str, w: it.width || 0 });
    });
    lines.sort((a, b) => b.y - a.y);
    const text = lines.map(l => {
      l.parts.sort((a, b) => a.x - b.x);
      let out = "";
      l.parts.forEach((pt, i) => {
        const prev = l.parts[i - 1];
        // insert a space only where the glyphs are actually far apart
        if (prev && pt.x - (prev.x + prev.w) > 1.2 && !/\s$/.test(out)) out += " ";
        out += pt.s;
      });
      return out.trim();
    }).filter(Boolean).join("\n");
    pages.push(text);
    page.cleanup();
  }
  await doc.destroy();
  // Some embedded fonts map to Kangxi radicals (U+2F00-2FDF) and CJK
  // compatibility forms rather than unified ideographs, so "出生日期" arrives as
  // "出⽣⽇期". NFKC folds them back; without it the redaction patterns and the
  // model both see characters that look right and compare wrong.
  const all = pages.join("\n\n").normalize("NFKC")
    .replace(/\n{3,}/g, "\n\n").trim();
  if (!all) throw new Error("这个 PDF 里没有可提取的文字层——多半是扫描件，请手动录入或粘贴");
  return all;
}

async function aiReadFile(file, onProgress) {
  const name = (file.name || "").toLowerCase();
  if (name.endsWith(".docx")) return docxToText(await file.arrayBuffer());
  if (name.endsWith(".pdf")) {
    try {
      return await pdfToText(await file.arrayBuffer(), onProgress);
    } catch (e) {
      if (/import|module|Failed to fetch|dynamically imported/i.test(e.message || "")) {
        throw new Error("PDF 解析库未能加载（单文件版报告不含它）——请复制 PDF 里的文字粘贴到下方");
      }
      throw e;
    }
  }
  return file.text();
}

/* ---------- strip direct identifiers before anything leaves the browser ----------
   Order matters. Dates are normalised first so that a range like "2014.09 -
   2018.07" stops looking like a 12-digit number run; only then is phone-like
   redaction applied. Getting this backwards destroys the employment dates the
   whole extraction depends on. */
function aiRedact(t) {
  const hits = {};
  const bump = k => { hits[k] = (hits[k] || 0) + 1; };

  // full dates -> year only (age can still be derived, the day cannot identify)
  t = t.replace(/(\d{4})\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日/g, (m, y) => { bump("生日→年"); return y + " 年"; });
  t = t.replace(/\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](19|20)(\d{2})\b/g, (m, a, b, c, y) => { bump("日期→年"); return c + y + " 年"; });
  t = t.replace(/\b((?:19|20)\d{2})[\/\-.](\d{1,2})[\/\-.](\d{1,2})\b/g, (m, y) => { bump("日期→年"); return y + " 年"; });

  // year-month (2014.09, 2018-07) -> 2014年9月, so it is no longer a digit run
  t = t.replace(/\b((?:19|20)\d{2})[.\-\/](0?[1-9]|1[0-2])\b/g, (m, y, mo) => y + "年" + (+mo) + "月");

  t = t.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, () => { bump("邮箱"); return "[邮箱已移除]"; });
  t = t.replace(/https?:\/\/\S+|\bwww\.[\w.-]+\.\w+\S*/gi, () => { bump("网址"); return "[网址已移除]"; });

  // phone / passport / account: a separated run carrying at least 9 digits
  t = t.replace(/[+(]?\d[\d\s\-().]{6,}\d/g, m => {
    const n = (m.match(/\d/g) || []).length;
    if (n < 9) return m;
    bump("长串数字");
    return "[号码已移除]";
  });

  const summary = Object.entries(hits).map(([k, v]) => `${k}×${v}`).join("，") || "未发现可识别信息";
  return { text: t.trim(), summary };
}

/* ---------- the request ----------
   Scoring lives on the points page, so this asks for one thing only: which
   ANZSCO occupation the CV describes. That is the fuzzy-matching job a model is
   actually good at, and narrowing the schema means less of the CV's meaning
   leaves the browser and the call returns in a fraction of the time. */
const AI_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["jobTitles", "keyDuties", "fieldOfStudy", "candidates"],
  properties: {
    jobTitles: { type: "array", items: { type: "string" } },
    keyDuties: { type: "array", items: { type: "string" } },
    fieldOfStudy: { type: ["string", "null"] },
    candidates: { type: "array", items: { type: "object", additionalProperties: false,
      required: ["name", "code", "why"],
      properties: {
        name: { type: "string" },              // ANZSCO English title
        code: { type: ["string", "null"] },     // six digits, or null
        why:  { type: "string" } } } },
  },
};

const AI_SYSTEM =
  "你的任务只有一个：判断这份简历对应澳洲 ANZSCO 职业清单里的哪个职业。只输出 JSON，不要解释。\n" +
  "- jobTitles：简历里**原文写出的**职位名称，原样照抄，不要翻译改写。\n" +
  "- keyDuties：最能体现职业性质的职责关键词，3–8 条，尽量短。\n" +
  "- fieldOfStudy：所学专业；没写填 null。\n" +
  "- candidates：1–4 个最可能的 ANZSCO 职业，按可能性从高到低。\n" +
  "  name 必须是澳洲 ANZSCO 清单上的**英文职业名**（例如 Software Engineer、" +
  "Developer Programmer、ICT Business Analyst）。\n" +
  "  code 是六位数字代码；不确定就填 null，**不要瞎编，也不要填 \"unknown\"**。\n" +
  "  why 用一句中文说明依据，引用简历里的职责或专业。\n" +
  "- 不要输出年龄、英语成绩、工作年限、配偶等信息——这些本工具在别处处理，这里不需要。";

function aiBuildBody() {
  const raw = $ai("aiRaw").value || "";
  const { text, summary } = aiRedact(raw);
  $ai("aiRedactStat").textContent =
    `原文 ${raw.length} 字，脱敏后 ${text.length} 字。本地移除：${summary}。` +
    (aiProv().api === "proxy" ? `公共服务上限 ${PROXY_MAX_CHARS} 字。` : "");
  AI_BODY = aiWireBody({ model: aiProf().model, system: AI_SYSTEM, user: text,
                         schema: AI_SCHEMA, maxTokens: 8000 });
  const pre = document.createElement("pre");
  pre.style.cssText = "white-space:pre-wrap;word-break:break-word;font-size:11.5px;margin:0;padding:10px";
  pre.textContent = `POST ${aiChatUrl()}\n` +
    Object.keys(aiHeaders()).map(k => k + ": " +
      (/key|authorization/i.test(k) ? "（密钥已隐去）" : aiHeaders()[k])).join("\n") +
    "\n\n" + JSON.stringify(AI_BODY, null, 2);
  const w = $ai("aiBody"); w.textContent = ""; w.appendChild(pre);
  return AI_BODY;
}

async function aiSend() {
  aiSaveCfg(); aiEnvCheck();
  const stat = $ai("aiSendStat"), prof = aiProf();
  if (!prof.endpoint) { stat.textContent = "先在第 1 步填端点。"; return; }
  if (aiProv().api !== "proxy" && !prof.model) {
    stat.textContent = "先在第 1 步填模型名。"; return; }
  if (!($ai("aiRaw").value || "").trim()) { stat.textContent = "第 2 步还没有简历正文。"; return; }
  const body = AI_BODY || aiBuildBody();
  // Catch an over-long resume here rather than after uploading it and waiting
  // for the endpoint to reject it.
  if (aiProv().api === "proxy" && (body.text || "").length > PROXY_MAX_CHARS) {
    stat.textContent = `简历太长：脱敏后 ${body.text.length} 字，公共服务上限 ` +
      `${PROXY_MAX_CHARS} 字。请只保留学历和工作经历，去掉获奖与项目清单，` +
      "或在第 1 步换成自己的 API Key（不受这个上限约束）。";
    return;
  }
  stat.textContent = `已发送到 ${aiProv().label}，等待返回（思考模型可能需要几十秒）…`;
  const t0 = Date.now();

  // Not every OpenAI-compatible service accepts a json_schema; step down rather
  // than fail, since the parser already tolerates prose around the JSON.
  const attempts = [body];
  if (aiProv().api === "openai") {
    attempts.push(Object.assign({}, body, { response_format: { type: "json_object" } }));
    const bare = Object.assign({}, body); delete bare.response_format;
    attempts.push(bare);
  } else if (aiProv().api === "anthropic") {
    const bare = Object.assign({}, body); delete bare.output_config;
    attempts.push(bare);
  }

  try {
    let d = null, lastErr = "";
    for (let i = 0; i < attempts.length; i++) {
      const r = await fetch(aiChatUrl(),
        { method: "POST", headers: aiHeaders(), body: JSON.stringify(attempts[i]) });
      if (r.ok) { d = await r.json(); if (i) stat.textContent = "（该服务不支持结构化输出，已降级重试）"; break; }
      const raw = await r.text();
      let msg = raw.slice(0, 200);
      try {                       // the shared endpoint already answers in Chinese
        const j = JSON.parse(raw);
        if (j.maxChars) PROXY_MAX_CHARS = j.maxChars;
        if (j.error) msg = j.error + (j.detail ? "：" + String(j.detail).slice(0, 160) : "");
      } catch (_) { /* not JSON; the raw body is the best we have */ }
      lastErr = aiProv().api === "proxy" ? msg : "HTTP " + r.status + " " + msg;
      // only a schema-shaped complaint is worth retrying
      if (r.status !== 400 || !/format|schema|response_format|output_config/i.test(lastErr)) break;
    }
    if (!d) throw new Error(lastErr || "请求失败");

    const got = aiWireRead(d);
    AI_RAW = got.text;
    let parsed;
    try { parsed = JSON.parse(AI_RAW); }
    catch (e) {
      const m = AI_RAW.match(/\{[\s\S]*\}/);          // tolerate fences or stray prose
      if (!m) throw new Error(AI_RAW
        ? "模型返回的不是 JSON（finish=" + (got.finish || "?") + "）"
        : "模型返回了空内容（finish=" + (got.finish || "?") +
          "，思考模型可能把 token 用在了推理上，可换个模型或提高上限）");
      parsed = JSON.parse(m[0]);
    }
    AI_RESULT = parsed;
    stat.textContent = `完成，用时 ${((Date.now() - t0) / 1000).toFixed(1)} 秒` +
      (got.tokens ? `，${got.tokens} tokens` : "") + `（${aiProv().label} · ${prof.model}）。`;
    aiShowRaw(AI_RAW, got.think);
    await aiRenderResult(parsed);
  } catch (e) {
    // A network-level failure surfaces as a bare "Failed to fetch" with no
    // detail available to script, so spell out what actually causes it.
    stat.textContent = e instanceof TypeError
      ? `连不上端点（${e.message}）。常见原因：` +
        (location.protocol === "https:" && /^http:\/\//i.test(prof.endpoint)
          ? "① 本页是 https，调不了 http 端点——请在本机用 http 打开本站，或改用云端服务商；"
          : "① 端点地址写错，或服务没在跑；") +
        "② 该服务不允许浏览器跨域调用；" +
        "③ 本地模型正忙于上一次生成，槽位占满时新连接会被直接拒绝——等它跑完再试。"
      : "失败：" + e.message;
  }
}

function aiShowRaw(raw, think) {
  const put = (id, txt) => {
    const w = $ai(id); w.textContent = "";
    const pre = document.createElement("pre");
    pre.style.cssText = "white-space:pre-wrap;word-break:break-word;font-size:11.5px;margin:0;padding:10px";
    pre.textContent = txt || "（无）";
    w.appendChild(pre);
  };
  put("aiRawOut", raw); put("aiThink", think);
}

/* ANZSCO codes are hierarchical: 261313 sits in unit group 2613, minor group
   261, sub-major 26. Occupations sharing a prefix are the ones a skills
   assessor might plausibly place the same background in, so the model's picks
   are seeds and the neighbourhood is derived deterministically from the code. */
function aiRelated(seedCodes, idx, cap) {
  const out = [], seen = new Set();
  const add = (o, rel) => { if (!seen.has(o.code)) { seen.add(o.code); out.push({ o, rel }); } };
  seedCodes.forEach(c => { const o = idx.find(o => o.code === c); if (o) add(o, "模型判定最贴近"); });
  [[4, "同一四位小类"], [3, "同一三位中类"], [2, "同一两位大类"]].forEach(([n, rel]) => {
    if (out.length >= cap) return;
    const prefixes = new Set(seedCodes.map(c => c.slice(0, n)));
    idx.forEach(o => {
      if (out.length >= cap) return;
      if (prefixes.has(o.code.slice(0, n))) add(o, rel);
    });
  });
  return out;
}

/* The score the user actually filled in on the points page. */
function aiBaseScore() {
  let saved = CALC;
  if (!saved || !Object.keys(saved).length) {
    try { saved = JSON.parse(localStorage.getItem(CALC_KEY)) || {}; } catch (e) { saved = {}; }
  }
  const prev = CALC; CALC = saved;
  const total = calcBreakdown().total;
  CALC = prev;
  return total;
}

async function aiRateFor(code, score) {
  try {
    const d = await (await fetch(`data/${code}.json`, { cache: "force-cache" })).json();
    const per = {};
    (d.visaOrder || []).forEach(v => {
      const bonus = /^190/.test(v) ? 5 : (/^491/.test(v) ? 15 : 0);
      const want = score + bonus;
      const R = d.rate[v];
      if (!R || !R.points.length) return;
      let i = R.points.indexOf(want);
      if (i < 0) { for (let j = 0; j < R.points.length; j++) if (R.points[j] <= want) i = j; }
      if (i < 0) return;
      per[v] = { rate: R.rate[i], n: R.total[i], at: R.points[i], score: want,
                 exact: R.points[i] === want };
    });
    return per;
  } catch (e) { return null; }
}

async function aiRenderResult(x) {
  $ai("aiResultCard").hidden = false;
  const titles = (x.jobTitles || []).join("、") || "（未识别到职位名）";
  const duties = (x.keyDuties || []).join(" · ");
  $ai("aiRead").textContent =
    `简历里的职位：${titles}` + (x.fieldOfStudy ? `　专业：${x.fieldOfStudy}` : "") +
    (duties ? `\n关键职责：${duties}` : "");

  const idx = (typeof window !== "undefined" && window.OCC_INDEX) || [];
  const seen = new Set(), seeds = [];
  const addByCode = code => {
    const o = idx.find(o => o.code === code);
    if (o && !seen.has(o.code)) { seen.add(o.code); seeds.push(o.code); }
    return !!o;
  };
  const addByName = name => {
    const words = String(name || "").toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 3);
    if (!words.length) return;
    const scored = idx.map(o => {
      const n = o.name.toLowerCase();
      const hit = words.filter(w => n.includes(w));
      return { o, all: hit.length === words.length, sc: hit.reduce((a, w) => a + w.length, 0) };
    }).filter(r => r.sc > 0);
    const full = scored.filter(r => r.all).sort((a, b) => b.sc - a.sc);
    const pick = full.length ? full.slice(0, 2) : scored.sort((a, b) => b.sc - a.sc).slice(0, 1);
    pick.forEach(({ o }) => { if (!seen.has(o.code)) { seen.add(o.code); seeds.push(o.code); } });
  };
  (x.candidates || []).forEach(c => {
    const code = /^\d{6}$/.test(c.code || "") ? c.code : null;
    if (!(code && addByCode(code))) addByName(c.name);
  });

  const note = $ai("aiOccNote"), list = $ai("aiOccList");
  list.textContent = "";
  if (!seeds.length) {
    note.textContent = "没有匹配到 SkillSelect 清单里的职业。模型给出的名称是：" +
      ((x.candidates || []).map(c => c.name).join("、") || "（无）") +
      "。可以到「职业数据查询」页用搜索框自己找。";
    return;
  }

  const base = aiBaseScore();
  const rows = aiRelated(seeds, idx, 14);

  if (!base) {
    note.textContent = "找到了相关职业，但还不知道你的分数——先到「计算分数」页把表填了，" +
      "回来这里就会按你的分数把这些职业按历史获邀率排序。";
    rows.slice(0, 6).forEach(({ o, rel }) => {
      const row = document.createElement("div"); row.className = "occrow";
      const b = document.createElement("button");
      b.type = "button"; b.className = "tblbtn nt";
      b.textContent = `${o.name}　在池 ${fmt(o.pool)}`;
      b.addEventListener("click", () => { location.hash = "#/data/" + o.code; });
      const r = document.createElement("span"); r.className = "occwhy"; r.textContent = rel;
      row.append(b, r); list.appendChild(row);
    });
    return;
  }

  note.textContent = `以下按你在「计算分数」页算出的 ${base} 分（未含州/地区提名），` +
    "查每个职业在对应分数上的历史获邀率，从高到低排。189 用 " + base + " 分、" +
    "190 用 " + (base + 5) + " 分、491 用 " + (base + 15) + " 分。加载中…";

  const withRates = await Promise.all(rows.map(async ({ o, rel }) => {
    const per = await aiRateFor(o.code, base);
    let best = -1, bestVisa = null;
    Object.entries(per || {}).forEach(([v, r]) => {
      if (r.n >= 50 && r.rate > best) { best = r.rate; bestVisa = v; }
    });
    return { o, rel, per: per || {}, best, bestVisa };
  }));
  withRates.sort((a, b) => b.best - a.best || b.o.pool - a.o.pool);

  const cols = ["189", "190", "491 (州担保)"];
  const head = ["职业", `189 (${base}分)`, `190 (${base + 5}分)`, `491 (${base + 15}分)`, "在池", "关系"];
  const cell = r => !r ? "—" : (r.n < 50 ? `${r.rate}%▲` : `${r.rate}%`);
  const body = withRates.map(w => [w.o.name].concat(
    cols.map(c => cell(w.per[c])), [fmt(w.o.pool), w.rel]));

  list.textContent = "";
  const wrap = document.createElement("div");
  wrap.className = "tblwrap on"; wrap.style.maxHeight = "none";
  const tb = document.createElement("table");
  const tr = document.createElement("tr");
  head.forEach(h => { const th = document.createElement("th"); th.textContent = h; tr.appendChild(th); });
  tb.appendChild(tr);
  const tbody = document.createElement("tbody");
  body.forEach((cells, i) => {
    const row = document.createElement("tr");
    cells.forEach((c, j) => {
      const td = document.createElement("td");
      if (j === 0) {
        const b = document.createElement("button");
        b.type = "button"; b.className = "linkbtn"; b.textContent = c;
        b.addEventListener("click", () => { location.hash = "#/data/" + withRates[i].o.code; });
        td.appendChild(b);
      } else td.textContent = c;
      if (j >= 1 && j <= 3 && withRates[i].bestVisa === cols[j - 1] && withRates[i].best > 0) {
        td.className = "best";
      }
      row.appendChild(td);
    });
    tbody.appendChild(row);
  });
  tb.appendChild(tbody); wrap.appendChild(tb); list.appendChild(wrap);

  note.textContent = `按你在「计算分数」页算出的 ${base} 分排序（189 用 ${base} 分、` +
    `190 用 ${base + 5} 分、491 用 ${base + 15} 分，含提名加分）。每行最高的一格加粗；` +
    "带 ▲ 的样本不足 50，不可靠。点职业名可查看它的完整数据页。";
}

function aiInit() {
  if ($ai("aiEndpoint") && $ai("aiEndpoint").dataset.wired) return;
  aiLoadCfg(); aiEnvCheck();
  ["aiEndpoint", "aiModel", "aiKey"].forEach(id => {
    const el = $ai(id); if (!el) return;
    el.dataset.wired = "1";
    el.addEventListener("change", () => { aiSaveCfg(); aiEnvCheck(); AI_BODY = null; });
  });
  $ai("aiProvider").addEventListener("change", () => {
    AICFG.provider = $ai("aiProvider").value;
    AI_BODY = null;
    aiFillProfile(); aiSaveCfg(); aiEnvCheck();
    $ai("aiTestOut").textContent = "";
  });
  $ai("aiTest").addEventListener("click", aiTest);
  $ai("aiForget").addEventListener("click", () => {
    AICFG.profiles = {};
    try { localStorage.setItem(AI_KEY, JSON.stringify(AICFG));
          localStorage.removeItem("immi.ai.cfg.v1"); } catch (e) {}
    aiFillProfile();
    $ai("aiTestOut").textContent = "已清除本机保存的所有服务商端点与密钥。";
    aiEnvCheck();
  });
  $ai("aiPick").addEventListener("click", () => $ai("aiFile").click());
  $ai("aiFile").addEventListener("change", async e => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    $ai("aiFileName").textContent = f.name + " 解析中…";
    try {
      $ai("aiRaw").value = await aiReadFile(f, (p, n) => {
        $ai("aiFileName").textContent = `${f.name} 解析中… 第 ${p}/${n} 页`;
      });
      $ai("aiFileName").textContent = `${f.name} 已在本地解析，${$ai("aiRaw").value.length} 字`;
      aiBuildBody();
    } catch (err) {
      $ai("aiFileName").textContent = f.name + " 解析失败：" + err.message;
    }
  });
  // aiBuildBody caches its result in AI_BODY, and the file picker rebuilds it.
  // Typing or pasting into the box must invalidate it too, or a second send
  // after an edit would ship the previous text.
  $ai("aiRaw").addEventListener("input", () => { AI_BODY = null; });
  $ai("aiSend").addEventListener("click", aiSend);
}
