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

/* ---------- the request ---------- */
const AI_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["birthYear", "englishTests", "employment", "education", "partner",
             "professionalYear", "naatiCredential", "regionalStudy",
             "specialistEducation", "anzscoGuess", "evidence"],
  properties: {
    birthYear: { type: ["integer", "null"] },
    englishTests: { type: "array", items: { type: "object", additionalProperties: false,
      required: ["test", "overall"],
      properties: { test: { type: "string", enum: ["IELTS", "PTE", "TOEFL", "CAE", "OET", "other"] },
                    overall: { type: ["number", "null"] } } } },
    employment: { type: "array", items: { type: "object", additionalProperties: false,
      required: ["title", "start", "end", "country", "countryEvidence", "relatedToMainOccupation"],
      properties: {
        title: { type: "string" },
        start: { type: ["string", "null"] },            // "YYYY-MM"
        end:   { type: ["string", "null"] },            // "YYYY-MM" or "present"
        country: { type: "string", enum: ["australia", "overseas", "unknown"] },
        countryEvidence: { type: "string" },
        relatedToMainOccupation: { type: ["boolean", "null"] } } } },
    education: { type: "array", items: { type: "object", additionalProperties: false,
      required: ["level", "country", "countryEvidence", "start", "end"],
      properties: {
        level: { type: "string", enum: ["doctorate", "masters", "bachelor", "diploma", "trade", "other"] },
        country: { type: "string", enum: ["australia", "overseas", "unknown"] },
        countryEvidence: { type: "string" },
        start: { type: ["string", "null"] }, end: { type: ["string", "null"] } } } },
    partner: { type: "object", additionalProperties: false,
      required: ["hasPartner", "partnerIsAuPrOrCitizen", "partnerHasSkillsAssessment", "partnerCompetentEnglish"],
      properties: { hasPartner: { type: ["boolean", "null"] },
                    partnerIsAuPrOrCitizen: { type: ["boolean", "null"] },
                    partnerHasSkillsAssessment: { type: ["boolean", "null"] },
                    partnerCompetentEnglish: { type: ["boolean", "null"] } } },
    professionalYear: { type: ["boolean", "null"] },
    naatiCredential: { type: ["boolean", "null"] },
    regionalStudy: { type: ["boolean", "null"] },
    specialistEducation: { type: ["boolean", "null"] },
    anzscoGuess: { type: "object", additionalProperties: false, required: ["name"],
      properties: { name: { type: "string" }, code: { type: ["string", "null"] } } },
    evidence: { type: "object", additionalProperties: true },
  },
};

const AI_SYSTEM =
  "你是一个简历信息抽取器。只输出 JSON，不要解释。\n" +
  "核心规则：只记录简历中**写出来的**信息，原样填写。所有计算由调用方完成，你不要算。\n" +
  "- birthYear：出生年份四位数。**不要算年龄。**没写填 null。\n" +
  "- englishTests：考试名与总分原值。**不要判断属于哪个英语等级。**\n" +
  "- employment / education 的 country 指这段经历**发生在哪个国家**，不是申请目标国。\n" +
  "  澳洲以外的任何国家（中国、印度、英国……）一律填 overseas。\n" +
  "  只有简历明确说明在澳洲境内工作或就读时才填 australia。看不出来填 unknown。\n" +
  "  countryEvidence 必须引用你据以判断国别的原文；引不出原文就填空字符串。\n" +
  "  注意：配偶是澳洲 PR、或本人正在申请澳洲签证，都**不能**说明本人在澳洲工作或学习过。\n" +
  "- start / end 用 \"YYYY-MM\"，在职写 \"present\"。**不要算工作了多少个月或多少年。**\n" +
  "- education：每段学历一条，level 取最接近的层次。\n" +
  "- partner：分别回答有无配偶、配偶是否澳洲 PR/公民、配偶是否有职业评估、配偶是否有 competent English。\n" +
  "- 其余布尔字段没有明确证据时填 null，不要猜 false。\n" +
  "- anzscoGuess.name 填最贴近的澳洲 ANZSCO 职业**英文名**；code 不确定填 null，不要填 \"unknown\"。\n" +
  "- evidence：为每个非空字段附简历原文片段（20 字以内）。";

function aiBuildBody() {
  const raw = $ai("aiRaw").value || "";
  const { text, summary } = aiRedact(raw);
  $ai("aiRedactStat").textContent =
    `原文 ${raw.length} 字，脱敏后 ${text.length} 字。本地移除：${summary}。`;
  AI_BODY = {
    model: AICFG.model || "",
    max_tokens: 6000,
    temperature: 0.2,
    response_format: { type: "json_schema",
      json_schema: { name: "cv_extract", strict: true, schema: AI_SCHEMA } },
    messages: [{ role: "system", content: AI_SYSTEM },
               { role: "user", content: text }],
  };
  const pre = document.createElement("pre");
  pre.style.cssText = "white-space:pre-wrap;word-break:break-word;font-size:11.5px;margin:0;padding:10px";
  pre.textContent = JSON.stringify(AI_BODY, null, 2);
  const w = $ai("aiBody"); w.textContent = ""; w.appendChild(pre); w.classList.add("on");
  const btn = document.querySelector('[data-t="aiBody"]');
  if (btn) btn.textContent = "收起完整请求体";
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
      (d.usage ? `，${d.usage.completion_tokens} tokens` : "") + "。请核对第 4 步的每一行。";
    aiShowRaw(AI_RAW, msg.reasoning_content || "");
    aiRenderResult(parsed);
  } catch (e) {
    stat.textContent = "失败：" + e.message;
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

/* ---------- every conversion below is local and checkable ---------- */
// English thresholds live in a ministerial instrument, not Schedule 6D, so the
// mapped level is presented as a suggestion the user confirms.
const ENGLISH_TABLE = {
  IELTS: [[8, 2], [7, 1], [6, 0]],      // [minimum overall, calculator option index]
  PTE:   [[79, 2], [65, 1], [50, 0]],
  TOEFL: [[94, 2], [79, 1], [60, 0]],
  CAE:   [[200, 2], [185, 1], [169, 0]],
};
function aiEnglishIdx(tests) {
  let best = 0, note = "简历未见英语成绩，按 Competent 处理";
  (tests || []).forEach(t => {
    const tbl = ENGLISH_TABLE[t.test];
    if (!tbl || t.overall == null) return;
    for (const [min, idx] of tbl) {
      if (t.overall >= min) {
        if (idx >= best) { best = idx; note = `${t.test} ${t.overall} → 本地按分数换算`; }
        break;
      }
    }
  });
  return { idx: best, note };
}

/* the model only ever reports start/end; the arithmetic is here */
const ymToMonths = v => {
  if (!v) return null;
  if (/^present$/i.test(v) || /至今|现在/.test(v)) {
    const n = new Date(); return n.getFullYear() * 12 + n.getMonth();
  }
  const m = String(v).match(/(\d{4})\D*(\d{1,2})?/);
  if (!m) return null;
  return (+m[1]) * 12 + (m[2] ? +m[2] - 1 : 0);
};
function aiWorkMonths(employment) {
  // Schedule 6D.3/6D.4 count only the 10 years before the invitation
  const now = new Date(), cutoff = now.getFullYear() * 12 + now.getMonth() - 120;
  const acc = { australia: 0, overseas: 0, unknown: 0 }, spans = [];
  (employment || []).forEach(e => {
    if (e.relatedToMainOccupation === false) return;   // null counts, false does not
    let a = ymToMonths(e.start), b = ymToMonths(e.end);
    if (a == null) return;
    if (b == null) b = now.getFullYear() * 12 + now.getMonth();
    a = Math.max(a, cutoff);
    const n = Math.max(0, b - a);
    acc[e.country in acc ? e.country : "unknown"] += n;
    spans.push(`${e.title || "?"} ${e.start || "?"}~${e.end || "至今"} ${n} 个月`);
  });
  return { au: acc.australia, os: acc.overseas + acc.unknown, spans,
           hasUnknown: acc.unknown > 0 };
}
const bracket = (months, cuts) => {
  let i = 0;
  cuts.forEach((c, k) => { if (months >= c) i = k + 1; });
  return i;
};

function aiMap(x) {
  const rows = [], set = {};
  const ev = k => (x.evidence && x.evidence[k]) ? String(x.evidence[k]).slice(0, 40) : "—";
  const push = (key, label, idx, note, evidence) => {
    set[key] = idx;
    const f = RULES.fields.find(f => f.key === key);
    rows.push([label, f ? f.options[idx].t : "-", note, evidence || "—"]);
  };

  // age -- computed here from a birth year, never taken from the model
  let ageIdx = 0, ageNote = "简历未见出生年份，按 0 分处理";
  if (x.birthYear) {
    const age = new Date().getFullYear() - x.birthYear;
    ageIdx = age >= 18 && age < 25 ? 1 : age >= 25 && age < 33 ? 2
           : age >= 33 && age < 40 ? 3 : age >= 40 && age < 45 ? 4 : 0;
    ageNote = `${x.birthYear} 年生 → 约 ${age} 岁（本地计算；法规按收到邀请时的年龄）`;
  }
  push("age", "年龄", ageIdx, ageNote, ev("birthYear"));

  const en = aiEnglishIdx(x.englishTests);
  push("english", "英语能力", en.idx,
       en.note + "　※等级门槛出自部长令而非 Schedule 6D，请自行核对", ev("englishTests"));

  const w = aiWorkMonths(x.employment);
  const cn = { australia: "澳洲", overseas: "海外", unknown: "国别未知" };
  const empEv = (x.employment || []).map(e =>
    `${e.title || "?"}（${cn[e.country] || "?"}${e.countryEvidence ? "：" + e.countryEvidence : "：无原文依据"}）`)
    .join("；").slice(0, 80) || ev("employment");
  push("expOs", "海外技术工作经验", bracket(w.os, [36, 60, 96]),
       `本地按起止日期累计 ${w.os} 个月（只计近 10 年）` + (w.hasUnknown ? "；国别未知的按海外计" : ""),
       empEv);
  push("expAu", "澳洲技术工作经验", bracket(w.au, [12, 36, 60, 96]),
       `本地累计 ${w.au} 个月（只计近 10 年）`, empEv);

  // highest qualification wins; 6D71-75 do not stack
  const rank = { doctorate: 4, masters: 3, bachelor: 3, diploma: 2, trade: 2, other: 1 };
  let bestEdu = null;
  (x.education || []).forEach(e => {
    if (!bestEdu || (rank[e.level] || 0) > (rank[bestEdu.level] || 0)) bestEdu = e;
  });
  let eduIdx = 0, eduNote = "简历未见学历";
  if (bestEdu) {
    const inAu = bestEdu.country === "australia";
    eduIdx = bestEdu.level === "doctorate" ? 1
           : (bestEdu.level === "masters" || bestEdu.level === "bachelor") ? 2
           : (bestEdu.level === "diploma" || bestEdu.level === "trade") ? (inAu ? 3 : 4) : 4;
    eduNote = `最高学历 ${bestEdu.level}${inAu ? "（澳洲）" : bestEdu.country === "overseas" ? "（海外）" : "（国别未知）"}` +
              " → Schedule 6D.7 取最高一项，不叠加";
  }
  push("edu", "学历", eduIdx, eduNote,
       bestEdu ? `${bestEdu.level}（${cn[bestEdu.country] || "?"}${bestEdu.countryEvidence ? "：" + bestEdu.countryEvidence : "：无原文依据"}）`
               : ev("education"));

  // Australian study requirement: roughly two academic years of study in Australia
  let auStudyMonths = 0;
  (x.education || []).forEach(e => {
    if (e.country !== "australia") return;
    const a = ymToMonths(e.start), b = ymToMonths(e.end);
    if (a != null && b != null) auStudyMonths += Math.max(0, b - a);
  });
  push("auStudy", "澳洲学习要求", auStudyMonths >= 16 ? 1 : 0,
       auStudyMonths ? `澳洲学习约 ${auStudyMonths} 个月（要求约 2 学年 / 16 个月）`
                     : "简历未见澳洲学历，按不满足处理", ev("education"));

  push("spec", "专业教育资格", x.specialistEducation === true ? 1 : 0,
       x.specialistEducation == null ? "简历未提及，按无处理" : "", ev("specialistEducation"));
  push("py", "职业年", x.professionalYear === true ? 1 : 0,
       x.professionalYear == null ? "简历未提及" : "", ev("professionalYear"));
  push("lang", "社区语言", x.naatiCredential === true ? 1 : 0,
       x.naatiCredential == null ? "简历未提及" : "", ev("naatiCredential"));
  push("regional", "偏远地区学习", x.regionalStudy === true ? 1 : 0,
       x.regionalStudy == null ? "简历未提及" : "", ev("regionalStudy"));

  // 6D111 / 6D112 / 6D113 are mutually exclusive
  const p = x.partner || {};
  let pIdx = 0, pNote = "简历未提及配偶情况，按不加分处理";
  if (p.hasPartner === false) { pIdx = 1; pNote = "单身 → 6D112"; }
  else if (p.partnerIsAuPrOrCitizen === true) { pIdx = 1; pNote = "配偶是澳洲 PR / 公民 → 6D112"; }
  else if (p.partnerHasSkillsAssessment === true && p.partnerCompetentEnglish === true) {
    pIdx = 2; pNote = "配偶有职业评估且 competent English → 6D111"; }
  else if (p.partnerCompetentEnglish === true) { pIdx = 3; pNote = "配偶有 competent English → 6D113"; }
  else if (p.hasPartner === true) { pNote = "有配偶但未见符合条件的证据，按 0 分处理"; }
  push("partner", "配偶情况", pIdx, pNote, ev("partner"));

  return { rows, set };
}

function aiRenderResult(x) {
  const { rows } = aiMap(x);
  $ai("aiResultCard").hidden = false;
  table("aiFields", ["项目", "本地换算结果", "换算依据", "简历原文（模型引用）"], rows);

  // occupation candidates: matched locally against the site's own index
  const list = $ai("aiOccList"); list.textContent = "";
  const guess = ((x.anzscoGuess && x.anzscoGuess.name) || "") + " " +
    (x.employment || []).map(e => e.title || "").join(" ");
  const idx = (typeof window !== "undefined" && window.OCC_INDEX) || [];
  // ANZSCO titles are English, so latin tokens carry the signal; keep short
  // ones like "ict" too
  const words = guess.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 3);
  const scored = idx.map(o => {
    const n = o.name.toLowerCase();
    let sc = words.reduce((a, w) => a + (n.includes(w) ? w.length : 0), 0);
    const gc = x.anzscoGuess && /^\d{6}$/.test(x.anzscoGuess.code || "") ? x.anzscoGuess.code : null;
    if (gc && o.code === gc) sc += 100;
    return { o, sc };
  }).filter(r => r.sc > 0).sort((a, b) => b.sc - a.sc).slice(0, 6);

  const head = $ai("aiOccHead"), note = $ai("aiOccNote");
  head.hidden = note.hidden = false;
  note.textContent = `模型的猜测是「${(x.anzscoGuess && x.anzscoGuess.name) || "未给出"}」` +
    (x.anzscoGuess && x.anzscoGuess.code ? `（${x.anzscoGuess.code}）` : "") +
    "。以下候选由本地在 ANZSCO 清单里匹配得出，仅供参考——以职业评估机构的判定为准。";
  if (!scored.length) {
    note.textContent += " 本地没有匹配到候选。";
  }
  scored.forEach(({ o }) => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "tblbtn nt";
    b.textContent = `${o.name}（在池 ${fmt(o.pool)}）`;
    b.addEventListener("click", () => { location.hash = "#/data/" + o.code; });
    list.appendChild(b);
  });
}

function aiApplyToCalc() {
  if (!AI_RESULT) return;
  const { set } = aiMap(AI_RESULT);
  Object.assign(CALC, set);
  RULES.fields.forEach(f => {
    const sel = $ai("c_" + f.key);
    if (sel) sel.value = CALC[f.key] | 0;
  });
  renderCalc();
  setView("points");
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
  $ai("aiPrep").addEventListener("click", aiBuildBody);
  $ai("aiSend").addEventListener("click", aiSend);
  $ai("aiApply").addEventListener("click", aiApplyToCalc);
}
