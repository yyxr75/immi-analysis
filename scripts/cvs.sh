#!/usr/bin/env bash
# Download resumes visitors agreed to share (aiKeep box) into ~/immi-cvs/,
# one JSON per submission: {at, text (redacted), result (model output)}.
# Only fetches ones not already on disk. Never commit that folder.
# workers.dev rather than api.ausimmitool.com: the JCU firewall intercepts it.
set -euo pipefail
API=https://immi-occupation-match.yyxr75.workers.dev/admin/cvs
OUT=~/immi-cvs
mkdir -p "$OUT"; chmod 700 "$OUT"
TOK=$(tr -d '\n' < ~/.immi-admin-token)
call() { curl -s -X POST "$API" -H "Origin: https://ausimmitool.com" \
           -H "authorization: Bearer $TOK" -d "$1"; }

cursor=""; new=0; total=0
while :; do
  page=$(call "{\"cursor\":\"$cursor\"}")
  for key in $(python3 -c 'import json,sys; [print(k["key"]) for k in json.load(sys.stdin)["keys"]]' <<<"$page"); do
    total=$((total+1))
    f="$OUT/$(tr ':' '_' <<<"$key").json"
    [ -s "$f" ] && continue
    # KV listings lag deletes/expiries by up to a minute; skip what is gone.
    rec=$(call "{\"key\":\"$key\"}")
    grep -q '"ok":true' <<<"$rec" || continue
    printf '%s' "$rec" > "$f"; new=$((new+1))
  done
  cursor=$(python3 -c 'import json,sys; print(json.load(sys.stdin)["cursor"] or "")' <<<"$page")
  [ -z "$cursor" ] && break
done
echo "$total saved on server, $new new -> $OUT"
