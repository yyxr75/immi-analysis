"""Daily watch for the 动态 feed (site/data/news.json).

    python news_watch.py                # fetch, compare with data/news_state.json, write
    python news_watch.py --html PAGE    # use a saved copy of the Invitation rounds page
    python news_watch.py --dry          # report only, write nothing

Rules for what may enter the feed are in data/NEWS_RULES.md. This script does
the two halves the rules allow a machine to do:

  * publish: changes that are numbers copied from an official table, with a
    fixed Chinese template and no reading of our own --
      - a new SkillSelect invitation round (site/data/rounds/<date>.json),
      - a refresh of the SkillSelect EOI dashboard (site/data/meta.json),
      - processing-priority dates moving on the 189 / 190 / 491 banners.
    A banner line the template does not recognise is never published; it goes
    to the drafts instead.
  * draft: anything that needs reading -- a new instrument on the Federal
    Register whose name starts with "Migration", a watched state page whose
    text changed -- goes to data/news_drafts.json (never under site/), for a
    person to check, translate and publish by hand.

State (what was last seen) is data/news_state.json. Prints changed=true|false
to $GITHUB_OUTPUT when set.
"""
import hashlib
import html
import json
import os
import re
import sys
import urllib.request
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
NEWS = os.path.join(ROOT, "site", "data", "news.json")
STATE = os.path.join(ROOT, "data", "news_state.json")
DRAFTS = os.path.join(ROOT, "data", "news_drafts.json")
ROUNDS_URL = "https://immi.homeaffairs.gov.au/visas/working-in-australia/skillselect/invitation-rounds"
MD122_URL = "https://immi.homeaffairs.gov.au/visas/getting-a-visa/visa-processing-times/visa-processing-priorities/skilled-visa"
EOI_URL = "https://api.dynamic.reports.employment.gov.au/anonap/extensions/hSKLS02_SkillSelect_EOI_Data/hSKLS02_SkillSelect_EOI_Data.html"
LEG_API = ("https://api.prod.legislation.gov.au/v1/titles?$filter=startswith(name,'Migration')"
           "&$orderby=makingDate%20desc&$select=id,name,makingDate&$top=20")
# state pages whose text we fingerprint; a change only makes a draft
STATE_PAGES = {
    "qld-news": "https://migration.qld.gov.au/news",
    "wa-snmp": "https://migration.wa.gov.au/our-services-support/state-nominated-migration-program",
    "nsw-190": "https://www.nsw.gov.au/visas-and-migration/skilled-visas/skilled-nominated-visa-subclass-190",
    "act-rounds": "https://www.act.gov.au/migration/resources/canberra-matrix-invitation-round",
}
UA = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) Chrome/120 (ausimmitool.com news watch)"}
TODAY = datetime.now(timezone.utc).date().isoformat()

MONTHS = {m: i for i, m in enumerate(["January", "February", "March", "April", "May", "June", "July",
                                      "August", "September", "October", "November", "December"], 1)}
VISA_NAME = {"189": "独立技术移民签证（189 类，计分类别）", "190": "技术提名签证（190 类）",
             "491": "技术工作偏远地区（临时）签证（491 类）"}
BANNERS = {"189": "189 visa landing page banner", "190": "190 visa page banner", "491": "491 visa page banner"}
# banner line -> (column key, Chinese). Anything else stops auto-publishing.
CATS = [
    (r"^Construction, Healthcare, Teaching, Agriculture, Aquaculture, Fishing, and Resources sectors, "
     r"or in Australia's law enforcement and defence interests\.?$", "prio",
     "建筑、医疗、教育、农业、水产养殖、渔业和资源行业，或涉及澳大利亚执法和国防利益的申请。"),
    (r"^Visa applications where the primary applicant was in Australia at the time they lodged their application\.?$",
     "on", "主申请人递交申请时身在澳大利亚境内的签证申请。"),
    (r"^Visa applications where the primary applicant was outside of Australia at the time they lodged their "
     r"application and whose application is not combined with another person.s application at any time\.?$",
     "off", "主申请人递交申请时身在澳大利亚境外，且其申请在任何时候都没有与他人的申请合并的签证申请。"),
    (r"^All other visa applications from applicants who were outside Australia when they applied\.?$",
     "other", "申请时身在澳大利亚境外的申请人的所有其他签证申请。"),
]
COLS = [("prio", "优先行业"), ("on", "境内递交"), ("off", "境外递交")]
NOTE_EN = ("Please note, while we transition to the new processing priorities under Ministerial Direction No. 122, "
           "published allocation dates and processing timeframes may fluctuate. Some timeframes may temporarily "
           "increase as applications are reprioritised.")
NOTE_ZH = ("请注意，在我们过渡到第 122 号部长指令下的新处理优先顺序期间，公布的分配日期和处理时限可能会有波动。"
           "由于申请需要重新排序，部分处理时限可能会暂时延长。")


def fetch(url, timeout=60):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", "replace")


def load(path, default):
    try:
        return json.load(open(path, encoding="utf-8"))
    except FileNotFoundError:
        return default


def zh_month(ym):
    y, m = ym.split("-")
    return f"{y}年{int(m)}月"


def short_month(ym):
    y, m = ym.split("-")
    return f"{y[2:]}年{int(m)}月"


def text_of(fragment):
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", fragment))).replace("​", "").strip()


# ---------------------------------------------------------------- banners

def banners(page):
    """{visa: {"text", "rows": {key: "YYYY-MM"}, "zh": [...], "ok": bool, "updated"}} from the page JSON."""
    raw = html.unescape(page)
    out = {}
    for visa, title in BANNERS.items():
        m = re.search(r'"title":"' + re.escape(title) + r'","content":"(.*?)","type".{0,600}?"updateDate":"([^"]*)"',
                      raw, re.S)
        if not m:
            continue
        content = m.group(1).encode("latin-1", "backslashreplace").decode("unicode_escape", "ignore")
        try:
            content = content.encode("latin-1").decode("utf-8")
        except (UnicodeEncodeError, UnicodeDecodeError):
            pass
        text = text_of(content).replace("Skilled – ", "Skilled – ")
        body = re.search(r"lodged in or before:\s*(.*?)\s*Please note", text)
        rows, zh, ok = {}, [], bool(body)
        if body:
            for mo, yr, rest in re.findall(r"([A-Z][a-z]+) (\d{4}) [–-] (.*?)(?= [A-Z][a-z]+ \d{4} [–-] |$)", body.group(1)):
                hit = next(((k, z) for pat, k, z in CATS if re.match(pat, rest.strip())), None)
                if not hit or mo not in MONTHS:
                    ok = False
                    continue
                ym = f"{yr}-{MONTHS[mo]:02d}"
                rows[hit[0]] = ym
                zh.append(f"{zh_month(ym)}：{hit[1]}")
        out[visa] = {"text": text, "rows": rows, "zh": zh, "ok": ok and len(rows) == 4, "updated": m.group(2)}
    return out


def proc_item(old, new):
    """An auto item for moved processing dates, or None when nothing moved."""
    moved = [(v, k) for v in ("189", "190", "491") if v in new and v in old
             for k, _ in COLS if new[v]["rows"].get(k) != old[v]["rows"].get(k)]
    if not moved:
        return None
    head = [""] + [c for _, c in COLS]
    rows = []
    for v in ("189", "190", "491"):
        r = [v]
        for k, _ in COLS:
            a, b = old.get(v, {}).get("rows", {}).get(k), new[v]["rows"].get(k)
            r.append(f"{short_month(a)} → {short_month(b)}" if a and b and a != b else short_month(b))
        rows.append(r)
    names = dict(COLS)
    lines = [f"{v} {names[k]}：{zh_month(old[v]['rows'][k])} → {zh_month(new[v]['rows'][k])}" for v, k in moved]
    # the title names the move readers ask about most: onshore, then offshore, then priority sectors
    rank = {"on": 0, "off": 1, "prio": 2}
    v0, k0 = min(moved, key=lambda m: (rank[m[1]], ["190", "189", "491"].index(m[0])))
    title = f"移民局更新处理进度：{v0} {names[k0]}推进到 {zh_month(new[v0]['rows'][k0])}"
    changed = sorted({v for v, _ in moved})
    parts = []
    for v in changed:
        b = new[v]
        en_head = b["text"].split("lodged in or before:")[0] + "lodged in or before:"
        en_rows = re.search(r"lodged in or before:\s*(.*?)\s*Please note", b["text"]).group(1)
        parts.append({"en": en_head.strip(), "zh": f"我们根据第 122 号部长指令，对{VISA_NAME[v]}申请进行优先排序。我们目前正在处理在以下月份或之前递交的申请："})
        parts.append({"en": re.sub(r" (?=[A-Z][a-z]+ \d{4} [–-] )", "\n", en_rows), "zh": "\n".join(b["zh"])})
    parts.append({"en": NOTE_EN, "zh": NOTE_ZH})
    return {
        "id": f"{TODAY}-processing", "date": TODAY, "type": "proc", "tag": "189 · 190 · 491",
        "title": title,
        "points": ["表示“正在处理这个月及之前递交的申请”，和上一版对比。", "不代表多久能下签，官方注明处理时间可能波动。"],
        "table": {"head": head, "rows": rows},
        "src": {"name": "内政部 · 签证页面处理进度", "url": MD122_URL},
        "checked": TODAY, "how": "auto",
        "detail": {"summary": ["内政部更新了签证页面顶部的处理进度横幅，按第 122 号部长指令列出“正在处理哪个月及以前递交的申请”。和本站上一次记录的版本相比，变化如下：",
                               "；".join(lines) + "。",
                               "这只说明处理排到了哪个月递交的申请，不代表多久能下签。官方原文也写明，过渡期间公布的日期和处理时间可能波动。"],
                   "parts": parts,
                   "srcNote": "横幅显示在内政部 189、190、491 各签证页面的顶部；下面的链接是第 122 号部长指令的说明页。"},
    }


# ---------------------------------------------------------------- rounds / EOI

def round_item(date, rnd, prev):
    tot = rnd["totals"].get("189", {}).get("invited")
    occ = [o for o in rnd["occupations"] if o["min"].get("189")]
    n65 = sum(1 for o in occ if o["min"]["189"] == 65)
    d = datetime.strptime(date, "%Y-%m-%d")
    day = f"{d.month}月{d.day}日"
    pts = [f"这一轮 189 共有 {len(occ)} 个职业获邀，最低 65 分就有邀请的有 {n65} 个。"]
    if prev:
        p65 = sum(1 for o in prev["occupations"] if o["min"].get("189") == 65)
        pd = datetime.strptime(prev["date"], "%Y-%m-%d")
        pts.append(f"上一轮（{pd.month}月{pd.day}日）最低 65 分的职业有 {p65} 个。")
    en_tot = f"Skilled Independent visa (subclass 189): {tot:,}" if tot else ""
    return {
        "id": f"{TODAY}-round-{date}", "date": TODAY, "type": "round", "tag": f"189 · {day}轮",
        "title": f"{day}轮官方结果：189 共 {tot:,} 个邀请" if tot else f"{day}轮官方结果已公布",
        "points": pts,
        "src": {"name": "内政部 · SkillSelect Invitation rounds", "url": ROUNDS_URL},
        "checked": TODAY, "how": "auto",
        "go": {"label": "每个职业邀请了多少人 → 行情 · 邀请轮次", "hash": "#/board", "boardMode": "round"},
        "detail": {"summary": [f"内政部公布了 {d.year}年{day} SkillSelect 邀请轮次的官方结果" + (f"：189 签证一共发出 {tot:,} 个邀请。" if tot else "。")]
                   + pts[:1] + ["每个职业的最低获邀分数和同分排序日期，可以在「行情 → 邀请轮次」里看。"],
                   "parts": [{"en": f"Invitations issued on {d.day} {d.strftime('%B')} {d.year}", "zh": f"{d.year}年{day}发出的邀请"}]
                   + ([{"en": "Visa subclass | Total EOIs Invited\n" + en_tot, "zh": f"签证类别 | 获邀 EOI 总数\n独立技术移民签证（189 类）| {tot:,}"}] if tot else [])},
    }


def eoi_item(month, reload_time):
    m, y = month.split("/")
    return {
        "id": f"{TODAY}-eoi-{y}-{m}", "date": TODAY, "type": "round", "tag": "EOI 看板",
        "title": f"SkillSelect EOI 看板更新到 {y}年{int(m)}月",
        "points": ["各职业排队人数、分数分布、获邀率已同步更新。"],
        "src": {"name": "就业与劳资关系部 · SkillSelect EOI 看板", "url": EOI_URL},
        "checked": TODAY, "how": "auto",
        "go": {"label": "看你的职业 → 我的 · 自选职业", "hash": "#/watch"},
        "detail": {"summary": [f"SkillSelect EOI 看板（由就业与劳资关系部发布）已刷新，数据更新到 {y}年{int(m)}月。",
                               "本站已同步更新各职业的排队人数、分数分布和历史获邀率。这是一条数据更新通知，没有需要翻译的官方公告原文。"],
                   "parts": []},
    }


# ---------------------------------------------------------------- main

def main():
    dry = "--dry" in sys.argv
    page = open(sys.argv[sys.argv.index("--html") + 1], encoding="utf-8").read() if "--html" in sys.argv else None
    state = load(STATE, {})
    news = load(NEWS, {"items": []})
    drafts = load(DRAFTS, {"items": []})
    ids = {it["id"] for it in news["items"]}
    draft_ids = {d["id"] for d in drafts["items"]}
    new_items, new_drafts, log = [], [], []

    def draft(d):
        if d["id"] not in draft_ids and d["id"] not in ids:
            new_drafts.append(d); draft_ids.add(d["id"])

    # 1. processing banners (from the Invitation rounds page, which carries all site banners)
    try:
        page = page or fetch(ROUNDS_URL)
        cur = banners(page)
        old = state.get("proc", {})
        if all(cur.get(v, {}).get("ok") for v in BANNERS):
            snap = {v: {"rows": cur[v]["rows"]} for v in cur}
            if old:
                it = proc_item(old, cur)
                if it and it["id"] not in ids:
                    new_items.append(it); log.append("processing moved")
            state["proc"] = snap
        else:
            bad = [v for v in BANNERS if not cur.get(v, {}).get("ok")]
            sig = hashlib.sha1(json.dumps({v: cur.get(v, {}).get("text") for v in bad}, sort_keys=True).encode()).hexdigest()[:10]
            draft({"id": f"proc-unparsed-{sig}", "found": TODAY, "kind": "processing banner not recognised",
                   "visas": bad, "text": {v: cur.get(v, {}).get("text") for v in bad}, "url": MD122_URL})
            log.append(f"banner not recognised: {bad}")
    except Exception as e:
        log.append(f"banners: {e!r}")

    # 2. invitation rounds already saved by rounds.py
    rdir = os.path.join(ROOT, "site", "data", "rounds")
    dates = sorted(f[:-5] for f in os.listdir(rdir) if f.endswith(".json"))
    last = state.get("round")
    if last and dates and dates[-1] > last:
        rnd = json.load(open(os.path.join(rdir, dates[-1] + ".json"), encoding="utf-8"))
        prev = json.load(open(os.path.join(rdir, last + ".json"), encoding="utf-8")) if last in dates else None
        it = round_item(dates[-1], rnd, prev)
        if it["id"] not in ids:
            new_items.append(it); log.append(f"round {dates[-1]}")
    if dates:
        state["round"] = dates[-1]

    # 3. EOI dashboard refresh (refresh.yml rewrites site/data/meta.json)
    meta = load(os.path.join(ROOT, "site", "data", "meta.json"), {})
    month = meta.get("latestMonth")
    if state.get("eoi") and month and month != state["eoi"]:
        it = eoi_item(month, meta.get("reloadTime"))
        if it["id"] not in ids:
            new_items.append(it); log.append(f"eoi {month}")
    if month:
        state["eoi"] = month

    # 4. Federal Register: new "Migration ..." instruments -> drafts
    try:
        seen = set(state.get("leg", []))
        rows = json.loads(fetch(LEG_API)).get("value", [])
        for r in rows:
            if seen and r["id"] not in seen:
                draft({"id": "leg-" + r["id"], "found": TODAY, "kind": "new instrument",
                       "name": r["name"], "made": r["makingDate"][:10],
                       "url": f"https://www.legislation.gov.au/{r['id']}"})
                log.append("leg " + r["id"])
        state["leg"] = sorted(seen | {r["id"] for r in rows})[-200:]
    except Exception as e:
        log.append(f"legislation: {e!r}")

    # 5. state pages: fingerprint the visible text -> drafts on change
    pages = state.setdefault("pages", {})
    for key, url in STATE_PAGES.items():
        try:
            t = fetch(url, timeout=40)
            t = re.sub(r"<script.*?</script>|<style.*?</style>", "", t, flags=re.S)
            t = re.sub(r"Last (published|updated)[^<]{0,80}", "", text_of(t))
            h = hashlib.sha1(t.encode()).hexdigest()[:12]
            if pages.get(key) and pages[key] != h:
                draft({"id": f"page-{key}-{h}", "found": TODAY, "kind": "state page changed", "page": key, "url": url})
                log.append(f"page {key} changed")
            pages[key] = h
        except Exception as e:
            log.append(f"page {key}: {type(e).__name__}")

    print("\n".join(log) or "nothing new")
    if new_items:
        print("publish:", [i["id"] for i in new_items])
    if new_drafts:
        print("drafts:", [d["id"] for d in new_drafts])
    changed = bool(new_items or new_drafts)
    if not dry:
        if new_items:
            news["items"] = sorted(new_items + news["items"], key=lambda x: x["date"], reverse=True)
            json.dump(news, open(NEWS, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
        if new_drafts:
            drafts["items"] = new_drafts + drafts["items"]
            json.dump(drafts, open(DRAFTS, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
        json.dump(state, open(STATE, "w", encoding="utf-8"), ensure_ascii=False, indent=1, sort_keys=True)
    gh = os.environ.get("GITHUB_OUTPUT")
    if gh:
        with open(gh, "a") as f:
            f.write(f"changed={'true' if changed else 'false'}\npublished={'true' if new_items else 'false'}\n")


if __name__ == "__main__":
    main()
