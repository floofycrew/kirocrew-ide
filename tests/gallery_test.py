"""The merged extension gallery: both stores in one Extensions view.

Pure merge rules, the asset redirect, product.json pointing/restoring, and a
live loopback round trip with stubbed upstreams (no network): bind is loopback
only, both stores are asked for one query, duplicates collapse to the
Marketplace copy, a store outage degrades to the other store's results, and
/unpkg redirects each extension to the store it came from.
"""

import importlib.util
import json
import os
import socket
import sys
import tempfile
import types
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
HOOK = os.path.join(HERE, "..", "hook", "__init__.py")
GALLERY = os.path.join(HERE, "..", "hook", "gallery.py")


def _load(path, name):
    sys.modules.setdefault("floofy", types.ModuleType("floofy"))
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def ext(pub, name, store, installs, version="1.0.0"):
    return {"publisher": {"publisherName": pub, "displayName": pub}, "extensionName": name, "displayName": name,
            "statistics": [{"statisticName": "install", "value": installs}],
            "versions": [{"version": version, "assetUri": "https://%s.example/%s/%s" % (store, pub, name), "files": []}]}


def reply(*exts):
    return {"results": [{"extensions": list(exts), "resultMetadata": [{"metadataType": "ResultCount", "metadataItems": [{"name": "TotalCount", "count": len(exts)}]}]}]}


def main():
    g = _load(GALLERY, "kirocrew_ide_gallery_t")
    hook = _load(HOOK, "kirocrew_ide_hook_gallery")
    assert hook.gallery.MODES == g.MODES, "the hook found its gallery module when loaded bare"

    # Merge: Marketplace wins a duplicate; order by installs across stores; one TotalCount.
    merged = g.merge_results([
        {"store": "openvsx", "doc": reply(ext("a", "x", "openvsx", 10, "1.0.0"), ext("b", "only-ovsx", "openvsx", 500))},
        {"store": "marketplace", "doc": reply(ext("A", "X", "marketplace", 20, "1.2.0"), ext("c", "only-ms", "marketplace", 5))},
    ])
    rows = merged["results"][0]["extensions"]
    ids = [(e["publisher"]["publisherName"] + "." + e["extensionName"], e["_kirocrewStore"]) for e in rows]
    # Interleaved by rank, Marketplace first within a rank: each store's own relevance order survives.
    assert ids == [("A.X", "marketplace"), ("c.only-ms", "marketplace"), ("b.only-ovsx", "openvsx")], ids
    by_installs = g.merge_results([
        {"store": "openvsx", "doc": reply(ext("a", "x", "openvsx", 10), ext("b", "only-ovsx", "openvsx", 500))},
        {"store": "marketplace", "doc": reply(ext("a", "x", "marketplace", 20), ext("c", "only-ms", "marketplace", 5))},
    ], sort_by=g.SORT_INSTALLS)
    assert [e["extensionName"] for e in by_installs["results"][0]["extensions"]] == ["only-ovsx", "x", "only-ms"], "an explicit install-count sort re-ranks across stores"
    paged = g.merge_results([{"store": "openvsx", "doc": reply(*[ext("p", "e%d" % i, "openvsx", i) for i in range(6)])}], page_size=4)
    assert len(paged["results"][0]["extensions"]) == 4 and paged["results"][0]["resultMetadata"][0]["metadataItems"][0]["count"] == 6, "cut to the page, total kept"
    only_ms = g.merge_results([
        {"store": "openvsx", "doc": reply(*[ext("big", "popular%d" % i, "openvsx", 100000 - i) for i in range(5)])},
        {"store": "marketplace", "doc": reply(ext("IKKI2000", "ikki-vscode-light-theme", "marketplace", 300))},
    ])
    assert only_ms["results"][0]["extensions"][0]["extensionName"] == "ikki-vscode-light-theme", "a Marketplace-only name search lands on top, not under Open VSX's most-installed"
    assert g.query_shape({"filters": [{"sortBy": 4, "pageSize": 50}]}) == (4, 50) and g.query_shape({}) == (0, 0)
    assert rows[0]["versions"][0]["version"] == "1.2.0", "the Marketplace copy (newer build) replaced Open VSX's"
    assert merged["results"][0]["resultMetadata"][0]["metadataItems"][0]["count"] == 3
    assert merged["_kirocrewStores"] == ["openvsx", "marketplace"]
    # One store down: the other's results, in its own order.
    one = g.merge_results([{"store": "openvsx", "doc": reply(ext("a", "x", "openvsx", 1), ext("b", "y", "openvsx", 9))}, {"store": "marketplace", "doc": None}])
    assert [e["extensionName"] for e in one["results"][0]["extensions"]] == ["x", "y"] and one["_kirocrewStores"] == ["openvsx"]
    assert one["results"][0]["resultMetadata"][0]["metadataItems"][0]["count"] == 2
    assert g.merge_results([])["results"][0]["extensions"] == []
    # Asset redirect follows the store the entry came from; traversal refused.
    index = {"a.x": "marketplace", "b.y": "openvsx"}
    assert g.asset_redirect("unpkg/a/x/1.2.0/extension/package.json", index) == "https://a.vscode-unpkg.net/a/x/1.2.0/extension/package.json"
    assert g.asset_redirect("unpkg/b/y/2.0.0/README.md", index) == "https://open-vsx.org/vscode/unpkg/b/y/2.0.0/README.md"
    assert g.asset_redirect("unpkg/z/z/1.0.0/img.png", index).startswith("https://z.vscode-unpkg.net/"), "unknown extension: the preferred store"
    assert g.asset_redirect("unpkg/a/x/1.0.0/../../etc", index) is None and g.asset_redirect("other/a/x/1/y", index) is None and g.asset_redirect("unpkg/a/x", index) is None
    print("gallery: merge, order, outage and asset redirect rules hold")

    # product.json pointing and restoring, original kept beside.
    tmp = tempfile.mkdtemp(prefix="kide-gallery-")
    product = os.path.join(tmp, "product.json")
    original = {"serviceUrl": "https://open-vsx.org/vscode/gallery", "itemUrl": "https://open-vsx.org/vscode/item",
                "resourceUrlTemplate": "https://open-vsx.org/vscode/unpkg/{publisher}/{name}/{version}/{path}"}
    with open(product, "w") as fh:
        json.dump({"nameShort": "x", "extensionsGallery": original, "linkProtectionTrustedDomains": ["https://open-vsx.org"]}, fh)
    logs = []
    block = {"serviceUrl": "http://127.0.0.1:1/", "itemUrl": "https://open-vsx.org/vscode/item", "resourceUrlTemplate": "http://127.0.0.1:1/unpkg/{publisher}/{name}/{version}/{path}"}
    assert g.point_product_json(product, block, logs.append) is True
    assert g.point_product_json(product, block, logs.append) is False, "idempotent"
    doc = json.load(open(product))
    assert doc["extensionsGallery"] == block and doc["_kirocrewOriginalGallery"] == original and doc["nameShort"] == "x"
    assert "https://marketplace.visualstudio.com" in doc["linkProtectionTrustedDomains"]
    assert g.restore_product_json(product, logs.append) is True and json.load(open(product))["extensionsGallery"] == original
    assert g.restore_product_json(product, logs.append) is False
    print("gallery: product.json pointed and restored, original kept")

    # Live loopback round trip with stubbed stores.
    calls = []
    def fetch(url, data, headers):
        calls.append(url)
        if data is None:  # GET: the /latest resource
            if url.endswith("/pub/mist/latest") and "marketplace" in url:
                return json.dumps(ext("pub", "mist", "marketplace", 7, "1.0.0")).encode()
            if url.endswith("/b/only-ovsx/latest") and "open-vsx" in url:
                return json.dumps(ext("b", "only-ovsx", "openvsx", 1, "2.0.0")).encode()
            raise urllib.error.HTTPError(url, 404, "not found", {}, None)
        if "/stats?statType=" in url:
            return b"{}"
        body = json.loads(data)
        text = body["filters"][0]["criteria"][0]["value"]
        if "open-vsx" in url:
            return json.dumps(reply(ext("pub", text, "openvsx", 3, "0.9.0"))).encode()
        if text == "down":
            raise OSError("marketplace unreachable")
        return json.dumps(reply(ext("pub", text, "marketplace", 7, "1.0.0"), ext("ms", "extra", "marketplace", 1))).encode()
    service = g.Gallery("merged", fetch, logs.append)
    url = service.start()
    try:
        assert url.startswith("http://127.0.0.1:"), url
        # The listener is loopback only.
        with socket.create_connection(("127.0.0.1", service.port), timeout=2):
            pass
        for host in (socket.gethostname(),):
            try:
                addrs = {a[4][0] for a in socket.getaddrinfo(host, service.port, socket.AF_INET)} - {"127.0.0.1"}
            except socket.gaierror:
                addrs = set()
            for addr in addrs:
                try:
                    socket.create_connection((addr, service.port), timeout=0.5).close()
                    raise AssertionError("gallery reachable on %s: not loopback only" % addr)
                except OSError:
                    pass
        q = json.dumps({"filters": [{"criteria": [{"filterType": 10, "value": "mist"}], "pageNumber": 1, "pageSize": 50}], "flags": 914}).encode()
        req = urllib.request.Request(url + "/extensionquery", data=q, headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=10) as r:
            doc = json.load(r)
        assert sorted(c.split("/")[2] for c in calls) == ["marketplace.visualstudio.com", "open-vsx.org"], calls
        rows = doc["results"][0]["extensions"]
        assert [(e["extensionName"], e["versions"][0]["version"]) for e in rows] == [("mist", "1.0.0"), ("extra", "1.0.0")], rows
        assert doc["results"][0]["resultMetadata"][0]["metadataItems"][0]["count"] == 2, "the duplicate is not counted twice"
        assert all("_kirocrewStore" not in e for e in rows), "the private marker never reaches the engine"
        assert service.index == {"pub.mist": "marketplace", "ms.extra": "marketplace"}
        # Asset for pub.mist goes to the Marketplace's unpkg host, as a redirect the engine follows on the host side.
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *a, **k):
                return None
        opener = urllib.request.build_opener(NoRedirect)
        try:
            opener.open(url + "/unpkg/pub/mist/1.0.0/extension/package.json", timeout=5)
            raise AssertionError("expected a redirect")
        except urllib.error.HTTPError as e:
            assert e.code == 302 and e.headers["Location"] == "https://pub.vscode-unpkg.net/pub/mist/1.0.0/extension/package.json", (e.code, e.headers.get("Location"))
        # Marketplace down: Open VSX's result alone, still a 200.
        q2 = json.dumps({"filters": [{"criteria": [{"filterType": 10, "value": "down"}], "pageNumber": 1, "pageSize": 50}], "flags": 914}).encode()
        with urllib.request.urlopen(urllib.request.Request(url + "/extensionquery", data=q2, headers={"Content-Type": "application/json"}), timeout=10) as r:
            doc2 = json.load(r)
        assert [e["versions"][0]["version"] for e in doc2["results"][0]["extensions"]] == ["0.9.0"] and any("unreachable" in l for l in logs)
        # Unknown routes and oversized bodies are refused; nothing is proxied by path.
        for path, code in (("/anything", 404), ("/unpkg/a", 404)):
            try:
                urllib.request.urlopen(url + path, timeout=5)
                raise AssertionError(path)
            except urllib.error.HTTPError as e:
                assert e.code == code, (path, e.code)
        try:
            urllib.request.urlopen(urllib.request.Request(url + "/extensionquery", data=b"x" * (g.MAX_BODY + 1), headers={"Content-Type": "application/json"}), timeout=5)
            raise AssertionError("oversized body accepted")
        except urllib.error.HTTPError as e:
            assert e.code == 400
        block = service.product_gallery()
        assert block["serviceUrl"] == url and block["resourceUrlTemplate"].startswith(url + "/unpkg/") and block["itemUrl"] == g.OPENVSX["item"]
        assert block["extensionUrlTemplate"] == url + "/vscode/{publisher}/{name}/latest"

        # The "latest version" resource the client derives from serviceUrl: the
        # extension's own store first, then the others; a miss everywhere is a 404.
        del calls[:]
        with urllib.request.urlopen(url + "/vscode/pub/mist/latest", timeout=5) as r:
            assert r.status == 200 and json.load(r)["versions"][0]["version"] == "1.0.0"
        assert calls == ["https://marketplace.visualstudio.com/_apis/public/gallery/vscode/pub/mist/latest"], calls
        del calls[:]
        with urllib.request.urlopen(url + "/vscode/b/only-ovsx/latest", timeout=5) as r:
            assert json.load(r)["versions"][0]["version"] == "2.0.0"
        assert [c.split("/")[2] for c in calls] == ["marketplace.visualstudio.com", "open-vsx.org"], "unknown to the index: preferred store first, then the other"
        assert service.index["b.only-ovsx"] == "openvsx", "the store that answered is remembered for assets"
        try:
            urllib.request.urlopen(url + "/vscode/no/such/latest", timeout=5)
            raise AssertionError("expected 404")
        except urllib.error.HTTPError as e:
            assert e.code == 404
        # Stats go to the extension's store; the client only needs a 200.
        del calls[:]
        with urllib.request.urlopen(urllib.request.Request(url + "/publishers/pub/extensions/mist/1.0.0/stats?statType=install", data=b"", method="POST"), timeout=5) as r:
            assert r.status == 200
        assert calls == ["https://marketplace.visualstudio.com/_apis/public/gallery/publishers/pub/extensions/mist/1.0.0/stats?statType=install"], calls
        # The request ring records the lot, a query with its text and hit count.
        recent = list(service.recent)
        assert any(r["path"] == "/extensionquery" and r["detail"] == "text='mist' hits=2" for r in recent), recent
        assert recent[-1]["path"] == "/publishers/pub/extensions/mist/1.0.0/stats" and recent[-1]["status"] == 200
        assert any(r["path"] == "/vscode/no/such/latest" and r["status"] == 404 for r in recent)

        # The page injector: the browser's product configuration is what the
        # Extensions view searches with (the engine's product.json never reaches
        # it; openvscode-server serves it empty), so the hook writes the block
        # into the workbench page's settings meta, in the engine's own encoding.
        hook._gallery["service"] = service
        page = ('<meta id="vscode-workbench-web-configuration" data-settings="{&quot;remoteAuthority&quot;:&quot;127.0.0.1:1&quot;,'
                '&quot;serverBasePath&quot;:&quot;/kirocrew-ide&quot;,&quot;productConfiguration&quot;:{},'
                '&quot;callbackRoute&quot;:&quot;/kirocrew-ide/stable-abc/callback&quot;}">\n<meta id="other" data-settings="">')
        out = hook._inject_gallery(page)
        settings = json.loads(out.split('data-settings="', 1)[1].split('"', 1)[0].replace("&quot;", '"'))
        assert settings["productConfiguration"]["extensionsGallery"] == block, settings["productConfiguration"]
        assert settings["productConfiguration"]["linkProtectionTrustedDomains"] == g.TRUSTED_DOMAINS
        assert settings["remoteAuthority"] == "127.0.0.1:1" and settings["callbackRoute"].endswith("/callback"), "the rest of the settings survive"
        assert out.count("vscode-workbench-web-configuration") == 1 and out.endswith('<meta id="other" data-settings="">')
        assert '"' not in out.split('data-settings="', 1)[1].split('">', 1)[0], "quotes stay entity-escaped inside the attribute"
        assert hook._inject_gallery("<html>no meta</html>") == "<html>no meta</html>"
        hook._gallery["service"] = None
        assert hook._inject_gallery(page) == page, "no gallery running: the page is untouched"
        print("gallery: /latest and stats forwarded per store, requests recorded, page carries the block")
    finally:
        service.stop()
    print("gallery: loopback service merges both stores, survives an outage, redirects assets per store")

    # The port is stable across reloads: deactivate closes the listener, the next
    # start binds the same port; a listener an earlier instance left behind is closed too.
    class Log:
        def __getattr__(self, _name):
            return lambda msg, *a, **k: logs.append(msg % a if a else msg)
    hook._ctx = types.SimpleNamespace(log=Log(), config={})
    port = hook._gallery_port()
    assert hook.GALLERY_PORT_BASE <= port < hook.GALLERY_PORT_BASE + hook.PORT_SCAN, port
    first = g.Gallery("merged", fetch, logs.append)
    first.start(port)
    assert first.port == port
    hook._gallery["service"] = first
    hook.deactivate(None)
    assert hook._gallery["service"] is None and first.port is None and hook._port_free(port), "deactivate freed the port"
    hook._ctx = types.SimpleNamespace(log=Log(), config={})
    assert hook._gallery_port() == port, "the reload gets the same port back"
    leaked = g.Gallery("merged", fetch, logs.append)
    leaked.start(port)
    leaked = None  # the old module instance is gone; only its thread remains
    assert not hook._port_free(port)
    hook._close_leaked_galleries()
    assert hook._port_free(port), "the leaked listener was closed through its thread"
    assert any("left on port %d" % port in l for l in logs), logs[-3:]
    hook._ctx = types.SimpleNamespace(log=Log(), config={"engine.gallery_port": str(port)})
    assert hook._gallery_port() == port, "a pinned port is honoured"
    hook._ctx = None
    print("gallery: port stable across deactivate/reload, leaked listeners closed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
