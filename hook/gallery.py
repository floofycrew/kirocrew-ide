"""A merged extension gallery for the engine: Open VSX and the Microsoft
Marketplace, searched together, served on loopback.

The engine's Extensions view talks to ONE store, `extensionsGallery.serviceUrl`
in its product.json (Open VSX for openvscode-server). Many extensions were never
published there and live only on the Marketplace. Both stores speak the same
gallery protocol (POST .../extensionquery with the same body and reply shape),
so this module runs a small HTTP service on 127.0.0.1 that fans each query out
to both, merges the results, drops the duplicates (one entry per
`publisher.name`; the Marketplace copy wins — newer builds, Microsoft's own
assets) and answers in the same shape. Two things are pointed at it:

* the engine's product.json — the SERVER's own gallery client (installs,
  update downloads) reads that file;
* the workbench page the proxy serves — the Extensions view SEARCHES FROM THE
  BROWSER, whose product configuration is baked into the web bundle at build
  time (Open VSX) and is only overridden by the page's
  ``productConfiguration`` object, which openvscode-server 1.109 serves EMPTY.
  So product.json alone changes nothing the view does (found 2026-10-22: a
  Marketplace-only search stayed empty while the gallery itself answered); the
  hook writes the same `extensionsGallery` block into the page.

Reachability: the browser's request service tries the URL itself first and, on
failure or a 405, forwards the request over the workbench connection to the
SERVER's request channel — the engine process, on this host — so a loopback
address works from a remote browser too (the direct attempt fails fast, the
remote one succeeds). The client derives three more resources from
`serviceUrl`: `/vscode/{publisher}/{name}/latest` (an installed extension's
newest version, asked before any query), `/publishers/.../stats` (install
counts) and the asset template; all are served here, the first two forwarded
to the store the extension came from, the assets as a redirect to that store.
Every request is kept in a short ring (`recent`, shown by the hook's status)
so "the view found nothing" is a one-line read.

Exposure, deliberately: bind 127.0.0.1 only (asserted after bind), fixed
routes, no path pass-through, read-only proxied JSON (the stats report is the
one forwarded write, an install count), upstream hosts fixed to the two stores
and declared in the manifest's network.hosts. No credential is read or
forwarded. `engine.gallery` in the mod config: "merged" (default), "openvsx"
(leave the engine alone) or "marketplace" (Marketplace only).
"""

from __future__ import annotations

import collections
import json
import os
import socket
import threading
import time
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

RECENT_MAX = 40

OPENVSX = {
    "id": "openvsx",
    "query": "https://open-vsx.org/vscode/gallery/extensionquery",
    "item": "https://open-vsx.org/vscode/item",
    "unpkg": "https://open-vsx.org/vscode/unpkg/{publisher}/{name}/{version}/{path}",
    "latest": "https://open-vsx.org/vscode/gallery/{publisher}/{name}/latest",
    "stats": "https://open-vsx.org/vscode/gallery/publishers/{publisher}/extensions/{name}/{version}/stats?statType={stat}",
    "host": "open-vsx.org",
}
MARKETPLACE = {
    "id": "marketplace",
    "query": "https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery",
    "item": "https://marketplace.visualstudio.com/items",
    # The Marketplace serves a web-extension's files from <publisher>.vscode-unpkg.net.
    "unpkg": "https://{publisher}.vscode-unpkg.net/{publisher}/{name}/{version}/{path}",
    "latest": "https://marketplace.visualstudio.com/_apis/public/gallery/vscode/{publisher}/{name}/latest",
    "stats": "https://marketplace.visualstudio.com/_apis/public/gallery/publishers/{publisher}/extensions/{name}/{version}/stats?statType={stat}",
    "host": "marketplace.visualstudio.com",
}
STORES = {"openvsx": OPENVSX, "marketplace": MARKETPLACE}
MODES = ("merged", "openvsx", "marketplace")
#: Which store wins a duplicate in merged mode.
PREFERRED = "marketplace"
#: Link-protection allowlist a client pointed here needs: both stores' item pages.
TRUSTED_DOMAINS = ["https://open-vsx.org", "https://marketplace.visualstudio.com"]

#: Gallery API bits (the protocol both stores implement).
FILTER_EXTENSION_ID = 4
FILTER_EXTENSION_NAME = 7
FILTER_SEARCH_TEXT = 10
FLAG_INCLUDE_STATISTICS = 0x100
STAT_INSTALL = "install"
UPSTREAM_TIMEOUT = 20
MAX_BODY = 64 * 1024


SORT_INSTALLS = 4  # the gallery API's SortBy.InstallCount; everything else keeps each store's own order


def _total_count(results):
    for meta in results.get("resultMetadata") or []:
        if meta.get("metadataType") == "ResultCount":
            for item in meta.get("metadataItems") or []:
                if item.get("name") == "TotalCount":
                    try:
                        return int(item.get("count") or 0)
                    except (TypeError, ValueError):
                        return 0
    return len(results.get("extensions") or [])


def merge_results(responses, preferred=PREFERRED, sort_by=0, page_size=0):
    """Merge gallery responses ({"store": id, "doc": dict|None}) into one page.

    One entry per publisher.name (case-insensitive), the preferred store's copy
    kept when both have it. Order INTERLEAVES the stores by rank (both first
    hits, then both second hits, …; the preferred store first within a rank),
    so each store's own relevance order survives: a search for a name that
    exists on one store only keeps that store's top hit at the top, instead of
    sinking under the other store's most-installed extensions. Only an
    explicit install-count sort (``sort_by`` 4) re-sorts across stores. The page
    is cut to ``page_size`` (the engine's own page) and "TotalCount" reports
    the stores' totals combined, so the view keeps paging. Each extension gets
    a private `_kirocrewStore` marker that the caller strips.
    """
    columns = []
    stores = []
    total = 0
    for reply in responses:
        doc = reply.get("doc")
        if not isinstance(doc, dict):
            continue
        results = doc.get("results") or []
        if not results:
            continue
        stores.append(reply["store"])
        total += _total_count(results[0])
        column = []
        for ext in results[0].get("extensions") or []:
            pub = ((ext.get("publisher") or {}).get("publisherName") or "").strip()
            name = (ext.get("extensionName") or "").strip()
            if not pub or not name:
                continue
            ext = dict(ext)
            ext["_kirocrewStore"] = reply["store"]
            column.append(((pub + "." + name).lower(), ext))
        columns.append((reply["store"], column))
    # The preferred store leads within a rank so its copy is the one kept.
    columns.sort(key=lambda c: 0 if c[0] == preferred else 1)
    by_key = {}
    order = []
    for rank in range(max((len(c) for _, c in columns), default=0)):
        for store, column in columns:
            if rank >= len(column):
                continue
            key, ext = column[rank]
            if key not in by_key:
                by_key[key] = ext
                order.append(key)
            elif store == preferred and by_key[key]["_kirocrewStore"] != preferred:
                by_key[key] = ext
    merged = [by_key[k] for k in order]

    def installs(ext):
        for stat in ext.get("statistics") or []:
            if stat.get("statisticName") == STAT_INSTALL:
                try:
                    return float(stat.get("value") or 0)
                except (TypeError, ValueError):
                    return 0.0
        return 0.0

    if len(stores) > 1 and sort_by == SORT_INSTALLS:
        merged.sort(key=installs, reverse=True)
    dropped = sum(len(c) for _, c in columns) - len(merged)  # duplicates collapsed on this page
    if page_size and len(merged) > page_size:
        merged = merged[:page_size]
    return {
        "results": [{
            "extensions": merged,
            "pagingToken": None,
            "resultMetadata": [{
                "metadataType": "ResultCount",
                "metadataItems": [{"name": "TotalCount", "count": max(len(merged), total - dropped)}],
            }],
        }],
        "_kirocrewStores": stores,
    }


def query_shape(body):
    """(sort_by, page_size) of a gallery query body; zeros when absent."""
    try:
        f = (body.get("filters") or [{}])[0]
        return int(f.get("sortBy") or 0), int(f.get("pageSize") or 0)
    except (AttributeError, TypeError, ValueError, IndexError):
        return 0, 0


def asset_redirect(path, index):
    """The upstream URL for `/unpkg/<publisher>/<name>/<version>/<rest>`, or None.

    `index` maps lower-cased `publisher.name` to the store id whose copy of
    the extension this gallery returned last; an extension never seen here
    (an install that predates the gallery) is looked up at the preferred store
    first by the caller.
    """
    parts = path.split("/", 4)
    if len(parts) < 5 or parts[0] != "unpkg":
        return None
    _, publisher, name, version, rest = parts
    if not publisher or not name or not version or ".." in rest.split("/"):
        return None
    store = STORES.get(index.get((publisher + "." + name).lower()) or PREFERRED, OPENVSX)
    return store["unpkg"].format(publisher=urllib.parse.quote(publisher), name=urllib.parse.quote(name),
                                 version=urllib.parse.quote(version), path=urllib.parse.quote(rest))


def latest_target(path):
    """`vscode/<publisher>/<name>/latest` -> (publisher, name), or None.

    The workbench derives this "latest version" resource from ``serviceUrl`` and
    asks it for every installed extension's newest version before it falls back
    to a query; a 404 here is harmless but logged by the client on every check.
    """
    parts = path.split("/")
    if len(parts) != 4 or parts[0] != "vscode" or parts[3] != "latest" or not parts[1] or not parts[2]:
        return None
    return parts[1], parts[2]


def stats_target(path, query):
    """`publishers/<p>/extensions/<n>/<v>/stats?statType=install` -> (p, n, v, stat), or None."""
    parts = path.split("/")
    if len(parts) != 6 or parts[0] != "publishers" or parts[2] != "extensions" or parts[5] != "stats":
        return None
    stat = (urllib.parse.parse_qs(query).get("statType") or [""])[0]
    if not parts[1] or not parts[3] or not parts[4] or not stat.isalnum():
        return None
    return parts[1], parts[3], parts[4], stat


def store_url(store, key, **fields):
    return store[key].format(**{k: urllib.parse.quote(v) for k, v in fields.items()})


class _Handler(BaseHTTPRequestHandler):
    server_version = "kirocrew-ide-gallery"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # quiet; the hook's log carries failures
        return

    def _send(self, status, body=b"", ctype="application/json", extra=None):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self.end_headers()
        if body:
            self.wfile.write(body)

    def do_OPTIONS(self):
        self._send(204, b"", extra={"Access-Control-Allow-Origin": "*",
                                   "Access-Control-Allow-Headers": "*",
                                   "Access-Control-Allow-Methods": "GET, POST, OPTIONS"})

    def do_GET(self):
        url = urllib.parse.urlparse(self.path)
        path = url.path.strip("/")
        if path in ("", "health"):
            self._send(200, json.dumps({"ok": True, "mode": self.server.gallery.mode}).encode())
            return
        latest = latest_target(path)
        if latest:
            body = self.server.gallery.latest(*latest)
            self.server.gallery.note("GET", path, 200 if body else 404)
            if body:
                self._send(200, body, extra={"Access-Control-Allow-Origin": "*"})
            else:
                self._send(404, b'{"error":"not found"}', extra={"Access-Control-Allow-Origin": "*"})
            return
        target = asset_redirect(path, self.server.gallery.index)
        self.server.gallery.note("GET", path, 302 if target else 404)
        if not target:
            self._send(404, b'{"error":"not found"}')
            return
        self._send(302, b"", extra={"Location": target})

    def do_POST(self):
        url = urllib.parse.urlparse(self.path)
        path = url.path.strip("/")
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        stats = stats_target(path, url.query)
        if stats:
            if 0 < length <= MAX_BODY:
                self.rfile.read(length)
            self.server.gallery.report_stat(*stats)  # best effort; the client never reads the reply
            self.server.gallery.note("POST", path, 200)
            self._send(200, b"{}", extra={"Access-Control-Allow-Origin": "*"})
            return
        if path != "extensionquery":
            self.server.gallery.note("POST", path, 404)
            self._send(404, b'{"error":"not found"}')
            return
        if length <= 0 or length > MAX_BODY:
            self.server.gallery.note("POST", path, 400)
            self._send(400, b'{"error":"bad body"}')
            return
        raw = self.rfile.read(length)
        try:
            body = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            self.server.gallery.note("POST", path, 400)
            self._send(400, b'{"error":"bad json"}')
            return
        doc = self.server.gallery.query(body, raw)
        self.server.gallery.note("POST", path, 200, detail=query_summary(body, doc))
        self._send(200, json.dumps(doc).encode(), extra={"Access-Control-Allow-Origin": "*"})


def query_summary(body, doc):
    """One line about a query for the request log: the search text and the hit count."""
    text = ""
    for flt in body.get("filters") or []:
        for crit in flt.get("criteria") or []:
            if crit.get("filterType") == FILTER_SEARCH_TEXT:
                text = str(crit.get("value") or "")[:60]
    try:
        hits = len(doc["results"][0]["extensions"])
    except (KeyError, IndexError, TypeError):
        hits = 0
    return "text=%r hits=%d" % (text, hits)


class Gallery:
    """The merged gallery service: start() binds loopback and returns the service URL."""

    def __init__(self, mode, fetch, log):
        if mode not in MODES:
            raise ValueError("engine.gallery must be one of %s" % ", ".join(MODES))
        self.mode = mode
        self._fetch = fetch      # fetch(url, data, headers) -> bytes, via the manifest-checked opener
        self._log = log
        self.index = {}          # lower publisher.name -> store id of the copy served last
        self.recent = collections.deque(maxlen=RECENT_MAX)  # the last requests, for status/debug
        self._server = None
        self._thread = None
        self.port = None

    def note(self, method, path, status, detail=""):
        self.recent.append({"at": time.time(), "method": method, "path": "/" + path, "status": status,
                            "detail": detail})

    @property
    def stores(self):
        return [MARKETPLACE] if self.mode == "marketplace" else [OPENVSX, MARKETPLACE] if self.mode == "merged" else [OPENVSX]

    def _stores_for(self, publisher, name):
        """The store this gallery served `publisher.name` from first, then the preferred one, then the rest."""
        known = self.index.get((publisher + "." + name).lower())
        rank = {known: 0, PREFERRED: 1}
        return sorted(self.stores, key=lambda s: rank.get(s["id"], 2))

    def latest(self, publisher, name):
        """The raw `/latest` document from the first store that has the extension, else None."""
        for store in self._stores_for(publisher, name):
            try:
                body = self._fetch(store_url(store, "latest", publisher=publisher, name=name), None, {
                    "Accept": "application/json;api-version=3.0-preview.1",
                })
            except Exception:  # noqa: BLE001 — a 404 at one store is the normal "try the next"
                continue
            if body:
                self.index[(publisher + "." + name).lower()] = store["id"]
                return body
        return None

    def report_stat(self, publisher, name, version, stat):
        """Forward an install/uninstall count to the extension's own store (best effort)."""
        store = self._stores_for(publisher, name)[0]
        try:
            self._fetch(store_url(store, "stats", publisher=publisher, name=name, version=version, stat=stat),
                        b"", {"Accept": "application/json;api-version=3.0-preview.1"})
        except Exception as error:  # noqa: BLE001
            self._log("gallery: %s stat report failed: %s" % (store["id"], error))

    def _ask(self, store, raw):
        try:
            data = self._fetch(store["query"], raw, {
                "Content-Type": "application/json",
                "Accept": "application/json;api-version=3.0-preview.1",
            })
            return {"store": store["id"], "doc": json.loads(data.decode("utf-8"))}
        except Exception as error:  # noqa: BLE001 — one store down must not blank the view
            self._log("gallery: %s query failed: %s" % (store["id"], error))
            return {"store": store["id"], "doc": None}

    def query(self, body, raw):
        stores = self.stores
        replies = [None] * len(stores)
        threads = []
        for i, store in enumerate(stores):
            def run(i=i, store=store):
                replies[i] = self._ask(store, raw)
            thread = threading.Thread(target=run, daemon=True)
            thread.start()
            threads.append(thread)
        for thread in threads:
            thread.join(UPSTREAM_TIMEOUT + 5)
        sort_by, page_size = query_shape(body)
        merged = merge_results([r for r in replies if r], preferred=PREFERRED, sort_by=sort_by, page_size=page_size)
        for ext in merged["results"][0]["extensions"]:
            pub = (ext.get("publisher") or {}).get("publisherName") or ""
            self.index[(pub + "." + (ext.get("extensionName") or "")).lower()] = ext.pop("_kirocrewStore", PREFERRED)
        return merged

    def start(self, port=0):
        """Bind loopback (``port`` 0 = any free) and serve; returns the service URL."""
        server = ThreadingHTTPServer(("127.0.0.1", port), _Handler)
        host, port = server.server_address[:2]
        if host != "127.0.0.1":
            server.server_close()
            raise RuntimeError("gallery bound %r, not loopback" % host)
        server.daemon_threads = True
        server.gallery = self
        self._server = server
        self.port = port
        self._thread = threading.Thread(target=server.serve_forever, name="kirocrew-ide-gallery", daemon=True)
        self._thread.start()
        return self.service_url

    @property
    def service_url(self):
        return "http://127.0.0.1:%d" % self.port if self.port else None

    def product_gallery(self):
        """The `extensionsGallery` block that aims a client here.

        Written to the engine's product.json (the server's client) and into the
        workbench page's productConfiguration (the browser's). Same block, so
        the two clients agree on every URL; the page merge is key-by-key, so
        every key is given, none left to the baked default.
        """
        base = self.service_url
        return {
            "serviceUrl": base,
            "itemUrl": MARKETPLACE["item"] if self.mode == "marketplace" else OPENVSX["item"],
            "resourceUrlTemplate": base + "/unpkg/{publisher}/{name}/{version}/{path}",
            "extensionUrlTemplate": base + "/vscode/{publisher}/{name}/latest",
            "controlUrl": "",
            "recommendationsUrl": "",
            "nlsBaseUrl": "",
            "publisherUrl": "",
        }

    def stop(self):
        if self._server:
            self._server.shutdown()
            self._server.server_close()
            self._server = None
            self.port = None


def default_fetch(url, data, headers):
    request = urllib.request.Request(url, data=data, headers=dict(headers, **{"User-Agent": "kirocrew-ide-mod"}))
    with urllib.request.urlopen(request, timeout=UPSTREAM_TIMEOUT) as reply:
        return reply.read()


def point_product_json(path, gallery_block, log):
    """Rewrite `extensionsGallery` in the engine's product.json, keeping the original beside it.

    The original block is saved under `_kirocrewOriginalGallery` the first time
    so `restore_product_json` can put it back; a product.json already carrying
    the same block is left alone. Returns True when the file changed.
    """
    with open(path, "r", encoding="utf-8") as fh:
        product = json.load(fh)
    current = product.get("extensionsGallery") or {}
    if current == gallery_block:
        return False
    if "_kirocrewOriginalGallery" not in product and current.get("serviceUrl", "").startswith("https://"):
        product["_kirocrewOriginalGallery"] = current
    product["extensionsGallery"] = gallery_block
    trusted = product.get("linkProtectionTrustedDomains") or []
    for host in TRUSTED_DOMAINS:
        if host not in trusted:
            trusted.append(host)
    product["linkProtectionTrustedDomains"] = trusted
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(product, fh, indent=2)
        fh.write("\n")
    os.replace(tmp, path)
    log("gallery: product.json now points the Extensions view at %s" % gallery_block["serviceUrl"])
    return True


def restore_product_json(path, log):
    """Put the engine's own gallery back (engine.gallery: openvsx). Returns True when the file changed."""
    with open(path, "r", encoding="utf-8") as fh:
        product = json.load(fh)
    original = product.pop("_kirocrewOriginalGallery", None)
    if not original:
        return False
    product["extensionsGallery"] = original
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(product, fh, indent=2)
        fh.write("\n")
    os.replace(tmp, path)
    log("gallery: product.json restored to %s" % original.get("serviceUrl"))
    return True
