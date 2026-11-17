"""The side-bar sections' minimum height: the served workbench bundle carries a
smaller Pane minimum body size (``pane_min_body_px``), and the served page's
script URL is versioned with it so the browser's year-long cache of the stock
bundle is bypassed.
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import hook  # noqa: E402


class Ctx:
    def __init__(self, config):
        self.config = config


# The constructor default as the 1.109 bundle minifies it (field names vary per build).
BUNDLE = ('this.z=typeof e.orientation>"u"?0:e.orientation,this.M=this.S(e.title),'
          'this.I=typeof e.minimumBodySize=="number"?e.minimumBodySize:this.z===1?200:120,'
          'this.J=typeof e.maximumBodySize=="number"?e.maximumBodySize:Number.POSITIVE_INFINITY')
PAGE = ('<html><head><script type="module" src="/kirocrew-ide/stable-abc/static/out/nls.messages.js"></script>'
        '<script type="module" src="/kirocrew-ide/stable-abc/static/out/vs/code/browser/workbench/workbench.js"></script>'
        '</head><body></body></html>')


def main():
    hook._ctx = None
    assert hook._pane_min_body() == 22, "default without a context"

    out, matched = hook._rewrite_pane_min(BUNDLE, 22)
    assert matched and "this.z===1?200:22," in out and "200:120" not in out, out
    assert "e.maximumBodySize:Number.POSITIVE_INFINITY" in out, "nothing else touched"
    # Another build's names: the field and parameter names differ, the shape does not.
    other = BUNDLE.replace("this.z", "this.Q").replace("e.minimumBodySize", "t.minimumBodySize")
    out, matched = hook._rewrite_pane_min(other, 0)
    assert matched and "this.Q===1?200:0," in out, out
    out, matched = hook._rewrite_pane_min("var x=120;", 22)
    assert not matched and out == "var x=120;", "no literal -> untouched, reported"
    # A 1200 is not a 120.
    out, matched = hook._rewrite_pane_min(BUNDLE.replace("200:120,", "200:1200,"), 22)
    assert not matched

    out = hook._inject_pane_min_query(PAGE, 22)
    assert 'workbench/workbench.js?kide-pane=22"' in out and out.count("kide-pane") == 1, out
    assert "nls.messages.js\"" in out, "only the bundle's URL is versioned"
    assert hook._inject_pane_min_query(out, 22) == out, "idempotent"
    assert hook._inject_pane_min_query(PAGE, 120) == PAGE, "stock value: no query, the bundle streams untouched"
    assert hook._inject_pane_min_query("<html>", 22) == "<html>", "no bundle tag -> untouched"

    hook._ctx = Ctx({"pane_min_body_px": "40"})
    assert hook._pane_min_body() == 40
    assert "kide-pane=40" in hook._inject_pane_min_query(PAGE)
    hook._ctx = Ctx({"pane_min_body_px": 500})
    assert hook._pane_min_body() == 120, "clamped to the stock value, which turns the rewrite off"
    hook._ctx = Ctx({"pane_min_body_px": -3})
    assert hook._pane_min_body() == 0
    hook._ctx = Ctx({"pane_min_body_px": "soon"})
    assert hook._pane_min_body() == 22, "garbage -> default"
    hook._ctx = None

    # The real engine's bundle, when one is installed here: the literal must be found exactly once.
    engines = os.path.expanduser("~/.kiro/crew/floofy/mods/kirocrew-ide/.floofy/engines")
    if os.path.isdir(engines):
        for name in sorted(os.listdir(engines)):
            path = os.path.join(engines, name, "out", "vs", "code", "browser", "workbench", "workbench.js")
            if os.path.isfile(path):
                with open(path, encoding="utf-8") as fh:
                    text = fh.read()
                assert len(hook._PANE_MIN_RE.findall(text)) == 1, "%s: Pane minimum found %d times" % (name, len(hook._PANE_MIN_RE.findall(text)))
                print("real bundle %s: Pane minimum found once" % name)
    print("pane minimum OK: bundle rewritten once, page URL versioned, config clamped")


if __name__ == "__main__":
    main()
