"""Probe the SkillSelect Qlik app: list sheets and their objects."""
import json
import sys
from qlik import Engine, APP_ID

eng = Engine()
doc = eng.open_doc()
print("doc handle", doc)

layout = eng.call("GetAppLayout", doc, [])["qLayout"]
print("app title:", layout.get("qTitle"), "| last reload:", layout.get("qLastReloadTime"))

# All object infos
infos = eng.call("GetAllInfos", doc, [])["qInfos"]
from collections import Counter
print("object types:", Counter(i["qType"] for i in infos).most_common())

out = {"app": APP_ID, "lastReload": layout.get("qLastReloadTime"), "sheets": []}

for info in infos:
    if info["qType"] != "sheet":
        continue
    h = eng.call("GetObject", doc, [info["qId"]])["qReturn"]["qHandle"]
    sl = eng.call("GetLayout", h, [])["qLayout"]
    sheet = {"id": info["qId"], "title": sl["qMeta"].get("title"), "objects": []}
    for cell in sl.get("cells", []):
        sheet["objects"].append({"id": cell["name"], "type": cell["type"]})
    out["sheets"].append(sheet)
    print(f"\n=== SHEET {sheet['title']} ({info['qId']})")
    for o in sheet["objects"]:
        print("   ", o["type"], o["id"])

with open("../data/app_structure.json", "w") as f:
    json.dump(out, f, indent=2)
eng.close()
