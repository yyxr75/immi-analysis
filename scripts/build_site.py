"""Build the static site: one JSON per occupation + an app shell that fetches
the selected one on demand.

Everything comes from the bulk cubes in data/, so this makes no engine calls.
Run extract.py / extract_all.py / extract_thresholds.py first.
"""
import datetime
import json
import os
import sys

import pandas as pd

from prep_report import VISA_SHORT, VISA_ORDER, mkey, pct, findings_for

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "..", "data")
SITE = os.path.join(HERE, "..", "site")
SITE_DATA = os.path.join(SITE, "data")

SITE_TITLE = "澳洲技术移民工具箱"
MIN_POOL = 0          # keep every occupation; the picker sorts by size


def code_of(occ):
    return occ.split(" ", 1)[0]


PICKER_HTML = """  <div id="report" hidden>"""

OCCPICKER_HTML = """  <div class="picker">
    <label class="plab" for="occSearch">选择职业（ANZSCO）</label>
    <div class="prow">
      <input type="search" id="occSearch" autocomplete="off"
             placeholder="输入职业名称或代码筛选，例如 software / 2613 / 社工">
      <select id="occSelect" aria-label="职业列表"></select>
    </div>
    <p class="pstat" id="pstat">正在载入职业列表…</p>
  </div>"""

PICKER_CSS = """
.picker { background:var(--surface); border:1px solid var(--hair); border-radius:12px;
          padding:15px 16px; margin:0 0 22px; }
.plab { display:block; font-size:12.5px; color:var(--ink2); margin-bottom:8px; font-weight:600; }
.prow { display:flex; flex-direction:column; gap:8px; }
@media (min-width:640px) { .prow { flex-direction:row; }
  .prow #occSearch { flex:1 1 40%; } .prow #occSelect { flex:1 1 60%; } }
.picker input, .picker select {
  font:inherit; font-size:14px; color:var(--ink); background:var(--plane);
  border:1px solid var(--hair); border-radius:8px; padding:9px 11px; min-height:42px;
  width:100%; max-width:100%; }
.picker input:focus-visible, .picker select:focus-visible {
  outline:2px solid var(--s1); outline-offset:1px; }
.pstat { font-size:12px; color:var(--muted); margin:9px 0 0; }
.err { color:var(--ink); background:var(--grid); border-left:3px solid var(--s2);
       padding:9px 11px; border-radius:0 6px 6px 0; font-size:13px; }
#report[hidden] { display:none; }
#report.busy { opacity:.45; transition:opacity .12s; }
@media (prefers-reduced-motion:reduce) { #report.busy { transition:none; } }
"""

PICKER_JS = """
<script>
/* ---- occupation picker: fetches one occupation's JSON on demand ---- */
(function () {
  const SITE_NAME = "澳洲技术移民工具箱";
  const sel = document.getElementById("occSelect");
  const search = document.getElementById("occSearch");
  const stat = document.getElementById("pstat");
  const report = document.getElementById("report");
  let INDEX = [], current = null;

  const fmtN = n => n.toLocaleString("en-US");
  const label = o => `${o.name} · 在池 ${fmtN(o.pool)}`;

  function fill(list) {
    sel.textContent = "";
    // If the current occupation isn't in the filtered list, the browser would
    // silently select the first option -- and then clicking that option fires
    // no "change" event (the value never changed), so the report would appear
    // frozen. A selected disabled placeholder keeps the control empty instead,
    // so every real pick is a genuine value change.
    if (!list.some(o => o.code === current)) {
      const ph = document.createElement("option");
      ph.value = "";
      ph.textContent = list.length ? "— 请选择职业 —" : "没有匹配的职业";
      ph.disabled = true; ph.selected = true;
      sel.appendChild(ph);
    }
    list.slice(0, 600).forEach(o => {
      const opt = document.createElement("option");
      opt.value = o.code; opt.textContent = label(o);
      if (o.code === current) opt.selected = true;
      sel.appendChild(opt);
    });
  }

  function filtered() {
    const q = search.value.trim().toLowerCase();
    if (!q) return INDEX;
    return INDEX.filter(o => o.name.toLowerCase().includes(q) ||
                             (o.group || "").toLowerCase().includes(q));
  }

  async function load(code) {
    const hit = INDEX.find(o => o.code === code);
    if (!hit) return;
    current = code;
    stat.textContent = `正在载入 ${hit.name} …`;
    report.classList.add("busy");
    try {
      const res = await fetch(`data/${code}.json`, { cache: "force-cache" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const d = await res.json();
      // reveal before boot: charts measure their container, and one drawn while
      // the panel is still hidden comes out at the fallback width
      report.hidden = false;
      boot(d);
      report.classList.remove("busy");
      document.title = `${d.occupation} · ${SITE_NAME}`;
      fill(filtered());        // current changed -> drops the placeholder, marks the pick
      stat.className = "pstat";
      stat.textContent = `共 ${fmtN(INDEX.length)} 个职业可选。当前：${hit.name}`;
      curCode = code;
      const want = hashFor(curView, code);
      if (location.hash !== want) history.replaceState(null, "", want);
    } catch (e) {
      report.classList.remove("busy");
      stat.className = "pstat err";
      stat.textContent = `载入 ${hit.name} 失败：${e.message}。` +
        `如果你是直接双击打开的 HTML 文件，浏览器会拦截本地数据读取——请通过 http 访问。`;
    }
  }

  sel.addEventListener("change", () => { if (sel.value) load(sel.value); });
  search.addEventListener("input", () => {
    const list = filtered();
    fill(list);
    const cur = INDEX.find(o => o.code === current);
    stat.className = "pstat";
    stat.textContent = `${fmtN(list.length)} / ${fmtN(INDEX.length)} 个职业匹配` +
      (list.some(o => o.code === current) ? "" :
       `。下方仍是${cur ? " " + cur.name : "上一个职业"} 的报告，选一个以切换`);
  });
  // Enter loads the top match, so the keyboard path never needs the dropdown
  search.addEventListener("keydown", e => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const list = filtered();
    if (list.length && list[0].code !== current) load(list[0].code);
  });
  addEventListener("hashchange", () => {
    const c = parseHash().code;
    if (c && c !== current) { current = c; fill(filtered()); load(c); }
  });

  // the refresh date is data, not a constant -- it moves every release
  fetch("data/meta.json", { cache: "no-cache" })
    .then(r => r.json())
    .then(m => {
      const el = document.getElementById("src");
      if (!el) return;
      const d = (m.reloadTime || "").slice(0, 10);
      el.textContent = "数据源：澳大利亚就业与劳资关系部 SkillSelect EOI 公开看板（Qlik 引擎接口）。" +
        (d ? `源看板最后刷新 ${d}，` : "") +
        `覆盖至 ${m.latestMonth}，共 ${m.monthsCovered} 个月、${m.occupations} 个职业。`;
    })
    .catch(() => {});

  fetch("data/occupations.json", { cache: "force-cache" })
    .then(r => r.json())
    .then(idx => {
      INDEX = idx;
      const want = parseHash().code;
      current = INDEX.some(o => o.code === want) ? want : INDEX[0].code;
      fill(INDEX);
      load(current);
    })
    .catch(e => {
      stat.className = "pstat err";
      stat.textContent = "职业列表载入失败：" + e.message +
        "。本地预览请用 http 服务访问，不要直接双击打开文件。";
    });
})();
</script>
"""


def build_payload(occ, g_series, g_points, g_rate, g_states, months, mlabel):
    """Same JSON shape prep_report.py emits, assembled from the bulk tables."""
    latest = months[-1]
    out = {"occupation": occ, "months": months,
           "monthLabels": [mlabel[k] for k in months],
           "visaOrder": [], "series": {}, "percentiles": {}, "heat": {},
           "poolPoints": {}, "states": {}, "rate": {}, "findings": {}, "compare": []}

    visas = [v for v in VISA_ORDER if v in set(g_series.visa.dropna())]
    out["visaOrder"] = visas
    if not visas:
        return None

    for visa in visas:
        v = g_series[g_series.visa == visa]
        st = {}
        for status in ["SUBMITTED", "INVITED", "LODGED", "HOLD", "CLOSED"]:
            s = v[v.eoi_status == status].groupby("k").eois.sum()
            st[status] = [int(s.get(k, 0)) for k in months]
        out["series"][visa] = st

        p = g_points[g_points.visa == visa]
        p50, p75, p90 = [], [], []
        for k in months:
            gk = p[p.k == k]
            p50.append(pct(gk.points, gk.eois, .50))
            p75.append(pct(gk.points, gk.eois, .75))
            p90.append(pct(gk.points, gk.eois, .90))
        # a month with no live pool leaves None; carry the previous value so the
        # line stays continuous rather than breaking the chart
        def ffill(xs):
            out_, last = [], None
            for x in xs:
                last = x if x is not None else last
                out_.append(last if last is not None else 0)
            return out_
        out["percentiles"][visa] = {"p50": ffill(p50), "p75": ffill(p75), "p90": ffill(p90)}

        tot_by_pt = p.groupby("points").eois.sum()
        keep = sorted(tot_by_pt[tot_by_pt / max(tot_by_pt.sum(), 1) >= .002].index.tolist())
        if not keep:
            keep = sorted(tot_by_pt.index.tolist())[:1] or [0]
        grid = (p[p.points.isin(keep)]
                .pivot_table(index="k", columns="points", values="eois", aggfunc="sum")
                .reindex(index=months, columns=keep).fillna(0).astype(int))
        out["heat"][visa] = {"points": [int(x) for x in keep],
                             "rows": grid.values.tolist()}

        cur = p[p.k == latest].groupby("points").eois.sum()
        out["poolPoints"][visa] = {"points": [int(x) for x in cur.index],
                                   "counts": [int(x) for x in cur.values]}

        s = g_states[g_states.visa == visa].groupby("nominated_state").eois.sum()
        s = s.sort_values(ascending=False)
        out["states"][visa] = [[str(i), int(x)] for i, x in s.items()]

        r = g_rate[(g_rate.visa == visa) & (g_rate.eois_total >= 10)].sort_values("points")
        out["rate"][visa] = {
            "points": [int(x) for x in r.points],
            "total": [int(x) for x in r.eois_total],
            "invited": [int(x) for x in r.eois_ever_invited],
            "rate": [round(a / b * 100, 1) for a, b in
                     zip(r.eois_ever_invited, r.eois_total)]}

    for visa in visas:
        out["findings"][visa] = findings_for(
            visa, out["series"][visa], out["percentiles"][visa], out["rate"][visa],
            months, mlabel, out["poolPoints"][visa])

    scores = sorted({p for v in visas
                     for p, t in zip(out["rate"][v]["points"], out["rate"][v]["total"])
                     if t >= 50})
    for sc in scores:
        row = {"points": sc, "rates": {}}
        for v in visas:
            R = out["rate"][v]
            hit = [r for p, r, t in zip(R["points"], R["rate"], R["total"])
                   if p == sc and t >= 50]
            row["rates"][v] = hit[0] if hit else None
        if any(x is not None for x in row["rates"].values()):
            out["compare"].append(row)
    return out


def main():
    os.makedirs(SITE_DATA, exist_ok=True)
    print("reading bulk tables ...")
    ser = pd.read_csv(os.path.join(DATA, "occupation_visa_status.csv"))
    pts = pd.read_csv(os.path.join(DATA, "all_occ_points.csv"))
    rate = pd.read_csv(os.path.join(DATA, "thresholds.csv"))
    sts = pd.read_csv(os.path.join(DATA, "all_occ_states.csv"))

    for df in (ser, pts, sts, rate):
        df["visa"] = df.visa_type.map(VISA_SHORT)
    for df in (ser, pts):
        df.drop(df.index[~df.as_at_month.astype(str).str.contains("/")], inplace=True)
        df["k"] = df.as_at_month.map(mkey)
    pts["points"] = pd.to_numeric(pts.points, errors="coerce")
    pts.dropna(subset=["points"], inplace=True)
    ser["eois"] = ser.eois.astype(int)
    pts["eois"] = pts.eois.astype(int)

    months = sorted(ser.k.unique())
    mlabel = {k: f"{k[4:]}/{k[:4]}" for k in months}
    latest = months[-1]
    print(f"  months {mlabel[months[0]]} .. {mlabel[latest]}")

    gser = dict(tuple(ser.groupby("occupation")))
    gpts = dict(tuple(pts.groupby("occupation")))
    grate = dict(tuple(rate.groupby("occupation")))
    gsts = dict(tuple(sts.groupby("occupation")))

    pool = (ser[(ser.k == latest) & (ser.eoi_status == "SUBMITTED")]
            .groupby("occupation").eois.sum())

    index, skipped = [], 0
    occs = sorted(gser.keys())
    for i, occ in enumerate(occs, 1):
        code = code_of(occ)
        if occ not in grate or occ not in gpts:
            skipped += 1
            continue
        payload = build_payload(occ, gser[occ], gpts[occ], grate[occ],
                                gsts.get(occ, sts.iloc[0:0]), months, mlabel)
        if payload is None:
            skipped += 1
            continue
        with open(os.path.join(SITE_DATA, f"{code}.json"), "w") as f:
            json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
        index.append({"code": code, "name": occ, "pool": int(pool.get(occ, 0))})
        if i % 100 == 0:
            print(f"  {i}/{len(occs)} ...")

    # meta drives the "last refreshed" line on the page and lets
    # check_update.py tell whether the source has moved since this build
    from qlik import Engine
    try:
        eng = Engine(); doc = eng.open_doc()
        reload_time = eng.call("GetAppLayout", doc, [])["qLayout"].get("qLastReloadTime")
        eng.close()
    except Exception as e:
        print(f"  ! could not read qLastReloadTime ({e}); meta will omit it")
        reload_time = None
    meta = {"reloadTime": reload_time,
            "latestMonth": mlabel[latest],
            "monthsCovered": len(months),
            "occupations": None,
            "builtAt": datetime.datetime.now(datetime.timezone.utc)
                       .strftime("%Y-%m-%dT%H:%M:%SZ")}

    index.sort(key=lambda o: -o["pool"])
    with open(os.path.join(SITE_DATA, "occupations.json"), "w") as f:
        json.dump(index, f, ensure_ascii=False, separators=(",", ":"))
    meta["occupations"] = len(index)
    with open(os.path.join(SITE_DATA, "meta.json"), "w") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)
    print(f"  meta: reload={meta['reloadTime']} latest={meta['latestMonth']}")

    tpl = open(os.path.join(HERE, "report_template.html")).read()
    html = (tpl.replace("__DATA__", "null")
               .replace("__TITLE__", SITE_TITLE)
               .replace("<!--PICKER-->", PICKER_HTML)
               .replace("<!--OCCPICKER-->", OCCPICKER_HTML)
               .replace('  <p class="foot" id="foot"></p>\n</div>',
                        '  <p class="foot" id="foot"></p>\n  </div>\n</div>')
               .replace("</style>", PICKER_CSS + "</style>")
            + PICKER_JS)
    html = '<!doctype html>\n<html lang="zh-CN">\n<meta charset="utf-8">\n' + html
    with open(os.path.join(SITE, "index.html"), "w") as f:
        f.write(html)

    total = sum(os.path.getsize(os.path.join(SITE_DATA, f))
                for f in os.listdir(SITE_DATA))
    print(f"\nsite/index.html  ({len(html)/1024:.0f} KB)")
    print(f"site/data/       {len(index)} occupations, {total/1024/1024:.1f} MB total")
    print(f"  index file: {os.path.getsize(os.path.join(SITE_DATA,'occupations.json'))/1024:.0f} KB")
    print(f"  skipped (no rate/points data): {skipped}")


if __name__ == "__main__":
    main()
