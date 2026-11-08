/* ---------- 动态 (official updates) ----------
   A dated feed of official changes from data/news.json: Home Affairs, the
   Federal Register of Legislation and state migration agencies only. The list
   shows a card per item; #/news/<id> opens the item: a Chinese summary, the
   official text paragraph by paragraph with its Chinese translation, and the
   source links last. Items marked "review" were read by the owner before
   publishing; drafts never reach site/ (they sit in data/news_drafts.json).
*/
const NW = { data: null, f: "all", open: null, seenKey: "immi.news.seen" };
const NW_TYPES = { round: "邀请与排队", proc: "处理进度", law: "政策法规", state: "州担保" };
const nwEsc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const nwBr = s => nwEsc(s).replace(/\n/g, "<br>");
const nwDay = d => { const [, m, x] = d.split("-").map(Number); return `${m}月${x}日`; };

function nwLoad() {
  return fetch("data/news.json", { cache: "no-cache" })
    .then(r => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
    .then(d => { NW.data = d; return d; });
}

// red dot on the tab when there is an item newer than the last one seen
function nwDot() {
  const go = d => {
    const top = d.items[0] && d.items[0].id;
    let seen = null;
    try { seen = localStorage.getItem(NW.seenKey); } catch (e) {}
    const b = document.querySelector('#tabs button[data-v="news"]');
    if (b && top && top !== seen && !b.querySelector(".nw-dot")) {
      const i = document.createElement("i"); i.className = "nw-dot"; i.setAttribute("aria-label", "有新动态"); b.appendChild(i);
    }
  };
  (NW.data ? Promise.resolve(NW.data) : nwLoad()).then(go).catch(() => {});
}

function nwDue(eff) {
  const t = new Date(); t.setHours(0, 0, 0, 0);
  const n = Math.round((new Date(eff + "T00:00:00") - t) / 864e5);
  return n > 0 ? `${n} 天后生效` : n === 0 ? "今天生效" : `${nwDay(eff)}已生效`;
}

function nwCell(c) {
  if (c === "0") return `<td class="nw-zero">0</td>`;
  const m = String(c).split(" → ");
  return m.length === 2 ? `<td><span class="nw-from">${nwEsc(m[0])} →</span> <b class="nw-moved">${nwEsc(m[1])}</b></td>` : `<td>${nwEsc(c)}</td>`;
}
const nwTable = it => it.table ? `<div class="nw-tbl"><table><tr>${it.table.head.map(h => `<th>${nwEsc(h)}</th>`).join("")}</tr>${
  it.table.rows.map(r => `<tr>${r.map(nwCell).join("")}</tr>`).join("")}</table></div>` : "";
const nwMeta = it => `<div class="nw-meta"><span class="nw-type nw-${it.type}">${NW_TYPES[it.type]}</span>${
  it.effective ? `<span class="nw-due">${nwDue(it.effective)}</span>` : ""}<span>${nwEsc(it.tag || "")}</span></div>`;
const nwHow = it => `<span class="nw-how nw-${it.how}">${it.how === "auto" ? "数字照官方表格自动更新" : "译文已对照原文核对"}</span>`;

function nwCard(it) {
  return `<article class="nw-item" data-t="${it.type}">
    ${nwMeta(it)}
    <h3><a href="#/news/${nwEsc(it.id)}">${nwEsc(it.title)}</a></h3>
    ${it.who ? `<p class="nw-who"><b>影响谁</b>${nwEsc(it.who)}</p>` : ""}
    <ul>${it.points.map(p => `<li>${nwEsc(p)}</li>`).join("")}</ul>
    ${nwTable(it)}
    <a class="nw-more" href="#/news/${nwEsc(it.id)}">${it.detail && it.detail.parts.length ? "看全文：中文翻译和官方原文" : "看详情"} →</a>
    <div class="nw-foot"><span>${nwEsc(it.src.name)}</span><span>查阅 ${nwDay(it.checked)}</span>${nwHow(it)}</div>
  </article>`;
}

function nwDetail(it) {
  const d = it.detail || { summary: it.points, parts: [] };
  const links = [it.src].concat(d.more || []);
  return `<article class="nw-page">
    <a class="nw-back" href="#/news">← 返回动态</a>
    ${nwMeta(it)}
    <h2 class="nw-title">${nwEsc(it.title)}</h2>
    <p class="nw-dates">${nwDay(it.date)} · 查阅 ${nwDay(it.checked)} · ${nwHow(it)}</p>
    ${it.who ? `<p class="nw-who"><b>影响谁</b>${nwEsc(it.who)}</p>` : ""}
    <section><h4>中文总结</h4>${d.summary.map(p => `<p class="nw-p">${nwEsc(p)}</p>`).join("")}${nwTable(it)}</section>
    ${d.parts.length ? `<section><h4>官方原文与中文翻译</h4>
      <p class="nw-hint">按段落翻译，每段下面是英文原文。“…”表示省略了与本条无关的部分。</p>
      ${d.parts.map(p => `<div class="nw-pair"><p class="nw-zh">${nwBr(p.zh)}</p><p class="nw-en" lang="en">${nwBr(p.en)}</p></div>`).join("")}
    </section>` : ""}
    ${it.go ? `<a class="nw-go" href="${nwEsc(it.go.hash)}"${it.go.boardMode ? ` data-mode="${nwEsc(it.go.boardMode)}"` : ""}>${nwEsc(it.go.label)}</a>` : ""}
    <section class="nw-srcs"><h4>原文地址</h4>
      ${d.srcNote ? `<p class="nw-hint">${nwEsc(d.srcNote)}</p>` : ""}
      <ul>${links.map(l => `<li><a href="${nwEsc(l.url)}" target="_blank" rel="noopener">${nwEsc(l.name)} ↗</a><small>${nwEsc(l.url)}</small></li>`).join("")}</ul>
    </section>
    <p class="nw-disc">翻译和总结由本站完成，以英文原文为准。不是移民建议；个人情况请咨询注册移民代理（MARA）。</p>
  </article>`;
}

function nwRender() {
  const box = document.getElementById("nwList");
  if (!box) return;
  if (!NW.data) {
    box.innerHTML = `<p class="nw-empty">载入中…</p>`;
    nwLoad().then(nwRender).catch(e => { box.innerHTML = `<p class="nw-empty">动态载入失败：${nwEsc(e.message)}。刷新页面重试。</p>`; });
    return;
  }
  const head = document.getElementById("nwHead");
  const it = NW.open && NW.data.items.find(x => x.id === NW.open);
  if (head) head.hidden = !!it;
  if (it) { box.innerHTML = nwDetail(it); window.scrollTo(0, 0); return; }
  if (NW.open) { NW.open = null; history.replaceState(null, "", "#/news"); }
  const items = NW.data.items.filter(x => NW.f === "all" || x.type === NW.f);
  let last = null, out = "";
  items.forEach(x => {
    if (x.date !== last) { out += `<div class="nw-day">${nwDay(x.date)}</div>`; last = x.date; }
    out += nwCard(x);
  });
  box.innerHTML = out || `<p class="nw-empty">这一类还没有动态。</p>`;
  document.querySelectorAll("#nwFilters button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.f === NW.f)));
  try { if (NW.data.items[0]) localStorage.setItem(NW.seenKey, NW.data.items[0].id); } catch (e) {}
  const dot = document.querySelector("#tabs .nw-dot"); if (dot) dot.remove();
}

function nwInit() {
  const h = parseHash();
  if (h.view === "news") NW.open = h.code;
  const f = document.getElementById("nwFilters");
  if (f && !f.dataset.wired) {
    f.dataset.wired = "1";
    f.innerHTML = [["all", "全部"]].concat(Object.entries(NW_TYPES)).map(([k, l]) =>
      `<button type="button" data-f="${k}" aria-pressed="${k === NW.f}">${l}</button>`).join("");
    f.addEventListener("click", e => { const b = e.target.closest("button"); if (b) { NW.f = b.dataset.f; nwRender(); } });
  }
  const list = document.getElementById("nwList");
  if (list && !list.dataset.wired) {
    list.dataset.wired = "1";
    list.addEventListener("click", e => {
      // the whole card opens the item, not only its title and "看全文" link
      const card = e.target.closest(".nw-item");
      if (card && !e.target.closest("a")) { const a = card.querySelector(".nw-more"); if (a) location.hash = a.getAttribute("href"); return; }
      // a link into 行情 can ask for a board mode (e.g. 邀请轮次): remember it for
      // the board's first wiring, and switch now if the board is already wired
      const g = e.target.closest(".nw-go[data-mode]"); if (!g) return;
      try { localStorage.setItem(HM_MODE_KEY, g.dataset.mode); } catch (err) {}
      setTimeout(() => { if (typeof HM !== "undefined" && HM.wired) lbMode(g.dataset.mode); }, 0);
    });
  }
  nwDot();
}
