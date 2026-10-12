"""Dashboard scheme -> workbench default theme: the mod route and the settings splice."""

import importlib.util
import os
import sys
import tempfile
import types

HERE = os.path.dirname(os.path.abspath(__file__))
HOOK = os.path.join(HERE, "..", "hook", "__init__.py")


class Req:
    def __init__(self, body=None, **query):
        self._body = body
        self.query = {k: [v] for k, v in query.items()}

    def json(self):
        return self._body


def _load():
    sys.modules.setdefault("floofy", types.ModuleType("floofy"))
    spec = importlib.util.spec_from_file_location("kirocrew_ide_hook_th", HOOK)
    hook = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(hook)
    return hook


def main():
    hook = _load()
    meta = ('<meta id="vscode-workbench-web-configuration" data-settings="{'
            '&quot;remoteAuthority&quot;:&quot;127.0.0.1:35476&quot;,'
            '&quot;serverBasePath&quot;:&quot;/kirocrew-ide&quot;}">')
    out = hook._inject_theme_default(meta, "light")
    assert "&quot;configurationDefaults&quot;:{&quot;workbench.colorTheme&quot;:&quot;Default Light Modern&quot;}," in out, out
    assert out.index("configurationDefaults") < out.index("serverBasePath")
    assert hook._inject_theme_default(out, "dark") == out, "idempotent: a document already carrying defaults is left alone"
    assert hook._inject_theme_default(meta, None) == meta and hook._inject_theme_default(meta, "sepia") == meta, "unknown scheme -> untouched"
    assert hook._inject_theme_default("<html>", "dark") == "<html>", "no anchor -> untouched"

    with tempfile.TemporaryDirectory() as tmp:
        hook._data_dir_hint["path"] = tmp
        assert hook._read_scheme() is None
        assert hook._theme_get(Req())["scheme"] is None
        status, body = hook._theme_set(Req({"scheme": "blue"}))
        assert status == 400 and "scheme" in body["error"]
        out = hook._theme_set(Req({"scheme": "light"}))
        assert out == {"ok": True, "scheme": "light", "theme": "Default Light Modern"}, out
        assert hook._read_scheme() == "light" and hook._theme_get(Req())["scheme"] == "light"
        hook._theme_set(Req({"scheme": "dark"}))
        assert hook._read_scheme() == "dark"
    print("theme OK: defaults spliced once, unknown schemes ignored, route round-trips the scheme")


if __name__ == "__main__":
    main()
