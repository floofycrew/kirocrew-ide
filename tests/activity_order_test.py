"""Activity-bar order: the pre-boot seed script is spliced into the workbench
document's <head>, once, and stays out of every other response.

The workbench reads workbench.activity.pinnedViewlets2 exactly once, at boot,
and writes its in-memory copy back on every later state change. A seed that
lands after that read (the 0.8.2 extension-side write) is overwritten by the
next save, so the seed has to run in the document itself before the workbench
script does. Set KIDE_WORKBENCH_HTML to the engine's real workbench.html to
also assert against the shipped document.
"""

import importlib.util
import os
import sys
import types

HERE = os.path.dirname(os.path.abspath(__file__))
HOOK = os.path.join(HERE, "..", "hook", "__init__.py")


def _load():
    sys.modules.setdefault("floofy", types.ModuleType("floofy"))
    spec = importlib.util.spec_from_file_location("kirocrew_ide_hook_ao", HOOK)
    hook = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(hook)
    return hook


def main():
    hook = _load()
    html = "<html><head><title>x</title></head><body></body></html>"
    out = hook._inject_activity_order(html)
    assert out.count('id="kirocrew-ide-order"') == 1, "script spliced once"
    assert out.index('id="kirocrew-ide-order"') < out.index("</head>"), "in the head"
    assert hook._inject_activity_order(out) == out, "idempotent"
    assert hook._inject_activity_order("<p>no head</p>") == "<p>no head</p>", "no head -> untouched"
    script = hook.ACTIVITY_ORDER_SCRIPT
    for needle in ("workbench.activity.pinnedViewlets2", "workbench.view.extension.kirocrew",
                   "vscode-web-state-db-global", hook.ACTIVITY_ORDER_MARK):
        assert needle in script, needle
    assert hook.ACTIVITY_ORDER_MARK != "kirocrew-ide.activityOrderSeeded", \
        "v1 marker was set by 0.8.1 on profiles whose order was later lost; v2 must re-seed them once"
    # The marker is checked BEFORE the order is read, so a seeded profile does
    # not even touch the pinned key (a user's drag is never rewritten).
    assert script.index('store.get(MARK)') < script.index('store.get(KEY)')

    # A VS Code profile other than the default keeps its UI state in its own
    # store (vscode-web-state-db-global-<id>); the seed must open THAT one or
    # the icon lands last in every imported/created profile. The profile list
    # is browser-owned in the web workbench, so the choice is made in the
    # script, from the same localStorage list and URL the workbench reads.
    assert 'localStorage.getItem("userDataProfiles")' in script
    assert 'localStorage.getItem("profileAssociations")' in script, "workspace -> profile map is its own key"
    assert 'params.get("payload")' in script and 'pair[0] === "profile"' in script, "switch-profile reload form"
    assert 'params.get("folder")' in script and "assoc.workspaces" in script, "folder association"
    assert "useDefaultFlags.globalState" in script, "profiles sharing UI state read the default store"
    assert 'DB = DB + "-" + id' in script and "indexedDB.open(DB)" in script
    assert script.index("indexedDB.open(DB)") > script.index('DB = DB + "-" + id'), "store chosen before it is opened"

    # The seed is JavaScript inside a Python string. With node available, run
    # it against stand-ins of the browser globals and check WHICH store it
    # opens, using the exact shapes the engine (1.109) keeps in localStorage:
    # userDataProfiles = [{location: <uri json>, name, ...}] (id = last path
    # segment of location; no workspaces field), profileAssociations =
    # {workspaces: {"<uri string>": "<profile id>"}} with the folder as
    # vscode-remote://<host>/<path>, URI-encoded.
    import json
    import shutil
    import subprocess
    import tempfile
    node = shutil.which("node")
    if node:
        body = script.strip()
        body = body[body.index(">") + 1:body.rindex("</script>")]
        work = {"location": {"$mid": 1, "scheme": "vscode-userdata", "path": "/User/profiles/1a2b3c4d"},
                "name": "Work", "icon": "briefcase"}
        shared = dict(work, location={"$mid": 1, "scheme": "vscode-userdata", "path": "/User/profiles/feedbeef"},
                      name="Shared", useDefaultFlags={"globalState": True})
        folder = "/local/home/me/my proj"
        key = "vscode-remote://localhost:35476" + folder.replace(" ", "%20")
        cases = [
            # (label, search, localStorage, expected store)
            ("no profiles", "?folder=" + folder, {}, "vscode-web-state-db-global"),
            ("payload names Work", "?folder=" + folder + '&payload=[["profile","Work"]]',
             {"userDataProfiles": [work]}, "vscode-web-state-db-global-1a2b3c4d"),
            ("payload names an unknown profile", '?payload=[["profile","Nope"]]',
             {"userDataProfiles": [work]}, "vscode-web-state-db-global"),
            ("folder associated with Work", "?folder=" + folder,
             {"userDataProfiles": [work], "profileAssociations": {"workspaces": {key: "1a2b3c4d"}}},
             "vscode-web-state-db-global-1a2b3c4d"),
            ("folder associated, trailing slash in the url", "?folder=" + folder + "/",
             {"userDataProfiles": [work], "profileAssociations": {"workspaces": {key: "1a2b3c4d"}}},
             "vscode-web-state-db-global-1a2b3c4d"),
            ("another folder associated", "?folder=/local/home/me/other",
             {"userDataProfiles": [work], "profileAssociations": {"workspaces": {key: "1a2b3c4d"}}},
             "vscode-web-state-db-global"),
            ("associated profile shares UI state with the default", "?folder=" + folder,
             {"userDataProfiles": [shared], "profileAssociations": {"workspaces": {key: "feedbeef"}}},
             "vscode-web-state-db-global"),
            ("association to a profile that no longer exists", "?folder=" + folder,
             {"userDataProfiles": [], "profileAssociations": {"workspaces": {key: "1a2b3c4d"}}},
             "vscode-web-state-db-global"),
            ("corrupt localStorage", "?folder=" + folder,
             {"userDataProfiles": "{not json", "profileAssociations": "[]"}, "vscode-web-state-db-global"),
        ]
        runner = """
const vm = require("vm");
const body = require("fs").readFileSync(process.argv[2], "utf8");
const cases = JSON.parse(require("fs").readFileSync(process.argv[3], "utf8"));
const out = [];
for (const c of cases) {
  const ls = {};
  for (const [k, v] of Object.entries(c.ls)) ls[k] = typeof v === "string" ? v : JSON.stringify(v);
  let opened = null;
  const ctx = {
    location: { search: c.search, host: "localhost:35476" },
    localStorage: { getItem: (k) => (k in ls ? ls[k] : null) },
    indexedDB: { open: (name) => { opened = name; return {}; } },
    URLSearchParams, JSON, decodeURIComponent, Array, Object, String,
  };
  vm.runInNewContext(body, ctx);
  out.push(opened);
}
process.stdout.write(JSON.stringify(out));
"""
        tmp = tempfile.mkdtemp(prefix="kide-seed-")
        try:
            paths = {}
            for fname, text in (("seed.js", body), ("run.js", runner),
                                ("cases.json", json.dumps([{"search": s, "ls": ls} for _, s, ls, _ in cases]))):
                paths[fname] = os.path.join(tmp, fname)
                with open(paths[fname], "w", encoding="utf-8") as fh:
                    fh.write(text)
            res = subprocess.run([node, paths["run.js"], paths["seed.js"], paths["cases.json"]],
                                 check=True, capture_output=True, text=True)
            opened = json.loads(res.stdout)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
        for (label, _, _, expected), got in zip(cases, opened):
            assert got == expected, "%s: opened %r, expected %r" % (label, got, expected)
        print("seed script picks the profile's store (%d cases, node)" % len(cases))

    real = os.environ.get("KIDE_WORKBENCH_HTML")
    if real and os.path.exists(real):
        with open(real, encoding="utf-8") as fh:
            doc = fh.read()
        assert "Content-Security-Policy" not in doc, "engine document grew a CSP: re-pin the seed"
        out = hook._inject_activity_order(doc)
        assert out.count("<script") == doc.count("<script") + 1
        print("real workbench.html: ok")
    print("activity_order_test: ok")


if __name__ == "__main__":
    main()
