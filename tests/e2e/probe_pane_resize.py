"""Can the KiroCrew activity-bar panes (Specs, Steering, Skills, ...) be resized by dragging the sash between them?

Usage: probe_pane_resize.py <workbench-url> [--shot PATH] [--height PX] [--stock]
Opens the KiroCrew container, measures the panes and sashes, drags the sash under
Specs by 120px, then drags it back up as far as it goes, and reports the heights
at each step (and after a reload). Unless --stock is given, the workbench bundle
is answered with the hook's rewritten copy (Pane minimum body = pane_min_body_px,
what the proxy serves), so the check covers the served product. A short viewport
(--height 640, a laptop at 125% zoom) is the case where every stock pane sits at
its 142px minimum and VS Code disables every sash.
"""

import json
import os
import pathlib
import sys
import time

from playwright.sync_api import sync_playwright

sys.path.insert(0, __file__.rsplit("/", 1)[0])
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))
from probe_extension import open_kirocrew_view  # noqa: E402

os.environ.setdefault("PYTHONDONTWRITEBYTECODE", "1")
import hook  # noqa: E402

MEASURE = """() => {
  const side = document.querySelector('.part.sidebar');
  if (!side) return null;
  const panes = [...side.querySelectorAll('.split-view-view')].map((v) => {
    const h = v.querySelector('.pane-header');
    const b = v.getBoundingClientRect();
    return { title: h ? h.innerText.trim().split('\\n')[0] : '?', top: Math.round(b.top), height: Math.round(b.height),
             expanded: h ? h.getAttribute('aria-expanded') : null };
  });
  const sashes = [...side.querySelectorAll('.monaco-sash.horizontal')].map((s) => {
    const b = s.getBoundingClientRect(); const cs = getComputedStyle(s);
    return { top: Math.round(b.top), left: Math.round(b.left), width: Math.round(b.width), height: Math.round(b.height),
             classes: s.className, pointer: cs.pointerEvents, display: cs.display, zIndex: cs.zIndex };
  });
  return { panes, sashes };
}"""


def show_kirocrew(page):
    for _ in range(3):
        shown = page.evaluate("""() => {
          const side = document.querySelector('.part.sidebar');
          if (!side || side.offsetWidth < 50) return false;
          const t = side.querySelector('.title-label, .composite.title h2');
          return !!(t && /kirocrew/i.test(t.textContent || ''));
        }""")
        if shown:
            return
        page.locator(".activitybar [aria-label^='KiroCrew']").first.click(force=True)
        time.sleep(2)


def sash_under_first(state):
    panes = state["panes"]
    if len(panes) > 1:
        second_top = panes[1]["top"]
        for s in state["sashes"]:
            if abs(s["top"] + s["height"] / 2 - second_top) <= 6:
                return s
    return state["sashes"][0] if state["sashes"] else None


def drag(page, sash, dy):
    x = sash["left"] + sash["width"] / 2
    y = sash["top"] + sash["height"] / 2
    page.mouse.move(x, y)
    time.sleep(0.3)
    page.mouse.down()
    steps = max(1, abs(dy) // 10)
    for i in range(1, steps + 1):
        page.mouse.move(x, y + dy * i / steps)
        time.sleep(0.03)
    page.mouse.up()
    time.sleep(0.8)
    return page.evaluate(MEASURE)


def heights(state):
    return [(p["title"], p["height"]) for p in state["panes"]]


def main():
    url = sys.argv[1]
    shot = sys.argv[sys.argv.index("--shot") + 1] if "--shot" in sys.argv else "/tmp/kirocrew-ide-pane-resize.png"
    height = int(sys.argv[sys.argv.index("--height") + 1]) if "--height" in sys.argv else 900
    stock = "--stock" in sys.argv
    minimum = hook.PANE_MIN_BODY_STOCK if stock else hook._pane_min_body()
    rewritten = {}
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        page = browser.new_page(viewport={"width": 1400, "height": height})
        if not stock:
            def serve_bundle(route):
                resp = route.fetch()
                text, matched = hook._rewrite_pane_min(resp.text(), minimum)
                rewritten["matched"] = matched
                route.fulfill(response=resp, body=text, headers={**resp.headers, "content-type": "text/javascript"})
            page.route("**" + hook._WORKBENCH_JS_SUFFIX + "*", serve_bundle)
        page.goto(url, wait_until="domcontentloaded")
        open_kirocrew_view(page, 90)
        show_kirocrew(page)
        before = page.evaluate(MEASURE)
        print("bundle rewritten:", rewritten.get("matched"), "pane minimum:", minimum)
        print("before", heights(before), "sash px:", [s["height"] for s in before["sashes"]])
        sash = sash_under_first(before)
        print("sash", sash and {k: sash[k] for k in ("top", "height", "classes")})
        down = up = again = None
        if sash:
            down = drag(page, sash, 120)
            print("after +120", heights(down))
            sash2 = sash_under_first(down)
            up = drag(page, sash2, -400)  # as far up as the pane allows: its minimum
            print("after -400", heights(up))
            page.screenshot(path=shot)
            page.reload(wait_until="domcontentloaded")
            open_kirocrew_view(page, 90)
            show_kirocrew(page)
            time.sleep(3)
            again = page.evaluate(MEASURE)
            print("after reload", heights(again))
        browser.close()
    grew = down is not None and down["panes"][0]["height"] - before["panes"][0]["height"] >= 60
    floor = up["panes"][0]["height"] if up else None
    # The pane's floor is its header (22) + the minimum body; stock = 142.
    expect = 22 + minimum
    shrank = floor is not None and abs(floor - expect) <= 2
    kept = again is not None and abs(again["panes"][0]["height"] - floor) <= 2
    print(json.dumps({"grew": grew, "floor": floor, "expectedFloor": expect, "shrankToFloor": shrank, "keptAfterReload": kept}))
    sys.exit(0 if grew and shrank and kept else 1)


if __name__ == "__main__":
    main()
