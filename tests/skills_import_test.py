"""Skill import from GitHub (requirement 11.4): the hook's `parse_github_url`
against the URL table shared with tests/steering_import.test.mjs (so the Python
and JS parsers agree), `skill_name_of`, `find_skill_dir`, `safe_extract`, and
`import_skill`'s error paths and success path with a stub fetcher, a temp home
and a temp tmp_root. No network.
"""

import importlib.util
import io
import json
import os
import re
import sys
import tarfile
import tempfile
import types
import urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))
GALLERY = os.path.join(HERE, "..", "hook", "gallery.py")
JS_TEST = os.path.join(HERE, "steering_import.test.mjs")


def load_gallery():
    sys.modules.setdefault("floofy", types.ModuleType("floofy"))
    spec = importlib.util.spec_from_file_location("kirocrew_ide_gallery_skills", GALLERY)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def shared_url_table():
    """The `[input, accepted, ref, path]` rows between URL_TABLE_BEGIN/END in the JS test."""
    with open(JS_TEST, "r", encoding="utf-8") as fh:
        text = fh.read()
    block = text.split("// URL_TABLE_BEGIN", 1)[1].split("// URL_TABLE_END", 1)[0]
    literal = re.sub(r"^\s*const URL_TABLE\s*=\s*", "", block.strip()).rstrip(";")
    rows = json.loads(literal)
    assert len(rows) >= 20 and all(len(r) == 4 for r in rows), rows
    return rows


def write(root, rel, text=""):
    path = os.path.join(root, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(text)
    return path


def make_tarball(files, wrapper="skills-abc123", links=()):
    """A gzip tarball like codeload's: `<wrapper>/<rel>` members; `links` are (name, target, symlink?) members."""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        if wrapper:
            info = tarfile.TarInfo(wrapper + "/")
            info.type = tarfile.DIRTYPE
            info.mode = 0o755
            tar.addfile(info)
        for rel, text in files.items():
            data = text.encode("utf-8")
            info = tarfile.TarInfo((wrapper + "/" if wrapper else "") + rel)
            info.size = len(data)
            info.mode = 0o644
            tar.addfile(info, io.BytesIO(data))
        for name, target, symlink in links:
            info = tarfile.TarInfo(name)
            info.type = tarfile.SYMTYPE if symlink else tarfile.LNKTYPE
            info.linkname = target
            tar.addfile(info)
    return buf.getvalue()


def test_parse(g):
    rows = shared_url_table()
    for url, accepted, ref, path in rows:
        want = {"owner": "anthropics", "repo": "skills", "ref": ref, "path": path} if accepted else None
        assert g.parse_github_url(url) == want, (url, g.parse_github_url(url), want)
    assert g.parse_github_url(None) is None and g.parse_github_url(42) is None
    print("parse_github_url OK: %d shared rows agree with the JS parser" % len(rows))


def test_skill_name_of(g, tmp):
    d = os.path.join(tmp, "names", "my-folder")
    write(d, "SKILL.md", "---\nname: pdf-tools\ndescription: x\n---\n# body\n")
    assert g.skill_name_of(d, "fallback") == "pdf-tools"
    write(d, "SKILL.md", "---\nName: \"quoted.name\"\n---\n")
    assert g.skill_name_of(d, "fallback") == "quoted.name"
    for text in ("---\nname: ../evil\n---\n", "---\nname: has space\n---\n", "---\nname: -dash\n---\n", "---\ndescription: no name\n---\n", "no front matter\n"):
        write(d, "SKILL.md", text)
        assert g.skill_name_of(d, "fallback") == "fallback", text
        assert g.skill_name_of(d) == "my-folder", text
    assert g.skill_name_of(os.path.join(tmp, "names", "absent")) == "absent", "no SKILL.md: the basename"
    print("skill_name_of OK")


def test_find_skill_dir(g, tmp):
    root = os.path.join(tmp, "tree")
    repo = os.path.join(root, "skills-abc123")
    write(repo, "README.md")
    write(repo, "docs/guide.md")
    write(repo, "skills/b/SKILL.md", "b")
    write(repo, "skills/a/SKILL.md", "a")
    write(repo, "skills/a/deep/SKILL.md", "deeper")
    write(repo, ".hidden/SKILL.md", "dot-dirs are skipped")
    assert g.find_skill_dir(root) == os.path.join(repo, "skills", "a"), "shallowest, name order"
    assert g.find_skill_dir(root, "skills/b") == os.path.join(repo, "skills", "b")
    assert g.find_skill_dir(root, "/skills/b/") == os.path.join(repo, "skills", "b")
    assert g.find_skill_dir(root, "skills") == os.path.join(repo, "skills", "a"), "a sub path above the skills: shallowest below it"
    assert g.find_skill_dir(root, "docs") is None, "a sub path without SKILL.md"
    assert g.find_skill_dir(root, "nope") is None
    assert g.find_skill_dir(root, "../..") is None, "sub may not leave the repository"
    assert g.find_skill_dir(os.path.join(tmp, "missing")) is None
    write(repo, "SKILL.md", "root skill")
    assert g.find_skill_dir(root) == repo, "the repository root wins once it holds SKILL.md"
    bare = os.path.join(tmp, "bare")
    write(bare, "README.md")
    write(bare, "other.md")
    assert g.find_skill_dir(bare) is None, "nothing holds SKILL.md"
    print("find_skill_dir OK")


def test_safe_extract(g, tmp):
    def extract(data, name):
        dest = os.path.join(tmp, "extract", name)
        with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as tar:
            g.safe_extract(tar, dest)
        return dest

    def refused(data, name, pattern):
        try:
            extract(data, name)
        except ValueError as error:
            assert re.search(pattern, str(error)), (pattern, error)
        else:
            raise AssertionError("extracted a tarball that should have been refused: " + name)
        assert not os.path.exists(os.path.join(tmp, "extract", name, "repo", "SKILL.md")), "nothing extracted on refusal"

    good = extract(make_tarball({"SKILL.md": "ok", "scripts/run.sh": "echo"}, wrapper="repo", links=[("repo/alias.md", "SKILL.md", True)]), "good")
    assert open(os.path.join(good, "repo", "SKILL.md")).read() == "ok"
    assert os.path.islink(os.path.join(good, "repo", "alias.md")) and open(os.path.join(good, "repo", "alias.md")).read() == "ok", "an in-tree symlink is kept"
    refused(make_tarball({"SKILL.md": "x", "../escape.md": "bad"}, wrapper="repo"), "dotdot", r"escapes the destination")
    refused(make_tarball({"SKILL.md": "x", "/etc/evil": "bad"}, wrapper=""), "absolute", r"escapes the destination")
    refused(make_tarball({"SKILL.md": "x"}, wrapper="repo", links=[("repo/out", "../../etc/passwd", True)]), "symlink-out", r"points outside")
    refused(make_tarball({"SKILL.md": "x"}, wrapper="repo", links=[("repo/abs", "/etc/passwd", True)]), "symlink-abs", r"points outside")
    refused(make_tarball({"SKILL.md": "x"}, wrapper="repo", links=[("repo/hard", "../outside", False)]), "hardlink-out", r"points outside")
    print("safe_extract OK")


class Fetch:
    """A stub fetcher: tarball bytes for codeload, a default-branch answer for the API, or a scripted failure."""

    def __init__(self, tarball=None, default_branch="main", fail=None, missing_refs=()):
        self.tarball, self.default_branch, self.fail, self.missing_refs = tarball, default_branch, fail, set(missing_refs)
        self.urls = []

    def __call__(self, url):
        self.urls.append(url)
        if self.fail:
            raise self.fail
        if url.startswith("https://api.github.com/"):
            return json.dumps({"default_branch": self.default_branch}).encode("utf-8")
        ref = url.rsplit("/", 1)[1]
        if ref in self.missing_refs:
            raise urllib.error.HTTPError(url, 404, "Not Found", {}, None)
        return self.tarball


def test_import_skill(g, tmp):
    home = os.path.join(tmp, "home")
    tmp_root = os.path.join(tmp, "data", "skill-import")
    os.makedirs(home)
    logs = []
    skill = make_tarball({"README.md": "repo", "skills/pdf/SKILL.md": "---\nname: pdf-tools\n---\n# PDF\n", "skills/pdf/run.py": "print(1)\n"})
    body = {"url": "https://github.com/anthropics/skills/tree/main/skills/pdf", "scope": "global"}

    def tmp_clean():
        return not os.path.isdir(tmp_root) or os.listdir(tmp_root) == []

    status, reply = g.import_skill({"url": "nope", "scope": "global"}, Fetch(skill), home=home, tmp_root=tmp_root)
    assert status == 400 and "GitHub URL" in reply["error"], reply
    status, reply = g.import_skill({"scope": "global"}, Fetch(skill), home=home, tmp_root=tmp_root)
    assert status == 400, reply
    status, reply = g.import_skill(dict(body, scope="nowhere"), Fetch(skill), home=home, tmp_root=tmp_root)
    assert status == 400 and "scope must be one of" in reply["error"], reply
    status, reply = g.import_skill(dict(body, scope="workspace"), Fetch(skill), home=home, tmp_root=tmp_root)
    assert status == 400 and "workspace is required" in reply["error"], reply
    status, reply = g.import_skill(dict(body, scope="workspace", workspace=os.path.join(tmp, "absent")), Fetch(skill), home=home, tmp_root=tmp_root)
    assert status == 400 and "does not exist" in reply["error"], reply
    status, reply = g.import_skill(dict(body, scope="workspace", workspace="relative/dir"), Fetch(skill), home=home, tmp_root=tmp_root)
    assert status == 400 and "absolute" in reply["error"], reply
    assert not os.path.exists(os.path.join(home, ".kiro")), "a 400 touches nothing"

    fetch = Fetch(skill)
    status, reply = g.import_skill(dict(body, url="https://github.com/anthropics/skills/tree/main/docs"), fetch, home=home, tmp_root=tmp_root)
    assert status == 404 and "no SKILL.md found under anthropics/skills/docs (ref main)" in reply["error"], reply
    assert fetch.urls == ["https://codeload.github.com/anthropics/skills/tar.gz/main"], fetch.urls
    status, reply = g.import_skill({"url": "anthropics/skills", "scope": "global"}, Fetch(make_tarball({"README.md": "no skill"})), home=home, tmp_root=tmp_root)
    assert status == 404 and "no SKILL.md found under anthropics/skills" in reply["error"], reply
    status, reply = g.import_skill(dict(body, url="anthropics/skills/tree/gone"), Fetch(skill, missing_refs=["gone"]), home=home, tmp_root=tmp_root)
    assert status == 404 and "ref gone" in reply["error"], reply
    assert tmp_clean(), "404 paths leave no temp dir behind"

    status, reply = g.import_skill(body, Fetch(fail=urllib.error.URLError("offline")), home=home, tmp_root=tmp_root)
    assert status == 502 and reply["error"] == "download of anthropics/skills failed: offline", reply
    status, reply = g.import_skill(body, Fetch(fail=urllib.error.HTTPError("u", 500, "boom", {}, None)), home=home, tmp_root=tmp_root)
    assert status == 502 and "HTTP 500" in reply["error"], reply
    status, reply = g.import_skill(body, Fetch(b"this is not a tarball"), home=home, tmp_root=tmp_root)
    assert status == 502 and "not a usable tarball" in reply["error"], reply
    status, reply = g.import_skill(body, Fetch(make_tarball({"SKILL.md": "x", "../escape": "bad"})), home=home, tmp_root=tmp_root)
    assert status == 502 and "escapes the destination" in reply["error"], reply
    assert tmp_clean(), "502 paths leave no temp dir behind"
    assert not os.path.exists(os.path.join(home, ".kiro", "skills")), "no skill written before the success path"

    # Success: the subfolder is moved into place, the temp dir removed, {name, path} answered.
    fetch = Fetch(skill)
    reply = g.import_skill(body, fetch, home=home, tmp_root=tmp_root, log=logs.append)
    assert isinstance(reply, dict) and "error" not in reply, reply
    assert reply["name"] == "pdf-tools" and reply["path"] == os.path.join(home, ".kiro", "skills", "pdf-tools"), reply
    assert reply["scope"] == "global" and reply["ref"] == "main" and reply["source"] == "anthropics/skills/skills/pdf", reply
    assert open(os.path.join(reply["path"], "SKILL.md")).read().endswith("# PDF\n")
    assert open(os.path.join(reply["path"], "run.py")).read() == "print(1)\n"
    assert sorted(os.listdir(os.path.join(home, ".kiro", "skills"))) == ["pdf-tools"], "only the skill folder, not the repository"
    assert tmp_clean(), "the temp dir is removed on success"
    assert logs and "skill import: anthropics/skills/skills/pdf (main)" in logs[0], logs

    status, reply = g.import_skill(body, Fetch(skill), home=home, tmp_root=tmp_root)
    assert status == 409 and reply["error"] == "skill pdf-tools already exists" and reply["name"] == "pdf-tools", reply
    assert reply["path"] == os.path.join(home, ".kiro", "skills", "pdf-tools")
    assert open(os.path.join(reply["path"], "SKILL.md")).read().endswith("# PDF\n"), "the existing skill is untouched"
    assert tmp_clean()

    # Workspace scope and a repository-root skill: named after the repository, default branch asked from the API.
    workspace = os.path.join(tmp, "ws")
    os.makedirs(workspace)
    fetch = Fetch(make_tarball({"SKILL.md": "# root\n"}), default_branch="trunk")
    reply = g.import_skill({"url": "anthropics/skills", "scope": "workspace", "workspace": workspace}, fetch, home=home, tmp_root=tmp_root)
    assert reply["name"] == "skills" and reply["path"] == os.path.join(workspace, ".kiro", "skills", "skills") and reply["ref"] == "trunk", reply
    assert fetch.urls == ["https://api.github.com/repos/anthropics/skills", "https://codeload.github.com/anthropics/skills/tar.gz/trunk"], fetch.urls
    print("import_skill OK: 400/404/409/502 paths and the success path")


def main():
    tmp = tempfile.mkdtemp(prefix="kide-skills-")
    g = load_gallery()
    test_parse(g)
    test_skill_name_of(g, tmp)
    test_find_skill_dir(g, tmp)
    test_safe_extract(g, tmp)
    test_import_skill(g, tmp)
    print("skills import OK: shared URL table, name/folder discovery, safe extraction, route error paths and success")
    return 0


if __name__ == "__main__":
    sys.exit(main())
