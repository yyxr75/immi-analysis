"""Figure out why the hypercube comes back empty."""
from qlik import Engine

eng = Engine()
doc = eng.open_doc()

for expr in ['=Count(%EOIID)', '=Count(DISTINCT %EOIID)', "=Concat(DISTINCT [Visa Type], ', ')",
             "=Concat(DISTINCT [EOI Status], ', ')", '=NoOfFields()', '=DocumentTitle()',
             '=vMinCountMask', '=GetFieldSelections([As At Month])']:
    try:
        r = eng.call("EvaluateEx", doc, [expr])
        print(f"{expr:45s} -> {r}")
    except Exception as e:
        print(f"{expr:45s} -> ERR {e}")

# field list without filters
for defn in [{"qShowSystem": True, "qShowHidden": True, "qShowSemantic": True,
              "qShowSrcTables": True, "qShowDerivedFields": True},
             {}]:
    h = eng.call("CreateSessionObject", doc, [
        {"qInfo": {"qType": "FieldList"}, "qFieldListDef": defn}])["qReturn"]["qHandle"]
    items = eng.call("GetLayout", h, [])["qLayout"]["qFieldList"]["qItems"]
    print(f"\nFieldList(defn={defn}) -> {len(items)} fields")
    for it in items[:60]:
        print("   ", it["qName"], it.get("qCardinal"))

# unfiltered single-dim cube, nothing suppressed
h = eng.call("CreateSessionObject", doc, [{
    "qInfo": {"qType": "cube"},
    "qHyperCubeDef": {
        "qDimensions": [{"qDef": {"qFieldDefs": ["Visa Type"]}}],
        "qMeasures": [],
        "qInitialDataFetch": [{"qLeft": 0, "qTop": 0, "qWidth": 1, "qHeight": 30}],
        "qSuppressZero": False, "qSuppressMissing": False,
    }}])["qReturn"]["qHandle"]
lay = eng.call("GetLayout", h, [])["qLayout"]["qHyperCube"]
print("\nsingle-dim cube:", lay["qSize"], lay.get("qError"))
print(lay.get("qDataPages"))

eng.close()
