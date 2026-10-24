"""What it takes to get into each occupation: lists, visas, assessor, skill level.

    python occ_entry.py                 # fetch both sources, write if changed
    python occ_entry.py --sol f --anzsco g   # use saved copies instead

The EOI dashboard tells us how occupations do once people are in the pool.
The plan view also needs the way in: which visas an occupation can be used
for, who assesses it, and what level of qualification it normally takes.
Two official sources cover that for every occupation we track:

  Home Affairs "Skilled occupation list" page. A SharePoint shell like the
  rounds page; all 700-odd occupations sit as HTML-escaped JSON in one input
  value: lists (MLTSSL/STSOL/ROL/CSOL), eligible visas, assessing authority.

  ABS ANZSCO 2022 structure workbook. Table 5 gives each six-digit occupation
  its skill level (1 = bachelor or higher, 2 = diploma, 3 = Cert III/IV with
  on-the-job training, 4-5 = lower certificates). Codes that changed after
  ANZSCO 2013 (which SkillSelect still uses) fall back to the unit, minor or
  sub-major group's predominant level, and say so.

Occupations whose assessor is also a registration or licensing body (nurses,
teachers, doctors, licensed trades...) are flagged `regulated`: their extra
conditions (registration English, licences, required experience) are checked
by hand and kept in data/occ_manual/<group>.json with a source for every value;
when a file covers an occupation it is merged in under `manual`.

Writes site/data/occ_entry.json. Prints changed=true|false (and a one-line
summary of what moved) to $GITHUB_OUTPUT when set.
"""
import html
import io
import json
import os
import re
import sys
import urllib.request
from datetime import datetime, timezone

import openpyxl

SOL_URL = "https://immi.homeaffairs.gov.au/visas/working-in-australia/skill-occupation-list"
ANZSCO_URL = ("https://www.abs.gov.au/statistics/classifications/anzsco-australian-and-new-zealand-standard-"
              "classification-occupations/2022/anzsco%202022%20structure%20062023.xlsx")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "site", "data")
MANUAL = os.path.join(ROOT, "data", "occ_manual")
OUT = os.path.join(DATA, "occ_entry.json")

# assessors that also register or license the profession
REGULATORS = {"MedBA", "ANMAC", "APC", "OTC", "APharmC", "ADC", "ASMIRT", "AIMS", "CMBA", "AITSL", "ACECQA",
              "AASW", "APS", "Legal admissions authority of a state or territory", "CASA", "SPA", "AVBC", "AACA",
              "CCEA", "DAA", "OCANZ", "AOAC", "Community Work Australia"}
LICENSED_TRADES = {"341111", "341112", "341113", "334111", "334112", "334113", "334114", "334115", "342111"}

# ANZSCO skill level -> the qualification it is commensurate with, and the
# Schedule 6D points that qualification earns (None: no points of its own)
LEVELS = {1: ("本科或以上", 15), 2: ("Diploma / Advanced Diploma / 副学士", 10),
          3: ("Certificate IV，或 Certificate III 加至少两年在岗培训", 10),
          4: ("Certificate II/III", None), 5: ("Certificate I", None)}


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (ausimmitool.com data refresh)"})
    with urllib.request.urlopen(req, timeout=90) as r:
        return r.read()


def text(v):
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " | ", v or ""))).strip()


def parse_sol(page):
    m = re.search(r'value="(\[\{&quot;occupation&quot;.*?\}\])"', page, re.S)
    if not m:
        raise SystemExit("occupation list page changed: embedded data not found")
    out = {}
    for x in json.loads(html.unescape(m.group(1))):
        codes = text(x.get("anzscocode"))
        c13 = re.search(r"ANZSCO 2013[^|]*?(\d{6})", codes) or re.search(r"(\d{6})", codes)
        if not c13:
            continue
        parts = [p.strip() for p in text(x.get("assessauth")).split("|") if p.strip().strip("​")]
        auth = []
        for i, p in enumerate(parts):
            if i + 1 < len(parts) and parts[i + 1] == "Assessing authority":
                name = parts[i + 2] if i + 2 < len(parts) else p
                url = next((q for q in parts[i + 2:i + 5] if q.startswith("http")), None)
                auth.append({"abbr": p, "name": name, "url": url})
        visas = sorted({v.split(" ")[0] for v in (x.get("visas") or "").split(";") if v.strip()})
        out.setdefault(c13.group(1), {
            "title": x["occupation"],
            "lists": [s for s in (x.get("list") or "").split(";") if s],
            "visas": visas,
            "assessors": auth,
        })
    return out


def parse_anzsco(xlsx):
    wb = openpyxl.load_workbook(io.BytesIO(xlsx), read_only=True)

    def level(v):  # 1, '1,2', '1 Aus,2 NZ' -> the Australian (or first) level
        if v is None:
            return None
        m = re.search(r"(\d)\s*Aus", str(v)) or re.search(r"(\d)", str(v))
        return int(m.group(1)) if m else None

    occ, groups = {}, {}
    # (sheet, column of the code, column of the level); Table 5 = occupations
    for sheet, ci, li in (("Table 2", 1, 3), ("Table 3", 2, 4), ("Table 4", 3, 5), ("Table 5", 4, 6)):
        for r in wb[sheet].iter_rows(values_only=True):
            if r and len(r) > li and isinstance(r[ci], int):
                (occ if sheet == "Table 5" else groups)[str(r[ci])] = level(r[li])
    return occ, groups


def load_manual():
    out = {}
    if not os.path.isdir(MANUAL):
        return out
    for f in sorted(os.listdir(MANUAL)):
        if not f.endswith(".json"):
            continue
        m = json.load(open(os.path.join(MANUAL, f), encoding="utf-8"))
        for code, occ in m.get("occupations", {}).items():
            out[code] = {"group": m["group"], "checkedAt": m.get("checkedAt"), "file": f"data/occ_manual/{f}"}
    return out


def build(sol, levels, groups, manual):
    ours = json.load(open(os.path.join(DATA, "occupations.json"), encoding="utf-8"))
    occ, missing = {}, []
    for o in ours:
        c = o.get("code")
        if not c or not c.isdigit():
            continue
        s = sol.get(c)
        lvl, frm = levels.get(c), "occupation"
        for k, name in ((4, "unit group"), (3, "minor group"), (2, "sub-major group")):
            if lvl is None:
                lvl, frm = groups.get(c[:k]), name
        q = LEVELS.get(lvl, (None, None))
        e = {
            "onList": bool(s),
            "lists": s["lists"] if s else [],
            "visas": s["visas"] if s else [],
            "assessors": s["assessors"] if s else [],
            "skillLevel": lvl, "skillLevelFrom": frm if lvl else None,
            "qualification": q[0], "qualPoints": q[1],
        }
        abbrs = {a["abbr"] for a in e["assessors"]}
        e["regulated"] = bool(abbrs & REGULATORS) or c in LICENSED_TRADES
        if c in manual:
            e["manual"] = manual[c]
        if not s:
            missing.append(c)
        occ[c] = e
    return occ, missing


def main():
    args = dict(zip(sys.argv[1::2], sys.argv[2::2]))
    page = open(args["--sol"], encoding="utf-8").read() if "--sol" in args else fetch(SOL_URL).decode("utf-8", "replace")
    xlsx = open(args["--anzsco"], "rb").read() if "--anzsco" in args else fetch(ANZSCO_URL)
    sol = parse_sol(page)
    levels, groups = parse_anzsco(xlsx)
    occ, missing = build(sol, levels, groups, load_manual())

    n = len(occ)
    lv = sum(1 for e in occ.values() if e["skillLevel"])
    reg = [c for c, e in occ.items() if e["regulated"]]
    done = [c for c in reg if "manual" in occ[c]]
    print(f"{len(sol)} occupations on the official list; ours {n}: {n - len(missing)} matched, "
          f"{lv} with a skill level, {len(reg)} regulated ({len(done)} checked by hand)")
    if missing:
        print("not on the current list:", ", ".join(missing))

    old = json.load(open(OUT, encoding="utf-8")) if os.path.exists(OUT) else {"occ": {}}
    moved = []
    for c, e in occ.items():
        p = old["occ"].get(c)
        if p is None:
            continue
        for k in ("lists", "visas"):
            if p.get(k) != e[k]:
                moved.append(f"{c} {k}: {','.join(p.get(k) or [])} -> {','.join(e[k])}")
    changed = old["occ"] != occ
    if changed:
        now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        out = {"builtAt": now,
               "sources": {"occupationList": {"url": SOL_URL, "fetchedAt": now},
                           "anzsco": {"url": ANZSCO_URL, "release": "ANZSCO 2022 Australian Update"}},
               "levels": {str(k): {"qualification": v[0], "points": v[1]} for k, v in LEVELS.items()},
               "occ": occ}
        with open(OUT, "w", encoding="utf-8") as f:
            json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
        print("wrote site/data/occ_entry.json" + (f"; {len(moved)} list/visa changes" if moved else ""))
    else:
        print("no change")
    for m in moved:
        print("  " + m)

    gh = os.environ.get("GITHUB_OUTPUT")
    if gh:
        with open(gh, "a") as f:
            f.write(f"changed={'true' if changed else 'false'}\n")
            f.write(f"moved={len(moved)}\n")


if __name__ == "__main__":
    main()
