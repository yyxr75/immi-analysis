"""Extract the SkillSelect EOI dataset into tidy CSVs.

Counts are raw COUNT(DISTINCT %EOIID). The public dashboard masks any cell
below vMinCountMask (=20) for privacy; we keep raw values locally and apply
the mask only when publishing (see analyse.py).
"""
import csv
import os
import time

from qlik import Engine, cube

OUT = os.path.join(os.path.dirname(__file__), "..", "data")
CNT = "COUNT(DISTINCT %EOIID)"


def save(name, cols, rows):
    path = os.path.join(OUT, name)
    with open(path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(cols)
        w.writerows(rows)
    print(f"  -> {name}: {len(rows):,} rows")


def main():
    eng = Engine()
    doc = eng.open_doc()

    # 0. reference: available as-at months
    t0 = time.time()
    cols, rows = cube(eng, doc, ["As At Month"], [CNT], ["as_at_month", "eois"])
    save("months.csv", cols, rows)
    # "As At Month" is MM/YYYY text -> sort by (year, month), not lexically
    def mkey(m):
        mm, yy = m.split("/")
        return (yy, mm)

    months = sorted((r[0] for r in rows if "/" in r[0]), key=mkey)
    earliest, latest = months[0], months[-1]
    print(f"  as-at months: {earliest} .. {latest} ({len(months)})")

    jobs = [
        # name, dims, labels
        ("ts_visa_status.csv",
         ["As At Month", "Visa Type", "EOI Status"],
         ["as_at_month", "visa_type", "eoi_status", "eois"]),

        ("points_visa_status.csv",
         ["As At Month", "Visa Type", "EOI Status", "Score"],
         ["as_at_month", "visa_type", "eoi_status", "points", "eois"]),

        ("state_visa_status.csv",
         ["As At Month", "Visa Type", "EOI Status", "Nominated State"],
         ["as_at_month", "visa_type", "eoi_status", "nominated_state", "eois"]),

        ("submitted_month.csv",
         ["Month Submitted", "Visa Type", "EOI Status"],
         ["month_submitted", "visa_type", "eoi_status", "eois"]),

        ("occupation_visa_status.csv",
         ["As At Month", "Occupation", "Visa Type", "EOI Status"],
         ["as_at_month", "occupation", "visa_type", "eoi_status", "eois"]),
    ]
    for name, dims, labels in jobs:
        print(f"[{time.time()-t0:6.1f}s] {name} ...")
        cols, rows = cube(eng, doc, dims, [CNT], labels)
        save(name, cols, rows)

    # occupation x points, latest snapshot only (otherwise combinatorially huge)
    print(f"[{time.time()-t0:6.1f}s] occupation_points_latest.csv ...")
    sel = f"{{$<[As At Month]={{'{latest}'}}>}}"
    cols, rows = cube(
        eng, doc,
        ["Occupation", "Occupation Group", "Visa Type", "EOI Status", "Score"],
        [f"COUNT({sel} DISTINCT %EOIID)"],
        ["occupation", "occupation_group", "visa_type", "eoi_status", "points", "eois"])
    rows = [r for r in rows if r[-1] not in ("0", "-", None)]
    save("occupation_points_latest.csv", cols, rows)

    # points-attribute breakdown, latest snapshot
    print(f"[{time.time()-t0:6.1f}s] attributes_latest.csv ...")
    attrs = ["English Test Score", "Australian Study Flag", "Regional Study",
             "PartnerSkills Score", "Professional Year", "Comm Language Qual",
             "Specialist Education"]
    all_rows = []
    for a in attrs:
        cols, rows = cube(eng, doc, ["Visa Type", "EOI Status", a],
                          [f"COUNT({sel} DISTINCT %EOIID)"],
                          ["visa_type", "eoi_status", "value", "eois"])
        for r in rows:
            if r[-1] not in ("0", "-", None):
                all_rows.append([a] + r)
    save("attributes_latest.csv", ["attribute", "visa_type", "eoi_status", "value", "eois"],
         all_rows)

    with open(os.path.join(OUT, "SOURCE.txt"), "w") as f:
        f.write(
            "Source: Australian Dept of Employment & Workplace Relations, SkillSelect EOI dashboard\n"
            "Dashboard: https://api.dynamic.reports.employment.gov.au/anonap/extensions/"
            "hSKLS02_SkillSelect_EOI_Data/hSKLS02_SkillSelect_EOI_Data.html\n"
            "Qlik app id: aaac76b5-ad30-477e-9ca0-472f8ab57fc8\n"
            f"App last reload: 2026-08-02\nExtracted via Qlik Engine JSON API.\n"
            f"Measure: COUNT(DISTINCT %EOIID). Dashboard masks cells < 20.\n"
            f"As-at months covered: {earliest} .. {latest}\n")

    print(f"done in {time.time()-t0:.1f}s")
    eng.close()


if __name__ == "__main__":
    main()
