"""The profile-list seed: the engine's mirrored profiles reach every browser.

The web workbench owns the profile LIST in the browser (localStorage
"userDataProfiles", per origin); the engine's storage.json only mirrors it. A
profile imported in one client therefore vanished from the picker in another
origin, or after the browser's storage was wiped, while its data stayed under
data/User/profiles/<id>/. The seed reads the mirror server-side, keeps the
profiles whose folder exists, and merges them into the browser's list before the
workbench boots, ahead of the activity-order seed that reads the same list.
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
    spec = importlib.util.spec_from_file_location("kirocrew_ide_hook_ps", HOOK)
    hook = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(hook)
    return hook


def main():
    hook = _load()
    tmp = tempfile.mkdtemp(prefix="kide-profiles-")
    try:
        storage = os.path.join(tmp, "storage.json")
        dirs = os.path.join(tmp, "profiles")
        for pid in ("-1180f179", "-3904788d"):
            os.makedirs(os.path.join(dirs, pid))
        # The engine's own shape: the list is a JSON string inside storage.json,
        # locations are bare ids; ghosts of re-created profiles have no folder.
        mirror = [
            {"location": "-1180f179", "name": "vscode", "icon": "briefcase"},
            {"location": "-3904788d", "name": "vscode-default", "useDefaultFlags": {"globalState": True}},
            {"location": "-2dc5b0a9", "name": "vscode"},
            {"location": "-4e25e7f3", "name": "vscode"},
            {"location": "", "name": "no id"},
            {"name": "no location"},
            "not a dict",
        ]
        with open(storage, "w", encoding="utf-8") as fh:
            json.dump({"userDataProfiles": json.dumps(mirror), "profileAssociations": "{}"}, fh)
        kept = hook._mirrored_profiles(storage, dirs)
        assert [p["location"] for p in kept] == ["-1180f179", "-3904788d"], kept
        assert kept[0] == {"location": "-1180f179", "name": "vscode", "icon": "briefcase"}
        assert kept[1]["useDefaultFlags"] == {"globalState": True}

        # A uri-shaped location (older mirrors) reduces to its last segment too.
        with open(storage, "w", encoding="utf-8") as fh:
            json.dump({"userDataProfiles": [{"location": {"path": "/User/profiles/-1180f179"}, "name": "vscode"}]}, fh)
        assert [p["location"] for p in hook._mirrored_profiles(storage, dirs)] == ["-1180f179"]

        # Missing or corrupt mirror: nothing injected, document untouched.
        assert hook._mirrored_profiles(os.path.join(tmp, "nope.json"), dirs) == []
        with open(storage, "w", encoding="utf-8") as fh:
            fh.write("{not json")
        assert hook._mirrored_profiles(storage, dirs) == []
        html = "<html><head><title>x</title></head><body></body></html>"
        assert hook._inject_profile_seed(html, []) == html, "no profiles -> untouched"

        out = hook._inject_profile_seed(html, kept)
        assert out.count('id="kirocrew-ide-profiles"') == 1
        assert out.index('id="kirocrew-ide-profiles"') < out.index("</head>")
        assert hook._inject_profile_seed(out, kept) == out, "idempotent"
        assert hook._inject_profile_seed("<p>no head</p>", kept) == "<p>no head</p>"
        both = hook._inject_activity_order(hook._inject_profile_seed(html, kept))
        assert both.index('id="kirocrew-ide-profiles"') < both.index('id="kirocrew-ide-order"'), \
            "the profile seed runs before the order seed that reads the list"
        evil = hook._inject_profile_seed(html, [{"location": "x", "name": "</script><b>"}])
        assert "</script><b>" not in evil, "a name cannot close the script element"

        node = shutil.which("node")
        if node:
            script = out[out.index('<script id="kirocrew-ide-profiles">'):]
            body = script[script.index(">") + 1:script.index("</script>")]
            runner = """
const vm = require("vm");
const body = require("fs").readFileSync(process.argv[2], "utf8");
const cases = JSON.parse(require("fs").readFileSync(process.argv[3], "utf8"));
const out = [];
for (const c of cases) {
  const ls = Object.assign({}, c.ls);
  const ctx = { localStorage: { getItem: (k) => (k in ls ? ls[k] : null), setItem: (k, v) => { ls[k] = v; } },
                JSON, Array, Object, String };
  vm.runInNewContext(body, ctx);
  out.push(ls.userDataProfiles === undefined ? null : JSON.parse(ls.userDataProfiles));
}
process.stdout.write(JSON.stringify(out));
"""
            work = {"location": {"$mid": 1, "scheme": "vscode-userdata", "path": "/User/profiles/1a2b3c4d"}, "name": "Work"}
            same_name = {"location": {"$mid": 1, "scheme": "vscode-userdata", "path": "/User/profiles/aaaaaaaa"}, "name": "vscode"}
            already = {"location": {"$mid": 1, "scheme": "vscode-userdata", "path": "/User/profiles/-1180f179"}, "name": "vscode"}
            cases = [
                ("empty browser list", {}, ["-1180f179", "-3904788d"]),
                ("browser has another profile: mirror appended, nothing removed", {"userDataProfiles": json.dumps([work])},
                 ["1a2b3c4d", "-1180f179", "-3904788d"]),
                ("browser already has the id: not duplicated", {"userDataProfiles": json.dumps([already])},
                 ["-1180f179", "-3904788d"]),
                ("browser has the name under another id: the name is not doubled", {"userDataProfiles": json.dumps([same_name])},
                 ["aaaaaaaa", "-3904788d"]),
                ("corrupt browser list: replaced by the mirror", {"userDataProfiles": "{not json"}, ["-1180f179", "-3904788d"]),
            ]
            paths = {}
            for fname, text in (("seed.js", body), ("run.js", runner),
                                ("cases.json", json.dumps([{"ls": ls} for _, ls, _ in cases]))):
                paths[fname] = os.path.join(tmp, fname)
                with open(paths[fname], "w", encoding="utf-8") as fh:
                    fh.write(text)
            res = subprocess.run([node, paths["run.js"], paths["seed.js"], paths["cases.json"]],
                                 check=True, capture_output=True, text=True)
            results = json.loads(res.stdout)

            def ids(lst):
                out_ids = []
                for p in lst or []:
                    loc = p.get("location")
                    s = loc if isinstance(loc, str) else (loc or {}).get("path", "")
                    out_ids.append(s.rstrip("/").rsplit("/", 1)[-1])
                return out_ids
            for (label, _, expected), got in zip(cases, results):
                assert ids(got) == expected, "%s: %r, expected %r" % (label, ids(got), expected)
            # The browser's own entries keep their stored shape (uri location), the mirrored ones the bare id.
            assert results[1][0]["location"] == work["location"]
            print("seed script merges the mirror into the browser list (%d cases, node)" % len(cases))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    print("profile_seed_test: ok")


if __name__ == "__main__":
    main()
