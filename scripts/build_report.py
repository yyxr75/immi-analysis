"""Inject one occupation's JSON into the report template.

Usage: python build_report.py "233411 Electronics Engineer"
"""
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "output")


def main(occupation):
    slug = re.sub(r"\W+", "_", occupation).strip("_").lower()
    data = json.load(open(os.path.join(OUT, f"{slug}__report.json")))
    tpl = open(os.path.join(HERE, "report_template.html")).read()

    title = f"{occupation} · 澳洲技术移民工具箱"
    # </script> inside a JSON string would close the host <script> tag early
    payload = json.dumps(data, ensure_ascii=False).replace("</", "<\\/")
    html = (tpl.replace("__DATA__", payload).replace("__TITLE__", title)
           .replace("<!--OCCPICKER-->", "")
           .replace("__PUBLIC_PROXY_URL__", '""'))

    # Artifact build: the host wraps the file in its own <head>, so ship the
    # fragment as-is. Local build: opened over file://, so it needs the charset
    # declaration itself or the Chinese text decodes as mojibake.
    art = os.path.join(OUT, f"{slug}__artifact.html")
    open(art, "w").write(html)
    local = os.path.join(OUT, f"{slug}__report.html")
    open(local, "w").write('<meta charset="utf-8">\n' + html)
    print(f"wrote {local}  ({len(html)/1024:.0f} KB)")
    print(f"wrote {art}   (artifact-ready, no <head> tags)")
    return local


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "233411 Electronics Engineer")
