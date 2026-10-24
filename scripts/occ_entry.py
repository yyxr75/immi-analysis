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
import glob
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
CARDS = os.path.join(ROOT, "data", "occ_cards.json")
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


# Numbers in a card note must appear in the fact the note cites. Facts are in
# English, so month names and small number words count as their digits.
_WORDS = {w: i for i, w in enumerate("zero one two three four five six seven eight nine ten eleven twelve".split())}
_WORDS.update({m: i + 1 for i, m in enumerate("january february march april may june july august september "
                                              "october november december".split())})
_WORDS.update({m[:3]: i + 1 for i, m in enumerate("january february march april may june july august september "
                                                  "october november december".split())})


def _nums(t):
    return {float(x.replace(",", "")) for x in re.findall(r"\d+(?:[.,]\d+)*", t)}


def _hay_nums(t):
    out = _nums(t)
    for w in re.findall(r"[a-z]+", t.lower()):
        if w in _WORDS:
            out.add(float(_WORDS[w]))
    return out


ROUTE_GATES = ("enrol", "enrolHas", "finish", "licence")


def load_cards():
    """data/occ_cards.json -> {key: card}, every ref resolved to its fact."""
    if not os.path.exists(CARDS):
        return {}
    spec = json.load(open(CARDS, encoding="utf-8"))["notes"]
    # route gates are researched area by area, one file each, so they can be added in parallel
    for fn in sorted(glob.glob(os.path.join(os.path.dirname(CARDS), "occ_routes", "*.json"))):
        for key, c in json.load(open(fn, encoding="utf-8"))["routes"].items():
            have = spec.setdefault(key, {"notes": []}).setdefault("route", {})
            clash = set(have) & set(c)
            if clash:
                raise SystemExit(f"{fn}: {key} gates {sorted(clash)} already set elsewhere")
            have.update(c)
    files = {}

    def fact(ref):
        f, path = ref.split(":", 1)
        if f not in files:
            files[f] = json.load(open(os.path.join(MANUAL, f + ".json"), encoding="utf-8"))
        v = files[f]
        for k in path.split("/"):
            if not isinstance(v, dict) or k not in v:
                raise SystemExit(f"occ_cards.json: {ref} does not resolve")
            v = v[k]
        if not (isinstance(v, dict) and v.get("source") and "value" in v):
            raise SystemExit(f"occ_cards.json: {ref} is not a sourced fact")
        return v, path, files[f].get("checkedAt")

    def refs(r):
        return [r] if isinstance(r, str) else list(r or [])

    def check(text, rs, what):
        got = [fact(r) for r in rs]
        hay = set()
        for v, path, _ in got:
            hay |= _hay_nums(json.dumps(v["value"], ensure_ascii=False) + " " + (v.get("quote") or "") + " " + path)
        bad = _nums(text) - hay
        if bad:
            raise SystemExit(f"occ_cards.json: {what} {text!r} has numbers {sorted(bad)} not in {rs}")
        return got

    out = {}
    for key, c in spec.items():
        card = {"notes": []}
        for n in c.get("notes", []):
            if n.get("gap"):
                if _nums(n["t"]):
                    raise SystemExit(f"occ_cards.json: gap note {n['t']!r} must not state a number")
                card["notes"].append({"t": n["t"], "gap": True})
                continue
            got = check(n["t"], refs(n.get("ref")), key)
            card["notes"].append({"t": n["t"], "src": got[0][0]["source"], "checkedAt": got[0][2]})
        if "study" in c:
            st = c["study"]
            if st and st.get("weeks"):
                # a course length straight from its CRICOS row: check the weeks, plan in whole years
                check(" ".join(str(w) for w in st["weeks"].values()), refs(st["ref"]), key + " study weeks")
                st = dict(st, **{k: -(-w // 52) for k, w in st["weeks"].items()})
                st.setdefault("assumed", [])
                st["assumed"] = st["assumed"] + [k for k in ("new", "has") if k not in st["weeks"]]
            if st and st.get("ref"):
                sure = [str(st[k]) for k in ("new", "has") if k not in st.get("assumed", []) and k not in st.get("weeks", {})]
                check(" ".join(sure), refs(st["ref"]), key + " study")
                st = dict(st, src=fact(refs(st["ref"])[0])[0]["source"])
            card["study"] = st
        if "work" in c:
            w = c["work"]
            if w:
                check(w.get("label") or str(w["months"]), refs(w["ref"]), key + " work")
                w = dict(w, src=fact(w["ref"])[0]["source"])
            card["work"] = w
        # route gates for "study for it, then 189" -- can a non-PR enrol, finish,
        # get licensed. Each is a sourced fact or an explicit gap, like the notes.
        if "route" in c:
            card["route"] = {}
            for g, n in c["route"].items():
                if g not in ROUTE_GATES:
                    raise SystemExit(f"occ_cards.json: {key} route gate {g!r} unknown")
                if n.get("gap"):
                    if _nums(n["t"]):
                        raise SystemExit(f"occ_cards.json: gap {n['t']!r} must not state a number")
                    card["route"][g] = {"t": n["t"], "ok": False}
                    continue
                got = check(n["t"], refs(n.get("ref")), key + " route " + g)
                card["route"][g] = {"t": n["t"], "ok": n.get("ok", True) is True,
                                    "src": got[0][0]["source"], "checkedAt": got[0][2]}
        for k in ("own", "use"):
            if k in c:
                card[k] = c[k]
        out[key] = card
    return out


def card_for(code, abbrs, cards):
    """The notes and assumptions for one occupation: its assessors' cards, then its own."""
    own = cards.get(code, {})
    keys = [] if own.get("own") else ["@" + a for a in abbrs]
    keys += [code]
    merged, seen = {"notes": []}, set()

    def add(k):
        if k in seen or k not in cards:
            return
        seen.add(k)
        c = cards[k]
        for u in c.get("use", []):
            add(u)
        merged["notes"] += c["notes"]
        for f in ("study", "work"):
            if f in c:
                merged[f] = c[f]
        if "route" in c:
            merged["route"] = dict(merged.get("route", {}), **c["route"])
    for k in keys:
        add(k)
    return merged if (merged["notes"] or len(merged) > 1) else None


def build(sol, levels, groups, manual, cards=None):
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
        card = card_for(c, [a["abbr"] for a in e["assessors"]], cards or {})
        if card:
            e["card"] = card
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
    cards = load_cards()
    occ, missing = build(sol, levels, groups, load_manual(), cards)

    n = len(occ)
    lv = sum(1 for e in occ.values() if e["skillLevel"])
    reg = [c for c, e in occ.items() if e["regulated"]]
    done = [c for c in reg if "manual" in occ[c]]
    bare = [c for c in reg if not (occ[c].get("card") or {}).get("notes")]
    if bare:
        raise SystemExit("regulated occupations with no card notes: " + ", ".join(bare))
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
    # 485 graduate visa age limit: the plan needs it for routes that require work after graduating
    v485 = json.load(open(os.path.join(MANUAL, "route_checks.json"), encoding="utf-8"))["visa485"]["higherEducationAge"]
    if "35 years old or younger" not in v485["quote"]:
        raise SystemExit("route_checks.json: visa485 age quote no longer says 35")
    visa485 = {"maxAge": 35, "src": v485["source"], "quote": v485["quote"]}
    changed = old["occ"] != occ or old.get("visa485") != visa485
    if changed:
        now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        out = {"builtAt": now,
               "sources": {"occupationList": {"url": SOL_URL, "fetchedAt": now},
                           "anzsco": {"url": ANZSCO_URL, "release": "ANZSCO 2022 Australian Update"}},
               "levels": {str(k): {"qualification": v[0], "points": v[1]} for k, v in LEVELS.items()},
               "visa485": visa485,
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
