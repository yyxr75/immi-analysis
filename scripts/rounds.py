"""Official SkillSelect invitation rounds (189 / 491 family-sponsored).

    python rounds.py            # fetch, save if the round is new
    python rounds.py --html f   # parse a saved copy of the page instead
    ... --rewrite               # also overwrite an already saved round file

Home Affairs publishes each round on the "Invitation rounds" page about two
weeks after it is held: invitations per visa, the tie-break date, and the
minimum score invited for every occupation (from 2026-10-15 the tie-break
date is given per occupation instead of per visa). That is the official version of
what Xiaohongshu posts piece together from client reports, so we keep it.

The page is a SharePoint shell; the content sits as HTML-escaped JSON in a
hidden input. We parse its "Current round" block, match occupation titles to
ANZSCO codes via site/data/occupations.json, and write

    site/data/rounds/<YYYY-MM-DD>.json   one file per round, never rewritten
    site/data/rounds.json                index + the latest round in full

Prints `changed=true|false` (and round=<date>) to $GITHUB_OUTPUT when set.
"""
import difflib
import html
import json
import os
import re
import sys
import urllib.request
from datetime import datetime, timezone

URL = "https://immi.homeaffairs.gov.au/visas/working-in-australia/skillselect/invitation-rounds"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "site", "data")
OUT_DIR = os.path.join(DATA, "rounds")
INDEX = os.path.join(DATA, "rounds.json")


def fetch():
    req = urllib.request.Request(URL, headers={"User-Agent": "Mozilla/5.0 (ausimmitool.com data refresh)"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read().decode("utf-8", "replace")


def text(cell):
    return html.unescape(re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", cell))).strip()


def tables(block):
    out = []
    for tb in re.findall(r"<table.*?</table>", block, re.S):
        rows = [[text(c) for c in re.findall(r"<t[hd][^>]*>(.*?)</t[hd]>", tr, re.S)]
                for tr in re.findall(r"<tr.*?</tr>", tb, re.S)]
        out.append([r for r in rows if r])
    return out


def visa_key(label):
    if "189" in label:
        return "189"
    if "491" in label:
        return "491F"
    return label


def parse(page):
    m = re.search(r'id="ctl00_PlaceHolderMain_PageSchemaHiddenField_Input" value="([^"]*)"', page)
    if not m:
        raise SystemExit("page layout changed: content input not found")
    sections = json.loads(html.unescape(m.group(1)))["content"]
    block = next((s["block"] for s in sections if s.get("text", "").strip().lower() == "current round"), None)
    if block is None:
        raise SystemExit("page layout changed: no 'Current round' section")

    h = re.search(r"Invitations issued on (\d{1,2} \w+ \d{4})", text(block))
    if not h:
        raise SystemExit("page layout changed: round date not found")
    date = datetime.strptime(h.group(1), "%d %B %Y").date().isoformat()

    totals, occ, program = {}, [], {}
    for rows in tables(block):
        head = [c.lower() for c in rows[0]]
        if any("total eois invited" in c for c in head):
            for r in rows[1:]:
                if len(r) >= 2:
                    # from 2026-10-15 the tie break moved to the occupation table
                    totals[visa_key(r[0])] = {"invited": int(re.sub(r"\D", "", r[1]) or 0),
                                              "tieBreak": day(r[2])[0] if len(r) >= 3 else None}
        elif head and head[0].startswith("occupation"):
            # one score column per visa ("189", "491 ..."), or since 2026-10-15
            # "Minimum points score | Tie break date" for the 189 round alone
            tb_col = next((i for i, c in enumerate(head) if "tie break" in c), None)
            score_cols = [(i, "189" if "minimum points" in c else visa_key(rows[0][i]))
                          for i, c in enumerate(head) if i and i != tb_col]
            seen = set()
            for r in rows[1:]:
                if len(r) < 2 or r[0] in seen:  # the page lists some titles twice
                    continue
                seen.add(r[0])
                scores = {k: int(r[i]) for i, k in score_cols if i < len(r) and re.fullmatch(r"\d+", r[i])}
                o = {"name": r[0], "min": scores}
                if tb_col is not None and tb_col < len(r):
                    o["tieBreak"], raw = day(r[tb_col])
                    if raw:
                        o["tieBreakRaw"] = raw  # typo on the page, e.g. "13/10/206"
                occ.append(o)
        elif head and head[0].startswith("visa subclass") and "jul" in head:
            months = rows[0][1:]
            for r in rows[1:]:
                program[visa_key(r[0])] = dict(zip(months, (int(re.sub(r"\D", "", x) or 0) for x in r[1:])))
    py = re.search(r"Total invitations issued during (\d{4}-\d{2})", text(block))
    return {"date": date, "totals": totals, "occupations": occ,
            "program": {"year": py.group(1) if py else None, "byMonth": program}}


def day(v):
    """dd/mm/yyyy -> (yyyy-mm-dd, None); anything else -> (None, raw text)."""
    try:
        return datetime.strptime(v, "%d/%m/%Y").date().isoformat(), None
    except ValueError:
        return None, v or None


def norm(s):
    return re.sub(r"[^a-z0-9]+", " ", s.lower().replace("&", "and")).strip()


def attach_codes(rnd):
    occs = json.load(open(os.path.join(DATA, "occupations.json"), encoding="utf-8"))
    by = {norm(o["name"].split(" ", 1)[1]): o for o in occs}
    miss = []
    for o in rnd["occupations"]:
        hit = by.get(norm(o["name"]))
        if not hit:  # the page has typos ("Enviromental", "Paeditrician")
            close = difflib.get_close_matches(norm(o["name"]), list(by), n=1, cutoff=0.9)
            hit = by[close[0]] if close else None
        o["code"] = hit["code"] if hit else None
        if hit:
            o["zh"] = hit["zh"][0] if hit.get("zh") else None
        else:
            miss.append(o["name"])
    return miss


def main():
    page = open(sys.argv[2], encoding="utf-8").read() if sys.argv[1:2] == ["--html"] else fetch()
    rnd = parse(page)
    miss = attach_codes(rnd)
    rnd["source"] = URL
    rnd["fetchedAt"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    print(f"round {rnd['date']}: {len(rnd['occupations'])} occupations, totals {rnd['totals']}")
    if miss:
        print(f"unmatched titles ({len(miss)}): {', '.join(miss)}")

    os.makedirs(OUT_DIR, exist_ok=True)
    path = os.path.join(OUT_DIR, rnd["date"] + ".json")
    changed = not os.path.exists(path)
    if changed or "--rewrite" in sys.argv:
        json.dump(rnd, open(path, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    # the index always follows the page (program-year totals can move between rounds)
    dates = sorted((f[:-5] for f in os.listdir(OUT_DIR) if f.endswith(".json")), reverse=True)
    json.dump({"rounds": dates, "latest": rnd}, open(INDEX, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print("new round" if changed else "round already saved")

    gh = os.environ.get("GITHUB_OUTPUT")
    if gh:
        with open(gh, "a") as f:
            f.write(f"changed={'true' if changed else 'false'}\nround={rnd['date']}\n")


if __name__ == "__main__":
    main()
