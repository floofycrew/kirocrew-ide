"""The command-centre style spliced into the served workbench page.

The engine sizes the title bar's search pill with one stock rule (38vw, max
600px); the page carries a later rule on the same selector that scales it,
half by default, from the ``command_center_scale`` config key.
"""

import importlib.util
import os
import sys
import types

HERE = os.path.dirname(os.path.abspath(__file__))
HOOK = os.path.join(HERE, "..", "hook", "__init__.py")

PAGE = "<html><head><link rel=\"stylesheet\" href=\"workbench.css\"></head><body></body></html>"
SELECTOR = (".monaco-workbench .part.titlebar>.titlebar-container>.titlebar-center>"
            ".window-title>.command-center .action-item.command-center-center")


class _Config(dict):
    def get(self, key, default=None):
        return dict.get(self, key, default)


class Ctx:
    def __init__(self, config=None):
        self.config = _Config(config or {})
        self.data_dir = "/nonexistent"


def _load():
    sys.modules.setdefault("floofy", types.ModuleType("floofy"))
    spec = importlib.util.spec_from_file_location("kirocrew_ide_hook_chrome", HOOK)
    hook = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(hook)
    return hook


def main():
    hook = _load()

    hook._ctx = Ctx()
    out = hook._inject_chrome_style(PAGE)
    assert '<style id="kirocrew-ide-chrome">' in out, out
    assert SELECTOR + "{width:19vw;max-width:300px}" in out, out
    assert out.index("kirocrew-ide-chrome") > out.index("workbench.css"), "after the stock stylesheet, so it wins by source order"
    assert out.endswith("</head><body></body></html>"), out
    assert hook._inject_chrome_style(out) == out, "idempotent"
    assert hook._inject_chrome_style("<html>") == "<html>", "no </head> -> untouched"

    hook._ctx = Ctx({"command_center_scale": 1})
    assert hook._inject_chrome_style(PAGE) == PAGE, "stock width is a no-op, nothing injected"
    hook._ctx = Ctx({"command_center_scale": "1.5"})
    assert hook._inject_chrome_style(PAGE) == PAGE, "above 1 clamps to stock"

    hook._ctx = Ctx({"command_center_scale": "0.75"})
    assert "{width:28.5vw;max-width:450px}" in hook._inject_chrome_style(PAGE)
    hook._ctx = Ctx({"command_center_scale": 0.1})
    assert "{width:9.5vw;max-width:150px}" in hook._inject_chrome_style(PAGE), "floor at 0.25"
    hook._ctx = Ctx({"command_center_scale": "wide"})
    assert "{width:19vw;max-width:300px}" in hook._inject_chrome_style(PAGE), "garbage -> default"
    hook._ctx = Ctx({"command_center_scale": float("nan")})
    assert "{width:19vw;max-width:300px}" in hook._inject_chrome_style(PAGE), "NaN -> default"
    hook._ctx = None
    assert hook._command_center_scale() == 0.5, "no ctx (early import) -> default"
    print("chrome style OK: half by default, scaled from config, clamped, idempotent, stock = untouched")


if __name__ == "__main__":
    main()
