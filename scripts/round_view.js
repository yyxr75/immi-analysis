/* ---------- 邀请轮次 ----------
   Per-round, per-occupation 189 invitations from data/round_occ.json
   (scripts/extract_rounds_occ.py): how many EOIs each occupation had invited
   in each round and at which scores. Counts are rebuilt from the EOI
   dashboard's status dates; the minimum score is the official one when Home
   Affairs published a table for that round. Used by 行情 → 邀请轮次 and by the
   occupation card in 自选. */
const RD = { data: null, loading: null, day: null, sort: "most", q: "" };
const rdFmt = n => n.toLocaleString("en-US");
const rdEsc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const rdDay = d => d.replace(/^(\d+)-0?(\d+)-0?(\d+)$/, "$1年$2月$3日");
const rdTb = t => !t ? "—" : /^\d{4}-\d{2}-\d{2}$/.test(t) ? rdDay(t) : /^\d{2}\/\d{4}$/.test(t) ? t.replace(/^0?(\d+)\/(\d+)$/, "$2年$1月") : t;

function rdLoad() {
  if (!RD.loading)
    RD.loading = Promise.all([
      fetch("data/round_occ.json", { cache: "no-cache" }).then(r => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); }),
      fetch("data/occupations.json", { cache: "force-cache" }).then(r => r.json()),
    ]).then(([d, index]) => {
        RD.names = {}; index.forEach(o => { RD.names[o.code] = o; });
        RD.data = d; RD.day = RD.day || (d.rounds.length ? d.rounds[d.rounds.length - 1].date : null); return d; })
      .catch(e => { RD.loading = null; throw e; });
  return RD.loading;
}

/* score distribution: "80分 1,158 · 85分 381 · 75分 122" (largest first) */
function rdDist(dist, top = 3) {
  const e = Object.entries(dist).sort((a, b) => b[1] - a[1]);
  return e.slice(0, top).map(([s, n]) => `${s}分 ${rdFmt(n)}`).join(" · ") + (e.length > top ? " …" : "");
}

/* stacked bar of one occupation's invitees by score, low score on the left */
function rdBar(dist) {
  const e = Object.entries(dist).map(([s, n]) => [+s, n]).sort((a, b) => a[0] - b[0]);
  const tot = e.reduce((a, x) => a + x[1], 0);
  return `<span class="rd-bar" aria-hidden="true">` + e.map(([s, n]) =>
    `<i style="flex:${n};--k:${Math.max(0, Math.min(1, (s - 60) / 45)).toFixed(2)}" title="${s}分 ${rdFmt(n)}"></i>`).join("") +
    `</span>`;
}

/* occupation card (自选): every 189 round, this occupation's invitees */
function rdOccHtml(code) {
  const D = RD.data;
  if (!D || !D.rounds.length) return "";
  const mine = {};
  (D.occ[code] || []).forEach(x => { mine[x[0]] = x; });
  const rows = D.rounds.slice().reverse().map(r => {
    const x = mine[r.date];
    if (!x) return `<tr><td>${rdDay(r.date)}</td><td class="num z">0</td><td class="num">—</td><td class="d">${r.official ? "官方表里没有这个职业：这一轮没邀请" : "没有统计到邀请"}</td></tr>`;
    return `<tr><td>${rdDay(r.date)}</td><td class="num"><b>${rdFmt(x[1])}</b></td><td class="num">${x[3]} 分${r.official ? "" : "*"}</td><td class="d">${rdBar(x[2])}<small>${rdDist(x[2])}</small></td></tr>`;
  }).join("");
  return `<div class="rd-occ"><p class="k">历次 189 邀请：这个职业邀请了多少人、什么分数</p>
    <table><thead><tr><th>轮次</th><th class="num">获邀人数</th><th class="num">最低分</th><th>分数分布</th></tr></thead><tbody>${rows}</tbody></table>
    <p class="n">获邀人数由 SkillSelect 看板里每个 EOI 的状态日期还原，和官方总数对得上 96% 以上，个别人可能漏计。最低分来自移民局官网公布的轮次表${D.rounds.some(r => !r.official) ? "，带 * 的轮次官网表没存档，最低分是按统计结果推算" : ""}。历史结果，不代表下一轮。</p></div>`;
}

/* 行情 → 邀请轮次 */
const RD_SORTS = {
  most: ["获邀人数最多", (a, b) => b[1] - a[1] || b[3] - a[3]],
  least: ["获邀人数最少", (a, b) => a[1] - b[1] || b[3] - a[3]],
  hi: ["最低分最高", (a, b) => b[3] - a[3] || a[1] - b[1]],
  lo: ["最低分最低", (a, b) => a[3] - b[3] || b[1] - a[1]],
};

function rdRender() {
  const box = document.getElementById("lbRound");
  if (!box) return;
  if (!RD.data) {
    box.querySelector(".rd-list").innerHTML = `<p class="lb-cav">载入中…</p>`;
    rdLoad().then(rdRender).catch(e => {
      box.querySelector(".rd-list").innerHTML = `<p class="lb-cav">邀请数据载入失败：${rdEsc(e.message)}。刷新页面重试。</p>`; });
    return;
  }
  const D = RD.data, r = D.rounds.find(x => x.date === RD.day) || D.rounds[D.rounds.length - 1];
  const names = RD.names;
  const rows = Object.entries(D.occ).map(([c, v]) => { const x = v.find(y => y[0] === r.date); return x && [c, x[1], x[2], x[3]]; })
    .filter(Boolean);
  const q = RD.q.trim().toLowerCase();
  const nm = c => { const o = names[c]; return o ? { zh: (o.zh && o.zh[0]) || "", en: o.name.replace(/^\d+ /, "") } : { zh: "", en: "" }; };
  const shown = rows.filter(([c]) => !q || c.includes(q) || (nm(c).zh + " " + nm(c).en + " " + ((names[c] && names[c].zh) || []).join(" ")).toLowerCase().includes(q))
    .sort(RD_SORTS[RD.sort][1]);

  box.querySelector(".rd-days").innerHTML = D.rounds.slice().reverse().map(x =>
    `<button type="button" data-d="${x.date}" aria-pressed="${x.date === r.date}">${rdDay(x.date)}</button>`).join("");
  box.querySelector(".lb-tape").innerHTML =
    `<div><span>官方邀请总数</span><b>${r.invitedOfficial == null ? "未存档" : rdFmt(r.invitedOfficial)}</b></div>
     <div><span>按职业统计到</span><b>${rdFmt(r.counted)}${r.invitedOfficial ? `<small> ${Math.round(r.counted / r.invitedOfficial * 100)}%</small>` : ""}</b></div>
     <div><span>获邀职业数</span><b>${rows.length}</b></div>
     <div><span>同分 tie break 到</span><b>${rdTb(r.tieBreak)}</b></div>`;
  box.querySelector(".rd-sort").innerHTML = Object.entries(RD_SORTS).map(([k, s]) =>
    `<button type="button" data-s="${k}" aria-pressed="${k === RD.sort}">${s[0]}</button>`).join("");
  box.querySelector(".rd-list").innerHTML = shown.length ? shown.map(([c, n, dist, lo], i) => {
    const o = nm(c);
    return `<a class="lb-row rd-row" href="#/watch/${c}">
      <span class="lb-rk">${i + 1}</span>
      <span class="lb-nm"><b>${rdEsc(o.zh || o.en || c)}</b><small>${c} ${rdEsc(o.en)}</small></span>
      <span class="rd-mid">${rdBar(dist)}<small>${rdDist(dist)}</small></span>
      <span class="lb-val"><b>${rdFmt(n)} 人</b><small>最低 ${lo} 分${r.official ? "" : "*"}</small></span></a>`;
  }).join("") : `<p class="lb-cav">${q ? "没有找到这个职业：这一轮可能没有邀请它。" : "这一轮没有数据。"}</p>`;
  box.querySelector(".rd-note").textContent = r.official
    ? `${rdDay(r.date)}这一轮官网表列出 ${rows.length} 个职业。不在这里的职业，这一轮没有发 189 邀请。`
    : `${rdDay(r.date)}这一轮官网表没有存档，带 * 的最低分按统计结果推算（去掉了零星记录）。`;
}

function rdWire() {
  const box = document.getElementById("lbRound");
  if (!box || RD.wired) return;
  RD.wired = true;
  box.querySelector(".rd-days").addEventListener("click", e => {
    const b = e.target.closest("button"); if (b) { RD.day = b.dataset.d; rdRender(); } });
  box.querySelector(".rd-sort").addEventListener("click", e => {
    const b = e.target.closest("button"); if (b) { RD.sort = b.dataset.s; rdRender(); } });
  box.querySelector(".rd-q").addEventListener("input", e => { RD.q = e.target.value; rdRender(); });
  box.querySelector(".rd-list").addEventListener("click", e => {
    const a = e.target.closest(".lb-row");
    if (a && typeof reportLook === "function") reportLook(a.getAttribute("href").slice(-6), "pick");
  });
}
