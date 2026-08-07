/* ---------- AI 分析：调用用户自己的 OpenAI 兼容端点 ----------
   Division of labour is the whole point here. The model is only ever asked for
   raw facts it can read off the page -- a birth year, a test name and score, a
   count of months. Every conversion into Schedule 6D points happens below in
   plain JavaScript, because the points test is a legal instrument and a model
   that quietly gets it wrong produces a number the user cannot check.

   This is not hypothetical: on the first trial run the model turned "born 1996"
   into age 27 and graded PTE 79 as Proficient when it is Superior. Both are
   conversions, and both are now done here instead. */
const AI_KEY = "immi.ai.cfg.v1";
let AICFG = { endpoint: "", model: "", key: "" };
let AI_RESULT = null, AI_BODY = null, AI_RAW = "";

const $ai = id => document.getElementById(id);

function aiLoadCfg() {
  try { AICFG = Object.assign(AICFG, JSON.parse(localStorage.getItem(AI_KEY)) || {}); } catch (e) {}
  ["endpoint", "model", "key"].forEach(k => { const el = $ai("ai" + k[0].toUpperCase() + k.slice(1)); if (el) el.value = AICFG[k] || ""; });
}
function aiSaveCfg() {
  ["endpoint", "model", "key"].forEach(k => {
    const el = $ai("ai" + k[0].toUpperCase() + k.slice(1));
    if (el) AICFG[k] = el.value.trim();
  });
  AICFG.endpoint = AICFG.endpoint.replace(/\/+$/, "").replace(/\/v1$/, "");
  try { localStorage.setItem(AI_KEY, JSON.stringify(AICFG)); } catch (e) {}
}
const aiHeaders = () => Object.assign({ "Content-Type": "application/json" },
  AICFG.key ? { Authorization: "Bearer " + AICFG.key } : {});

/* A page served over https cannot fetch an http endpoint -- browsers block
   active mixed content outright, with no user override. Say so up front
   instead of letting it surface as an unexplained "Failed to fetch". */
function aiEnvCheck() {
  const w = $ai("aiEnvWarn");
  if (!w) return;
  const httpsPage = location.protocol === "https:";
  const httpEp = /^http:\/\//i.test(AICFG.endpoint || "");
  if (httpsPage && httpEp) {
    w.hidden = false;
    w.textContent = "";
    const b = document.createElement("b");
    b.textContent = "这个页面走 https，而端点是 http —— 浏览器会直接拦截，无法绕过。";
    w.append(b, document.createTextNode(
      "要么在本机用 http 打开本站（例如 python -m http.server），要么给端点套一层 HTTPS（如 Cloudflare Tunnel）。" +
      "另外公网访客也连不到局域网地址。"));
  } else if (httpsPage && !AICFG.endpoint) {
    w.hidden = false;
    w.textContent = "提示：本页通过 https 打开，只能连 https 端点。局域网里的 http 服务需要在本机用 http 打开本站才能调用。";
  } else { w.hidden = true; }
}

async function aiTest() {
  aiSaveCfg(); aiEnvCheck();
  const out = $ai("aiTestOut");
  if (!AICFG.endpoint) { out.textContent = "先填端点地址。"; return; }
  out.textContent = "连接中…";
  try {
    const r = await fetch(AICFG.endpoint + "/v1/models", { headers: aiHeaders() });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const d = await r.json();
    const ids = (d.data || d.models || []).map(m => m.id || m.name).filter(Boolean);
    if (!AICFG.model && ids.length) { AICFG.model = ids[0]; $ai("aiModel").value = ids[0]; aiSaveCfg(); }
    out.textContent = `连接成功。可用模型：${ids.join("、") || "（服务未列出）"}。当前使用：${AICFG.model || "未指定"}`;
  } catch (e) {
    out.textContent = `连接失败：${e.message}。` + (location.protocol === "https:"
      ? "本页是 https，无法调用 http 端点——这是最常见的原因。"
      : "检查端点是否可达、是否允许跨域（服务端需回 Access-Control-Allow-Origin）。");
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
    `原文 ${raw.length} 字，脱敏后 ${text.length} 字。本地移除：${summary}。`;
  AI_BODY = {
    model: AICFG.model || "",
    max_tokens: 3000,
    temperature: 0.2,
    response_format: { type: "json_schema",
      json_schema: { name: "occupation_match", strict: true, schema: AI_SCHEMA } },
    messages: [{ role: "system", content: AI_SYSTEM },
               { role: "user", content: text }],
  };
  const pre = document.createElement("pre");
  pre.style.cssText = "white-space:pre-wrap;word-break:break-word;font-size:11.5px;margin:0;padding:10px";
  pre.textContent = JSON.stringify(AI_BODY, null, 2);
  const w = $ai("aiBody"); w.textContent = ""; w.appendChild(pre);
  return AI_BODY;
}

async function aiSend() {
  aiSaveCfg(); aiEnvCheck();
  const stat = $ai("aiSendStat");
  if (!AICFG.endpoint) { stat.textContent = "先在第 1 步填端点。"; return; }
  if (!($ai("aiRaw").value || "").trim()) { stat.textContent = "第 2 步还没有简历正文。"; return; }
  const body = AI_BODY || aiBuildBody();
  stat.textContent = "已发送，等待模型返回（思考模型可能需要几十秒）…";
  const t0 = Date.now();
  try {
    const r = await fetch(AICFG.endpoint + "/v1/chat/completions",
      { method: "POST", headers: aiHeaders(), body: JSON.stringify(body) });
    if (!r.ok) throw new Error("HTTP " + r.status + " " + (await r.text()).slice(0, 200));
    const d = await r.json();
    const msg = (d.choices && d.choices[0] && d.choices[0].message) || {};
    AI_RAW = msg.content || "";
    let parsed;
    try { parsed = JSON.parse(AI_RAW); }
    catch (e) {
      const m = AI_RAW.match(/\{[\s\S]*\}/);          // tolerate fences or stray prose
      if (!m) throw new Error(AI_RAW
        ? "模型返回的不是 JSON（finish_reason=" + (d.choices[0].finish_reason || "?") + "）"
        : "模型返回了空内容（finish_reason=" + (d.choices[0].finish_reason || "?") +
          "，思考模型可能把 token 用在了推理上，可提高 max_tokens）");
      parsed = JSON.parse(m[0]);
    }
    AI_RESULT = parsed;
    stat.textContent = `完成，用时 ${((Date.now() - t0) / 1000).toFixed(1)} 秒` +
      (d.usage ? `，${d.usage.completion_tokens} tokens` : "") + "。";
    aiShowRaw(AI_RAW, msg.reasoning_content || "");
    aiRenderResult(parsed);
  } catch (e) {
    // A network-level failure surfaces as a bare "Failed to fetch" with no
    // detail available to script, so spell out what actually causes it.
    stat.textContent = e instanceof TypeError
      ? `连不上端点（${e.message}）。常见原因：` +
        (location.protocol === "https:"
          ? "① 本页是 https，调不了 http 端点——请在本机用 http 打开本站；"
          : "① 端点地址写错，或服务没在跑；") +
        "② 服务未允许跨域（需回 Access-Control-Allow-Origin）；" +
        "③ 服务正忙于上一次生成，槽位占满时新连接会被直接拒绝——等它跑完再试。"
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

function aiRenderResult(x) {
  $ai("aiResultCard").hidden = false;

  const titles = (x.jobTitles || []).join("、") || "（未识别到职位名）";
  const duties = (x.keyDuties || []).join(" · ");
  $ai("aiRead").textContent =
    `简历里的职位：${titles}` +
    (x.fieldOfStudy ? `　专业：${x.fieldOfStudy}` : "") +
    (duties ? `\n关键职责：${duties}` : "");

  // Rank by the model's own ordering, but only ever offer occupations that
  // exist in the SkillSelect index -- a hallucinated title is worse than none.
  const idx = (typeof window !== "undefined" && window.OCC_INDEX) || [];
  const seen = new Set(), out = [];
  const addByCode = (code, why) => {
    const o = idx.find(o => o.code === code);
    if (o && !seen.has(o.code)) { seen.add(o.code); out.push({ o, why, how: "代码精确匹配" }); }
    return !!o;
  };
  const addByName = (name, why) => {
    const words = String(name || "").toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 3);
    if (!words.length) return;
    const scored = idx.map(o => {
      const n = o.name.toLowerCase();
      const hit = words.filter(w => n.includes(w));
      return { o, all: hit.length === words.length,
               sc: hit.reduce((a, w) => a + w.length, 0) };
    }).filter(r => r.sc > 0);
    // "Software Engineer" partially matches every ...Engineer in the list, so
    // prefer entries containing every word; only fall back to a single best
    // partial match when nothing matches in full.
    const full = scored.filter(r => r.all).sort((a, b) => b.sc - a.sc);
    const pick = full.length ? full.slice(0, 2) : scored.sort((a, b) => b.sc - a.sc).slice(0, 1);
    pick.forEach(({ o, all }) => {
      if (!seen.has(o.code)) {
        seen.add(o.code);
        out.push({ o, why, how: all ? "名称完全匹配" : "名称部分匹配" });
      }
    });
  };
  (x.candidates || []).forEach(c => {
    const code = /^\d{6}$/.test(c.code || "") ? c.code : null;
    if (!(code && addByCode(code, c.why))) addByName(c.name, c.why);
  });

  const note = $ai("aiOccNote"), list = $ai("aiOccList");
  list.textContent = "";
  if (!out.length) {
    note.textContent = "没有匹配到 SkillSelect 清单里的职业。模型给出的名称是：" +
      ((x.candidates || []).map(c => c.name).join("、") || "（无）") +
      "。可以到「职业数据查询」页用搜索框自己找。";
    return;
  }
  note.textContent = `以下 ${out.length} 个候选都来自 SkillSelect 的 492 个在册职业` +
    "（模型给的名字如果不在清单里会被丢弃）。点一个即可跳到该职业的数据页——" +
    "最终以职业评估机构的判定为准。";
  out.slice(0, 6).forEach(({ o, why, how }) => {
    const row = document.createElement("div"); row.className = "occrow";
    const b = document.createElement("button");
    b.type = "button"; b.className = "tblbtn nt";
    b.textContent = `${o.name}　在池 ${fmt(o.pool)}`;
    b.addEventListener("click", () => { location.hash = "#/data/" + o.code; });
    const r = document.createElement("span"); r.className = "occwhy";
    r.textContent = (why || "") + `（${how}）`;
    row.append(b, r); list.appendChild(row);
  });
}

function aiInit() {
  if ($ai("aiEndpoint") && $ai("aiEndpoint").dataset.wired) return;
  aiLoadCfg(); aiEnvCheck();
  ["aiEndpoint", "aiModel", "aiKey"].forEach(id => {
    const el = $ai(id); if (!el) return;
    el.dataset.wired = "1";
    el.addEventListener("change", () => { aiSaveCfg(); aiEnvCheck(); });
  });
  $ai("aiTest").addEventListener("click", aiTest);
  $ai("aiForget").addEventListener("click", () => {
    try { localStorage.removeItem(AI_KEY); } catch (e) {}
    AICFG = { endpoint: "", model: "", key: "" };
    ["aiEndpoint", "aiModel", "aiKey"].forEach(id => { const e = $ai(id); if (e) e.value = ""; });
    $ai("aiTestOut").textContent = "已清除。";
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
  $ai("aiSend").addEventListener("click", aiSend);
}
