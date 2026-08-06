"""Minimal Qlik Sense Engine JSON-API client over WebSocket (anonymous access)."""
import json
import ssl
import urllib.request
import http.cookiejar

import websocket

HOST = "api.dynamic.reports.employment.gov.au"
APP_ID = "aaac76b5-ad30-477e-9ca0-472f8ab57fc8"
SHEET_URL = (f"https://{HOST}/anonap/single/?appid={APP_ID}"
             "&sheet=1fbfd90f-e36c-44b9-a078-a7c78a46792c&opt=ctxmenu")
WS_URL = f"wss://{HOST}/anonap/app/{APP_ID}"
ORIGIN = f"https://{HOST}"
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36"


def get_session_cookie():
    """Hit the mashup sheet over HTTPS so Qlik mints an anonymous session,
    then return the Cookie header (session + F5 stickiness) for the WebSocket."""
    jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    opener.addheaders = [("User-Agent", UA)]
    opener.open(SHEET_URL).read()
    return "; ".join(f"{c.name}={c.value}" for c in jar)


class Engine:
    def __init__(self, url=WS_URL, timeout=120, cookie=None):
        cookie = cookie if cookie is not None else get_session_cookie()
        self.ws = websocket.create_connection(
            url,
            origin=ORIGIN,
            header=[f"User-Agent: {UA}", f"Cookie: {cookie}"],
            sslopt={"cert_reqs": ssl.CERT_NONE},
            timeout=timeout,
        )
        self._id = 0
        self._recv()  # OnConnected

    def _recv(self):
        return json.loads(self.ws.recv())

    def call(self, method, handle, params):
        self._id += 1
        req = {"jsonrpc": "2.0", "id": self._id, "method": method,
               "handle": handle, "params": params}
        self.ws.send(json.dumps(req))
        while True:
            msg = self._recv()
            if msg.get("id") == self._id:
                if "error" in msg:
                    raise RuntimeError(f"{method}: {msg['error']}")
                return msg["result"]
            # else: async change/notification message -> ignore

    def open_doc(self, app_id=APP_ID):
        # params: qDocName, qUserName, qPassword, qSerial, qNoData
        return self.call("OpenDoc", -1, [app_id, "", "", "", False])["qReturn"]["qHandle"]

    def close(self):
        try:
            self.ws.close()
        except Exception:
            pass


MAX_CELLS = 10000  # Qlik engine caps a single GetHyperCubeData page at 10k cells


def cube(eng, doc, dims, measures, labels=None, suppress_missing=True,
         max_rows=None, suppress_zero=False):
    """Build a session hypercube over `dims` (field/expression strings) and
    `measures` (expression strings), page through it, return (columns, rows)."""
    dim_defs = []
    for d in dims:
        dim_defs.append({"qDef": {"qFieldDefs": [d], "qFieldLabels": [d.strip("=[]")]}})
    meas_defs = [{"qDef": {"qDef": m}} for m in measures]
    width = len(dims) + len(measures)

    h = eng.call("CreateSessionObject", doc, [{
        "qInfo": {"qType": "cube"},
        "qHyperCubeDef": {
            "qDimensions": dim_defs,
            "qMeasures": meas_defs,
            "qInitialDataFetch": [],
            "qSuppressZero": suppress_zero,
            "qSuppressMissing": suppress_missing,
        }}])["qReturn"]["qHandle"]

    lay = eng.call("GetLayout", h, [])["qLayout"]["qHyperCube"]
    if lay.get("qError"):
        raise RuntimeError(f"hypercube error: {lay['qError']}")
    height = lay["qSize"]["qcy"]
    if max_rows:
        height = min(height, max_rows)

    page_rows = max(1, MAX_CELLS // width)
    rows, top = [], 0
    while top < height:
        n = min(page_rows, height - top)
        res = eng.call("GetHyperCubeData", h,
                       ["/qHyperCubeDef",
                        [{"qLeft": 0, "qTop": top, "qWidth": width, "qHeight": n}]])
        for dp in res["qDataPages"]:
            for r in dp["qMatrix"]:
                rows.append([c.get("qText") for c in r])
        top += n

    cols = list(labels) if labels else (
        [d.strip("=[]") for d in dims] + [f"m{i}" for i in range(len(measures))])
    return cols, rows


def get_hypercube_data(eng, doc, obj_id, page_rows=2000, max_rows=None):
    """Fetch a generic object's hypercube as (columns, rows)."""
    h = eng.call("GetObject", doc, [obj_id])["qReturn"]["qHandle"]
    layout = eng.call("GetLayout", h, [])["qLayout"]
    hc = layout["qHyperCube"]
    cols = [d["qFallbackTitle"] for d in hc["qDimensionInfo"]] + \
           [m["qFallbackTitle"] for m in hc["qMeasureInfo"]]
    width = hc["qSize"]["qcx"]
    height = hc["qSize"]["qcy"]
    if max_rows:
        height = min(height, max_rows)

    rows = []
    top = 0
    while top < height:
        n = min(page_rows, height - top)
        pages = [{"qLeft": 0, "qTop": top, "qWidth": width, "qHeight": n}]
        res = eng.call("GetHyperCubeData", h, ["/qHyperCubeDef", pages])
        for dp in res["qDataPages"]:
            for r in dp["qMatrix"]:
                rows.append([c.get("qText") for c in r])
        top += n
    return cols, rows, layout
