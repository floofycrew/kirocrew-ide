"""The hook vendors ONE pinned mermaid build and copies it into both provisioned extensions.

* `_ensure_mermaid` writes <data>/vendor/mermaid-<ver>.min.js only when the download's
  SHA-256 matches the pin; a wrong digest is refused and recorded (retried next start);
  `mermaid.enabled: false` skips everything; a vendored file is reused without a fetch.
* `_provision_extension` copies the file into each extension's media/ as mermaid.min.js;
  with no file the preview extension's manifest loses its `media/mermaid.min.js` preview
  script (the workbench would 404 it on every preview) while the bridge is untouched.

Run with the gateway's interpreter, no floofy on the path (stubbed).
"""
import hashlib
import importlib.util
import json
import os
import sys
import tempfile
import types

HERE = os.path.dirname(os.path.abspath(__file__))
HOOK = os.path.join(HERE, "..", "hook", "__init__.py")


class Log:
    def __init__(self): self.lines = []
    def info(self, msg, *a): self.lines.append(("info", msg % a if a else msg))
    def warning(self, msg, *a): self.lines.append(("warning", msg % a if a else msg))
    debug = info


class Http:
    def __init__(self): self.checked = []
    def check(self, url): self.checked.append(url)


class Ctx:
    def __init__(self, data_dir, config=None):
        self.data_dir = data_dir
        self.config = config or {}
        self.log = Log()
        self.http = Http()
        self.state = {}


def load_hook():
    sys.modules.setdefault("floofy", types.ModuleType("floofy"))
    spec = importlib.util.spec_from_file_location("kirocrew_ide_hook_mermaid", HOOK)
    hook = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(hook)
    return hook


def main():
    hook = load_hook()
    good = b"/* pretend mermaid */ window.mermaid = {};"
    hook.MERMAID_SHA256 = hashlib.sha256(good).hexdigest()

    # 1. disabled: nothing fetched, nothing written, status says so
    data = tempfile.mkdtemp(prefix="ide-mermaid-")
    hook._ctx = Ctx(data, {"mermaid.enabled": False})
    calls = []
    assert hook._ensure_mermaid(fetch=lambda url: calls.append(url) or good) is None
    assert calls == [] and not os.path.exists(hook._mermaid_path())
    assert hook._mermaid["present"] is False and "disabled" in hook._mermaid["note"], hook._mermaid

    # 2. a wrong digest is refused: no file, a warning, the note names the mismatch, next start retries
    hook._ctx = Ctx(data)
    assert hook._ensure_mermaid(fetch=lambda url: b"tampered") is None
    assert not os.path.exists(hook._mermaid_path()), "a bad download must never be installed"
    assert hook._mermaid["present"] is False and "checksum" in hook._mermaid["note"], hook._mermaid
    assert any(lvl == "warning" and "mermaid" in msg for lvl, msg in hook._ctx.log.lines)

    # 3. the pinned build is written once, from the pinned URL, and reused without fetching
    calls = []
    path = hook._ensure_mermaid(fetch=lambda url: calls.append(url) or good)
    assert path == hook._mermaid_path() and os.path.isfile(path)
    assert calls == [hook.MERMAID_URL.format(version=hook.MERMAID_VERSION)], calls
    assert open(path, "rb").read() == good
    assert hook._mermaid == {"present": True, "version": hook.MERMAID_VERSION, "note": "downloaded"}, hook._mermaid
    assert hook._ensure_mermaid(fetch=lambda url: (_ for _ in ()).throw(AssertionError("fetched again"))) == path
    assert hook._mermaid["note"] == "vendored"

    # 4. provisioning copies it into BOTH extensions' media/
    root = hook._provision_extension()
    assert root == os.path.join(data, hook.EXTENSIONS_DIR), root
    dirs = sorted(d for d in os.listdir(root) if os.path.isdir(os.path.join(root, d)))
    assert len(dirs) == 2 and any("bridge" in d for d in dirs) and any("spec-preview" in d for d in dirs), dirs
    for d in dirs:
        copied = os.path.join(root, d, "media", hook.MERMAID_FILE)
        assert os.path.isfile(copied) and open(copied, "rb").read() == good, copied
    preview_dir = next(d for d in dirs if "spec-preview" in d)
    manifest = json.load(open(os.path.join(root, preview_dir, "package.json")))
    assert "./media/mermaid.min.js" in manifest["contributes"]["markdown.previewScripts"], "with the file the script entry stays"
    registry = json.load(open(os.path.join(root, "extensions.json")))
    ids = sorted(e["identifier"]["id"] for e in registry)
    assert ids == ["kirocrew-ide.kirocrew-ide-bridge", "kirocrew-ide.kirocrew-spec-preview"], ids
    assert all(e["metadata"]["isApplicationScoped"] for e in registry)
    # the preview extension's own tree never carried the vendored file
    assert not os.path.exists(os.path.join(hook._mod_dir(), "preview", "media", hook.MERMAID_FILE))
    assert not os.path.exists(os.path.join(hook._mod_dir(), "extension", "media", hook.MERMAID_FILE))

    # 5. no vendored file (download failed, offline): the preview manifest drops the script entry, the bridge is untouched
    data2 = tempfile.mkdtemp(prefix="ide-mermaid-")
    hook._ctx = Ctx(data2)
    assert hook._ensure_mermaid(fetch=lambda url: (_ for _ in ()).throw(OSError("offline"))) is None
    assert "offline" in hook._mermaid["note"]
    root2 = hook._provision_extension()
    dirs2 = sorted(d for d in os.listdir(root2) if os.path.isdir(os.path.join(root2, d)))
    preview2 = next(d for d in dirs2 if "spec-preview" in d)
    manifest2 = json.load(open(os.path.join(root2, preview2, "package.json")))
    assert manifest2["contributes"]["markdown.previewScripts"] == ["./media/mermaid-preview.js"], manifest2["contributes"]["markdown.previewScripts"]
    assert not os.path.exists(os.path.join(root2, preview2, "media", hook.MERMAID_FILE))
    bridge2 = next(d for d in dirs2 if "bridge" in d)
    assert not os.path.exists(os.path.join(root2, bridge2, "media", hook.MERMAID_FILE))
    assert json.load(open(os.path.join(root2, bridge2, "package.json")))["name"] == "kirocrew-ide-bridge"

    # 6. the engine CLI relaunch rule still keys on the bridge version; the preview rides along
    assert hook._extension_version() == json.load(open(os.path.join(hook._mod_dir(), "extension", "package.json")))["version"]
    assert hook._reregister_extension() is True
    print("mermaid_vendor_test: OK")


if __name__ == "__main__":
    main()
