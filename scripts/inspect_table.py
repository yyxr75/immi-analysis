"""Inspect the results table object + the app's data model fields."""
import json
from qlik import Engine

eng = Engine()
doc = eng.open_doc()

# --- the table object's *properties* (definition, not layout)
h = eng.call("GetObject", doc, ["eymDb"])["qReturn"]["qHandle"]
props = eng.call("GetProperties", h, [])["qProp"]
hcd = props.get("qHyperCubeDef", {})
print("TABLE eymDb  definition")
for d in hcd.get("qDimensions", []):
    dd = d["qDef"]
    print("  DIM :", dd.get("qFieldDefs"), "| labels:", dd.get("qFieldLabels"), "| libId:", d.get("qLibraryId"))
for m in hcd.get("qMeasures", []):
    md = m["qDef"]
    print("  MEAS:", md.get("qDef"), "| label:", md.get("qLabel"), "| libId:", m.get("qLibraryId"))

lay = eng.call("GetLayout", h, [])["qLayout"]
print("  layout size:", lay["qHyperCube"]["qSize"], "| error:", lay["qHyperCube"].get("qError"))

# --- master dimensions / measures
infos = eng.call("GetAllInfos", doc, [])["qInfos"]
print("\nMASTER DIMENSIONS")
for i in infos:
    if i["qType"] == "dimension":
        dh = eng.call("GetDimension", doc, [i["qId"]])["qReturn"]["qHandle"]
        dl = eng.call("GetLayout", dh, [])["qLayout"]
        print("  ", dl["qMeta"].get("title"), "->", dl["qDim"].get("qFieldDefs"))
print("\nMASTER MEASURES")
for i in infos:
    if i["qType"] == "measure":
        mh = eng.call("GetMeasure", doc, [i["qId"]])["qReturn"]["qHandle"]
        ml = eng.call("GetLayout", mh, [])["qLayout"]
        print("  ", ml["qMeta"].get("title"), "->", ml["qMeasure"].get("qDef"))

# --- full field list of the data model
tk = eng.call("GetTablesAndKeys", doc, [{"qcx": 1000, "qcy": 1000}, {"qcx": 0, "qcy": 0}, 30, True, False])
print("\nDATA MODEL")
for t in tk["qtr"]:
    print(f"  table {t['qName']}  rows={t.get('qNoOfRows')}")
    for f in t["qFields"]:
        print(f"      {f['qName']}  card={f.get('qCardinal')}")

# --- variables (the mashup uses variable inputs)
vlh = eng.call("CreateSessionObject", doc, [{
    "qInfo": {"qType": "VariableList"},
    "qVariableListDef": {"qType": "variable", "qShowReserved": False,
                         "qShowConfig": False, "qData": {"tags": "/tags"}}
}])["qReturn"]["qHandle"]
vl = eng.call("GetLayout", vlh, [])["qLayout"]["qVariableList"]["qItems"]
print("\nVARIABLES")
for v in vl:
    print(f"   {v['qName']} = {v.get('qDefinition')}")

json.dump({"table_props": props, "model": tk, "vars": vl},
          open("../data/model_dump.json", "w"), indent=2)
eng.close()
