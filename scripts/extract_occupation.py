"""Extract the full time x points x status cube for a single occupation.

Usage: python extract_occupation.py "233411 Electronics Engineer"
"""
import csv
import os
import re
import sys
import time

from qlik import Engine, cube

OUT = os.path.join(os.path.dirname(__file__), "..", "data", "occ")
os.makedirs(OUT, exist_ok=True)


def save(name, cols, rows):
    with open(os.path.join(OUT, name), "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(cols)
        w.writerows(rows)
    print(f"  -> occ/{name}: {len(rows):,} rows")


def main(occupation):
    slug = re.sub(r"\W+", "_", occupation).strip("_").lower()
    eng = Engine()
    doc = eng.open_doc()
    t0 = time.time()

    # set-analysis filter pinning this one occupation; everything else stays unselected
    f = f"{{$<Occupation={{'{occupation}'}}>}}"
    cnt = f"COUNT({f} DISTINCT %EOIID)"

    jobs = [
        ("time_points.csv",
         ["As At Month", "Visa Type", "EOI Status", "Score"],
         ["as_at_month", "visa_type", "eoi_status", "points", "eois"]),
        ("time_state.csv",
         ["As At Month", "Visa Type", "EOI Status", "Nominated State"],
         ["as_at_month", "visa_type", "eoi_status", "nominated_state", "eois"]),
        ("inflow.csv",
         ["Month Submitted", "Visa Type", "EOI Status"],
         ["month_submitted", "visa_type", "eoi_status", "eois"]),
        ("attributes.csv",
         ["As At Month", "Visa Type", "EOI Status", "English Test Score"],
         ["as_at_month", "visa_type", "eoi_status", "english_score", "eois"]),
        # No As At Month dimension -> distinct EOIs that were EVER in each status.
        # Summing the monthly INVITED stock would double-count anyone whose
        # invitation straddled two month-ends; this de-duplicates them.
        ("ever.csv",
         ["Visa Type", "EOI Status", "Score"],
         ["visa_type", "eoi_status", "points", "eois"]),
    ]
    for name, dims, labels in jobs:
        cols, rows = cube(eng, doc, dims, [cnt], labels)
        rows = [r for r in rows if r[-1] not in ("0", "-", None)]
        save(f"{slug}__{name}", cols, rows)

    # Invitation rate by points. Both measures are DISTINCT counts of %EOIID:
    # statuses must not be summed (one EOI passes through SUBMITTED -> CLOSED and
    # would be counted twice), and LODGED is a subset of INVITED, so the numerator
    # is the de-duplicated union of the two.
    cols, rows = cube(
        eng, doc, ["Visa Type", "Score"],
        [f"COUNT({f} DISTINCT %EOIID)",
         f"COUNT({{$<Occupation={{'{occupation}'}},"
         f"[EOI Status]={{'INVITED','LODGED'}}>}} DISTINCT %EOIID)"],
        ["visa_type", "points", "eois_total", "eois_ever_invited"])
    rows = [r for r in rows if r[2] not in ("0", "-", None)]
    save(f"{slug}__rate.csv", cols, rows)

    print(f"done in {time.time()-t0:.1f}s  (occupation = {occupation})")
    eng.close()


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "233411 Electronics Engineer")
