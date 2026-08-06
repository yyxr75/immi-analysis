"""Invitation rate by (occupation, visa type, score) for EVERY occupation.

No As At Month dimension -> unaffected by the panel back-fill documented in
README, so these thresholds are comparable across occupations.
"""
import os
import pandas as pd
from qlik import Engine, cube

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data")

eng = Engine()
doc = eng.open_doc()
cols, rows = cube(
    eng, doc,
    ["Occupation", "Visa Type", "Score"],
    ["COUNT(DISTINCT %EOIID)",
     "COUNT({$<[EOI Status]={'INVITED','LODGED'}>} DISTINCT %EOIID)"],
    ["occupation", "visa_type", "points", "eois_total", "eois_ever_invited"])
eng.close()

d = pd.DataFrame(rows, columns=cols)
d = d[(d.points != "-") & d.occupation.notna()].copy()
d["points"] = pd.to_numeric(d.points, errors="coerce")
for c in ("eois_total", "eois_ever_invited"):
    d[c] = pd.to_numeric(d[c], errors="coerce").fillna(0).astype(int)
d = d.dropna(subset=["points"])
d["points"] = d.points.astype(int)
d = d[d.eois_total > 0]
d["rate"] = (d.eois_ever_invited / d.eois_total * 100).round(1)
d.to_csv(os.path.join(OUT, "thresholds.csv"), index=False)
print(f"wrote data/thresholds.csv: {len(d):,} rows, "
      f"{d.occupation.nunique()} occupations")


def bar(g, min_n=50, min_rate=10):
    """Lowest score whose invitation rate clears min_rate on a real sample."""
    s = g[g.eois_total >= min_n].sort_values("points")
    hit = s[s.rate >= min_rate]
    return pd.Series({
        "分数线": int(hit.points.iloc[0]) if len(hit) else None,
        "该线获邀率%": hit.rate.iloc[0] if len(hit) else None,
        "该线样本n": int(hit.eois_total.iloc[0]) if len(hit) else None,
        "EOI总数": int(g.eois_total.sum()),
        "曾获邀": int(g.eois_ever_invited.sum()),
    })


summary = (d.groupby(["occupation", "visa_type"]).apply(bar, include_groups=False)
           .reset_index())
summary.to_csv(os.path.join(OUT, "thresholds_summary.csv"), index=False)
print("wrote data/thresholds_summary.csv")
