"""The folder -> profile seed: a folder opens in the profile you gave it, in every client.

The web workbench keeps which profile a folder opens in as browser state
(localStorage "profileAssociations", {workspaces: {"<folder uri>": "<id>"}}),
and never forwards it to the server (the remote profiles service syncs profile
creation and removal only; the engine's mirror reads `workspaces: {}`). So a
folder opened from a new browser, or the desktop app after its storage moved,
booted into Default. The layer now reports the browser's map to the host
(`POST profiles/associations`, stored by folder PATH), and the served document
seeds that record into a browser's map before the workbench boots — only for
folders the browser has no entry for, so a choice made in that browser wins.

The key's authority is the engine's own 127.0.0.1:<port> (the proxy drops the
browser's Host), and the workbench compares keys as whole URIs, so a relaunch
that moved the port orphaned earlier choices; the seed copies an entry held
under another authority to the current one.
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
    spec = importlib.util.spec_from_file_location("kirocrew_ide_hook_assoc", HOOK)
    hook = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(hook)
    return hook


class _Request:
    def __init__(self, body):
        self._body = body

    def json(self):
        if isinstance(self._body, Exception):
            raise self._body
        return self._body


class _Ctx:
    def __init__(self, tmp):
        self.data_dir = tmp
        self.state = {}


def main():
    hook = _load()
    tmp = tempfile.mkdtemp(prefix="kide-assoc-")
    try:
        dirs = os.path.join(tmp, "profiles")
        for pid in ("-1180f179", "4b57311b"):
            os.makedirs(os.path.join(dirs, pid))
        folder_a = os.path.join(tmp, "proj a")
        folder_b = os.path.join(tmp, "projb")
        os.makedirs(folder_a)
        os.makedirs(folder_b)
        hook._ctx = _Ctx(tmp)
        with open(os.path.join(tmp, "server.json"), "w", encoding="utf-8") as fh:
            json.dump({"port": 35476, "pid": 1}, fh)
        assert hook._engine_authority() == "127.0.0.1:35476"
        assert hook._engine_authority({}) is None

        # --- key -> path: URI strings as the workbench stores them, bare paths, junk ---
        assert hook._uri_path("vscode-remote://127.0.0.1:35476/local/home/me/proj%20a/") == "/local/home/me/proj a"
        assert hook._uri_path("vscode-remote://127.0.0.1:35476") == ""
        assert hook._uri_path("/abs/path/") == "/abs/path"
        assert hook._uri_path("relative") == ""
        assert hook._uri_path("vscode-remote://h/") == "/"
        assert hook._uri_authority("vscode-remote://127.0.0.1:35477/x") == "127.0.0.1:35477"
        assert hook._uri_authority("/x") is None

        # --- a browser's map -> {path: id}: unknown profiles dropped, the current authority wins ---
        reported = {
            "vscode-remote://127.0.0.1:35477" + folder_a.replace(" ", "%20"): "4b57311b",   # older engine port
            "vscode-remote://127.0.0.1:35476" + folder_a.replace(" ", "%20"): "-1180f179",  # current one
            "vscode-remote://127.0.0.1:35476" + folder_b: hook.DEFAULT_PROFILE_ID,           # an explicit Default
            "vscode-remote://127.0.0.1:35476/gone": "deadbeef",                              # no such profile folder
            "vscode-remote://127.0.0.1:35476/odd": "../../etc",                             # not an id shape
            "nonsense": "-1180f179",
            42: "-1180f179",
            "vscode-remote://127.0.0.1:35476/notastring": 7,
        }
        norm = hook._normalise_associations(reported, dirs_path=dirs, authority="127.0.0.1:35476")
        assert norm == {folder_a: "-1180f179", folder_b: hook.DEFAULT_PROFILE_ID}, norm
        # Without a known authority the last entry for a path wins.
        two = {"vscode-remote://127.0.0.1:35477/p": "4b57311b", "vscode-remote://127.0.0.1:35476/p": "-1180f179"}
        assert hook._normalise_associations(two, dirs_path=dirs, authority=None) == {"/p": "-1180f179"}
        # The pinned (current-authority) entry is kept even when an older one comes later in the map.
        assert hook._normalise_associations({"vscode-remote://127.0.0.1:35476/p": "-1180f179", "vscode-remote://127.0.0.1:35477/p": "4b57311b"},
                                            dirs_path=dirs, authority="127.0.0.1:35476") == {"/p": "-1180f179"}

        # --- the record: upsert by path, atomic file, read-back ---
        record_path = os.path.join(tmp, "profile-associations.json")
        assert hook._read_associations(record_path) == {}
        record, changed = hook._record_associations({"/a": "-1180f179", "/b": hook.DEFAULT_PROFILE_ID}, record_path)
        assert changed == 2 and record == {"/a": "-1180f179", "/b": hook.DEFAULT_PROFILE_ID}
        record, changed = hook._record_associations({"/a": "-1180f179"}, record_path)
        assert changed == 0, "an unchanged report writes nothing"
        record, changed = hook._record_associations({"/a": "4b57311b"}, record_path)
        assert changed == 1 and record == {"/a": "4b57311b", "/b": hook.DEFAULT_PROFILE_ID}, "another browser's choice updates the path, others stay"
        assert hook._read_associations(record_path) == record
        assert not os.path.exists(record_path + ".tmp")
        with open(record_path, "w", encoding="utf-8") as fh:
            fh.write("{broken")
        assert hook._read_associations(record_path) == {}
        record, _ = hook._record_associations({"/a": "4b57311b"}, record_path)
        assert record == {"/a": "4b57311b"}, "a corrupt record is replaced, not fatal"
        # The cap keeps the newest report whole.
        big = {"/f%d" % i: "4b57311b" for i in range(hook.PROFILE_ASSOCIATIONS_MAX + 20)}
        hook._record_associations(big, record_path)
        hook._record_associations({"/last": "-1180f179"}, record_path)
        capped = hook._read_associations(record_path)
        assert len(capped) == hook.PROFILE_ASSOCIATIONS_MAX and capped["/last"] == "-1180f179"

        # --- what the seed ships: existing folders, profiles that still have a folder ---
        hook._record_associations({folder_a: "-1180f179", folder_b: hook.DEFAULT_PROFILE_ID,
                                   os.path.join(tmp, "missing"): "-1180f179", "/also": "feedbeef"}, record_path)
        shipped = hook._recorded_associations(record_path, dirs)
        assert shipped == {folder_a: "-1180f179", folder_b: hook.DEFAULT_PROFILE_ID}, shipped

        # --- the routes ---
        os.remove(record_path)
        assert hook._associations_get(None) == {"workspaces": {}, "authority": "127.0.0.1:35476"}
        status, body = hook._associations_set(_Request({"workspaces": "nope"}))
        assert status == 400
        status, body = hook._associations_set(_Request(ValueError("bad json")))
        assert status == 400
        status, _ = hook._associations_set(_Request({"workspaces": {"/f%d" % i: "x" for i in range(hook.PROFILE_ASSOCIATIONS_MAX + 1)}}))
        assert status == 400, "an oversized report is refused before any work"
        hook.PROFILE_DIRS_PATH = dirs
        reply = hook._associations_set(_Request({"workspaces": reported}))
        assert reply["ok"] and reply["accepted"] == 2 and reply["changed"] == 2, reply
        assert reply["workspaces"] == {folder_a: "-1180f179", folder_b: hook.DEFAULT_PROFILE_ID}
        assert hook._associations_get(None)["workspaces"] == reply["workspaces"]
        reply = hook._associations_set(_Request({"workspaces": reported}))
        assert reply["changed"] == 0

        # --- the injection: placement, idempotency, escaping ---
        html = "<html><head><title>x</title></head><body></body></html>"
        out = hook._inject_association_seed(html, {folder_a: "-1180f179"}, "127.0.0.1:35476")
        assert out.count('id="kirocrew-ide-associations"') == 1
        assert out.index('id="kirocrew-ide-associations"') < out.index("</head>")
        assert hook._inject_association_seed(out, {folder_a: "-1180f179"}, "127.0.0.1:35476") == out, "idempotent"
        assert hook._inject_association_seed("<p>no head</p>", {}, None) == "<p>no head</p>"
        empty = hook._inject_association_seed(html, {}, None)
        assert 'id="kirocrew-ide-associations"' in empty, "injected with nothing recorded: the port migration needs no record"
        evil = hook._inject_association_seed(html, {"/x</script><b>": "-1180f179"}, "</script>")
        assert "</script><b>" not in evil and evil.count("</script>") == 1, "a path or authority cannot close the script element"
        chain = hook._inject_activity_order(hook._inject_new_window_profile(hook._inject_association_seed(
            hook._inject_profile_seed(html, [{"location": "-1180f179", "name": "vscode"}]), {}, None)))
        order = [chain.index('id="kirocrew-ide-profiles"'), chain.index('id="kirocrew-ide-associations"'),
                 chain.index('id="kirocrew-ide-new-window-profile"'), chain.index('id="kirocrew-ide-order"')]
        assert order == sorted(order), "list seed, then associations, then the two seeds that read the association"

        node = shutil.which("node")
        if node:
            script = out[out.index('<script id="kirocrew-ide-associations">'):]
            body = script[script.index(">") + 1:script.index("</script>")]
            # The seed is JavaScript inside a Python string: run it against stand-ins of
            # localStorage and the workbench's configuration meta, with the shapes the
            # engine (1.109) keeps: userDataProfiles = [{location: <uri json>, name}],
            # profileAssociations = {workspaces: {"vscode-remote://<authority>/<path>": "<id>"}}.
            runner = """
const vm = require("vm");
const cases = JSON.parse(require("fs").readFileSync(process.argv[2], "utf8"));
const out = [];
for (const c of cases) {
  const ls = Object.assign({}, c.ls);
  const meta = c.meta === undefined ? null : { getAttribute: () => c.meta };
  const ctx = { localStorage: { getItem: (k) => (k in ls ? ls[k] : null), setItem: (k, v) => { ls[k] = v; } },
                document: { getElementById: (id) => (id === "vscode-workbench-web-configuration" ? meta : null) },
                JSON, Array, Object, String, encodeURIComponent, decodeURIComponent };
  vm.runInNewContext(c.body, ctx);
  out.push(ls.profileAssociations === undefined ? null : JSON.parse(ls.profileAssociations));
}
process.stdout.write(JSON.stringify(out));
"""
            work = {"location": {"$mid": 1, "scheme": "vscode-userdata", "path": "/User/profiles/-1180f179"}, "name": "vscode"}
            other = {"location": {"$mid": 1, "scheme": "vscode-userdata", "path": "/User/profiles/4b57311b"}, "name": "Probe"}
            meta_now = json.dumps({"remoteAuthority": "127.0.0.1:35476", "serverBasePath": "/kirocrew-ide"})
            key_now = "vscode-remote://127.0.0.1:35476" + folder_a.replace(" ", "%20")
            key_old = "vscode-remote://127.0.0.1:35477" + folder_a.replace(" ", "%20")
            key_b_now = "vscode-remote://127.0.0.1:35476" + folder_b

            def seed(record, authority):
                if authority is None:  # the injector reads None as "from the engine state": build the bare script instead
                    s = hook.PROFILE_ASSOCIATION_SEED_SCRIPT % (json.dumps(record), "null", hook.DEFAULT_PROFILE_ID)
                else:
                    s = hook._inject_association_seed(html, record, authority)
                s = s[s.index('<script id="kirocrew-ide-associations">'):]
                return s[s.index(">") + 1:s.index("</script>")]

            cases = [
                # (label, body, meta, localStorage, expected workspaces)
                ("empty browser: the record is seeded under the meta's authority",
                 seed({folder_a: "-1180f179"}, "127.0.0.1:9"), meta_now, {"userDataProfiles": json.dumps([work])},
                 {key_now: "-1180f179"}),
                ("no meta: the embedded authority is used",
                 seed({folder_a: "-1180f179"}, "127.0.0.1:35476"), None, {"userDataProfiles": json.dumps([work])},
                 {key_now: "-1180f179"}),
                ("no meta and no authority: nothing written",
                 seed({folder_a: "-1180f179"}, None), None, {"userDataProfiles": json.dumps([work])},
                 None),
                ("the browser's own choice for the folder wins over the record",
                 seed({folder_a: "-1180f179"}, "127.0.0.1:35476"), meta_now,
                 {"userDataProfiles": json.dumps([work, other]), "profileAssociations": json.dumps({"workspaces": {key_now: "4b57311b"}})},
                 {key_now: "4b57311b"}),
                ("an explicit Default in the browser is a choice too",
                 seed({folder_a: "-1180f179"}, "127.0.0.1:35476"), meta_now,
                 {"userDataProfiles": json.dumps([work]), "profileAssociations": json.dumps({"workspaces": {key_now: hook.DEFAULT_PROFILE_ID}})},
                 {key_now: hook.DEFAULT_PROFILE_ID}),
                ("a choice keyed with an earlier engine port is copied to the current one (and beats the record)",
                 seed({folder_a: "-1180f179"}, "127.0.0.1:35476"), meta_now,
                 {"userDataProfiles": json.dumps([work, other]), "profileAssociations": json.dumps({"workspaces": {key_old: "4b57311b"}})},
                 {key_old: "4b57311b", key_now: "4b57311b"}),
                ("a recorded profile this browser does not list is skipped",
                 seed({folder_a: "feedbeef", folder_b: "-1180f179"}, "127.0.0.1:35476"), meta_now, {"userDataProfiles": json.dumps([work])},
                 {key_b_now: "-1180f179"}),
                ("a recorded Default is seeded (it stops the new-window profile for that folder)",
                 seed({folder_b: hook.DEFAULT_PROFILE_ID}, "127.0.0.1:35476"), meta_now, {"userDataProfiles": json.dumps([work])},
                 {key_b_now: hook.DEFAULT_PROFILE_ID}),
                ("other entries and emptyWindows survive",
                 seed({folder_a: "-1180f179"}, "127.0.0.1:35476"), meta_now,
                 {"userDataProfiles": json.dumps([work]), "profileAssociations": json.dumps({"workspaces": {key_b_now: "-1180f179"}, "emptyWindows": {"w1": "-1180f179"}})},
                 {key_b_now: "-1180f179", key_now: "-1180f179"}),
                ("corrupt map: replaced by the seed",
                 seed({folder_a: "-1180f179"}, "127.0.0.1:35476"), meta_now,
                 {"userDataProfiles": json.dumps([work]), "profileAssociations": "{nope"},
                 {key_now: "-1180f179"}),
                ("nothing recorded, nothing stale: the map is left alone",
                 seed({}, "127.0.0.1:35476"), meta_now, {"userDataProfiles": json.dumps([work])},
                 None),
            ]
            paths = {}
            for fname, text in (("run.js", runner),
                                ("cases.json", json.dumps([{"body": b, "meta": m, "ls": ls} for _, b, m, ls, _ in cases]))):
                paths[fname] = os.path.join(tmp, fname)
                with open(paths[fname], "w", encoding="utf-8") as fh:
                    fh.write(text)
            res = subprocess.run([node, paths["run.js"], paths["cases.json"]], check=True, capture_output=True, text=True)
            results = json.loads(res.stdout)
            for (label, _, _, _, expected), got in zip(cases, results):
                workspaces = got.get("workspaces") if isinstance(got, dict) else got
                assert workspaces == expected, "%s: %r, expected %r" % (label, workspaces, expected)
            assert results[8]["emptyWindows"] == {"w1": "-1180f179"}
            print("seed script merges the record and migrates stale ports (%d cases, node)" % len(cases))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    print("profile_associations_test: ok")


if __name__ == "__main__":
    main()
