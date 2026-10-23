"""Install an extension from a Marketplace link: ref parsing, the download+install
worker against a stub Marketplace and a fake engine CLI, and the route's states.

The engine's store is Open VSX; `POST extensions/install {"ref"}` takes a
marketplace.visualstudio.com item link (or publisher.name), downloads the VSIX
from the Marketplace's public asset endpoint through the manifest-allowlisted
fetcher, and runs the engine's `--install-extension <vsix>` into the mod's
extensions dir. One install at a time; progress through GET extensions/install.
"""

import gzip
import importlib.util
import io
import json
import os
import stat
import sys
import tempfile
import time
import types
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
HOOK = os.path.join(HERE, "..", "hook", "__init__.py")


def load_hook():
    sys.modules.setdefault("floofy", types.ModuleType("floofy"))
    spec = importlib.util.spec_from_file_location("kirocrew_ide_hook_mkt", HOOK)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class _Log:
    def __init__(self):
        self.lines = []

    def __getattr__(self, level):
        return lambda msg, *args, **_k: self.lines.append((level, msg % args if args else msg))


class _Http:
    def __init__(self):
        self.checked = []

    def check(self, url):
        self.checked.append(url)
        if "marketplace.visualstudio.com" not in url:
            raise RuntimeError("off-list: " + url)


class Ctx:
    def __init__(self, tmp):
        self.data_dir = tmp
        self.config = types.SimpleNamespace(get=lambda _k, d=None: d)
        self.log = _Log()
        self.http = _Http()


class Req:
    def __init__(self, body):
        self._body = body

    def json(self):
        return self._body


def test_parse(hook):
    p = hook._parse_marketplace_ref
    assert p("https://marketplace.visualstudio.com/items?itemName=mubaidr.minimal-mist") == ("mubaidr", "minimal-mist")
    assert p("https://marketplace.visualstudio.com/items?itemName=ms-python.python&ssr=false#overview") == ("ms-python", "python")
    assert p("mubaidr.minimal-mist") == ("mubaidr", "minimal-mist")
    assert p("  publisher.name  ") == ("publisher", "name")
    assert p("https://open-vsx.org/extension/mubaidr/minimal-mist") is None, "another host is not the Marketplace"
    assert p("https://evil.example/items?itemName=a.b") is None
    assert p("not an id") is None
    assert p("a.b.c") is None
    assert p("") is None and p(None) is None
    print("parse OK")


def make_vsix():
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("extension.vsixmanifest", "<PackageManifest/>")
        z.writestr("extension/package.json", json.dumps({"name": "minimal-mist", "publisher": "mubaidr", "version": "1.5.0"}))
    return buf.getvalue()


class _Reply(io.BytesIO):
    def __init__(self, data, headers=None):
        super().__init__(data)
        self.headers = headers or {}

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def test_worker(hook, tmp):
    ctx = Ctx(tmp)
    hook._ctx = ctx
    # A fake engine CLI that records its argv and unpacks nothing.
    engines = os.path.join(tmp, hook.ENGINES_DIR, "openvscode-server-v1.0.0-linux-x64", "bin")
    os.makedirs(engines)
    binary = os.path.join(engines, "openvscode-server")
    with open(binary, "w") as fh:
        fh.write("#!/bin/sh\necho \"$@\" > \"%s\"\nexit 0\n" % os.path.join(tmp, "argv.txt"))
    os.chmod(binary, stat.S_IRWXU)
    # Stub Marketplace: the query answers one extension, the asset endpoint a gzip-wrapped VSIX.
    vsix = make_vsix()
    calls = []

    def fake_urlopen(request, timeout=None):
        calls.append(("query", request.full_url, request.data))
        assert request.get_method() == "POST" and b"mubaidr.minimal-mist" in request.data
        return _Reply(json.dumps({"results": [{"extensions": [{"displayName": "Minimal Mist", "versions": [
            {"version": "1.5.1", "targetPlatform": "win32-x64"}, {"version": "1.5.0"}]}]}]}).encode())

    def fake_open_checked(url, timeout=30):
        calls.append(("download", url))
        return _Reply(gzip.compress(vsix), {"Content-Encoding": "gzip"})

    hook.urllib.request.urlopen = fake_urlopen
    hook._open_checked = fake_open_checked
    hook._install_marketplace_worker("mubaidr", "minimal-mist")
    st = hook._ext_install
    assert st["state"] == "done", st
    assert st["display"] == "Minimal Mist" and st["version"] == "1.5.0", "the platform-neutral version is picked"
    assert calls[0][0] == "query" and calls[1] == ("download", hook.MARKETPLACE_VSIX.format(publisher="mubaidr", name="minimal-mist", version="1.5.0")), calls
    assert hook.MARKETPLACE_QUERY in ctx.http.checked, "the query URL went through the manifest allowlist check"
    assert os.path.isfile(st["vsix"]) and zipfile.is_zipfile(st["vsix"]), "the gzip wrapper is removed, a zip is kept"
    argv = open(os.path.join(tmp, "argv.txt")).read().split()
    assert argv[:2] == ["--extensions-dir", os.path.join(tmp, hook.EXTENSIONS_DIR)] and "--install-extension" in argv and argv[-1] == "--force", argv
    assert argv[argv.index("--install-extension") + 1] == st["vsix"]

    # An extension the Marketplace does not have ends in a clear error.
    hook.urllib.request.urlopen = lambda request, timeout=None: _Reply(json.dumps({"results": [{"extensions": []}]}).encode())
    hook._install_marketplace_worker("nobody", "nothing")
    assert hook._ext_install["state"] == "error" and "not on the Marketplace" in hook._ext_install["error"], hook._ext_install

    # A download that is not a zip is refused before the engine sees it.
    hook.urllib.request.urlopen = fake_urlopen
    hook._open_checked = lambda url, timeout=30: _Reply(b"<html>nope</html>")
    hook._install_marketplace_worker("mubaidr", "minimal-mist")
    assert hook._ext_install["state"] == "error" and "not a VSIX" in hook._ext_install["error"], hook._ext_install

    # The engine CLI failing surfaces its stderr.
    with open(binary, "w") as fh:
        fh.write("#!/bin/sh\necho 'Error: corrupt' 1>&2\nexit 1\n")
    hook._open_checked = fake_open_checked
    hook._install_marketplace_worker("mubaidr", "minimal-mist")
    assert hook._ext_install["state"] == "error" and "corrupt" in hook._ext_install["error"], hook._ext_install
    print("worker OK")


def test_route(hook, tmp):
    hook._ctx = Ctx(tmp)
    started = []
    hook.threading.Thread = lambda target, args, daemon: types.SimpleNamespace(start=lambda: started.append(args))
    assert hook._extensions_install(Req({}))[0] == 400
    assert hook._extensions_install(Req({"ref": "https://open-vsx.org/extension/a/b"}))[0] == 400
    hook._ext_install.clear(); hook._ext_install["state"] = "idle"
    reply = hook._extensions_install(Req({"ref": "https://marketplace.visualstudio.com/items?itemName=mubaidr.minimal-mist"}))
    assert reply["started"] and reply["install"]["state"] == "resolving" and reply["install"]["id"] == "mubaidr.minimal-mist", reply
    assert started == [("mubaidr", "minimal-mist")]
    # One at a time while a worker runs.
    assert hook._extensions_install(Req({"ref": "a.b"}))[0] == 409
    assert hook._extensions_install_status(None)["install"]["state"] == "resolving"
    print("route OK")


def main():
    tmp = tempfile.mkdtemp(prefix="kide-mkt-")
    hook = load_hook()
    test_parse(hook)
    test_worker(hook, tmp)
    test_route(hook, tmp)
    print("marketplace install OK: link/id parsing, allowlisted VSIX download + engine CLI install, one-at-a-time route")
    return 0


if __name__ == "__main__":
    sys.exit(main())
