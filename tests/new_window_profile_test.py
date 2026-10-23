"""The new-window profile seed: "Use for New Windows" is honoured for folders
opened from the mod.

The web workbench picks a load's profile from ?payload=[["profile",name]] or
the folder's association, never from the `window.newWindowProfile` setting the
Profiles editor's toggle writes (the desktop's main process reads that one). The
seed reads the setting from the Default profile's settings.json in the browser's
own IndexedDB user-data store, caches it in localStorage, and rewrites the URL
to the payload form before the workbench boots; a stale cache costs exactly one
early reload. Run under node against stand-ins of the browser globals.
"""

import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import types

HERE = os.path.dirname(os.path.abspath(__file__))
HOOK = os.path.join(HERE, "..", "hook", "__init__.py")


def _load():
    sys.modules.setdefault("floofy", types.ModuleType("floofy"))
    spec = importlib.util.spec_from_file_location("kirocrew_ide_hook_nwp", HOOK)
    hook = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(hook)
    return hook


RUNNER = r"""
const vm = require("vm");
const body = require("fs").readFileSync(process.argv[2], "utf8");
const cases = JSON.parse(require("fs").readFileSync(process.argv[3], "utf8"));
const out = [];
for (const c of cases) {
  const ls = {};
  for (const [k, v] of Object.entries(c.ls || {})) ls[k] = typeof v === "string" ? v : JSON.stringify(v);
  const base = "http://localhost:5476/kirocrew-ide/" + c.search;
  const result = { replaced: null, reloaded: null, cache: undefined, opened: false };
  let href = base;
  // A minimal IndexedDB: open -> success -> getAllKeys/get on one store, all synchronous callbacks
  // fired after the synchronous part of the script ran (queued with setTimeout 0).
  const settings = c.settings; // string (settings.json text) | undefined (no store yet) | null (no key)
  const req = (value) => { const r = {}; setTimeout(() => r.onsuccess && r.onsuccess(), 0); r.result = value; return r; };
  const indexedDB = { open: () => { const o = {}; result.opened = true; setTimeout(() => {
      if (settings === undefined) { o.onerror && o.onerror(); return; }
      o.result = { objectStoreNames: { contains: (n) => n === "vscode-userdata-store" }, close() {},
        transaction: () => ({ objectStore: () => ({
          getAllKeys: () => req(settings === null ? ["/User/keybindings.json"] : ["/User/keybindings.json", "/User/settings.json"]),
          get: () => req(new TextEncoder().encode(settings || "")) }) }) };
      o.onsuccess && o.onsuccess();
    }, 0); return o; } };
  const ctx = {
    get location() { return { href, replace: (u) => { result.reloaded = u; } }; },
    history: { state: null, replaceState: (s, t, u) => { href = u; result.replaced = u; } },
    localStorage: { getItem: (k) => (k in ls ? ls[k] : null), setItem: (k, v) => { ls[k] = v; }, removeItem: (k) => { delete ls[k]; } },
    indexedDB, URL, URLSearchParams, JSON, decodeURIComponent, Array, Object, String, TextDecoder, RegExp, setTimeout,
  };
  vm.runInNewContext(body, ctx);
  out.push(new Promise((res) => setTimeout(() => { result.cache = ls["kirocrew-ide.newWindowProfile"]; res(result); }, 20)));
}
Promise.all(out).then((r) => process.stdout.write(JSON.stringify(r)));
"""


def _profile_of(url):
    if not url:
        return None
    from urllib.parse import parse_qs, urlparse
    payload = parse_qs(urlparse(url).query).get("payload")
    if not payload:
        return ""
    return [p[1] for p in json.loads(payload[0]) if p[0] == "profile"][0] if any(p[0] == "profile" for p in json.loads(payload[0])) else ""


def main():
    hook = _load()
    html = "<html><head><title>x</title></head><body></body></html>"
    out = hook._inject_new_window_profile(html)
    assert 'id="kirocrew-ide-new-window-profile"' in out and out.count("<script") == 1
    assert hook._inject_new_window_profile(out) == out, "idempotent"
    assert hook._inject_new_window_profile("no head here") == "no head here"
    # Order in the composed document: list seed, then this, then the activity-order seed (it reads the payload).
    doc = hook._inject_activity_order(hook._inject_new_window_profile(hook._inject_profile_seed(html, profiles=[{"name": "Work", "location": {"path": "/User/profiles/1a2b3c4d"}}])))
    assert doc.index("kirocrew-ide-profiles") < doc.index("kirocrew-ide-new-window-profile") < doc.index("kirocrew-ide-order")
    print("new-window profile seed: injected once, in order")

    node = shutil.which("node")
    if not node:
        print("node not found: script behaviour not exercised")
        return 0
    script = hook.NEW_WINDOW_PROFILE_SCRIPT.strip()
    body = script[script.index(">") + 1:script.rindex("</script>")]
    work = {"location": {"$mid": 1, "scheme": "vscode-userdata", "path": "/User/profiles/1a2b3c4d"}, "name": "Work"}
    folder = "/local/home/me/proj"
    key = "vscode-remote://localhost:5476" + folder
    setting = '{\n  // my settings\n  "workbench.colorTheme": "Tempest",\n  "window.newWindowProfile": "Work"\n}'
    cases = [
        # label, search, localStorage, settings.json text (None: store has no settings; undefined: no DB), expect
        ("no folder on the url (the picker page)", "", {"userDataProfiles": [work], "kirocrew-ide.newWindowProfile": "Work"}, setting,
         {"replaced": None, "reloaded": None}),
        ("explicit payload profile wins", "?folder=%s&payload=%s" % (folder, json.dumps([["profile", "Other"]])), {"userDataProfiles": [work]}, setting,
         {"replaced": None, "reloaded": None}),
        ("folder association wins", "?folder=" + folder, {"userDataProfiles": [work], "profileAssociations": {"workspaces": {key: "1a2b3c4d"}}}, setting,
         {"replaced": None, "reloaded": None}),
        ("first load after the toggle: cache empty -> read the setting, reload once into Work", "?folder=" + folder, {"userDataProfiles": [work]}, setting,
         {"replaced": None, "reloaded_profile": "Work", "cache": "Work"}),
        ("warm cache: URL rewritten before boot, no reload", "?folder=" + folder, {"userDataProfiles": [work], "kirocrew-ide.newWindowProfile": "Work"}, setting,
         {"replaced_profile": "Work", "reloaded": None, "cache": "Work"}),
        ("toggle switched off: stale cache dropped, reload back to Default", "?folder=" + folder, {"userDataProfiles": [work], "kirocrew-ide.newWindowProfile": "Work"},
         '{"window.newWindowProfile": null}', {"replaced_profile": "Work", "reloaded_profile": "", "cache": None}),
        ("setting names a profile this browser does not have", "?folder=" + folder, {"userDataProfiles": []}, setting,
         {"replaced": None, "reloaded": None, "cache": "Work"}),
        ("no settings.json in the store", "?folder=" + folder, {"userDataProfiles": [work]}, None,
         {"replaced": None, "reloaded": None, "cache": None}),
        ("no user-data database yet (first visit)", "?folder=" + folder, {"userDataProfiles": [work]}, "__undefined__",
         {"replaced": None, "reloaded": None, "cache": None}),
        ("corrupt localStorage", "?folder=" + folder, {"userDataProfiles": "{nope", "kirocrew-ide.newWindowProfile": "Work"}, setting,
         {"replaced": None, "reloaded": None}),
    ]
    tmp = tempfile.mkdtemp(prefix="kide-nwp-")
    try:
        paths = {}
        payload = []
        for _, search, ls, settings, _ in cases:
            entry = {"search": search, "ls": ls}
            if settings != "__undefined__":
                entry["settings"] = settings
            payload.append(entry)
        for fname, text in (("seed.js", body), ("run.js", RUNNER), ("cases.json", json.dumps(payload))):
            paths[fname] = os.path.join(tmp, fname)
            with open(paths[fname], "w", encoding="utf-8") as fh:
                fh.write(text)
        res = subprocess.run([node, paths["run.js"], paths["seed.js"], paths["cases.json"]], check=True, capture_output=True, text=True)
        results = json.loads(res.stdout)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    for (label, _, _, _, expect), got in zip(cases, results):
        for k, v in expect.items():
            if k.endswith("_profile"):
                actual = _profile_of(got[k[:-8]])
            else:
                actual = got.get(k)
            assert actual == v, "%s: %s = %r, expected %r (result %r)" % (label, k, actual, v, got)
    print("new-window profile seed: %d browser cases pass (node)" % len(cases))
    return 0


if __name__ == "__main__":
    sys.exit(main())
