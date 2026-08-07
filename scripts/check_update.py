"""Cheap probe: has the SkillSelect app been reloaded since we last built?

One WebSocket round trip, ~2s. Prints the verdict and, under GitHub Actions,
writes `changed=true|false` to $GITHUB_OUTPUT so the workflow can skip the
expensive extraction on the ~29 days a month when nothing has moved.

The dashboard states its own cadence: the snapshot is taken as at the last day
of the month and "will not be reflected ... until the next month's release".
The exact release day is not published, so we watch the timestamp rather than
guess a date.
"""
import json
import os
import sys

from qlik import Engine

HERE = os.path.dirname(os.path.abspath(__file__))
META = os.path.join(HERE, "..", "site", "data", "meta.json")


def remote_state():
    eng = Engine()
    try:
        doc = eng.open_doc()
        lay = eng.call("GetAppLayout", doc, [])["qLayout"]
        h = eng.call("CreateSessionObject", doc, [{
            "qInfo": {"qType": "cube"},
            "qHyperCubeDef": {
                "qDimensions": [{"qDef": {"qFieldDefs": ["As At Month"]}}],
                "qMeasures": [],
                "qInitialDataFetch": [{"qLeft": 0, "qTop": 0, "qWidth": 1, "qHeight": 60}],
                "qSuppressMissing": True}}])["qReturn"]["qHandle"]
        rows = eng.call("GetLayout", h, [])["qLayout"]["qHyperCube"]["qDataPages"][0]["qMatrix"]
        months = [c[0]["qText"] for c in rows if c[0].get("qText") and "/" in c[0]["qText"]]
        months.sort(key=lambda m: (m.split("/")[1], m.split("/")[0]))
        return {"reloadTime": lay.get("qLastReloadTime"),
                "latestMonth": months[-1] if months else None,
                "monthsCovered": len(months)}
    finally:
        eng.close()


def local_state():
    try:
        d = json.load(open(META))
        return {k: d.get(k) for k in ("reloadTime", "latestMonth", "monthsCovered")}
    except Exception:
        return None


def main():
    remote = remote_state()
    local = local_state()
    print("remote:", json.dumps(remote, ensure_ascii=False))
    print("local :", json.dumps(local, ensure_ascii=False))

    changed = local is None or (
        remote["reloadTime"] != local.get("reloadTime")
        or remote["latestMonth"] != local.get("latestMonth"))
    print("CHANGED" if changed else "unchanged - nothing to rebuild")

    out = os.environ.get("GITHUB_OUTPUT")
    if out:
        with open(out, "a") as f:
            f.write(f"changed={'true' if changed else 'false'}\n")
            f.write(f"latest_month={remote['latestMonth']}\n")
            f.write(f"reload_time={remote['reloadTime']}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
