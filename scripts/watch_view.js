/* ---------- 自选职业：the home view ----------
   Left: the visitor's watchlist. Centre: one occupation's pool, invited-status
   and points-percentile series on a shared month axis. Right: the current pool
   by points band, with each band's historical invite rate.

   The stock-terminal layout is borrowed; the stock vocabulary is not. There is
   no "price", "volume" or "gain" here, because readers map those words onto a
   forecast of their own odds, and none of these series is one.

   The visitor's own score runs through the whole view. For 190 and 491 the
   state nomination points (+5 / +15) are added before any lookup -- comparing
   a bare 189 score against the 190 pool would understate every rate.

   Storage: localStorage always; when signed in, also the account (/me/prefs),
   so the list follows them across devices. */
const WT_KEY = "immi.watch.v1";
const WT_DEFAULT = ["261313", "221111", "233211", "241111", "254499", "233411"];
const WT_MIN_N = 30;                       // fewer than this in a band: "数据不足"
const WT_VISA = { "189": "189", "190": "190", "491": "491 (州担保)" };
const WT_BONUS = { "189": 0, "190": 5, "491": 15 };
const WT = { visa: "189", me: null, n: 12, sel: null, list: [], example: true, mdet: false,
             hover: null, board: null, index: null, cache: {}, inited: false };

const wt$ = id => document.getElementById(id);
const wtFmt = n => n == null ? "—" : n.toLocaleString("en-US");
const wtEsc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const wtSgn = d => d > 0 ? `+${wtFmt(d)}` : d < 0 ? `−${wtFmt(-d)}` : "0";
const wtCls = d => d > 0 ? "up" : d < 0 ? "down" : "flat";

function wtLoad() {
  try {
    const s = JSON.parse(localStorage.getItem(WT_KEY) || "null");
    if (s && Array.isArray(s.list)) {
      WT.list = s.list; WT.example = !!s.example;
      if (s.me != null) WT.me = s.me;
      if (WT_VISA[s.visa]) WT.visa = s.visa;
    }
  } catch (e) {}
  if (!WT.list.length && WT.example) WT.list = WT_DEFAULT.slice();
}
let wtPushT = null;
function wtSave() {
  try { localStorage.setItem(WT_KEY, JSON.stringify(
    { list: WT.list, me: WT.me, visa: WT.visa, example: WT.example })); } catch (e) {}
  // One write per burst of edits: KV's free tier is 1000 writes a day, shared
  // with every other counter on the Worker.
  clearTimeout(wtPushT);
  wtPushT = setTimeout(wtPush, 1500);
}
const wtApi = p => PUBLIC_PROXY_URL.replace(/\/+$/, "") + p;
async function wtPush() {
  const a = aiAuth(); if (!a || !PUBLIC_PROXY_URL) return;
  try {
    await fetch(wtApi("/me/prefs"), { method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + a.token },
      body: JSON.stringify({ prefs: { list: WT.list, me: WT.me, visa: WT.visa } }) });
  } catch (e) {}
}
async function wtPull() {
  const a = aiAuth(); if (!a || !PUBLIC_PROXY_URL) return;
  try {
    const r = await fetch(wtApi("/me/prefs"), { method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + a.token }, body: "{}" });
    if (r.status === 401) { aiSignOut(); return; }
    const d = await r.json();
    if (d && d.token) {               // renewed: keep signed in without a new code
      try { localStorage.setItem(AUTH_KEY, JSON.stringify(Object.assign({}, a, { token: d.token }))); } catch (e) {}
    }
    const p = d && d.prefs;
    if (p && Array.isArray(p.list)) {
      // First sign-in on a device that already had its own list: keep both.
      // Afterwards the account copy is the truth.
      WT.list = WT.example ? p.list : [...new Set([...p.list, ...WT.list])];
      if (p.me != null) WT.me = p.me;
      if (WT_VISA[p.visa]) WT.visa = p.visa;
      WT.example = false;
    }
    wtSave();
  } catch (e) {}
}

/* The score: what they typed here, else the points page, else nothing. */
function wtBase() {
  if (WT.me != null) return WT.me;
  try { const t = aiBaseScore(); return t > 0 ? t : null; } catch (e) { return null; }
}
const wtMine = () => { const b = wtBase(); return b == null ? null : b + WT_BONUS[WT.visa]; };

function wtBand(rate, pts) {
  if (!rate || pts == null) return null;
  const i = rate.points ? rate.points.indexOf(Math.floor(pts / 5) * 5) : -1;
  if (rate.points) return i < 0 ? null : { rate: rate.rate[i], n: rate.total[i] };
  const r = rate[String(Math.floor(pts / 5) * 5)];          // board.json shape
  return r ? { rate: r[0], n: r[1] } : null;
}
function wtCliff(rate) {
  if (!rate) return null;
  for (let i = 1; i < rate.points.length; i++)
    if (rate.total[i] >= WT_MIN_N && rate.rate[i] >= 10 && rate.rate[i] - rate.rate[i - 1] >= 10)
      return rate.points[i];
  return null;
}

/* ---------- phone: list page vs detail page ----------
   Desktop always shows both panes and keeps the selection in the hash. On a
   phone the hash decides: #/watch is the list, #/watch/<code> the detail. */
const wtMobile = () => matchMedia("(max-width:760px)").matches;
function wtHashCode() {
  const h = parseHash();
  return h.view === "watch" && h.code ? h.code : wtMobile() ? null : WT.sel;
}
const wtHash = () => "#/watch" + (WT.sel && (WT.mdet || !wtMobile()) ? "/" + WT.sel : "");
function wtMode() {
  const el = document.querySelector("#view-watch .wt");
  if (el) el.classList.toggle("m-det", !!WT.mdet);
}
function wtRoute(code) {
  const was = WT.mdet;
  WT.mdet = !!code;
  if (code && code !== WT.sel) { wtOpen(code); return; }
  wtMode();
  if (WT.mdet && !was) { scrollTo(0, 0); wtRenderCenter(); }
}

/* 12-month pool sparkline for the phone list. */
function wtSpark(s) {
  const v = s.slice(-12), W = 76, H = 30;
  if (v.length < 2 || !Math.max(...v)) return "";
  const lo = Math.min(...v), hi = Math.max(...v);
  const x = i => (1 + i * (W - 2) / (v.length - 1)).toFixed(1);
  const y = t => (hi === lo ? H / 2 : H - 3 - (t - lo) / (hi - lo) * (H - 6)).toFixed(1);
  const pts = v.map((t, i) => `${x(i)},${y(t)}`).join(" ");
  return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" aria-hidden="true">
    <polygon points="${x(0)},${H} ${pts} ${x(v.length - 1)},${H}" fill="currentColor" opacity=".12"/>
    <polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>`;
}

/* ---------- left: watchlist ---------- */
function wtRow(code) {
  const rows = (WT.board && WT.board.visas[WT.visa]) || [];
  return rows.find(r => r.c === code) || null;
}
function wtName(code) {
  const o = (WT.index || []).find(o => o.code === code);
  return o ? { zh: (o.zh || [""])[0], en: o.name.slice(7) } : { zh: code, en: "" };
}
function wtRenderList() {
  const mine = wtMine();
  wt$("wtCnt").textContent = WT.list.length;
  wt$("wtCol").textContent = mine == null ? "在池人数" : `${mine} 分获邀率`;
  wt$("wtListNote").textContent = WT.example
    ? (wtMobile() ? "这是示例自选。点「＋ 添加」加你关心的职业；点进职业页，再点「★ 已加自选」可以移除。"
                  : "这是示例自选。点 ✕ 删掉，点「＋ 添加」加你关心的职业。")
    : mine == null ? "填上你的分数，就会按你分数段的历史获邀率排序。"
    : `按你 ${mine} 分这一段的历史获邀率排序；样本少于 ${WT_MIN_N} 人的显示「数据不足」。`;
  const rows = WT.list.map(c => {
    const r = wtRow(c), nm = wtName(c), b = r ? wtBand(r.r, mine) : null;
    return { c, r, nm, b, ok: b && b.n >= WT_MIN_N };
  }).sort((a, b) => mine == null
    ? ((b.r ? b.r.s[b.r.s.length - 1] : -1) - (a.r ? a.r.s[a.r.s.length - 1] : -1))
    : (b.ok ? b.b.rate : -1) - (a.ok ? a.b.rate : -1));
  wt$("wtList").innerHTML = rows.length ? rows.map(({ c, r, nm, b, ok }) => {
    const s = r ? r.s : [], now = s[s.length - 1], prev = s[s.length - 2], d = now - prev;
    const pct = !r ? "" : !prev ? "—" : (d > 0 ? "+" : d < 0 ? "−" : "") + Math.abs(d / prev * 100).toFixed(1) + "%";
    const head = !r ? `<span class="wt-r na">无此签证</span>`
      : mine == null ? `<span class="wt-r">${wtFmt(now)}</span>`
      : `<span class="wt-r ${ok ? "" : "na"}">${ok ? b.rate.toFixed(1) + "%" : "数据不足"}</span>`;
    return `<li class="${c === WT.sel ? "on" : ""}">
      <button class="wt-it" type="button" data-c="${c}">
        <span class="wt-n">${wtEsc(nm.zh || nm.en)}</span>
        <span class="wt-sp ${r ? wtCls(s[s.length - 1] - s[Math.max(0, s.length - 12)]) : ""}">${r ? wtSpark(s) : ""}</span>${head}
        <span class="wt-c">${c}${r ? " · 在池 " + wtFmt(now) : ""}</span>
        <span class="wt-d ${r ? wtCls(d) : ""}">${r ? "较上月 " + wtSgn(d) : ""}</span>
        ${r ? `<span class="wt-b ${wtCls(d)}" title="在池人数较上月">${pct}</span>` : ""}
      </button>
      <button class="wt-x" type="button" data-rm="${c}" aria-label="从自选移除 ${wtEsc(nm.zh)}">✕</button></li>`;
  }).join("") : `<li class="wt-empty">还没有自选职业。点「＋ 添加」搜一个。</li>`;
}

/* ---------- centre: charts ---------- */
function wtScale(d0, d1, r0, r1) { return v => r0 + (v - d0) / ((d1 - d0) || 1) * (r1 - r0); }
function wtNice(v) { const p = Math.pow(10, Math.floor(Math.log10(v || 1))); return Math.ceil(v / p * 2) / 2 * p; }
function wtChart({ h, series, labels, kind, yMin, yMax, ticks, you, youLabel, fmtY }) {
  const W = Math.max(300, wt$("wtCharts").clientWidth), L = 34, R = 50, T = 10, B = 22;
  const n = labels.length, x = i => L + (n === 1 ? 0 : i * (W - L - R) / (n - 1));
  const y = wtScale(yMin, yMax, h - B, T);
  let g = "";
  ticks.forEach(t => { g += `<line x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}" stroke="var(--grid)"/>
    <text x="${W - R + 6}" y="${y(t) + 3.5}">${fmtY(t)}</text>`; });
  const step = n > 12 ? 3 : n > 6 ? 2 : 1;
  labels.forEach((l, i) => { if ((n - 1 - i) % step === 0)
    g += `<text x="${x(i)}" y="${h - 6}" text-anchor="middle">${l}</text>`; });
  if (kind === "bar") {
    const bw = Math.max(3, (W - L - R) / n * .55);
    series[0].v.forEach((v, i) => { g += `<rect x="${x(i) - bw / 2}" y="${y(v)}" width="${bw}"
      height="${Math.max(0, y(yMin) - y(v))}" fill="var(--wt-inv)" opacity=".8" rx="1"/>`; });
  } else series.forEach(s => {
    const pts = s.v.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
    if (s.fill) g += `<polygon points="${x(0)},${y(yMin)} ${pts} ${x(n - 1)},${y(yMin)}" fill="var(--wt-pool-fill)"/>`;
    g += `<polyline points="${pts}" fill="none" stroke="var(${s.c})" stroke-width="${s.w || 1.6}" stroke-linejoin="round"/>`;
    if (s.dot) g += `<circle cx="${x(n - 1)}" cy="${y(s.v[n - 1])}" r="3" fill="var(${s.c})"/>`;
  });
  if (you != null && you >= yMin && you <= yMax)
    g += `<line x1="${L}" x2="${W - R}" y1="${y(you)}" y2="${y(you)}" stroke="var(--wt-you)" stroke-dasharray="4 3" stroke-width="1.4"/>
          <text x="${L + 2}" y="${y(you) - 4}" style="fill:var(--wt-you)">${youLabel}</text>`;
  if (WT.hover != null && WT.hover < n)
    g += `<line x1="${x(WT.hover)}" x2="${x(WT.hover)}" y1="${T}" y2="${h - B}" stroke="var(--axis)"/>`;
  return `<svg class="wt-ch" viewBox="0 0 ${W} ${h}" height="${h}" data-l="${L}" data-r="${R}" data-n="${n}" role="img">${g}</svg>`;
}

async function wtDetail(code) {
  if (!WT.cache[code]) {
    const r = await fetch(`data/${code}.json`, { cache: "force-cache" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    WT.cache[code] = await r.json();
  }
  return WT.cache[code];
}

function wtRenderCenter() {
  const code = WT.sel, o = WT.cache[code], nm = wtName(code);
  const inList = WT.list.includes(code);
  wt$("wtName").textContent = nm.zh || nm.en;
  wt$("wtSub").textContent = `${code} ${nm.en} · ${WT.visa === "491" ? "491 州担保" : WT.visa}`;
  wt$("wtStar").textContent = inList ? "★ 已加自选" : "＋ 加入自选";
  wt$("wtStar").setAttribute("aria-pressed", inList);
  wt$("wtFull").href = "#/data/" + code;
  if (!o) { wt$("wtKpis").innerHTML = ""; wt$("wtRo").textContent = "载入中…"; wt$("wtCharts").innerHTML = ""; return; }
  const v = WT_VISA[WT.visa], s = o.series[v];
  if (!s) {
    wt$("wtKpis").innerHTML = ""; wt$("wtRo").textContent = "";
    wt$("wtCharts").innerHTML = `<p class="wt-note">这个职业没有 ${WT.visa} 签证的数据，换个签证类别看看。</p>`;
    return;
  }
  const n = Math.min(WT.n, o.monthLabels.length), sl = a => a.slice(-n);
  const lab = sl(o.monthLabels).map(l => l.replace(/^(\d\d)\/20(\d\d)$/, "$2.$1"));
  const p = s.SUBMITTED, inv = s.INVITED, pc = o.percentiles[v];
  const mine = wtMine(), b = wtBand(o.rate[v], mine), last = p.length - 1;
  wt$("wtKpis").innerHTML =
    `<div><span>在池人数</span><b>${wtFmt(p[last])}</b></div>
     <div><span>较上月</span><b class="${wtCls(p[last] - p[last - 1])}">${wtSgn(p[last] - p[last - 1])}</b></div>
     <div><span>较 6 个月前</span><b class="${wtCls(p[last] - p[last - 6])}">${wtSgn(p[last] - p[last - 6])}</b></div>
     <div><span>池内 p75 分数</span><b>${pc.p75[pc.p75.length - 1]} 分</b></div>
     <div><span>${mine == null ? "你的分数段获邀率" : `你 ${mine} 分段历史获邀率`}</span>
       <b class="you">${mine == null ? "先填分数" : b && b.n >= WT_MIN_N ? b.rate.toFixed(1) + "%" : "数据不足"}</b></div>`;
  const pv = sl(p), iv = sl(inv), p50 = sl(pc.p50), p75 = sl(pc.p75), p90 = sl(pc.p90);
  const lo = Math.min(...pv), hi = Math.max(...pv), pad = (hi - lo) * .25 || hi * .1 || 1;
  const yMin = Math.max(0, Math.floor((lo - pad) / 10) * 10), yMax = Math.ceil((hi + pad) / 10) * 10;
  const imax = wtNice(Math.max(...iv, 1));
  const smin = Math.min(...p50, mine == null ? 999 : mine) - 5, smax = Math.max(...p90, mine == null ? 0 : mine) + 5;
  const h = WT.hover != null && WT.hover < n ? WT.hover : n - 1;
  wt$("wtRo").innerHTML = `<b>20${lab[h].replace(".", "/")}</b> · 在池 <b>${wtFmt(pv[h])}</b> · 获邀状态 <b>${wtFmt(iv[h])}</b> · ` +
    `分数线 p50 <b>${p50[h]}</b> / p75 <b>${p75[h]}</b> / p90 <b>${p90[h]}</b>`;
  const youLabel = mine == null ? "" : `你 ${mine} 分` + (WT_BONUS[WT.visa] ? `（含州担保 ${WT_BONUS[WT.visa]} 分）` : "");
  wt$("wtCharts").innerHTML =
    `<div class="wt-panel"><div class="wt-plab"><b>池子人数</b><span class="wt-key" style="--k:var(--wt-pool)">提交了 EOI、还在排队的人</span></div>
       ${wtChart({ h: 230, labels: lab, series: [{ v: pv, c: "--wt-pool", fill: 1, dot: 1, w: 2 }],
                   yMin, yMax, ticks: [yMin, Math.round((yMin + yMax) / 2), yMax], fmtY: wtFmt })}</div>
     <div class="wt-panel"><div class="wt-plab"><b>获邀状态人数</b><i>月末快照，受邀请轮次影响，不等于当月发出的邀请数</i></div>
       ${wtChart({ h: 96, labels: lab, kind: "bar", series: [{ v: iv }], yMin: 0, yMax: imax, ticks: [0, imax], fmtY: wtFmt })}</div>
     <div class="wt-panel"><div class="wt-plab"><b>池内分数线</b>
         <span class="wt-key" style="--k:var(--wt-p90)">p90</span><span class="wt-key" style="--k:var(--wt-p75)">p75</span>
         <span class="wt-key" style="--k:var(--wt-p50)">p50</span>${mine == null ? "" : `<span class="wt-key dash" style="--k:var(--wt-you)">你的分数</span>`}</div>
       ${wtChart({ h: 130, labels: lab, series: [{ v: p90, c: "--wt-p90" }, { v: p75, c: "--wt-p75", w: 2 }, { v: p50, c: "--wt-p50" }],
                   yMin: smin, yMax: smax, you: mine, youLabel,
                   ticks: [Math.ceil(smin / 5) * 5, Math.round((smin + smax) / 10) * 5, Math.floor(smax / 5) * 5], fmtY: t => t })}</div>`;
}

/* ---------- right: distribution, findings, states ---------- */
function wtRenderRight() {
  const o = WT.cache[WT.sel];
  if (!o) { wt$("wtDist").innerHTML = ""; wt$("wtFind").innerHTML = ""; wt$("wtStates").innerHTML = ""; return; }
  const v = WT_VISA[WT.visa], pp = o.poolPoints[v], r = o.rate[v];
  if (!pp) {
    wt$("wtDist").innerHTML = `<p class="wt-note">没有 ${WT.visa} 签证的数据。</p>`;
    wt$("wtFind").innerHTML = ""; wt$("wtStates").innerHTML = ""; return;
  }
  wt$("wtDSub").textContent = `${o.monthLabels[o.monthLabels.length - 1]} · 当前池`;
  const max = Math.max(...pp.counts), cl = wtCliff(r), mine = wtMine();
  const mb = mine == null ? null : Math.floor(mine / 5) * 5;
  const rows = pp.points.map((pt, i) => ({ pt, c: pp.counts[i] })).filter(x => x.pt >= 55).reverse();
  wt$("wtDist").innerHTML = rows.map(({ pt, c }) => {
    const i = r ? r.points.indexOf(pt) : -1, nn = i >= 0 ? r.total[i] : 0;
    const rt = i < 0 ? "—" : nn < WT_MIN_N ? "样本少" : r.rate[i].toFixed(1) + "%";
    return `<div class="wt-drow ${pt === mb ? "me" : ""} ${cl && pt >= cl ? "cliff" : ""}">
      <span class="pt">${pt}</span><span class="bar"><i style="width:${(c / max * 100).toFixed(1)}%"></i></span>
      <span class="rt">${rt}</span></div>`;
  }).join("");
  wt$("wtFind").innerHTML = (o.findings[v] || []).map(f => `<p><b>${wtEsc(f.label)}</b>${wtEsc(f.text)}</p>`).join("");
  const sts = o.states[v] || [], tot = sts.reduce((a, s) => a + s[1], 0);
  wt$("wtStates").innerHTML = WT.visa === "189" || !sts.length ? "" :
    `<div class="wt-ph wt-top"><h3>提名州分布</h3><small>累计</small></div>
     <div class="wt-states">${sts.slice(0, 8).map(([s, c]) =>
       `<div class="wt-srow"><span>${wtEsc(s)}</span><span class="bar"><i style="width:${(c / sts[0][1] * 100).toFixed(1)}%"></i></span>
        <span class="pc">${(c / tot * 100).toFixed(0)}%</span></div>`).join("")}</div>`;
}

function wtRenderTop() {
  document.querySelectorAll("#wtVisa button").forEach(b => b.setAttribute("aria-pressed", b.dataset.v === WT.visa));
  document.querySelectorAll("#wtTf button").forEach(b => b.setAttribute("aria-pressed", +b.dataset.n === WT.n));
  const base = wtBase();
  if (document.activeElement !== wt$("wtMe")) wt$("wtMe").value = base == null ? "" : base;
  wt$("wtMeSrc").textContent = WT.me == null && base != null ? "来自「我的分数」" :
    WT_BONUS[WT.visa] ? `${WT.visa} 自动 +${WT_BONUS[WT.visa]} 分州担保` : "";
  const a = aiAuth();
  wt$("wtAcct").innerHTML = a
    ? `已登录 ${wtEsc(a.email || "")} · 自选已同步 <button type="button" class="linkbtn" id="wtOut">退出</button>`
    : `自选存在这台设备上 · <a class="linkbtn" href="login.html#/watch">登录后多设备同步</a>`;
}

function wtRenderAll() { wtRenderTop(); wtRenderList(); wtRenderCenter(); wtRenderRight(); }

async function wtOpen(code, how) {
  if (!/^\d{6}$/.test(code || "")) return;
  WT.sel = code; WT.hover = null;
  const tap = how === "tap" && wtMobile();
  if (tap || parseHash().code === code) WT.mdet = true;
  if (typeof curView !== "undefined" && curView === "watch") {
    const want = wtHash();
    // a tap on the phone list is a page change: push it so Back returns to the list
    if (location.hash !== want) history[tap ? "pushState" : "replaceState"](tap ? { wt: 1 } : null, "", want);
  }
  wtMode();
  if (tap) scrollTo(0, 0);
  wtRenderAll();
  try { await wtDetail(code); } catch (e) {
    wt$("wtRo").textContent = `载入 ${code} 失败：${e.message}。刷新页面重试。`; return; }
  if (WT.sel === code) { wtRenderCenter(); wtRenderRight(); }
}

function wtSearch() {
  const q = wt$("wtQ").value.trim().toLowerCase();
  if (!q) { wt$("wtQres").innerHTML = ""; return; }
  const hits = (WT.index || []).filter(o => !WT.list.includes(o.code) &&
    (o.code.startsWith(q) || o.name.toLowerCase().includes(q) || (o.zh || []).some(z => z.includes(q)))).slice(0, 8);
  wt$("wtQres").innerHTML = hits.length ? hits.map(o =>
    `<button type="button" data-addc="${o.code}">＋ ${wtEsc((o.zh || [""])[0] || o.name.slice(7))}
       <span>${o.code} ${wtEsc(o.name.slice(7))}</span></button>`).join("")
    : `<p class="wt-note">没有匹配的职业。</p>`;
}
function wtAdd(code) {
  if (WT.example) { WT.example = false; }
  if (!WT.list.includes(code)) WT.list.unshift(code);
  wtSave();
}

function wtInit() {
  const want = parseHash().code;
  WT.mdet = !!want;
  if (WT.inited) { if (want && want !== WT.sel) wtOpen(want); else { wtMode(); wtRenderAll(); } return; }
  WT.inited = true;
  wtLoad();
  wtMode();
  wt$("wtVisa").addEventListener("click", e => { const b = e.target.closest("button");
    if (b) { WT.visa = b.dataset.v; wtSave(); wtRenderAll(); } });
  wt$("wtTf").addEventListener("click", e => { const b = e.target.closest("button");
    if (b) { WT.n = +b.dataset.n; WT.hover = null; wtRenderCenter(); wtRenderTop(); } });
  wt$("wtMe").addEventListener("change", e => {
    const raw = e.target.value.trim();
    if (raw === "") WT.me = null;
    else { const v = Math.round(+raw / 5) * 5; if (v >= 0 && v <= 150) WT.me = v; }
    wtSave(); wtRenderAll(); });
  wt$("wtList").addEventListener("click", e => {
    const rm = e.target.closest("[data-rm]");
    if (rm) { WT.list = WT.list.filter(c => c !== rm.dataset.rm); WT.example = false; wtSave();
              if (WT.sel === rm.dataset.rm && WT.list.length) wtOpen(WT.list[0]); else wtRenderAll(); return; }
    const it = e.target.closest("[data-c]");
    if (it) { wtOpen(it.dataset.c, "tap"); if (typeof reportLook === "function") reportLook(it.dataset.c, "pick"); }
  });
  wt$("wtStar").addEventListener("click", () => {
    if (WT.list.includes(WT.sel)) { WT.list = WT.list.filter(c => c !== WT.sel); WT.example = false; wtSave(); }
    else wtAdd(WT.sel);
    wtRenderAll(); });
  wt$("wtAdd").addEventListener("click", () => {
    const box = wt$("wtAddBox"); box.hidden = !box.hidden; if (!box.hidden) wt$("wtQ").focus(); });
  wt$("wtQ").addEventListener("input", wtSearch);
  wt$("wtQres").addEventListener("click", e => { const b = e.target.closest("[data-addc]");
    if (b) { wtAdd(b.dataset.addc); wt$("wtQ").value = ""; wtSearch(); wtOpen(b.dataset.addc);
             if (typeof reportLook === "function") reportLook(b.dataset.addc, "pick"); } });
  wt$("wtBack").addEventListener("click", () => {
    if (history.state && history.state.wt) { history.back(); return; }
    history.replaceState(null, "", "#/watch"); wtRoute(null); });
  wt$("wtAcct").addEventListener("click", e => { if (e.target.id === "wtOut") { aiSignOut(); wtRenderTop(); } });
  const ch = wt$("wtCharts");
  ch.addEventListener("mousemove", e => {
    const svg = e.target.closest("svg.wt-ch"); if (!svg) return;
    const r = svg.getBoundingClientRect(), W = svg.viewBox.baseVal.width, k = W / r.width;
    const L = +svg.dataset.l, R = +svg.dataset.r, n = +svg.dataset.n;
    const i = Math.max(0, Math.min(n - 1, Math.round(((e.clientX - r.left) * k - L) / ((W - L - R) / (n - 1)))));
    if (i !== WT.hover) { WT.hover = i; wtRenderCenter(); }
  });
  ch.addEventListener("mouseleave", () => { WT.hover = null; wtRenderCenter(); });
  let rz; addEventListener("resize", () => { clearTimeout(rz); rz = setTimeout(() => {
    if (curView === "watch") { wtMode(); wtRenderCenter(); } }, 140); });

  Promise.all([
    fetch("data/board.json", { cache: "no-cache" }).then(r => r.json()),
    fetch("data/occupations.json", { cache: "force-cache" }).then(r => r.json()),
  ]).then(([board, index]) => {
    WT.board = board; WT.index = index;
    wtOpen(want || WT.sel || WT.list[0] || index[0].code);
  }).catch(e => { wt$("wtRo").textContent = "数据载入失败：" + e.message + "。刷新页面重试。"; });
  wtPull().then(() => { if (WT.board) wtRenderAll(); });
}
