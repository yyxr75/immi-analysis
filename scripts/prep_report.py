"""Turn one occupation's cubes into the compact JSON the HTML report reads.

Usage: python prep_report.py "233411 Electronics Engineer"
"""
import json
import os
import re
import sys

import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
OCC = os.path.join(HERE, "..", "data", "occ")
OUT = os.path.join(HERE, "..", "output")
os.makedirs(OUT, exist_ok=True)

# short labels; the raw Qlik strings are long and repeat the subclass number
VISA_SHORT = {
    "189PTS Points-Tested Stream": "189",
    "190SAS Skilled Australian Sponsored": "190",
    "491SNR State or Territory Nominated - Regional": "491 (州担保)",
    "491FSR Family Sponsored - Regional": "491 (亲属担保)",
}
VISA_ORDER = ["189", "190", "491 (州担保)", "491 (亲属担保)"]


def mkey(m):
    """'07/2026' -> '202607' so months sort chronologically."""
    mm, yy = m.split("/")
    return yy + mm


def pct(vals, weights, q):
    """Weighted quantile over integer points buckets."""
    df = pd.DataFrame({"v": vals, "w": weights}).dropna().sort_values("v")
    if df.empty or df.w.sum() == 0:
        return None
    cum = df.w.cumsum() / df.w.sum()
    hit = df.v[cum >= q]
    return float(hit.iloc[0]) if len(hit) else float(df.v.iloc[-1])


def trend_word(delta, flat=2.5):
    return "上升" if delta > flat else ("下降" if delta < -flat else "基本持平")


def findings_for(visa, S, P, R, months, mlabel, poolPts):
    """Derive the written conclusions from the numbers, so they hold for any
    occupation rather than being hand-written for one.

    Deliberately makes NO claim about growth over time: the As At Month panel
    back-fills (see README / data/coverage_check.csv), so month-over-month
    levels are not comparable. Everything here rests either on the latest
    snapshot or on the rate table, which has no As At Month dimension at all.
    """
    out = []
    sub = S["SUBMITTED"]
    now = sub[-1]
    last_m = mlabel[months[-1]]

    # --- 1. current scale and the shape of the live pool (latest snapshot only)
    pts, cnt = poolPts["points"], poolPts["counts"]
    tot = sum(cnt) or 1
    out.append({"label": "规模",
                "text": f"截至 {last_m}，{visa} 的在池（SUBMITTED）EOI 共 {now:,} 份，"
                        f"中位分 {P['p50'][-1]:.0f} 分，90 分位 {P['p90'][-1]:.0f} 分。"})

    # --- 2. where the invitation threshold actually sits, and its shape
    solid = [(p, r, t) for p, r, t in zip(R["points"], R["rate"], R["total"]) if t >= 50]
    bar10 = next((p for p, r, t in solid if r >= 10), None)
    bar50 = next((p for p, r, t in solid if r >= 50), None)
    jump, jump_at = 0, None
    for i in range(1, len(solid)):
        d = solid[i][1] - solid[i - 1][1]
        if d > jump:
            jump, jump_at = d, solid[i][0]
    if bar10 is None:
        out.append({"label": "门槛",
                    "text": "所有样本量足够（n≥50）的分数段，获邀率都没到 10%——"
                            "这条通道目前基本走不通，不要只看分数堆到多高。"})
    else:
        rate10 = next(r for p, r, t in solid if p == bar10)
        n10 = next(t for p, r, t in solid if p == bar10)
        prev = next((solid[i - 1][0] for i in range(1, len(solid))
                     if solid[i][0] == jump_at), None)
        shape = (f"而且是一道悬崖——从 {prev} 分到 {jump_at} 分，获邀率一档之间"
                 f"跳了 {jump:.0f} 个百分点" if jump >= 15 and prev is not None
                 else "获邀率随分数平缓爬升，是斜坡而不是一刀切的分数线")
        tail = f"；到 {bar50} 分获邀率过半" if bar50 else ""
        out.append({"label": "门槛",
                    "text": f"获邀率在 {bar10} 分首次突破 10%（{rate10}%，n={n10}）{tail}。{shape}。"})

        # --- 3. how crowded it is at or above that threshold, right now
        at_or_above = sum(c for p, c in zip(pts, cnt) if p >= bar10)
        out.append({"label": "定位",
                    "text": f"当前在池的 {now:,} 人里，有 {at_or_above:,} 人（{at_or_above/tot*100:.0f}%）"
                            f"已经达到或超过 {bar10} 分。低于这条线的那 {100-at_or_above/tot*100:.0f}%，"
                            f"从历史数据看获邀率都在 10% 以下。"})

    # --- 4. invitation activity: a stock, and only ever a lower bound
    inv = S["INVITED"]
    peak = max(inv)
    peak_m = mlabel[months[inv.index(peak)]]
    recent = [x for x in inv[-6:]]
    if sum(recent) == 0:
        rhythm = "最近 6 个月的月末快照里一个持有有效邀请的人都没抓到"
    else:
        rhythm = f"最近 6 个月每月抓到 {min(recent)}–{max(recent)} 人"
    out.append({"label": "节奏",
                "text": f"月末持有有效邀请的人数峰值出现在 {peak_m}（{peak} 人）；{rhythm}。"
                        f"这是月末存量而非邀请发放量，只能当下限读。"})

    # --- 5. the caveat that governs how far any of the above can be pushed
    out.append({"label": "可信度",
                "text": "获邀率与门槛结论来自不带时间维的完整记录，可信。"
                        "但按月的人数曲线不可用来判断“池子涨了几倍”——"
                        "该看板的月度面板存在回填，早期月份覆盖不全（详见口径说明第 6 条）。"})
    return out


def positioning(visa, poolPoints):
    """Where a given score sits inside the current live pool."""
    pts, cnt = poolPoints["points"], poolPoints["counts"]
    total = sum(cnt) or 1
    rows = []
    for p, c in zip(pts, cnt):
        above = sum(x for q, x in zip(pts, cnt) if q > p)
        rows.append({"points": p, "share": round(c / total * 100, 1),
                     "aboveShare": round(above / total * 100, 1)})
    return rows


def main(occupation):
    slug = re.sub(r"\W+", "_", occupation).strip("_").lower()
    tp = pd.read_csv(os.path.join(OCC, f"{slug}__time_points.csv"))
    ts = pd.read_csv(os.path.join(OCC, f"{slug}__time_state.csv"))
    rt = pd.read_csv(os.path.join(OCC, f"{slug}__rate.csv"))
    rt["visa"] = rt.visa_type.map(VISA_SHORT)
    rt = rt[rt.points != "-"].copy()
    rt["points"] = rt.points.astype(int)

    for df in (tp, ts):
        df["visa"] = df.visa_type.map(VISA_SHORT)
        df.drop(df.index[df.as_at_month.isna()], inplace=True)

    tp = tp[tp.as_at_month.astype(str).str.contains("/")].copy()
    ts = ts[ts.as_at_month.astype(str).str.contains("/")].copy()
    tp["k"] = tp.as_at_month.map(mkey)
    ts["k"] = ts.as_at_month.map(mkey)
    tp["points"] = pd.to_numeric(tp.points, errors="coerce")

    months = sorted(tp.k.unique())
    mlabel = {k: f"{k[4:]}/{k[:4]}" for k in months}

    out = {
        "occupation": occupation,
        "months": months,
        "monthLabels": [mlabel[k] for k in months],
        "visaOrder": [v for v in VISA_ORDER if v in set(tp.visa.dropna())],
        "series": {},        # visa -> status -> [count per month]
        "percentiles": {},   # visa -> {p50,p75,p90} -> [per month]
        "heat": {},          # visa -> {points:[...], rows:[[count per points] per month]}
        "invitedPoints": {}, # visa -> {points:[...], counts:[...]}
        "poolPoints": {},    # visa -> {points:[...], counts:[...]}  (latest month, SUBMITTED)
        "states": {},        # visa -> [[state, count], ...] latest month SUBMITTED
        "rate": {},          # visa -> {points, total, invited, rate}
        "findings": {},      # visa -> [{label, text}]
        "positioning": {},   # visa -> [{points, share, aboveShare}]
        "compare": [],       # cross-visa odds at a common score
    }
    latest = months[-1]

    for visa in out["visaOrder"]:
        v = tp[tp.visa == visa]

        # --- stock per status per month
        st = {}
        for status in ["SUBMITTED", "INVITED", "LODGED", "HOLD", "CLOSED"]:
            g = v[v.eoi_status == status].groupby("k").eois.sum()
            st[status] = [int(g.get(k, 0)) for k in months]
        out["series"][visa] = st

        # --- points percentiles of the LIVE pool (SUBMITTED) per month
        sub = v[v.eoi_status == "SUBMITTED"]
        p50, p75, p90 = [], [], []
        for k in months:
            g = sub[sub.k == k]
            p50.append(pct(g.points, g.eois, 0.50))
            p75.append(pct(g.points, g.eois, 0.75))
            p90.append(pct(g.points, g.eois, 0.90))
        out["percentiles"][visa] = {"p50": p50, "p75": p75, "p90": p90}

        # --- heatmap: month x points (SUBMITTED), trimmed to the meaningful range
        pool = sub.groupby(["k", "points"]).eois.sum().reset_index()
        keep = sorted(pool.groupby("points").eois.sum()
                      .pipe(lambda s: s[s / s.sum() >= 0.002]).index.tolist())
        grid = (pool[pool.points.isin(keep)]
                .pivot_table(index="k", columns="points", values="eois", aggfunc="sum")
                .reindex(index=months, columns=keep).fillna(0).astype(int))
        out["heat"][visa] = {"points": [int(p) for p in keep],
                             "rows": grid.values.tolist()}

        # --- invited: pooled over all months (stock is tiny in any single month)
        inv = v[v.eoi_status == "INVITED"].groupby("points").eois.sum()
        inv = inv[inv.index.notna()]
        out["invitedPoints"][visa] = {"points": [int(p) for p in inv.index],
                                      "counts": [int(x) for x in inv.values]}

        # --- pool points at the latest month, for the side-by-side comparison
        cur = sub[sub.k == latest].groupby("points").eois.sum()
        cur = cur[cur.index.notna()]
        out["poolPoints"][visa] = {"points": [int(p) for p in cur.index],
                                   "counts": [int(x) for x in cur.values]}

        # --- nominated state, latest month, live pool
        s = ts[(ts.visa == visa) & (ts.k == latest) & (ts.eoi_status == "SUBMITTED")]
        s = s.groupby("nominated_state").eois.sum().sort_values(ascending=False)
        out["states"][visa] = [[str(i), int(x)] for i, x in s.items()]

        # --- invitation rate by points (distinct EOIs, see extract_occupation.py)
        r = rt[(rt.visa == visa) & (rt.eois_total >= 10)].sort_values("points")
        out["rate"][visa] = {
            "points": [int(x) for x in r.points],
            "total": [int(x) for x in r.eois_total],
            "invited": [int(x) for x in r.eois_ever_invited],
            "rate": [round(a / b * 100, 1) for a, b in
                     zip(r.eois_ever_invited, r.eois_total)],
        }

    for visa in out["visaOrder"]:
        out["findings"][visa] = findings_for(
            visa, out["series"][visa], out["percentiles"][visa], out["rate"][visa],
            months, mlabel, out["poolPoints"][visa])
        out["positioning"][visa] = positioning(visa, out["poolPoints"][visa])

    # cross-visa: at each score, which visa type actually gives the best odds
    scores = sorted({p for v in out["visaOrder"]
                     for p, t in zip(out["rate"][v]["points"], out["rate"][v]["total"])
                     if t >= 50})
    for s in scores:
        row = {"points": s, "rates": {}}
        for v in out["visaOrder"]:
            R = out["rate"][v]
            hit = [(r, t) for p, r, t in zip(R["points"], R["rate"], R["total"])
                   if p == s and t >= 50]
            row["rates"][v] = hit[0][0] if hit else None
        if any(x is not None for x in row["rates"].values()):
            out["compare"].append(row)

    path = os.path.join(OUT, f"{slug}__report.json")
    json.dump(out, open(path, "w"), ensure_ascii=False)
    print(f"wrote {path}")

    # ---- console sanity read-out (look at the numbers before rendering) ----
    print(f"\n=== {occupation} | {mlabel[months[0]]} .. {mlabel[latest]} ===")
    for visa in out["visaOrder"]:
        s, p = out["series"][visa], out["percentiles"][visa]
        print(f"\n[{visa}]  live pool {s['SUBMITTED'][0]:,} -> {s['SUBMITTED'][-1]:,}"
              f"   ({(s['SUBMITTED'][-1]/max(s['SUBMITTED'][0],1)):.1f}x)")
        print(f"  median points {p['p50'][0]} -> {p['p50'][-1]}   "
              f"p75 {p['p75'][0]} -> {p['p75'][-1]}   p90 {p['p90'][0]} -> {p['p90'][-1]}")
        print(f"  INVITED stock by month: {s['INVITED']}")
        ip = out["invitedPoints"][visa]
        tot = sum(ip["counts"])
        print(f"  invited-points pooled (n={tot}): "
              f"{list(zip(ip['points'], ip['counts']))}")
        print(f"  top states: {out['states'][visa][:5]}")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "233411 Electronics Engineer")
