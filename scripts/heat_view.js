/* ---------- 龙虎榜 · 热力图 ----------
   A treemap of every occupation in the selected visa's pool, nested by ANZSCO
   sub-major group (the "sectors"). Area is always the current pool. Colour is
   one of two things, never both:
     池子变化 -- pool change over 1 or 6 months. Nearly every pool grows (97% of
       the 189 pool by weight over 6 months), so by default the colour is the
       change *relative to the whole pool*: red = crowding faster than the pool
       overall, green = slower or shrinking. "绝对变化" colours the raw sign.
     获邀率 -- cumulative historical invite rate in the visitor's points band
       (190 +5, 491 +15). One hue, darker = higher; never red, so it can't be
       read as "falling".
   On this map green always means "better for you".

   Shares board.json, the visa switch and the 加自选 path with the rest of the
   site. Rate history is not shown: board.json only has the cumulative rate as
   of now. build_site.py snapshots it monthly into data/hist/ from 09/2026. */
const HM_GROUP = { "12": "农场主", "13": "专业管理", "14": "酒店零售经理", "21": "艺术传媒", "22": "商业财会",
  "23": "工程设计科学", "24": "教育", "25": "医疗健康", "26": "ICT", "27": "法律社工心理", "31": "工程技术员",
  "32": "汽车工程技工", "33": "建筑技工", "34": "电工电子", "35": "食品技工", "36": "动物园艺", "39": "其他技工",
  "41": "医护社区服务", "44": "安保应急", "45": "体育", "51": "办公管理", "59": "文员", "61": "销售", "63": "销售" };
const HM_BONUS = { "189": 0, "190": 5, "491": 15 };
const HM_MIN_POOL = 100, HM_MIN_N = 30, HM_FEW = 10;   // rate: <10 hidden, 10-29 flagged *
const HM_MODE_KEY = "immi.lb.mode";
const HM = { met: "pool", per: 6, rel: 1, me: null, zoom: null, sel: null, base: 0, wired: false };
const hm$ = id => document.getElementById(id);

function hmScore() {
  try { const s = JSON.parse(localStorage.getItem("immi.watch.v1") || "null"); if (s && s.me != null) return s.me; } catch (e) {}
  try { const t = aiBaseScore(); return t > 0 ? t : null; } catch (e) { return null; }
}

function hmRows() {
  const visa = LB.visa, mine = HM.me == null ? null : HM.me + HM_BONUS[visa];
  return (LB.data.visas[visa] || []).filter(r => lbNow(r) > 0).map(r => {
    const s = r.s, now = s[s.length - 1], then = s[s.length - 1 - HM.per];
    const ok = now >= HM_MIN_POOL && then >= HM_MIN_POOL;
    const b = mine == null ? null : r.r[String(Math.floor(mine / 5) * 5)] || null;
    return { r, c: r.c, zh: r.zh || r.en, now, then, pct: ok ? (now - then) / then * 100 : null,
             band: b, rate: b && b[1] >= HM_FEW ? b[0] : null, few: !!b && b[1] < HM_MIN_N };
  });
}

const hmPctTxt = p => p == null ? "样本少" : (p > 0 ? "+" : p < 0 ? "−" : "") + Math.abs(p).toFixed(1) + "%";
const hmRateTxt = x => x == null ? "人数少" : (x < 10 ? x.toFixed(1) : Math.round(x)) + "%";
const hmVal = t => HM.met === "rate" ? t.rate : t.pct;
const hmTxt = x => HM.met === "rate" ? hmRateTxt(x) : hmPctTxt(x);
function hmCls(x) { return x == null ? "na" : HM.rel || HM.met === "rate" ? "" : x > 0.05 ? "up" : x < -0.05 ? "down" : ""; }
/* How much of the full-strength colour a value gets (0..100). Full strength is
   reached at the clamp; past ~60% the tile is dark enough to need white text. */
function hmMix(x) {
  if (x == null) return { m: 0 };
  if (HM.met === "rate")               // sqrt: most rates sit under 5%, a few pass 70%
    return { m: Math.round(12 + Math.min(1, Math.sqrt(x / 50)) * 88), c: "--hm-dn" };
  if (HM.rel) x -= HM.base;
  const k = Math.min(1, Math.abs(x) / (HM.per === 1 ? 6 : 20));
  return { m: Math.round(18 + k * 82), c: x > 0 ? "--hm-up" : "--hm-dn" };
}
function hmFill(x) {
  const { m, c } = hmMix(x);
  return m ? `color-mix(in oklab, var(${c}) ${m}%, var(--hm-flat))` : "var(--hm-flat)";
}
const hmDk = x => hmMix(x).m >= 62 ? " hm-dk" : "";

/* Squarified treemap (Bruls, Huizing & van Wijk): fill rows along the shorter
   side, closing a row when adding the next item would worsen its aspect ratio. */
function hmWorst(row, side) {
  const s = row.reduce((a, b) => a + b.a, 0);
  let mx = 0, mn = Infinity; row.forEach(r => { mx = Math.max(mx, r.a); mn = Math.min(mn, r.a); });
  return Math.max(side * side * mx / (s * s), s * s / (side * side * mn));
}
function hmSquarify(items, x, y, w, h) {
  const out = [], total = items.reduce((a, b) => a + b.v, 0);
  if (!total || w <= 0 || h <= 0) return out;
  let rest = items.map(it => ({ it, a: it.v * w * h / total }));
  while (rest.length) {
    const side = Math.min(w, h);
    let row = [rest[0]], best = hmWorst(row, side);
    for (let i = 1; i < rest.length; i++) {
      const nr = row.concat(rest[i]), wv = hmWorst(nr, side);
      if (wv > best) break;
      row = nr; best = wv;
    }
    rest = rest.slice(row.length);
    const thick = row.reduce((a, b) => a + b.a, 0) / side;
    let off = 0;
    row.forEach(({ it, a }) => {
      const len = a / thick;
      out.push(w >= h ? { it, x, y: y + off, w: thick, h: len } : { it, x: x + off, y, w: len, h: thick });
      off += len;
    });
    if (w >= h) { x += thick; w -= thick; } else { y += thick; h -= thick; }
  }
  return out;
}

function hmGroups(all) {
  const by = {};
  all.forEach(t => { const g = t.c.slice(0, 2); (by[g] = by[g] || []).push(t); });
  const tot = all.reduce((a, t) => a + t.now, 0);
  let gs = Object.entries(by).map(([g, ts]) => ({ g, name: HM_GROUP[g] || g, ts, v: ts.reduce((a, t) => a + t.now, 0) }));
  const small = gs.filter(x => x.v / tot < 0.012);    // slivers share one "其他类别" block
  if (small.length > 1) {
    gs = gs.filter(x => !small.includes(x));
    gs.push({ g: "xx", name: "其他类别", ts: small.flatMap(x => x.ts), v: small.reduce((a, x) => a + x.v, 0) });
  }
  return gs.sort((a, b) => b.v - a.v);
}

/* Occupations too small to label at this size fold into one "其他 N 个" tile;
   tapping it zooms into the group. Its value is the pooled figure, not a mean. */
function hmTiles(ts, area, minArea) {
  ts = ts.slice().sort((a, b) => b.now - a.now);
  const tot = ts.reduce((a, t) => a + t.now, 0), keep = [], tail = [];
  ts.forEach(t => (t.now / tot * area >= minArea ? keep : tail).push(t));
  if (tail.length === 1) keep.push(tail.pop());
  const out = keep.map(t => ({ v: t.now, t }));
  if (tail.length) {
    const now = tail.reduce((a, t) => a + t.now, 0), then = tail.reduce((a, t) => a + t.then, 0);
    const bs = tail.filter(t => t.band), n = bs.reduce((a, t) => a + t.band[1], 0);
    const inv = bs.reduce((a, t) => a + t.band[0] * t.band[1] / 100, 0);
    out.push({ v: now, other: tail.length, val: HM.met === "rate" ? (n >= HM_FEW ? inv / n * 100 : null)
      : now >= HM_MIN_POOL && then >= HM_MIN_POOL ? (now - then) / then * 100 : null });
  }
  return out;
}

function hmTile(it, rc) {
  const { w, h } = rc, fs = Math.max(10, Math.min(18, Math.sqrt(w * h) / 7.5));
  const pos = `left:${rc.x}px;top:${rc.y}px;width:${w}px;height:${h}px;`;
  if (it.other) {
    const lbl = w > 46 && h > 30 ? `<b style="font-size:${Math.min(fs, 13)}px">其他 ${it.other} 个</b>` +
      `<span class="${hmCls(it.val)}" style="font-size:${Math.min(fs, 12)}px">${hmTxt(it.val)}</span>` : "";
    return `<button type="button" class="hm-t hm-o${hmDk(it.val)}" data-other="1" style="${pos}background:${hmFill(it.val)}" aria-label="其他 ${it.other} 个职业，点开放大">${lbl}</button>`;
  }
  const t = it.t, v = hmVal(t), star = HM.met === "rate" && v != null && t.few ? "*" : "";
  let inner = "";
  if (w >= 60 && h >= 40) inner = `<b style="font-size:${fs}px">${lbEsc(t.zh)}</b><span class="${hmCls(v)}" style="font-size:${fs * .85}px">${hmTxt(v)}${star}</span>`;
  else if (w >= 44 && h >= 18) inner = `<b style="font-size:${Math.min(fs, 12)}px">${lbEsc(t.zh)}</b>`;
  return `<button type="button" class="hm-t${HM.sel === t.c ? " on" : ""}${hmDk(v)}" data-c="${t.c}" style="${pos}background:${hmFill(v)}"
    title="${lbEsc(t.zh)} ${hmTxt(v)}${star}" aria-label="${lbEsc(t.zh)}，在池 ${lbFmt(t.now)}，${hmTxt(v)}${star ? "，人数少" : ""}">${inner}</button>`;
}

function hmRender() {
  if (!LB.data || hm$("lbHeat").hidden) return;
  hm$("hmPer").hidden = hm$("hmCol").hidden = HM.met === "rate";
  [["hmMet", "t", HM.met], ["hmPer", "p", String(HM.per)], ["hmCol", "r", String(HM.rel)]].forEach(([id, k, v]) =>
    hm$(id).querySelectorAll("button").forEach(b => b.setAttribute("aria-pressed", b.dataset[k] === v)));
  if (document.activeElement !== hm$("hmMe")) hm$("hmMe").value = HM.me == null ? "" : HM.me;
  const map = hm$("hmMap"), W = map.clientWidth, H = map.clientHeight, phone = W < 600, HD = 20;
  const all = hmRows(), gs = hmGroups(all);
  HM.base = wtOverall(LB.data.visas[LB.visa] || [], HM.per) || 0;     // same figure the check-up card quotes
  const visa = LB.visa, mine = HM.me == null ? null : HM.me + HM_BONUS[visa];
  const legend = HM.met === "rate"
    ? (mine == null ? ` · <b class="hm-you">先填你的分数</b>，才能按获邀率上色`
       : ` · 你 <b class="hm-you">${mine}</b> 分${HM_BONUS[visa] ? `（含州担保 ${HM_BONUS[visa]} 分）` : ""}这一段的历史获邀率` +
         `<span class="hm-lg">0% <i class="rt"></i> 50%+ · * 这一档不到 30 人</span>`)
    : ` · 整体${HM.per === 1 ? "较上月" : "近 6 个月"} <b>${hmPctTxt(HM.base)}</b>` +
      (HM.rel ? `<span class="hm-lg">比整体涨得慢 <i></i> 比整体涨得快</span><span class="hm-hint">绿色不等于池子在缩小，格子里的百分比才是它自己的变化</span>`
              : `<span class="hm-lg">${HM.per === 1 ? "−6%" : "−20%"} <i></i> ${HM.per === 1 ? "+6%" : "+20%"}</span>`);
  let html = "";
  const g = HM.zoom && gs.find(x => x.g === HM.zoom);
  if (g) {
    hm$("hmCrumb").innerHTML = `<button type="button" class="wt-btn" data-up="1">‹ 全部</button><b>${lbEsc(g.name)}</b> · 在池 ${lbFmt(g.v)} · ${g.ts.length} 个职业${legend}`;
    hmSquarify(hmTiles(g.ts, W * H, phone ? 900 : 700), 0, 0, W, H).forEach(({ it, ...rc }) => html += hmTile(it, rc));
  } else {
    HM.zoom = null;
    hm$("hmCrumb").innerHTML = `${visa === "491" ? "491 偏远州担保" : visa} · 在池合计 <b>${lbFmt(gs.reduce((a, x) => a + x.v, 0))}</b> · ${all.length} 个职业${legend}`;
    hmSquarify(gs.map(x => ({ v: x.v, g: x })), 0, 0, W, H).forEach(({ it, x, y, w, h }) => {
      const head = h > 46 && w > 50, top = head ? HD : 0;
      let inner = head ? `<button type="button" class="hm-gh" data-g="${it.g.g}">${lbEsc(it.g.name)} <small>${lbFmt(it.g.v)}</small></button>` : "";
      hmSquarify(hmTiles(it.g.ts, w * (h - top), phone ? 1400 : 1100), 0, top, w, h - top)
        .forEach(({ it: t, ...rc }) => inner += hmTile(t, rc));
      html += `<div class="hm-g" data-gg="${it.g.g}" style="left:${x}px;top:${y}px;width:${w}px;height:${h}px">${inner}</div>`;
    });
  }
  map.innerHTML = html;
  hmPanel(all);
}

function hmPanel(all) {
  const p = hm$("hmPanel"), t = HM.sel && all.find(x => x.c === HM.sel);
  if (!t) {
    p.classList.add("idle");
    p.innerHTML = `<p class="hm-empty">点任意一个格子，这里显示这个职业的池子人数、变化和你分数段的历史获邀率。</p>
      <p class="wt-note">点分组标题（如「ICT」）可以放大看这一类的全部职业。</p>`;
    return;
  }
  p.classList.remove("idle");
  const visa = LB.visa, mine = HM.me == null ? null : HM.me + HM_BONUS[visa], s = t.r.s;
  // the card needs the per-occupation file (pool by band, invited series); fetch once, redraw when it lands
  const o = WT.cache[t.c];
  if (!o) wtDetail(t.c).then(() => { if (HM.sel === t.c) hmPanel(hmRows()); }).catch(() => {});
  const card = o ? wtCard(o, visa, mine, wtOverall(LB.data.visas[visa] || []))
    : `<p class="wt-cardh">载入中…</p>`;
  const lo = Math.min(...s), hi = Math.max(...s), Wd = 270, Hd = 70;
  const px = i => 4 + i * (Wd - 8) / (s.length - 1), py = v => hi === lo ? Hd / 2 : Hd - 14 - (v - lo) / (hi - lo) * (Hd - 22);
  const pts = s.map((v, i) => `${px(i).toFixed(1)},${py(v).toFixed(1)}`).join(" ");
  const inList = typeof WT !== "undefined" && WT.list.includes(t.c);
  const m12 = LB.data.m12;
  p.innerHTML = `<button type="button" class="hm-x" data-close="1" aria-label="关闭">×</button>
    <div><h3>${lbEsc(t.zh)}</h3><p class="hm-sub">${t.c} ${lbEsc(t.r.en)} · ${visa}</p></div>
    <svg class="hm-spark" viewBox="0 0 ${Wd} ${Hd}" preserveAspectRatio="none" role="img" aria-label="近 12 个月在池人数">
      <polygon points="${px(0)},${Hd - 12} ${pts} ${px(s.length - 1)},${Hd - 12}" fill="var(--wt-pool)" opacity=".10"/>
      <polyline points="${pts}" fill="none" stroke="var(--wt-pool)" stroke-width="1.8" vector-effect="non-scaling-stroke"/>
      <text x="4" y="${Hd - 1}">${m12[0]}</text><text x="${Wd - 4}" y="${Hd - 1}" text-anchor="end">${m12[m12.length - 1]}</text></svg>
    <div class="wt-card">${card}</div>
    <div class="hm-acts"><button type="button" data-star="${t.c}">${inList ? "★ 已加自选" : "＋ 加自选"}</button>
      <a class="hm-pri" href="#/watch/${t.c}">看详情 →</a></div>
    <p class="wt-note">历史获邀率：截至统计时这一分数段累计获邀的比例，不代表未来获邀概率。</p>`;
}

/* 加自选 from here goes through the watchlist's own store. If the 自选 view has
   not run yet this visit, pull the account copy first so this device's stale
   list never overwrites it. */
async function hmStar(code) {
  if (!WT.inited) { wtLoad(); await wtPull(); }
  if (WT.list.includes(code)) { WT.list = WT.list.filter(c => c !== code); WT.example = false; wtSave(); }
  else wtAdd(code);
  if (typeof reportLook === "function") reportLook(code, "pick");
  hmRender();
}

function lbMode(m) {
  hm$("lbHeat").hidden = m !== "heat"; hm$("lbList").hidden = m !== "list"; hm$("lbRound").hidden = m !== "round";
  hm$("lbSeg").hidden = m === "round";   // rounds are 189 only
  hm$("lbMode").querySelectorAll("button").forEach(b => b.setAttribute("aria-pressed", b.dataset.m === m));
  try { localStorage.setItem(HM_MODE_KEY, m); } catch (e) {}
  if (m === "heat") hmRender();
  if (m === "round" && typeof rdRender === "function") { rdWire(); rdRender(); }
}

function hmWire() {
  if (HM.wired) return;
  HM.wired = true;
  HM.me = hmScore();
  let m = "heat"; try { m = localStorage.getItem(HM_MODE_KEY) || "heat"; } catch (e) {}
  hm$("lbMode").addEventListener("click", e => { const b = e.target.closest("button"); if (b) lbMode(b.dataset.m); });
  const seg = (id, k, f) => hm$(id).addEventListener("click", e => {
    const b = e.target.closest("button"); if (b) { f(b.dataset[k]); hmRender(); } });
  seg("hmMet", "t", v => HM.met = v);
  seg("hmPer", "p", v => HM.per = +v);
  seg("hmCol", "r", v => HM.rel = +v);
  hm$("hmMe").addEventListener("change", e => {
    const raw = e.target.value.trim();
    HM.me = raw === "" ? null : Math.max(0, Math.min(150, Math.round(+raw / 5) * 5));
    hmRender(); });
  hm$("hmMap").addEventListener("click", e => {
    const g = e.target.closest("[data-g]"); if (g) { HM.zoom = g.dataset.g; hmRender(); return; }
    const t = e.target.closest("[data-c]"); if (t) { HM.sel = t.dataset.c; hmRender(); return; }
    const o = e.target.closest("[data-other]"), gg = o && o.closest("[data-gg]");
    if (gg) { HM.zoom = gg.dataset.gg; hmRender(); }
  });
  hm$("hmCrumb").addEventListener("click", e => { if (e.target.closest("[data-up]")) { HM.zoom = null; hmRender(); } });
  hm$("hmPanel").addEventListener("click", e => {
    if (e.target.closest("[data-close]")) { HM.sel = null; hmRender(); return; }
    const s = e.target.closest("[data-star]"); if (s) hmStar(s.dataset.star);
  });
  let rz; addEventListener("resize", () => { clearTimeout(rz); rz = setTimeout(() => { if (curView === "board") hmRender(); }, 140); });
  // desktop opens with a tile selected so the side panel shows what it is for
  if (!matchMedia("(max-width:760px)").matches) HM.sel = "261313";
  lbMode(m === "list" || m === "round" ? m : "heat");
}
