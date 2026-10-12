"""The mod's face is the FloofyCrew fox, declared where the Loader looks for it.

The FloofyCrew App shows a mod's icon in two states: while the mod is active,
the ui part's own ``icon`` (served from ``/ui/mods/<id>/``); otherwise the
manifest's top-level ``icon`` (served from ``/mods/<id>/icon``). Both must name
the same shipped file, it must sit under the ui part's ``path`` (the validator's
rule), be listed in ``files[]`` so its hash is verified, and be the very fox the
App page's loading splash already draws, so the mod wears one face everywhere.
"""

import hashlib
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")


def sha256(path):
    with open(path, "rb") as handle:
        return hashlib.sha256(handle.read()).hexdigest()


def main():
    with open(os.path.join(ROOT, "floofy.json"), encoding="utf-8") as handle:
        manifest = json.load(handle)

    icon = manifest.get("icon")
    assert icon == "ui/icon.svg", f"manifest icon must be ui/icon.svg, got {icon!r}"

    ui_parts = [part for part in manifest["parts"] if part.get("kind") == "ui"]
    assert len(ui_parts) == 1, "exactly one ui part"
    part = ui_parts[0]
    assert part.get("icon") == icon, "the ui part's icon is the same file as the manifest icon"
    assert icon.startswith(part["path"]), "the icon sits under the ui part's path (validator rule)"

    icon_file = os.path.join(ROOT, icon)
    assert os.path.isfile(icon_file), f"{icon} is shipped"
    assert sha256(icon_file) == sha256(os.path.join(ROOT, "app", "ui", "art", "fox.svg")), "the ui icon is the splash fox, byte for byte"

    listed = {entry["path"]: entry["sha256"] for entry in manifest["files"]}
    assert icon in listed, f"{icon} is listed in files[]"
    assert listed[icon] == sha256(icon_file), "the listed hash matches the file"

    with open(icon_file, encoding="utf-8") as handle:
        head = handle.read(400)
    assert "<svg" in head and 'aria-label="FloofyCrew - fox"' in head, "it is the FloofyCrew fox mark"
    print("mod icon OK: ui/icon.svg declared on the manifest and the ui part, listed, equal to the splash fox")


if __name__ == "__main__":
    main()
