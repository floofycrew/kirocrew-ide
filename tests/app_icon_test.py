"""The App's face is the FloofyCrew fox wearing a </> badge, declared where the App Kit looks.

The dashboard draws an installed App's icon (Apps sidebar entry, store card,
detail page) from the manifest's ``iconPath``, served as an image from
``/apps/<name>/art/<path>`` -- and ONLY from that field: a page's named
``icon`` (``"Code"``) is resolved against a nine-glyph map that has no ``Code``,
so without ``iconPath`` the App fell back to the Package box. The file must sit
inside the App's own directory (the install copies that tree), be an image the
route admits, be listed in ``files[]`` so its hash is verified, and be the fox
the splash and the mod icon already draw, with the code badge on top so the App
reads as the IDE at a glance.
"""

import hashlib
import json
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")
APP_DIR = os.path.join(ROOT, "app")

#: Image types the App Kit's art route serves (``_ART_IMAGE_EXTENSIONS`` in the host).
ART_EXTENSIONS = {".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico"}


def sha256(path):
    with open(path, "rb") as handle:
        return hashlib.sha256(handle.read()).hexdigest()


def read(path):
    with open(path, encoding="utf-8") as handle:
        return handle.read()


def main():
    with open(os.path.join(APP_DIR, "app.json"), encoding="utf-8") as handle:
        app = json.load(handle)
    with open(os.path.join(ROOT, "floofy.json"), encoding="utf-8") as handle:
        mod = json.load(handle)

    icon_path = app.get("iconPath")
    assert icon_path == "ui/art/icon.svg", f"app.json iconPath must be ui/art/icon.svg, got {icon_path!r}"
    assert not icon_path.startswith(("/", "./")) and ".." not in icon_path, "a plain path inside the App directory"
    assert os.path.splitext(icon_path)[1].lower() in ART_EXTENSIONS, "an image type the art route serves"

    icon_file = os.path.join(APP_DIR, icon_path)
    assert os.path.isfile(icon_file), f"app/{icon_path} is shipped"

    repo_path = "app/" + icon_path
    listed = {entry["path"]: entry["sha256"] for entry in mod["files"]}
    assert repo_path in listed, f"{repo_path} is listed in files[]"
    assert listed[repo_path] == sha256(icon_file), "the listed hash matches the file"

    svg = read(icon_file)
    assert svg.lstrip().startswith("<svg"), "an SVG document"
    assert "<script" not in svg.lower() and "javascript:" not in svg.lower() and not re.search(r"\son\w+\s*=", svg), "script-free"
    assert 'viewBox="0 0 512 512"' in svg, "the fox's 512 canvas, so the badge geometry below holds"

    # Every fox shape, verbatim: the App icon IS the fox the splash and the mod icon draw.
    fox = read(os.path.join(APP_DIR, "ui", "art", "fox.svg"))
    shapes = re.findall(r"<(?:path|ellipse)\b[^>]*/>", fox)
    assert len(shapes) == 9, f"the fox is 9 shapes, found {len(shapes)}"
    for shape in shapes:
        assert shape in svg, f"fox shape missing from the App icon: {shape[:60]}..."

    # The badge: plate, ring, and the three strokes of </>, drawn after the fox so it sits on top.
    badge_at = svg.index('id="code-badge"')
    assert badge_at > svg.index(shapes[-1]), "the badge is painted over the fox, not under it"
    badge = svg[badge_at:]
    assert badge.count("<rect") == 2, "ring + plate"
    assert badge.count("<polyline") == 2 and badge.count("<line") == 1, "< > and /"
    assert 'fill="#2A1014"' in badge, "the plate is the fox's own eye colour"
    assert 'fill="#FFE4CF"' in badge, "the ring is the fox's cream, separating the badge on light and dark tiles"
    print("app icon OK: ui/art/icon.svg declared as iconPath, listed, the fox's 9 shapes plus the </> badge")


if __name__ == "__main__":
    main()
