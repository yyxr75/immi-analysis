"""Bulk cubes needed to build every occupation's report without 495 round trips.

qSuppressZero keeps these tractable: the set-analysis measures return 0 for most
dimension combinations, and those rows are dropped engine-side.
"""
import os
import time

from qlik import Engine, cube

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data")
LATEST = "07/2026"


def save(name, cols, rows):
    import csv
    with open(os.path.join(OUT, name), "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(cols)
        w.writerows(rows)
    print(f"  -> {name}: {len(rows):,} rows")


def main():
    eng = Engine()
    doc = eng.open_doc()
    t0 = time.time()

    print("[1/2] all_occ_points.csv  (As At x Occupation x Visa x Score, SUBMITTED only)")
    cols, rows = cube(
        eng, doc,
        ["As At Month", "Occupation", "Visa Type", "Score"],
        ["COUNT({$<[EOI Status]={'SUBMITTED'}>} DISTINCT %EOIID)"],
        ["as_at_month", "occupation", "visa_type", "points", "eois"],
        suppress_zero=True)
    save("all_occ_points.csv", cols, rows)
    print(f"     {time.time()-t0:.0f}s")

    print("[2/2] all_occ_states.csv  (Occupation x Visa x State, latest month, SUBMITTED)")
    cols, rows = cube(
        eng, doc,
        ["Occupation", "Visa Type", "Nominated State"],
        [f"COUNT({{$<[As At Month]={{'{LATEST}'}},"
         "[EOI Status]={'SUBMITTED'}>} DISTINCT %EOIID)"],
        ["occupation", "visa_type", "nominated_state", "eois"],
        suppress_zero=True)
    save("all_occ_states.csv", cols, rows)

    print(f"done in {time.time()-t0:.0f}s")
    eng.close()


if __name__ == "__main__":
    main()
