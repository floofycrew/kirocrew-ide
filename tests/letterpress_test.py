"""The proxy answers the workbench's letterpress SVGs with a greyscale fox, per theme variant."""

import importlib.util
import os
import sys
import types

HERE = os.path.dirname(os.path.abspath(__file__))
HOOK = os.path.join(HERE, "..", "hook", "__init__.py")


def main():
    sys.modules.setdefault("floofy", types.ModuleType("floofy"))
    spec = importlib.util.spec_from_file_location("kirocrew_ide_hook_lp", HOOK)
    hook = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(hook)
    for path, variant in (("/kirocrew-ide/stable-abc/static/out/media/letterpress-dark.svg", "dark"),
                          ("/kirocrew-ide/x/out/media/letterpress-hcLight.svg", "hcLight")):
        m = hook._LETTERPRESS_RE.search(path)
        assert m and m.group(1) == variant, path
    assert hook._LETTERPRESS_RE.search("/kirocrew-ide/out/media/letterpress-dark.svg.map") is None
    assert hook._LETTERPRESS_RE.search("/kirocrew-ide/out/media/other.svg") is None
    dark = hook._fox_letterpress("dark").decode()
    light = hook._fox_letterpress("light").decode()
    assert dark.startswith("<svg") and "<defs>" not in dark
    assert 'opacity="0.27"' in dark, "chat empty-state opacity"
    # the chat treatment: each palette colour mapped to its LUMINANCE grey
    assert 'fill="#161616"' in dark, "eyes #2A1014 -> luminance grey"
    assert 'fill="#e8e8e8"' in dark, "body #FFE4CF -> luminance grey"
    assert "#FFE4CF" not in dark and "#FFBFAE" not in dark, "no original colours remain"
    assert dark == light, "one treatment for every theme variant, like the chat"
    assert hook._fox_letterpress("dark") is hook._fox_letterpress("dark"), "cached"
    print("letterpress OK: variants matched, fox greyscaled to luminance at 0.27, cached")


if __name__ == "__main__":
    main()
