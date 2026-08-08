/**
 * Shareable report pages.
 *
 * POST /report stores a payload and hands back a link; GET /r/<id> renders it.
 * The link is the credential -- there is nothing else to check -- so the id is
 * 128 bits from the CSPRNG and the page is marked noindex.
 *
 * Two things this file is careful about, because the payload comes from a
 * browser and comes back out as a page on your own domain:
 *
 *   1. Nothing is trusted. Every field is re-typed, clamped and length-capped
 *      by `clean` below; anything not in the shape is dropped. There is no path
 *      by which caller-supplied markup reaches the output -- every value goes
 *      through esc().
 *   2. Nothing is recomputed. The numbers are the ones the page already showed
 *      the user; the report must not disagree with the screen it came from.
 */

const ID_BYTES = 16;
export const REPORT_TTL = 30 * 86400;
const MAX_BODY = 60000;          // a report is a few KB; this is the abuse stop
export const REPORTS_PER_IP_DAY = 20;

export function newId() {
  const a = new Uint8Array(ID_BYTES);
  crypto.getRandomValues(a);
  return [...a].map(b => b.toString(16).padStart(2, "0")).join("");
}

const esc = s => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const str = (v, n) => typeof v === "string" ? v.slice(0, n) : "";
const num = v => (typeof v === "number" && isFinite(v)) ? v : null;
const arr = (v, n) => Array.isArray(v) ? v.slice(0, n) : [];

/** Re-type the whole payload. Unknown keys never survive. */
export function clean(b) {
  const s = b && b.score || {};
  return {
    v: 1,
    at: new Date().toISOString(),
    score: {
      total: num(s.total),
      rows: arr(s.rows, 20).map(r => ({
        label: str(r.label, 60), text: str(r.text, 120),
        pts: num(r.pts), item: str(r.item, 12), part: str(r.part, 12),
      })),
    },
    visas: arr(b && b.visas, 6).map(v => ({
      key: str(v.key, 24), label: str(v.label, 40), score: num(v.score),
    })),
    occupations: arr(b && b.occupations, 20).map(o => ({
      code: /^\d{6}$/.test(o.code) ? o.code : "",
      name: str(o.name, 90), pool: num(o.pool), rel: str(o.rel, 40),
      cells: arr(o.cells, 6).map(c => ({
        visa: str(c.visa, 24), rate: num(c.rate), n: num(c.n),
        at: num(c.at), exact: !!c.exact,
      })),
    })).filter(o => o.code),
    upgrades: arr(b && b.upgrades, 20).map(u => ({
      label: str(u.label, 60), to: str(u.to, 120),
      gain: num(u.gain), score: num(u.score), part: str(u.part, 12),
    })),
    ai: {
      titles: arr(b && b.ai && b.ai.titles, 8).map(t => str(t, 80)),
      study: str(b && b.ai && b.ai.study, 200),
      duties: arr(b && b.ai && b.ai.duties, 12).map(t => str(t, 80)),
    },
    source: str(b && b.source, 200),
  };
}

const fmt = n => n == null ? "—" : String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

const cell = c => {
  if (!c || c.rate == null) return "—";
  return `${c.rate}%` + (c.exact ? "" : `（${c.at}分）`) + (c.n != null && c.n < 50 ? "▲" : "");
};

export function render(d, siteUrl) {
  const visaCols = (d.visas.length ? d.visas
    : [{ key: "189", label: "189", score: d.score.total }])
    .map(v => Object.assign({}, v, {
      // The table has five other columns to fit; "189 独立技术（120 分）" as a
      // header pushed the last two off the page and squeezed the rest into
      // three-line rows. The long form still appears above, on the score cards.
      short: v.key.replace(/\s*\(.*\)/, "") + (v.score == null ? "" : ` · ${v.score}分`),
    }));
  const rows = d.occupations.map(o => `<tr>
      <td class="w">${esc(o.name)}</td>
      ${visaCols.map(v => `<td>${esc(cell(o.cells.find(c => c.visa === v.key)))}</td>`).join("")}
      <td class="n">${fmt(o.pool)}</td><td class="q">${esc(o.rel)}</td></tr>`).join("");

  const brk = d.score.rows.map(r => `<tr>
      <td>${esc(r.label)}</td><td class="q">${esc(r.text)}</td>
      <td class="n">${r.pts == null ? "—" : (r.pts > 0 ? "+" : "") + r.pts}</td>
      <td class="q">${esc(r.item || r.part)}</td></tr>`).join("");

  const ups = d.upgrades.map(u => `<tr>
      <td>${esc(u.label)}</td><td class="q">${esc(u.to)}</td>
      <td class="n">+${u.gain}</td><td class="n">${u.score} 分</td>
      <td class="q">Part ${esc(u.part)}</td></tr>`).join("");

  const when = d.at ? d.at.slice(0, 10) : "";

  return `<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>澳洲移民工具箱 · 评估报告 ${esc(when)}</title>
<style>
:root { color-scheme:light; --plane:#f9f9f7; --surface:#fff; --ink:#0b0b0b; --ink2:#52514e;
        --muted:#898781; --grid:#e1e0d9; --hair:rgba(11,11,11,.10); --accent:#12306e; }
@media (prefers-color-scheme:dark) { :root:where(:not([data-theme="light"])) {
  color-scheme:dark; --plane:#0d0d0d; --surface:#1a1a19; --ink:#fff; --ink2:#c3c2b7;
  --muted:#898781; --grid:#2c2c2a; --hair:rgba(255,255,255,.10); --accent:#7ea6e0; } }
:root[data-theme="dark"] { color-scheme:dark; --plane:#0d0d0d; --surface:#1a1a19; --ink:#fff;
  --ink2:#c3c2b7; --muted:#898781; --grid:#2c2c2a; --hair:rgba(255,255,255,.10); --accent:#7ea6e0; }
*{box-sizing:border-box}
body{margin:0;background:var(--plane);color:var(--ink);
  font:15px/1.62 system-ui,-apple-system,"Segoe UI","PingFang SC",sans-serif}
.wrap{max-width:860px;margin:0 auto;padding:30px 16px 70px}
h1{font-size:22px;margin:0 0 4px;letter-spacing:-.01em}
.sub{color:var(--ink2);font-size:13px;margin:0 0 26px}
h2{font-size:16px;margin:32px 0 10px}
.cap{color:var(--ink2);font-size:12.5px;margin:0 0 12px}
.big{display:flex;flex-wrap:wrap;gap:10px;margin:0 0 6px}
.big div{background:var(--surface);border:1px solid var(--hair);border-radius:10px;
  padding:12px 16px;min-width:132px}
.big .l{font-size:12px;color:var(--ink2)}
.big .v{font-size:25px;font-weight:700;font-variant-numeric:tabular-nums;letter-spacing:-.02em}
.tw{overflow-x:auto;-webkit-overflow-scrolling:touch;border:1px solid var(--hair);border-radius:10px;background:var(--surface)}
table{border-collapse:collapse;width:100%;font-size:13.5px}
th,td{text-align:left;padding:8px 11px;border-bottom:1px solid var(--grid);white-space:nowrap;
  vertical-align:top}
td.w,th.w{white-space:normal;min-width:190px}
th{color:var(--ink2);font-weight:600;font-size:12.5px}
tr:last-child td{border-bottom:0}
td.n{text-align:right;font-variant-numeric:tabular-nums}
td.q,th.q{color:var(--ink2);white-space:normal}
.note{font-size:12.5px;color:var(--ink2);line-height:1.7;background:var(--grid);
  border-radius:9px;padding:12px 14px;margin:14px 0 0}
.note b{color:var(--ink)}
.foot{margin-top:34px;padding-top:16px;border-top:1px solid var(--grid);
  font-size:11.5px;color:var(--muted);line-height:1.7}
a{color:var(--accent)}
@media print{body{background:#fff}.tw{border-color:#ccc}}
</style>
<div class="wrap">
<h1>澳洲技术移民评估报告</h1>
<p class="sub">生成于 ${esc(when)}${d.ai.titles.length ? " · 依据简历：" + esc(d.ai.titles.join("、")) : ""}${d.ai.study ? " · 专业：" + esc(d.ai.study) : ""}</p>

<h2>一、你的分数</h2>
<div class="big">${visaCols.map(v =>
  `<div><div class="l">${esc(v.label)}</div><div class="v">${v.score == null ? "—" : v.score}</div></div>`).join("")}</div>
<p class="cap">按 Migration Regulations 1994 Schedule 6D 逐条计算。190 含州提名 5 分（6D121），491 含偏远地区提名 15 分（6D131）。</p>
<div class="tw"><table>
<tr><th>项目</th><th class="q">你选的</th><th>分数</th><th class="q">条目</th></tr>
${brk || '<tr><td colspan="4">（未填写打分表）</td></tr>'}
</table></div>

<h2>二、可能匹配的职业</h2>
<p class="cap">每格是「正好在那一档」的人里历史上获邀的比例，不是「≥该分数」的累计值。官方按 5 分一档发布，括号里标出实际取的是哪一档，读的时候要当成下限。带 ▲ 的样本不足 50，不可靠。</p>
<div class="tw"><table>
<tr><th class="w">职业</th>${visaCols.map(v =>
  `<th>${esc(v.short)}</th>`).join("")}<th>在池</th><th class="q">关系</th></tr>
${rows || `<tr><td colspan="${visaCols.length + 3}">（没有职业数据）</td></tr>`}
</table></div>

<h2>三、再加分的话</h2>
${ups ? `<div class="tw"><table>
<tr><th>加分项</th><th class="q">达成后</th><th>加分</th><th>基础分变为</th><th class="q">Schedule</th></tr>
${ups}</table></div>` : '<p class="cap">各项均已达最高档，没有可再加的分。</p>'}
<p class="note">工作经验受 Part 6D.5 的 20 分合计上限约束，所以某些升级可能一分都不加——上表已经把这种情况剔除了。</p>

<h2>四、这份报告的口径</h2>
<p class="note">
<b>数字来自哪</b>：澳大利亚内政部 SkillSelect 公开看板。「在池」是 EOI Status = SUBMITTED 的去重 EOI 数（COUNT DISTINCT），获邀率＝该分数档里状态为 INVITED 或 LODGED 的比例。打分规则来自 Migration Regulations 1994 Schedule 6D，每一项都标了条目号，可自行核对。<br><br>
<b>哪些不可靠</b>：高分档人数很少，带 ▲ 的格子样本不足 50，一两个人的差别就能让百分比大幅跳动。官方按 5 分一档发布，你的分数没有对应档位时会落到更低的档，括号里已标出。SkillSelect 的月度快照存在回填，本报告因此不含任何「增长趋势」类结论。<br><br>
<b>这份报告不是什么</b>：它是历史统计，不是对你结果的预测。获邀率高只说明那个职业历史上竞争没那么激烈，不代表你能通过它的职业评估——那由评估机构判定。本站不是移民中介，不提供个案建议；涉及你个人情况的正式意见，请咨询持牌移民代理（MARA）。
</p>

<p class="foot">澳洲移民工具箱${siteUrl ? ` · <a href="${esc(siteUrl)}">${esc(siteUrl)}</a>` : ""}<br>
这个链接本身就是凭证，谁拿到谁能看，${Math.round(REPORT_TTL / 86400)} 天后失效。转发前想一下。</p>
</div>
</html>`;
}

export const tooBig = body => JSON.stringify(body).length > MAX_BODY;
