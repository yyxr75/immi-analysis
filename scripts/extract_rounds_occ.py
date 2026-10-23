"""How many EOIs each occupation had invited in each 189 round, and at what scores.

    python extract_rounds_occ.py

The official round table only gives the minimum score per occupation. The EOI
dashboard has more: every EOI row carries %StatusDate, and for an INVITED EOI
that is the invitation time. So for a round on day R in month M we count, in
the month-M snapshot, the EOIs that are
    INVITED with StatusDate == R, or
    LODGED  with StatusDate in [R, end of M]   (invited and already lodged).
Checked against the official totals: 14,493 / 15,000 (Nov 2024), 6,635 /
6,887 (Aug 2025), 9,960 / 10,000 (Jun 2026) after the noise filter below.
(Also requiring the EOI to be SUBMITTED in the M-1 snapshot undercounts badly
for older rounds, whose earlier snapshots are incomplete.)

Rounds are the official ones in site/data/rounds/ plus any day on which more
than 500 189 EOIs show as INVITED (rounds whose official table we never saw).
When the official table exists, scores below the official minimum and
occupations not in the table are dropped as noise (score changes after the
invitation, lodgements from another subclass); the dropped count is kept.
Without a table, score bands below the lowest band holding at least 5% of the
occupation's count (and 3+ EOIs) are dropped, which removes the same strays.

Writes site/data/round_occ.json.
"""
import calendar
import json
import os
from collections import Counter, defaultdict

from qlik import Engine, cube

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "..", "site", "data")
V189 = "[Visa Type]={'189PTS Points-Tested Stream'}"
SPIKE = 500


def month_of(day):  # '2026-06-04' -> '06/2026'
    return f"{day[5:7]}/{day[:4]}"


def month_end(day):
    y, m = int(day[:4]), int(day[5:7])
    return f"{y}-{m:02d}-{calendar.monthrange(y, m)[1]:02d}"


def official():
    out = {}
    d = os.path.join(DATA, "rounds")
    for f in os.listdir(d) if os.path.isdir(d) else []:
        r = json.load(open(os.path.join(d, f), encoding="utf-8"))
        if "189" in r.get("totals", {}):
            out[r["date"]] = r
    return out


def main():
    occs = json.load(open(os.path.join(DATA, "occupations.json"), encoding="utf-8"))
    code_of = {o["name"]: o["code"] for o in occs}
    meta = json.load(open(os.path.join(DATA, "meta.json")))
    off = official()

    eng = Engine()
    doc = eng.open_doc()
    _, rows = cube(eng, doc, ["As At Month", "=Date(Floor([%StatusDate]),'YYYY-MM-DD')"],
                   [f"COUNT({{<{V189},[EOI Status]={{'INVITED'}}>}} DISTINCT %EOIID)"], suppress_zero=True)
    months = {r[0] for r in rows}
    spikes = Counter()
    for m, day, n in rows:
        if m == month_of(day):  # first snapshot after the round
            spikes[day] += int(n)
    days = sorted(set(off) | {d for d, n in spikes.items() if n >= SPIKE})
    # a round can only be counted once its month is in the dashboard
    days = [d for d in days if month_of(d) in months]

    rounds, per = [], defaultdict(list)
    for day in days:
        m, end = month_of(day), month_end(day)
        _, rows = cube(eng, doc, ["Occupation", "Score", "[EOI Status]", "=Date(Floor([%StatusDate]),'YYYY-MM-DD')"],
                       [f"COUNT({{<[As At Month]={{'{m}'}},{V189},[EOI Status]={{'INVITED','LODGED'}}>}} DISTINCT %EOIID)"],
                       suppress_zero=True)
        got = defaultdict(Counter)
        for occ, score, st, d, n in rows:
            if occ not in code_of or not score.isdigit():
                continue
            if (st == "INVITED" and d == day) or (st == "LODGED" and day <= d <= end):
                got[code_of[occ]][int(score)] += int(n)
        o = off.get(day)
        mins = {x["code"]: x["min"].get("189") for x in o["occupations"] if x.get("code")} if o else None
        dropped = 0
        for code, c in got.items():
            if mins is not None:
                lo = mins.get(code)
            else:
                tot = sum(c.values())
                lo = min((s for s, n in c.items() if n >= max(3, 0.05 * tot)), default=None)
            keep = Counter({s: n for s, n in c.items() if lo is not None and s >= lo})
            dropped += sum(c.values()) - sum(keep.values())
            c = keep
            if c:
                # entry: [round day, EOIs invited, {score: EOIs}, minimum score (the official one when published)]
                per[code].append([day, sum(c.values()), {str(s): n for s, n in sorted(c.items())},
                                  lo if mins is not None else min(c)])
        counted = sum(x[1] for v in per.values() for x in v if x[0] == day)
        rounds.append({"date": day, "official": bool(o), "counted": counted, "dropped": dropped,
                       "invitedOfficial": o["totals"]["189"]["invited"] if o else None,
                       "tieBreak": o["totals"]["189"].get("tieBreak") if o else None,
                       "occupations": sum(1 for v in per.values() if v and v[-1][0] == day)})
        print(f"{day}: counted {counted:,}" + (f" of {o['totals']['189']['invited']:,} official" if o else " (no official table)")
              + f", {dropped} dropped as noise")
    eng.close()

    out = {"visa": "189", "dataMonth": meta.get("latestMonth"), "rounds": rounds, "occ": per}
    with open(os.path.join(DATA, "round_occ.json"), "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    print(f"wrote site/data/round_occ.json: {len(rounds)} rounds, {len(per)} occupations")


if __name__ == "__main__":
    main()
