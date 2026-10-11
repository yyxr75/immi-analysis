#!/usr/bin/env bash
# Visitors by ?src= tag and AI calls per day, last 14 days.
# workers.dev, not api.ausimmitool.com: the JCU firewall intercepts the new
# domain, and this is an operator tool, not something users load.
# Needs the admin token in ~/.immi-admin-token (never committed).
# Page views, countries and devices are in Cloudflare -> Web Analytics.
curl -s -X POST https://immi-occupation-match.yyxr75.workers.dev/admin/stats \
  -H "Origin: https://ausimmitool.com" \
  -H "authorization: Bearer $(tr -d '\n' < ~/.immi-admin-token)" -d '{}' |
python3 -c '
import json, sys
rows = json.load(sys.stdin)["rows"]
keys = [k for k in rows[0] if k != "day"]
print("day        " + "".join(f"{k:>8}" for k in keys))
for r in rows:
    print(r["day"] + " " + "".join(f"{r[k]:>8}" for k in keys))'
