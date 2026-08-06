"""List fields in the app and run a smoke-test aggregation."""
import json
from qlik import Engine

eng = Engine()
doc = eng.open_doc()

fl = eng.call("CreateSessionObject", doc, [{
    "qInfo": {"qType": "FieldList"},
    "qFieldListDef": {"qShowSystem": False, "qShowHidden": True, "qShowSemantic": True,
                      "qShowSrcTables": True, "qShowDerivedFields": True}
}])["qReturn"]["qHandle"]
items = eng.call("GetLayout", fl, [])["qLayout"]["qFieldList"]["qItems"]
print("FIELDS")
for it in items:
    print(f"  {it['qName']:32s} cardinal={it.get('qCardinal')} tables={[t for t in it.get('qSrcTables',[])]}")

json.dump(items, open("../data/fields.json", "w"), indent=2)


def cube(dims, meas, height=50):
    h = eng.call("CreateSessionObject", doc, [{
        "qInfo": {"qType": "cube"},
        "qHyperCubeDef": {
            "qDimensions": [{"qDef": {"qFieldDefs": [d]}} for d in dims],
            "qMeasures": [{"qDef": {"qDef": m}} for m in meas],
            "qInitialDataFetch": [{"qLeft": 0, "qTop": 0,
                                   "qWidth": len(dims) + len(meas), "qHeight": height}],
            "qSuppressZero": False, "qSuppressMissing": True,
        }}])["qReturn"]["qHandle"]
    lay = eng.call("GetLayout", h, [])["qLayout"]["qHyperCube"]
    print("\n  size:", lay["qSize"], "err:", lay.get("qError"))
    for row in lay["qDataPages"][0]["qMatrix"]:
        print("   ", " | ".join(str(c.get("qText")) for c in row))


print("\n=== smoke test: Visa Type x EOI Status")
cube(["Visa Type", "EOI Status"], ["COUNT(DISTINCT %EOIID)"], 40)

print("\n=== As At Month values")
cube(["As At Month"], ["COUNT(DISTINCT %EOIID)"], 40)

eng.close()
