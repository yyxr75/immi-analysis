#!/usr/bin/env bash
# Most looked-up occupations, last N days (default 14).
#   name = typed an occupation name into the AI box
#   pick = chose it on the 职业数据查询 page
# One count per visitor per occupation per day. Same token/host as stats.sh.
DAYS=${1:-14}
HERE=$(cd "$(dirname "$0")" && pwd)
curl -s -X POST https://immi-occupation-match.yyxr75.workers.dev/admin/looks \
  -H "Origin: https://ausimmitool.com" \
  -H "authorization: Bearer $(tr -d '\n' < ~/.immi-admin-token)" -d "{\"days\":$DAYS}" |
python3 -c '
import json, sys
idx = {o["code"]: o for o in json.load(open(sys.argv[1]))}
d = json.load(sys.stdin)
print("since %s     name  pick  occupation" % d["since"])
for r in d["rows"][:30]:
    o = idx.get(r["code"], {})
    zh = (o.get("zh") or [""])[0]
    print("%12s  %5d %5d  %s %s" % (r["code"], r["name"], r["pick"], o.get("name", r["code"])[7:], zh))
if not d["rows"]: print("(no lookups yet)")' "$HERE/../site/data/occupations.json"
