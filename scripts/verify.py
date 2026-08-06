"""Sanity-check the extracted CSVs against the live engine and against each other."""
import os
import pandas as pd
from qlik import Engine

D = os.path.join(os.path.dirname(__file__), "..", "data")
p = lambda n: pd.read_csv(os.path.join(D, n))

months = p("months.csv")
ts = p("ts_visa_status.csv")
pts = p("points_visa_status.csv")
occ = p("occupation_visa_status.csv")
LATEST = "07/2026"

print("=== 1. control total from live engine ===")
eng = Engine(); doc = eng.open_doc()
for expr in [f"=COUNT({{$<[As At Month]={{'{LATEST}'}}>}} DISTINCT %EOIID)",
             "=COUNT(DISTINCT %EOIID)"]:
    print(f"  {expr}\n     -> {eng.call('EvaluateEx', doc, [expr])['qValue']['qText']}")
eng.close()
print(f"  months.csv @ {LATEST}: {months.loc[months.as_at_month==LATEST,'eois'].iloc[0]:,}")

print("\n=== 2. cross-file agreement @ latest ===")
def tot(df, extra=None):
    d = df[df.as_at_month == LATEST]
    return d.eois.sum()
print(f"  ts_visa_status  sum : {tot(ts):,}   (>= total; an EOI can hold several visa types)")
print(f"  points_visa_st. sum : {tot(pts):,}")
print(f"  occupation_v_s  sum : {tot(occ):,}")
print(f"  ts vs points identical: {tot(ts) == tot(pts)}")

print("\n=== 3. status mix @ latest ===")
d = ts[ts.as_at_month == LATEST].groupby("eoi_status").eois.sum().sort_values(ascending=False)
print(d.to_string())

print("\n=== 4. does the pool only grow? (cumulative-snapshot check) ===")
m = months[months.as_at_month.str.contains("/")].copy()
m["k"] = m.as_at_month.str[3:] + m.as_at_month.str[:2]
m = m.sort_values("k")
print(m[["as_at_month", "eois"]].to_string(index=False))
print("  monotonically increasing:", (m.eois.diff().dropna() > 0).all())

print("\n=== 5. null / '-' values per file ===")
for n in ["ts_visa_status.csv", "points_visa_status.csv", "state_visa_status.csv",
          "submitted_month.csv", "occupation_visa_status.csv",
          "occupation_points_latest.csv", "attributes_latest.csv"]:
    df = p(n)
    dashes = (df.astype(str) == "-").sum()
    dashes = dashes[dashes > 0]
    print(f"  {n:32s} {len(df):>7,} rows | '-' cells: {dict(dashes) if len(dashes) else 'none'}")

print("\n=== 6. points sanity (should be 0..130-ish, step 5) ===")
print("  distinct points:", sorted(pts.points.dropna().unique().tolist()))

print("\n=== 7. top 10 occupations @ latest, SUBMITTED, 189 ===")
o = occ[(occ.as_at_month == LATEST) & (occ.eoi_status == "SUBMITTED") &
        (occ.visa_type.str.startswith("189"))]
print(o.nlargest(10, "eois")[["occupation", "eois"]].to_string(index=False))
