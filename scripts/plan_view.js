/* ---------- 我的 → 方案 ----------
   A personal PR plan: a short questionnaire, then every 189 occupation the
   visitor could reach -- by the job they have now, or by studying for a new
   one -- ranked by the preferences they tick, and once they pin one, a
   "where things stand" panel that is what 我的 opens on from then on.

   Nothing here is a model's opinion. The score at the time of the EOI is the
   points calculator's own Schedule 6D arithmetic (calcBreakdown) run on a
   copy of the answers with age, qualification and Australian study moved to
   that date. Lists, visas, assessor and skill level come from
   data/occ_entry.json (Home Affairs + ABS, checked weekly); the conditions on
   the cards are the hand-checked notes in data/occ_cards.json, each with its
   official source; rounds are data/round_occ.json. The one thing that is an
   assumption -- how many years a course takes, where no regulator states it --
   is labelled as one on every card.

   The optional AI read-out only rewrites these facts in plain words: the
   page sends the fact pack, and any number in the reply that is not in the
   pack (or any odds wording) gets the reply thrown away. */
const PLAN_KEY = "immi.plan.v1";
const PL = { data: null, loading: null, qi: 0, showAll: false, ai: null };
let PLAN = { door: null, birth: "", cur: null, years: null, areas: [],
             sort: { steady: 1, margin: 1, short: 1 }, pinned: null, done: false };
const plEsc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const plFmt = n => n.toLocaleString("en-US");
const $pl = id => document.getElementById(id);
const plNow = () => { const d = new Date(); return d.getFullYear() * 12 + d.getMonth(); };
const plYm = s => { const [y, m] = s.split("-").map(Number); return y * 12 + m - 1; };
const plMon = i => `${Math.floor(i / 12)}-${String(i % 12 + 1).padStart(2, "0")}`;

function plLoadState() {
  try { const s = JSON.parse(localStorage.getItem(PLAN_KEY)); if (s) PLAN = Object.assign(PLAN, s); } catch (e) {}
}
function plSave() { try { localStorage.setItem(PLAN_KEY, JSON.stringify(PLAN)); } catch (e) {} }
/* The calculator's answers are the score part of the profile: the plan reads
   and writes the same CALC, so 我的分数 and 方案 never disagree. */
function plCalc() {
  if (!CALC || !Object.keys(CALC).length) {
    try { CALC = JSON.parse(localStorage.getItem(CALC_KEY)) || {}; } catch (e) { CALC = {}; }
  }
  return CALC;
}
function plSetCalc(key, idx) {
  plCalc()[key] = idx;
  try { localStorage.setItem(CALC_KEY, JSON.stringify(CALC)); } catch (e) {}
  const sel = document.getElementById("c_" + key);
  if (sel) sel.value = idx;
}
const plAgeIdx = ageBand;            // the calculator's own band mapping
const plAgeAt = t => PLAN.birth ? Math.floor((t - plYm(PLAN.birth)) / 12) : null;
const plEduPts = i => RULES.fields.find(f => f.key === "edu").options[i | 0].v;
const plEduIdx = pts => pts >= 20 ? 1 : pts >= 15 ? 2 : pts >= 10 ? 3 : 0;

/* Schedule 6D total for the current answers with some fields overridden. */
function plScore(over) { return calcBreakdownWith(over || {}).total; }

function plLoad() {
  if (!PL.loading)
    PL.loading = Promise.all([
      fetch("data/occ_entry.json", { cache: "no-cache" }).then(r => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); }),
      fetch("data/round_occ.json", { cache: "no-cache" }).then(r => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); }),
      fetch("data/occupations.json", { cache: "force-cache" }).then(r => r.json()),
    ]).then(([entry, rounds, index]) => {
      const names = {};
      index.forEach(o => { names[o.code] = o; });
      const days = rounds.rounds.map(r => r.date);
      const occ = Object.entries(entry.occ).map(([c, e]) => {
        const nm = names[c] || {};
        const mine = {};
        (rounds.occ[c] || []).forEach(x => { mine[x[0]] = x; });
        return Object.assign({ c, en: (nm.name || c).replace(/^\d{6}\s*/, ""), zh: (nm.zh || [])[0] || "",
          zhAll: nm.zh || [], pool: nm.pool,
          r: days.map(d => mine[d] ? [mine[d][1], mine[d][3]] : [0, null]) }, e);
      });
      PL.data = { entry, rounds, occ, by: Object.fromEntries(occ.map(o => [o.c, o])), days };
      return PL.data;
    }).catch(e => { PL.loading = null; throw e; });
  return PL.loading;
}

/* interest areas by ANZSCO prefix (longest match wins) */
const PL_AREAS = { health: ["医疗护理", ["25", "2346", "311", "4114"]], edu: ["教育", ["24", "1341", "4211"]],
  eng: ["工程", ["233", "312"]], it: ["IT", ["26", "313"]], biz: ["商科会计", ["22", "13", "5"]],
  build: ["建筑", ["1331", "232"]], trade: ["技工", ["3"]], social: ["社工法律", ["27", "4117"]],
  sci: ["农业与科学", ["12", "234"]] };
function plArea(c) {
  let best = null, L = 0;
  for (const [k, [, ps]] of Object.entries(PL_AREAS))
    for (const p of ps) if (c.startsWith(p) && p.length > L) { best = k; L = p.length; }
  return best;
}

/* ---- questions ---- */
const PL_QS = [
  { k: "door", t: "你现在在哪一步？", why: "决定后面问什么、比较哪些路。",
    opts: [["new", "还没开始学", "高中毕业、准备读书"], ["study", "在读或刚毕业", "专业已经定了"], ["work", "工作了，想换赛道", "现在的职业邀请太少"]] },
  { k: "cur", input: "occ", t: "现在的职业或专业", skip: () => PLAN.door === "new",
    why: "作为<b>不读书</b>的那一行。在读就填专业对应的职业。" },
  { k: "years", t: "最多愿意再读几年书？", why: "决定能比较哪些路。卡片上会写清楚每条路按几年算、是官方学制还是常见学制。",
    opts: [["0", "不读了"], ["2", "最多 2 年"], ["4", "3–4 年也行"], ["6", "5 年以上也行"]] },
  { k: "areas", multi: true, t: "对哪些方向有兴趣？", why: "可以多选。不选就在全部职业里找。",
    opts: Object.entries(PL_AREAS).map(([k, [n]]) => [k, n]) },
];
const plVis = () => PL_QS.filter(q => !q.skip || !q.skip());

function plTally() {
  const age = plAgeAt(plNow());
  const over = age == null ? {} : { age: plAgeIdx(age) };
  const rows = calcBreakdownWith(over).rows.filter(r => r.pts);
  $pl("plPts").textContent = plScore(over);
  $pl("plTlist").innerHTML = (age == null ? `<li><span>年龄</span><b>先填出生年月</b></li>` : "") +
    rows.map(r => `<li><span>${plEsc(r.label)}</span><b>${r.pts > 0 ? "+" : ""}${r.pts}</b></li>`).join("") +
    `<li><span>分数不对？</span><b><button type="button" class="linkbtn" data-go="points">回「我的分数」改</button></b></li>`;
}
// CALC is the calculator's live state: always put it back, even if scoring throws
function calcBreakdownWith(over) {
  const saved = Object.assign({}, plCalc());
  try { Object.assign(CALC, over); return calcBreakdown(); }
  finally { CALC = saved; }
}

function plRenderQ() {
  const Q = plVis();
  PL.qi = Math.max(0, Math.min(Q.length - 1, PL.qi));
  const q = Q[PL.qi];
  $pl("plProg").innerHTML = Q.map((_, i) => `<i class="${i <= PL.qi ? "on" : ""}"></i>`).join("");
  let body = `<span class="pl-foot">第 ${PL.qi + 1} / ${Q.length} 题</span><h2>${q.t}</h2><p class="pl-why">${q.why}</p>`;
  if (q.input === "occ") {
    const o = PLAN.cur && PL.data.by[PLAN.cur];
    body += `<input type="search" id="plOcc" placeholder="搜职业：中文、英文或代码" autocomplete="off" value="${o ? plEsc((o.zh || o.en) + " " + o.c) : ""}">
      <div class="pl-sug" id="plSug"></div>`;
    body += `<button type="button" class="linkbtn" id="plNoCur">跳过，不比较现在的职业</button>`;
  } else {
    const cur = PLAN[q.k];
    body += `<div class="${q.multi ? "pl-chips" : "pl-opts"}">${q.opts.map(([v, l, s]) => {
      const on = q.multi ? PLAN.areas.includes(v) : String(cur) === String(v);
      return `<button type="button" class="pl-opt" data-v="${v}" aria-pressed="${!!on}"><b>${l}</b>${s ? `<small>${s}</small>` : ""}</button>`;
    }).join("")}</div>`;
  }
  $pl("plQ").innerHTML = body;
  $pl("plBack").disabled = PL.qi === 0;
  $pl("plNext").textContent = PL.qi === Q.length - 1 ? "生成方案" : "下一题";
  if (q.input === "occ") {
    const f = () => plSug($pl("plOcc").value);
    $pl("plOcc").addEventListener("input", f); f();
    $pl("plNoCur").addEventListener("click", () => { PLAN.cur = null; plSave(); plGo(1); });
  }
  $pl("plQ").querySelectorAll(".pl-opt[data-v]").forEach(b => b.addEventListener("click", () => {
    const v = b.dataset.v;
    if (q.multi) {
      PLAN.areas = PLAN.areas.includes(v) ? PLAN.areas.filter(x => x !== v) : PLAN.areas.concat([v]);
      b.setAttribute("aria-pressed", PLAN.areas.includes(v));
    } else {
      PLAN[q.k] = v;
      $pl("plQ").querySelectorAll(".pl-opt[data-v]").forEach(x => x.setAttribute("aria-pressed", x === b));
      setTimeout(() => plGo(1), 160);
    }
    plSave(); plTally();
  }));
  plTally();
}
function plSug(s) {
  s = s.trim().toLowerCase();
  const hits = !s ? [] : PL.data.occ.filter(o => o.c.includes(s) || o.en.toLowerCase().includes(s) ||
    o.zhAll.some(z => z.includes(s))).slice(0, 8);
  $pl("plSug").innerHTML = hits.map(o => `<button type="button" data-c="${o.c}">${plEsc(o.zh || o.en)} <span class="pl-foot">${o.c} ${plEsc(o.en)}</span></button>`).join("");
  $pl("plSug").querySelectorAll("button").forEach(b => b.addEventListener("click", () => {
    PLAN.cur = b.dataset.c; plSave();
    $pl("plOcc").value = (PL.data.by[PLAN.cur].zh || PL.data.by[PLAN.cur].en) + " " + PLAN.cur;
    $pl("plSug").innerHTML = "";
  }));
}
function plGo(d) {
  const Q = plVis(), q = Q[PL.qi];
  if (d > 0 && PL.qi === Q.length - 1) { PLAN.done = true; plSave(); plRender(); return; }
  PL.qi += d; plRenderQ();
}

/* ---- paths ---- */
function plLastMin(o) { for (let i = o.r.length - 1; i >= 0; i--) if (o.r[i][0]) return o.r[i][1]; return null; }

/* How long the course takes. A regulator's own figure when the card has one
   (teachers, social work, psychology, architects); otherwise the common
   course length for the ANZSCO skill level, marked as an assumption. */
function plStudy(o) {
  const card = o.card || {};
  const has = plEduPts(plCalc().edu) >= 15;
  if ("study" in card) {
    const st = card.study;
    if (!st) return null;                              // no plannable study route (specialists etc.)
    const k = has ? "has" : "new";
    return { y: st[k], l: has ? st.hasLabel : st.newLabel,
             official: !!st.ref && !(st.assumed || []).includes(k), src: st.src };
  }
  if (o.skillLevel === 1) return has ? { y: 2, l: "硕士（常见 2 年）" } : { y: 3, l: "本科（常见 3 年）" };
  if (o.skillLevel === 2) return { y: 2, l: "Diploma（常见 2 年）" };
  if (o.skillLevel === 3) return { y: 2, l: o.assessors.some(a => a.abbr === "TRA") ? "Certificate III/IV（常见 2 年）" : "Certificate IV（常见 2 年）" };
  return null;
}
function plPath(o, base) {
  const now = plNow();
  const st = base ? { y: 0, l: "不读书" } : plStudy(o);
  if (!st) return null;
  const w = !base && o.card && o.card.work ? o.card.work : null;
  const work = w ? w.months : 0;
  const eoi = now + st.y * 12 + work, age = plAgeAt(eoi);
  const over = { age: plAgeIdx(age) };
  if (!base) {
    const q = o.skillLevel === 1 ? 15 : 10;
    if (q > plEduPts(plCalc().edu)) over.edu = plEduIdx(q);
    if (st.y >= 2) over.auStudy = 1;
  }
  const pts = plScore(over);
  const min = plLastMin(o), zeros = o.r.slice(1).filter(x => !x[0]).length;
  return { o, st, work, workGap: !base && o.card && o.card.work === null, eoi, age, pts, min,
           margin: min == null ? null : pts - min, zeros, b33: plYm(PLAN.birth) + 33 * 12, base };
}
/* A study route is only offered as a plan once every step is confirmed by an
   official source for someone who is not a PR yet: they can enrol, they can
   finish (placements, apprenticeships), the assessor takes that Australian
   qualification and says how much work it wants, the licence or registration
   is open to them, and the occupation is on the 189 list. A points total that
   clears the cut-off is worth nothing if one of these fails, so routes with an
   unconfirmed step are listed apart, unranked, with the step named. */
const PL_GATES = { enrol: "能入学", finish: "能读完", assess: "能评估", licence: "能注册/执照", visa: "能申请 189" };
function plGates(r) {
  const o = r.o, c = o.card || {}, rt = c.route || {};
  const g = k => rt[k] ? { k, ok: rt[k].ok, t: rt[k].t, src: rt[k].src }
                       : { k, ok: false, t: k === "enrol" ? "有没有收留学生的课程，还没核实" : k === "finish"
                             ? "实习、学徒等环节学生签证能不能做，还没核实" : "留学生毕业后能不能注册或拿执照，还没核实" };
  const checked = (c.notes || []).some(n => n.src);
  const out = [g("enrol"), g("finish"),
    { k: "assess", ok: checked && c.work !== null,
      t: !checked ? "评估条件还没核对" : c.work === null ? "评估要几年工作，官方没写明" : "评估条件已核对" }];
  if (o.regulated) out.push(g("licence"));
  out.push({ k: "visa", ok: o.visas.includes("189"), t: "在 189 职业清单上" });
  return out;
}
const plCur = () => PLAN.door === "new" ? null : PLAN.cur;
function plCandidates() {
  const ys = +(PLAN.years || 0);
  if (!ys) return [];
  return PL.data.occ.filter(o => o.visas.includes("189") && o.skillLevel && o.skillLevel <= 3 && o.c !== plCur())
    .filter(o => !PLAN.areas.length || PLAN.areas.includes(plArea(o.c)))
    .map(o => plPath(o, false)).filter(r => r && r.st.y <= ys)
    .map(r => { r.gates = plGates(r); r.ok = r.gates.every(x => x.ok); return r; });
}
function plRank(r) {
  const S = PLAN.sort, last = r.o.r[r.o.r.length - 1];
  let s = 0;
  if (S.steady) s -= r.zeros * 20 + (last[0] ? 0 : 10);
  if (S.margin) s += r.margin == null ? -40 : Math.max(-25, Math.min(15, r.margin)) * 2;
  if (S.short) s -= (r.st.y * 12 + r.work) / 2;
  // a handful of invitations is not a route anyone can plan on
  return s + Math.log10(1 + last[0]) * 4 - (last[0] < 20 ? 10 : 0);
}

function plNotes(r) {
  const o = r.o, out = [];
  if (r.zeros >= 2) out.push(["bad", `近 ${o.r.length - 1} 轮有 ${r.zeros} 轮 0 邀请`]);
  else if (!r.zeros) out.push(["good", `近 ${o.r.length - 1} 轮每轮都有邀请`]);
  if (r.b33 <= r.eoi) out.push(["bad", `递 EOI 时 ${r.age} 岁，已过 33 岁`]);
  else if (r.b33 - r.eoi < 12) out.push(["warn", `递 EOI 后 ${r.b33 - r.eoi} 个月满 33 岁`]);
  if (!r.base) out.push([r.st.official ? "" : "warn", `${r.st.l}${r.st.official ? "（官方学制）" : "（常见学制，可能不同）"}` +
    (r.work ? ` + 工作 ${o.card.work.label || r.work + " 个月"}` : "")]);
  return out;
}
function plCard(r) {
  const o = r.o, mx = Math.max(1, ...o.r.map(x => x[0]));
  const notes = plNotes(r);
  const cn = (o.card && o.card.notes) || [];
  const ass = o.assessors.map(a => a.abbr).join(" / ") || "—";
  const pinned = PLAN.pinned === o.c && !r.base;
  return `<div class="pl-pc ${r.base ? "base" : ""} ${pinned ? "pin" : ""}">
    <div><h3>${r.base ? "不读书 · " : ""}${plEsc(o.zh || o.en)}</h3>
      <div class="pl-sub">${o.c} ${plEsc(o.en)}${o.pool != null ? ` · 189 在池 ${plFmt(o.pool)}` : ""} · 评估 ${plEsc(ass)}</div>
      <div class="pl-kv"><span>递 EOI<b>${plMon(r.eoi)}</b></span><span>届时<b>${r.pts} 分</b></span>
        <span>上一次最低<b class="${r.margin == null || r.margin < 0 ? "no" : "ok"}">${r.min == null ? "无邀请" : r.min + " 分"}</b></span></div></div>
    <div><span class="pl-foot">189 历次邀请人数 · 最低分</span><div class="pl-rounds">${o.r.map(([n, m], k) =>
      `<div><em>${n ? plFmt(n) : "0"}</em><i class="${n ? "" : "z"}" style="${n ? `height:${Math.max(3, n / mx * 26)}px` : ""}"></i><small>${PL.data.days[k].slice(2, 7)}${m ? " · " + m : ""}</small></div>`).join("")}</div></div>
    <div>${r.base ? "" : `<button type="button" class="pl-pinb" data-c="${o.c}">${pinned ? "已固定" : "固定这条"}</button>`}</div>
    <div class="pl-notes">${notes.map(([c, t]) => `<span class="pl-n ${c}">${plEsc(t)}</span>`).join("")}</div>
    ${r.gates ? `<div class="pl-gates"><span class="pl-foot">能不能走通：</span>${r.gates.map(x =>
      `<span class="pl-n ${x.ok ? "good" : "warn"}" title="${plEsc(x.t)}">${x.ok ? "✓" : "?"} ${PL_GATES[x.k]}${x.src ? ` <a href="${plEsc(x.src)}" target="_blank" rel="noopener">来源</a>` : ""}</span>`).join("")}</div>` : ""}
    ${cn.length ? `<details class="pl-cond"${pinned ? " open" : ""}><summary>评估和注册条件（${cn.length} 条，已核对官方原文）</summary><ul>${cn.map(n =>
      `<li class="${n.gap ? "gap" : ""}">${plEsc(n.t)}${n.src ? ` <a href="${plEsc(n.src)}" target="_blank" rel="noopener">来源</a>` : ""}</li>`).join("")}</ul></details>`
      : o.regulated ? "" : `<p class="pl-foot pl-cond0">${plEsc(ass)} 的评估条件本站还没逐条核对，以评估机构官网为准。</p>`}
  </div>`;
}

function plResults() {
  const D = PL.data;
  const cand = plCandidates();
  const all = cand.filter(r => r.ok).sort((a, b) => plRank(b) - plRank(a));
  const pend = cand.filter(r => !r.ok).sort((a, b) => b.o.r[b.o.r.length - 1][0] - a.o.r[a.o.r.length - 1][0]);
  const cur = plCur() && D.by[plCur()];
  const base = cur ? plPath(cur, true) : null;
  // first screen: the best route in each direction, then the rest by rank
  const seen = new Set(), first = [];
  all.forEach(r => { const a = plArea(r.o.c); if (!seen.has(a) && first.length < 8) { seen.add(a); first.push(r); } });
  all.forEach(r => { if (first.length < 8 && !first.includes(r)) first.push(r); });
  first.sort((a, b) => plRank(b) - plRank(a));
  const shown = PL.showAll ? all : first;
  const ok = all.filter(r => r.margin != null && r.margin >= 0).length;
  const today = plScore({ age: plAgeIdx(plAgeAt(plNow())) });
  $pl("plSum").innerHTML = `<span>今天 <b>${today} 分</b>（189，不含提名）</span><span>最多再读 <b>${+(PLAN.years || 0)} 年</b></span>
    <span>${PLAN.areas.length ? PLAN.areas.map(k => PL_AREAS[k][0]).join("、") : "全部方向"}</span>
    <span>读书年限内能转的 ${cand.length} 个职业里，<b>${all.length}</b> 条每一步都有官方原文确认能走通，其中 <b>${ok}</b> 条届时分数够得上上一次最低分</span>`;
  let baseNote = "";
  if (cur && !cur.visas.includes("189"))
    baseNote = `<p class="pl-warn">${plEsc(cur.zh || cur.en)} 现在不能用于 189（可用签证：${cur.visas.join("、") || "无"}）。</p>`;
  const why = r => r.gates.filter(x => !x.ok).map(x => PL_GATES[x.k] + "：" + x.t).join("；");
  const pendHtml = pend.length ? `<details class="pl-pend"><summary>还没核实能走通的 ${pend.length} 条路线（不排名、不比分数）</summary>
    <p class="pl-foot">这些职业分数上也许够，但从入学到拿评估、注册，至少有一步还没找到官方原文确认留学生能做到。交学费前请自己向学校、评估机构和注册机构问清楚。</p>
    <ul>${pend.slice(0, 60).map(r => { const L = r.o.r[r.o.r.length - 1];
      return `<li><b>${plEsc(r.o.zh || r.o.en)}</b> ${r.o.c} · 上一轮邀请 ${plFmt(L[0])} 人<br>卡在 ${plEsc(why(r))}</li>`; }).join("")}</ul>
    ${pend.length > 60 ? `<p class="pl-foot">只列邀请人数最多的 60 条。</p>` : ""}</details>` : "";
  $pl("plCards").innerHTML = baseNote + (base ? plCard(base) : "") + (shown.length ? shown.map(plCard).join("")
    : `<p class="pl-foot">${!+(PLAN.years || 0) ? "选了「不读了」，所以只比较现在的职业。改答案可以把读书换赛道的路也放进来。"
        : cand.length ? "读书换赛道的路线里，还没有一条每一步都核实过能走通。我们在逐个职业核对，下面列出了卡在哪一步。"
        : "没有符合条件的路线：试试放宽读书年限或兴趣方向。"}</p>`) + pendHtml;
  $pl("plMore").hidden = all.length <= 8;
  $pl("plMore").textContent = PL.showAll ? "只看每个方向最好的一条" : `看全部 ${all.length} 条（按排序）`;
  document.querySelectorAll("#plSort button").forEach(b => b.setAttribute("aria-pressed", !!PLAN.sort[b.dataset.k]));
  $pl("plCards").querySelectorAll(".pl-pinb").forEach(b => b.addEventListener("click", () => {
    PLAN.pinned = PLAN.pinned === b.dataset.c ? null : b.dataset.c; plSave(); plRender();
    if (PLAN.pinned) $pl("plNowBox").scrollIntoView({ behavior: "smooth", block: "start" });
  }));
}

/* ---- once a route is pinned: where things stand ---- */
function plUpgrades(over) {
  const saved = Object.assign({}, plCalc());
  try {
  Object.assign(CALC, over);
  const base = calcBreakdown().total, ups = [];
  for (const f of RULES.fields) {
    // age moves by itself; qualification and Australian study are the route;
    // the Professional Year is open to a few occupations only
    if (["age", "edu", "auStudy", "py", "spec"].includes(f.key)) continue;
    // the next tier up, not the top one: "8 years of Australian work" is not a step anyone can take next
    const now = f.options[CALC[f.key] | 0].v;
    const next = f.options.filter(o => o.v > now).sort((a, b) => a.v - b.v)[0];
    if (!next) continue;
    const keep = CALC[f.key];
    CALC[f.key] = f.options.indexOf(next);
    const nt = calcBreakdown().total;
    CALC[f.key] = keep;
    if (nt > base) ups.push({ label: f.label, to: next.t, gain: nt - base });
  }
  return ups.sort((a, b) => b.gain - a.gain);
  } finally { CALC = saved; }
}
function plFacts(r) {
  const o = r.o, D = PL.data;
  const rounds = o.r.map(([n, m], k) => ({ 日期: D.days[k], 获邀人数: n, 最低分: m }));
  return {
    说明: "按 Schedule 6D 和官方公开数据算出的结果，不是获邀概率",
    今天: { 年月: plMon(plNow()), 分数: plScore({ age: plAgeIdx(plAgeAt(plNow())) }), 年龄: plAgeAt(plNow()) },
    路线: { 职业: o.zh || o.en, 代码: o.c, 评估机构: o.assessors.map(a => a.abbr), 签证: o.visas,
            学习: r.st.l, 学习年数: r.st.y, 学制来源: r.st.official ? "官方" : "常见学制（假设）",
            评估前工作: o.card && o.card.work ? o.card.work.label : null,
            递EOI年月: plMon(r.eoi), 届时年龄: r.age, 届时分数: r.pts, 上一次最低分: r.min,
            分差: r.margin, 满33岁年月: plMon(r.b33), 近几轮189: rounds },
    条件: ((o.card && o.card.notes) || []).map(n => n.t),
    还能加分: plUpgrades({ age: plAgeIdx(r.age) }).map(u => ({ 项目: u.label, 达成后: u.to, 加分: u.gain })),
  };
}
function plRenderNow() {
  const box = $pl("plNowBox"), D = PL.data;
  const o = PLAN.pinned && D.by[PLAN.pinned];
  if (!o) { box.hidden = true; return; }
  const r = plPath(o, false) || plPath(o, true);
  box.hidden = false;
  $pl("plNowTitle").textContent = `我的方案：${o.zh || o.en}`;
  const k = o.r.length - 1, last = o.r[k];
  const ups = plUpgrades({ age: plAgeIdx(r.age) });
  const gapTxt = r.margin == null ? "这个职业最近几轮没有 189 邀请，分数够不够无从比较。"
    : r.margin < 0 ? `届时 ${r.pts} 分，比上一次最低分 ${r.min} 分少 ${-r.margin} 分。`
    : `届时 ${r.pts} 分，比上一次最低分 ${r.min} 分多 ${r.margin} 分。分数线会变，余量越大越稳。`;
  const upTxt = ups.length ? "还能加分：" + ups.slice(0, 3).map(u => `${u.label}到「${u.to}」+${u.gain}`).join("；") + "。"
    : "各项能加的分都已经拿满。";
  const lists = o.lists.join(" / ") || "不在任何清单上";
  const todo = [];
  if (o.regulated) todo.push("先读评估机构和注册机构的要求，尤其注册英语门槛（见下方条件）");
  if (o.card && o.card.work) todo.push(`算上评估前要求的 ${o.card.work.label} 工作，提前找能做这份工作的雇主`);
  if (o.card && o.card.work === null) todo.push("评估前需要几年工作官方没写明，直接问评估机构");
  if (!r.base && r.st.y) todo.push(`查 ${Math.floor(plNow() / 12) + 1} 年入学的「${r.st.l.replace(/（.*$/, "")}」课程，核对是否在评估机构认可名单上`);
  if (!(plCalc().english | 0)) todo.push("英语还没到 Proficient：这是不读书也能加的分");
  $pl("plNow").innerHTML = `
    <div><b>离 PR 还差什么</b>${plEsc(gapTxt)} ${plEsc(upTxt)}</div>
    <div><b>这个职业最近一轮</b>${D.days[k]} 邀请 ${plFmt(last[0])} 人${last[1] ? `，最低 ${last[1]} 分` : ""}。新一轮官方结果发布后，本页当天更新。</div>
    <div><b>清单和签证</b>${plEsc(lists)}；可用签证 ${plEsc(o.visas.join("、") || "无")}。名单每周一核对一次（上次 ${plEsc((D.entry.builtAt || "").slice(0, 10))}），有变动会在这里显示。</div>
    <div><b>接下来做什么</b><ol>${todo.map(t => `<li>${plEsc(t)}</li>`).join("")}</ol></div>`;
  $pl("plAiOut").textContent = "";
  $pl("plAiStat").textContent = "";
}

/* ---- the optional AI read-out ----
   The model gets the fact pack and nothing else, and may not add a number.
   The same check runs in the Worker; this copy covers bring-your-own-key
   providers, which never pass through it. */
const PL_AI_SYSTEM =
  "你是一个解读员。用户会给你一份 JSON 事实包，是本站按澳洲 Schedule 6D 打分规则和官方公开数据算好的结果。" +
  "请用 3 到 5 段大白话中文，向用户解释这条路线：现在多少分、递 EOI 时多少分、和上一次最低分比如何、最需要注意的条件、还能怎么加分。\n" +
  "硬性规则：\n" +
  "1. 只能使用事实包里出现过的数字，不许自己计算或编造任何新数字（包括年份、月份、分数、人数、费用、百分比）。\n" +
  "2. 不许说概率、几率、成功率、把握、保证、一定能之类的话；历史邀请不代表下一轮。\n" +
  "3. 不许推荐事实包以外的职业、课程、学校或签证。\n" +
  "4. 不给移民法律建议；不需要写免责声明，页面已经有。\n" +
  "5. 每段不超过 90 个字，不用标题、不用列表符号、不用 Markdown。";
const PL_AI_BAN = /概率|几率|成功率|把握|保证|一定|肯定|稳拿|稳了|包过|有望|很可能|大概率|应该能|胜算|%|％/;
// Markdown or list markers mean the format rule was ignored
const PL_AI_FMT = /\*\*|^\s*(#|[-*•]\s|\d+[.、)]\s?)/m;
function plNums(t) { return (String(t).replace(/(\d),(?=\d{3})/g, "$1").match(/\d+(?:\.\d+)?/g) || []).map(Number); }
function plAiCheck(text, facts) {
  const allow = new Set(plNums(JSON.stringify(facts)));
  const bad = [...new Set(plNums(text).filter(n => !allow.has(n)))];
  const ban = text.match(PL_AI_BAN) || (PL_AI_FMT.test(text) ? ["标题或列表格式"] : null);
  return { ok: !!text.trim() && !bad.length && !ban, bad, ban: ban && ban[0] };
}
async function plAiRun() {
  const o = PLAN.pinned && PL.data.by[PLAN.pinned];
  if (!o) return;
  const r = plPath(o, false) || plPath(o, true);
  const facts = plFacts(r);
  const stat = $pl("plAiStat"), out = $pl("plAiOut");
  out.textContent = "";
  stat.textContent = "已发送到公共服务，等待返回…";
  try {
    const a = typeof aiAuth === "function" ? aiAuth() : null;
    const res = await fetch(String(PUBLIC_PROXY_URL).replace(/\/+$/, "") + "/plan",
      { method: "POST", body: JSON.stringify({ facts }),
        headers: Object.assign({ "Content-Type": "application/json" }, a ? { Authorization: "Bearer " + a.token } : {}) });
    const d = await res.json().catch(() => ({}));
    // a Worker deployed before /plan existed answers as the occupation match
    if (res.status === 400 && d.error === "text required") throw new Error("解读接口还没上线，过几天再试。");
    if (!res.ok) throw new Error(d.error || "HTTP " + res.status);
    const text = d.content || "";
    const chk = plAiCheck(text, facts);
    if (!chk.ok) {
      stat.textContent = "AI 的回答没通过核对，已丢弃：" +
        (chk.bad.length ? `出现了事实包里没有的数字（${chk.bad.slice(0, 5).join("、")}）` : `出现了「${chk.ban}」这类说法`) +
        "。上面的数字都是按规则算的，以它们为准。";
      return;
    }
    out.textContent = text.trim();
    stat.textContent = "已核对：回答里的每个数字都出自本页算出的结果。";
  } catch (e) {
    stat.textContent = "没拿到解读：" + (e instanceof TypeError ? "连不上服务。" : e.message);
  }
}

/* ---- view ---- */
function plRender() {
  if (!PLAN.birth) {
    $pl("plQuizBox").hidden = $pl("plResBox").hidden = $pl("plNowBox").hidden = true;
    $pl("plStat").innerHTML = `方案要算读完书、递 EOI 时的年龄，先在「我的分数」填出生年月。
      <button type="button" class="linkbtn" data-go="points">去填 →</button>`;
    return;
  }
  const quiz = !PLAN.done;
  $pl("plQuizBox").hidden = !quiz;
  $pl("plResBox").hidden = quiz;
  if (quiz) { $pl("plNowBox").hidden = true; plRenderQ(); return; }
  plRenderNow();
  plResults();
}
let PL_WIRED = false;
function plInit() {
  plLoadState();
  const stat = $pl("plStat");
  if (!PL.data) stat.textContent = "正在载入 489 个职业的清单、评估和邀请数据…";
  plLoad().then(() => {
    // the plan stands on the calculator's answers; say so if there are none yet
    const filled = Object.keys(plCalc()).some(k => k !== "age" && plCalc()[k]);
    stat.innerHTML = filled ? "" : `还没填「我的分数」，下面的分数只算了年龄。
      <button type="button" class="linkbtn" data-go="points">先去填分数 →</button>`;
    if (!PL_WIRED) {
      PL_WIRED = true;
      $pl("plNext").addEventListener("click", () => plGo(1));
      $pl("plBack").addEventListener("click", () => plGo(-1));
      $pl("plRedo").addEventListener("click", () => { PLAN.done = false; PL.qi = 0; plSave(); plRender(); });
      $pl("plMore").addEventListener("click", () => { PL.showAll = !PL.showAll; plResults(); });
      $pl("plSort").addEventListener("click", e => {
        const b = e.target.closest("button"); if (!b) return;
        PLAN.sort[b.dataset.k] = PLAN.sort[b.dataset.k] ? 0 : 1; plSave(); plResults(); });
      $pl("plAiBtn").addEventListener("click", plAiRun);
      $pl("plUnpin").addEventListener("click", () => { PLAN.pinned = null; plSave(); plRender(); });
    }
    plRender();
  }).catch(e => { stat.textContent = "数据没载入成功（" + e.message + "），刷新再试。"; });
}
