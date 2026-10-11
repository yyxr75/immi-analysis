#!/usr/bin/env bash
# Visitors by ?src= tag and AI calls per day, last 14 days.
# Needs the admin token in ~/.immi-admin-token (never committed).
# Page views, countries and devices are in Cloudflare -> Web Analytics.
curl -s -X POST https://api.ausimmitool.com/admin/stats \
  -H "Origin: https://ausimmitool.com" \
  -H "authorization: Bearer $(tr -d '\n' < ~/.immi-admin-token)" -d '{}' |
python3 -c '
import json, sys
rows = json.load(sys.stdin)["rows"]
keys = [k for k in rows[0] if k != "day"]
print("day        " + "".join(f"{k:>8}" for k in keys))
for r in rows:
    print(r["day"] + " " + "".join(f"{r[k]:>8}" for k in keys))'
