/* ---------- 动态 (official updates) ----------
   A dated feed of official changes from data/news.json: Home Affairs, the
   Federal Register of Legislation and state migration agencies only. Each item
   carries the official sentence it rests on, a link and the date it was
   checked. Items marked "review" were read by the owner before publishing;
   drafts never reach site/ (they sit in data/news_drafts.json).
*/
const NW = { data: null, f: "all", seenKey: "immi.news.seen" };
const NW_TYPES = { round: "邀请与排队", proc: "处理进度", law: "政策法规", state: "州担保" };
const nwEsc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
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
  const v = nwEsc(c);
  if (c === "0") return `<td class="nw-zero">0</td>`;
  const m = String(c).split(" → ");
  return m.length === 2 ? `<td><span class="nw-from">${nwEsc(m[0])} →</span> <b class="nw-moved">${nwEsc(m[1])}</b></td>` : `<td>${v}</td>`;
}

function nwItem(it) {
  const tbl = it.table ? `<div class="nw-tbl"><table><tr>${it.table.head.map(h => `<th>${nwEsc(h)}</th>`).join("")}</tr>${
    it.table.rows.map(r => `<tr>${r.map(nwCell).join("")}</tr>`).join("")}</table></div>` : "";
  return `<article class="nw-item" data-t="${it.type}">
    <div class="nw-meta"><span class="nw-type nw-${it.type}">${NW_TYPES[it.type]}</span>${
      it.effective ? `<span class="nw-due">${nwDue(it.effective)}</span>` : ""}<span>${nwEsc(it.tag || "")}</span></div>
    <h3>${nwEsc(it.title)}</h3>
    ${it.who ? `<p class="nw-who"><b>影响谁</b>${nwEsc(it.who)}</p>` : ""}
    <ul>${it.points.map(p => `<li>${nwEsc(p)}</li>`).join("")}</ul>
    ${tbl}
    ${it.quote ? `<details class="nw-q"><summary>官方原文</summary><blockquote>${nwEsc(it.quote)}</blockquote></details>` : ""}
    ${it.go ? `<a class="nw-go" href="${nwEsc(it.go.hash)}"${it.go.boardMode ? ` data-mode="${nwEsc(it.go.boardMode)}"` : ""}>${nwEsc(it.go.label)}</a>` : ""}
    <div class="nw-foot"><span>${nwEsc(it.src.name)}</span><a href="${nwEsc(it.src.url)}" target="_blank" rel="noopener">原文 ↗</a><span>查阅 ${nwDay(it.checked)}</span><span class="nw-how nw-${it.how}">${
      it.how === "auto" ? "数字照官方表格自动更新" : "已人工核对"}</span></div>
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
  const items = NW.data.items.filter(it => NW.f === "all" || it.type === NW.f);
  let last = null, out = "";
  items.forEach(it => {
    if (it.date !== last) { out += `<div class="nw-day">${nwDay(it.date)}</div>`; last = it.date; }
    out += nwItem(it);
  });
  box.innerHTML = out || `<p class="nw-empty">这一类还没有动态。</p>`;
  document.querySelectorAll("#nwFilters button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.f === NW.f)));
  try { if (NW.data.items[0]) localStorage.setItem(NW.seenKey, NW.data.items[0].id); } catch (e) {}
  const dot = document.querySelector('#tabs .nw-dot'); if (dot) dot.remove();
}

function nwInit() {
  const f = document.getElementById("nwFilters");
  if (f && !f.dataset.wired) {
    f.dataset.wired = "1";
    f.innerHTML = [["all", "全部"]].concat(Object.entries(NW_TYPES)).map(([k, l]) =>
      `<button type="button" data-f="${k}" aria-pressed="${k === NW.f}">${l}</button>`).join("");
    f.addEventListener("click", e => { const b = e.target.closest("button"); if (b) { NW.f = b.dataset.f; nwRender(); } });
  }
  // a link into 行情 can ask for a board mode (e.g. 邀请轮次): remember it for
  // the board's first wiring, and switch now if the board is already wired
  const list = document.getElementById("nwList");
  if (list && !list.dataset.wired) {
    list.dataset.wired = "1";
    list.addEventListener("click", e => {
      const a = e.target.closest(".nw-go[data-mode]"); if (!a) return;
      try { localStorage.setItem(HM_MODE_KEY, a.dataset.mode); } catch (err) {}
      setTimeout(() => { if (typeof HM !== "undefined" && HM.wired) lbMode(a.dataset.mode); }, 0);
    });
  }
  nwDot();
}
