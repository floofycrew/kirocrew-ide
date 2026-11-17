"""Workspace checkpoints: "Revert changes" for a chat turn, like Kiro IDE's.

Kiro IDE keeps a checkpoint per message in its agent host and offers Revert on
the bubble; through the KiroCrew gateway that store is out of reach, so the mod
keeps its own. A checkpoint is a git tree object of the WHOLE working tree
(tracked and untracked, .gitignore honoured) written through a TEMPORARY index
file, so the user's index, HEAD, branches and stash are never touched. The tree
is anchored by a commit under ``refs/kirocrew/checkpoints/<id>`` so ``git gc``
keeps it; the ref namespace is outside ``refs/heads`` and ``refs/tags``, so
branch and tag lists do not show it. Pruned to CHECKPOINTS_MAX per repository.

Revert restores every file that differs between the checkpoint tree and the
working tree now (modified and deleted files come back, files created since are
removed, empty directories left behind are removed). Before reverting, the
current state is checkpointed too ("before revert") so a revert can be undone.

Non-git folders are reported as unsupported (409): the bridge shows why.

Routes (JSON over the mod's api): see ``routes()`` at the bottom; every folder
is realpath'ed and must be one of the engine's open workspaces (the same gate
the kas routes use) so this cannot snapshot or rewrite an arbitrary directory.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time

CHECKPOINTS_MAX = 200
REF_PREFIX = "refs/kirocrew/checkpoints/"
GIT_TIMEOUT = 120
_ID_RE = re.compile(r"^[0-9a-f]{12,40}$")
_lock = threading.Lock()


class GitError(Exception):
    pass


def real_folder(folder):
    return os.path.realpath(os.path.expanduser(str(folder or ""))).rstrip("/") or "/"


def _git(folder, args, env=None, timeout=GIT_TIMEOUT, check=True, run=subprocess.run):
    e = dict(os.environ)
    e.pop("GIT_DIR", None)
    e.pop("GIT_WORK_TREE", None)
    if env:
        e.update(env)
    try:
        done = run(["git", "-C", folder, "-P", *args], capture_output=True, text=True, timeout=timeout, env=e, check=False)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise GitError("git %s: %s" % (" ".join(args[:2]), error))
    if check and done.returncode:
        raise GitError((done.stderr or done.stdout or "git %s failed" % " ".join(args[:2])).strip())
    return done.stdout


def repo_root(folder, run=subprocess.run):
    """The repository's top level, or None when the folder is not inside a git work tree."""
    try:
        out = _git(folder, ["rev-parse", "--show-toplevel"], run=run)
    except GitError:
        return None
    return real_folder(out.strip()) if out.strip() else None


def _temp_index(folder):
    git_dir = _git(folder, ["rev-parse", "--git-dir"]).strip()
    if not os.path.isabs(git_dir):
        git_dir = os.path.join(folder, git_dir)
    fd, path = tempfile.mkstemp(prefix="kirocrew-index-", dir=git_dir)
    os.close(fd)
    os.unlink(path)  # git wants to create it
    return path


def write_tree(folder, run=subprocess.run):
    """A tree object of the working tree as it is now, through a temporary index (user's index untouched)."""
    index = _temp_index(folder)
    try:
        env = {"GIT_INDEX_FILE": index}
        _git(folder, ["add", "-A", "--", "."], env=env, run=run)
        return _git(folder, ["write-tree"], env=env, run=run).strip()
    finally:
        try:
            os.unlink(index)
        except OSError:
            pass


def _store_path(data_dir, root):
    import hashlib
    key = hashlib.sha256(root.encode("utf-8")).hexdigest()[:16]
    d = os.path.join(str(data_dir), "checkpoints")
    os.makedirs(d, exist_ok=True)
    return os.path.join(d, key + ".json")


def _load(data_dir, root):
    path = _store_path(data_dir, root)
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        data = {}
    rows = data.get("checkpoints") if isinstance(data, dict) else None
    return {"root": root, "checkpoints": [r for r in (rows or []) if isinstance(r, dict) and r.get("id")]}


def _save(data_dir, root, data):
    path = _store_path(data_dir, root)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=1)
    os.replace(tmp, path)


def snapshot(data_dir, folder, meta=None, run=subprocess.run):
    """Checkpoint the working tree now. Returns the record, or a (status, {error}) tuple."""
    root = repo_root(folder, run=run)
    if not root:
        return (409, {"error": "not a git repository: %s" % folder, "unsupported": True})
    meta = dict(meta or {})
    with _lock:
        tree = write_tree(root, run=run)
        data = _load(data_dir, root)
        last = data["checkpoints"][-1] if data["checkpoints"] else None
        label = str(meta.get("label") or "")[:120]
        # The same tree as the newest checkpoint: nothing changed since; reuse it so
        # two clicks in a row do not pile up identical records (the turn still links to it).
        if last and last.get("tree") == tree:
            last.setdefault("turns", []).append({k: meta.get(k) for k in ("session", "turn", "label") if meta.get(k) is not None})
            _save(data_dir, root, data)
            return dict(last, reused=True)
        commit = _git(root, ["commit-tree", tree, "-m", "kirocrew checkpoint " + (label or "")],
                      env={"GIT_AUTHOR_NAME": "KiroCrew IDE", "GIT_AUTHOR_EMAIL": "kirocrew-ide@localhost",
                           "GIT_COMMITTER_NAME": "KiroCrew IDE", "GIT_COMMITTER_EMAIL": "kirocrew-ide@localhost"}, run=run).strip()
        cid = commit[:12]
        _git(root, ["update-ref", REF_PREFIX + cid, commit], run=run)
        record = {"id": cid, "commit": commit, "tree": tree, "time": time.time(), "root": root,
                  "session": meta.get("session"), "turn": meta.get("turn"), "label": label,
                  "kind": str(meta.get("kind") or "turn"), "turns": []}
        data["checkpoints"].append(record)
        _prune(root, data, run=run)
        _save(data_dir, root, data)
        return record


def _prune(root, data, run=subprocess.run):
    rows = data["checkpoints"]
    while len(rows) > CHECKPOINTS_MAX:
        old = rows.pop(0)
        try:
            _git(root, ["update-ref", "-d", REF_PREFIX + old["id"]], run=run, check=False)
        except GitError:
            pass


def list_checkpoints(data_dir, folder, run=subprocess.run):
    root = repo_root(folder, run=run)
    if not root:
        return (409, {"error": "not a git repository: %s" % folder, "unsupported": True})
    data = _load(data_dir, root)
    return {"root": root, "checkpoints": data["checkpoints"]}


def _find(data, cid):
    for r in data["checkpoints"]:
        if r.get("id") == cid:
            return r
    return None


def changed_since(data_dir, folder, cid, run=subprocess.run):
    """Files that differ between checkpoint `cid` and the working tree now: [{path, status}]."""
    root = repo_root(folder, run=run)
    if not root:
        return (409, {"error": "not a git repository: %s" % folder, "unsupported": True})
    if not _ID_RE.match(str(cid or "")):
        return (400, {"error": "bad checkpoint id"})
    data = _load(data_dir, root)
    rec = _find(data, cid)
    if not rec:
        return (404, {"error": "unknown checkpoint %s" % cid})
    with _lock:
        now = write_tree(root, run=run)
        files = _diff_trees(root, rec["tree"], now, run=run)
    return {"id": cid, "root": root, "files": files, "same": now == rec["tree"]}


def _diff_trees(root, old_tree, new_tree, run=subprocess.run):
    out = _git(root, ["diff-tree", "-r", "--name-status", "-z", old_tree, new_tree], run=run)
    parts = out.split("\0")
    files = []
    i = 0
    while i + 1 < len(parts):
        status, path = parts[i], parts[i + 1]
        i += 2
        if not status:
            continue
        code = status[0]
        if code in ("R", "C") and i < len(parts):   # rename/copy carry a second path
            files.append({"path": parts[i], "status": code, "from": path})
            i += 1
            continue
        files.append({"path": path, "status": code})
    return files


def revert(data_dir, folder, cid, run=subprocess.run):
    """Restore the working tree to checkpoint `cid`. Checkpoints the current state first ("before revert")."""
    root = repo_root(folder, run=run)
    if not root:
        return (409, {"error": "not a git repository: %s" % folder, "unsupported": True})
    if not _ID_RE.match(str(cid or "")):
        return (400, {"error": "bad checkpoint id"})
    data = _load(data_dir, root)
    rec = _find(data, cid)
    if not rec:
        return (404, {"error": "unknown checkpoint %s" % cid})
    before = snapshot(data_dir, root, {"label": "before revert to " + cid, "kind": "before-revert"}, run=run)
    if isinstance(before, tuple):
        return before
    with _lock:
        now = write_tree(root, run=run)
        files = _diff_trees(root, rec["tree"], now, run=run)
        if not files:
            return {"id": cid, "root": root, "files": [], "restored": 0, "removed": 0, "undo": before["id"]}
        index = _temp_index(root)
        try:
            env = {"GIT_INDEX_FILE": index}
            _git(root, ["read-tree", rec["tree"]], env=env, run=run)
            # Write back every file that differs (modified or deleted since); `-f` overwrites the current content.
            restore = [f["path"] for f in files if f["status"] != "A"] + [f["from"] for f in files if f.get("from")]
            if restore:
                _git(root, ["checkout-index", "-f", "--", *restore], env=env, run=run)
        finally:
            try:
                os.unlink(index)
            except OSError:
                pass
        removed = 0
        for f in files:
            if f["status"] != "A":
                continue
            p = os.path.join(root, f["path"])
            if os.path.lexists(p) and os.path.realpath(p).startswith(root + os.sep):
                try:
                    os.unlink(p)
                    removed += 1
                except OSError:
                    continue
                d = os.path.dirname(p)
                while d.startswith(root + os.sep) and d != root:
                    try:
                        os.rmdir(d)
                    except OSError:
                        break
                    d = os.path.dirname(d)
    return {"id": cid, "root": root, "files": files, "restored": len(files) - removed, "removed": removed, "undo": before["id"]}


def forget(data_dir, folder, run=subprocess.run):
    """Drop every checkpoint of the folder's repository (refs and records)."""
    root = repo_root(folder, run=run)
    if not root:
        return (409, {"error": "not a git repository: %s" % folder, "unsupported": True})
    data = _load(data_dir, root)
    for r in data["checkpoints"]:
        _git(root, ["update-ref", "-d", REF_PREFIX + r["id"]], run=run, check=False)
    _save(data_dir, root, {"root": root, "checkpoints": []})
    return {"root": root, "forgotten": True}


# ------------------------------------------------------------------ routes

def _body(request):
    try:
        return request.json() or {}
    except Exception:  # noqa: BLE001
        return {}


def _query(request, key):
    values = (getattr(request, "query", None) or {}).get(key) or []
    return values[0] if isinstance(values, list) and values else (values if isinstance(values, str) else "")


def _gate(folder, workspaces):
    """The folder must be (inside) one of the engine's open workspaces; answers the real path or None."""
    real = real_folder(folder)
    if not folder or not os.path.isdir(real):
        return None
    for w in workspaces() or []:
        rw = real_folder(w)
        if real == rw or real.startswith(rw + os.sep):
            return real
    return None


def routes(ctx, data_dir, workspaces):
    """Register the checkpoint routes on the mod's api; `workspaces` lists the engine's open folders."""

    def guard(folder):
        real = _gate(folder, workspaces)
        return real, (None if real else (403, {"error": "not an open workspace: %s" % folder}))

    def _snapshot(request):
        body = _body(request)
        real, err = guard(body.get("folder"))
        if err:
            return err
        try:
            return snapshot(data_dir, real, {k: body.get(k) for k in ("session", "turn", "label", "kind")})
        except GitError as error:
            return (500, {"error": str(error)})

    def _list(request):
        real, err = guard(_query(request, "folder"))
        if err:
            return err
        try:
            return list_checkpoints(data_dir, real)
        except GitError as error:
            return (500, {"error": str(error)})

    def _changed(request):
        real, err = guard(_query(request, "folder"))
        if err:
            return err
        try:
            return changed_since(data_dir, real, _query(request, "id"))
        except GitError as error:
            return (500, {"error": str(error)})

    def _revert(request):
        body = _body(request)
        real, err = guard(body.get("folder"))
        if err:
            return err
        try:
            return revert(data_dir, real, body.get("id"))
        except GitError as error:
            return (500, {"error": str(error)})

    ctx.routes.add("POST", "checkpoints/snapshot", _snapshot)
    ctx.routes.add("GET", "checkpoints", _list)
    ctx.routes.add("GET", "checkpoints/changed", _changed)
    ctx.routes.add("POST", "checkpoints/revert", _revert)
