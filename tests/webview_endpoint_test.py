"""Same-origin webviews: the settings rewrite and the pre/index.html bypass."""

import base64
import hashlib
import importlib.util
import os
import sys
import types

HERE = os.path.dirname(os.path.abspath(__file__))
HOOK = os.path.join(HERE, "..", "hook", "__init__.py")


def _load():
    sys.modules.setdefault("floofy", types.ModuleType("floofy"))
    spec = importlib.util.spec_from_file_location("kirocrew_ide_hook_wv", HOOK)
    hook = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(hook)
    return hook


def main():
    hook = _load()

    # -- the workbench settings rewrite ------------------------------------
    html = ('<meta id="vscode-workbench-web-configuration" data-settings="{'
            '&quot;remoteAuthority&quot;:&quot;127.0.0.1:35476&quot;,'
            '&quot;serverBasePath&quot;:&quot;/kirocrew-ide&quot;}">')
    out = hook._inject_webview_endpoint(html, "http", "localhost:15476")
    expect = ("&quot;webviewEndpoint&quot;:&quot;http://localhost:15476/kirocrew-ide/"
              "stable-{{commit}}/static/out/vs/workbench/contrib/webview/browser/pre/&quot;,"
              "&quot;serverBasePath&quot;")
    assert expect in out, "endpoint spliced before serverBasePath"
    assert hook._inject_webview_endpoint(out, "http", "localhost:15476") == out, "idempotent"
    assert hook._inject_webview_endpoint("<html>", "http", "h") == "<html>", "no anchor -> untouched"
    assert hook._inject_webview_endpoint(html, "http", "") == html, "no host -> untouched"

    # -- the webview host page bypass, with the CSP hash re-pinned ----------
    def csp_hash(text):
        return "'sha256-%s'" % base64.b64encode(hashlib.sha256(text.encode()).digest()).decode()

    script = ("before();\n" + hook._PRE_GUARD_OLD + "\nreturn start(parentOrigin);\n}\n"
              + hook._PRE_REGISTER_OLD + "\n  .then(ok);")
    page = ('<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; '
            "script-src " + csp_hash(script) + " 'self';\">\n"
            '<script async type="module">' + script + "</script>")
    out = hook._inject_preindex_bypass(page)
    assert hook._PRE_GUARD_NEW in out, "same-origin clause added"
    # The module service-worker registration becomes classic: a module worker's
    # script fetch omits credentials, which behind the dashboard's cookie auth
    # returns the SPA shell (text/html) — the 0.8.3 blank-webview bug.
    assert hook._PRE_REGISTER_NEW + "\n  .then(ok);" in out, "service worker registered classic"
    assert "{ type: 'module' }" not in out, "module registration gone"
    edited = (script.replace(hook._PRE_GUARD_OLD, hook._PRE_GUARD_NEW, 1)
              .replace(hook._PRE_REGISTER_OLD, hook._PRE_REGISTER_NEW, 1))
    assert csp_hash(edited) in out, "CSP hash re-pinned to the edited script (both edits)"
    assert csp_hash(script) not in out, "stale hash gone"
    assert hook._inject_preindex_bypass("<html>no script</html>") == "<html>no script</html>"

    # -- against the real engine file when one is installed locally -----------
    real = _find_real_pre_index()
    if real:
        with open(real, encoding="utf-8") as handle:
            page = handle.read()
        assert hook._PRE_REGISTER_OLD in page, "engine still registers a module worker (else drop the edit)"
        out = hook._inject_preindex_bypass(page)
        assert hook._PRE_REGISTER_NEW in out and hook._PRE_GUARD_NEW in out
        match = hook._PRE_SCRIPT_RE.search(out)
        assert csp_hash(match.group(2)) in out, "real page: CSP pins the edited inline script"
        print("webview endpoint OK against the real engine page: %s" % real)

    print("webview endpoint OK: settings rewrite idempotent, pre bypass re-pins the CSP hash, "
          "service worker registered classic")


def _find_real_pre_index():
    import glob
    override = os.environ.get("KIDE_PRE_INDEX")
    if override:
        return override
    roots = [os.path.expanduser("~/.kiro/crew/floofy/mods/kirocrew-ide/.floofy/engines"),
             os.path.join(HERE, "..", ".floofy", "engines")]
    for root in roots:
        hits = glob.glob(os.path.join(root, "*", "out", "vs", "workbench", "contrib", "webview",
                                      "browser", "pre", "index.html"))
        if hits:
            return sorted(hits)[-1]
    return None


if __name__ == "__main__":
    main()
