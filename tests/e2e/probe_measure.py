"""Measure the horizontal chrome around the chat webview: where does the side space come from?"""

import json
import pathlib
import sys

from playwright.sync_api import sync_playwright

sys.path.insert(0, __file__.rsplit("/", 1)[0])
from probe_extension import open_kirocrew_view  # noqa: E402


def main():
    url = sys.argv[1]
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        page = browser.new_context(viewport={"width": 1400, "height": 900}).new_page()
        page.goto(url, wait_until="domcontentloaded")
        frame = open_kirocrew_view(page, 90)
        assert frame is not None
        outer = page.evaluate("""() => {
          const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.right), Math.round(b.width)]; };
          const part = document.querySelector('.part.auxiliarybar');
          const body = part && part.querySelector('.pane-body');
          const wv = part && part.querySelector('.webview-view, .webview');
          const iframe = document.querySelector('iframe.webview');
          const pad = (el) => el ? getComputedStyle(el).padding + ' / ' + getComputedStyle(el).margin : null;
          return { part: r(part), paneBody: r(body), paneBodyPad: pad(body), webview: r(wv), webviewPad: pad(wv), iframe: r(iframe) };
        }""")
        inner = frame.evaluate("""() => {
          const r = (sel) => { const el = document.querySelector(sel); if (!el) return null; const b = el.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.right), Math.round(b.width)]; };
          return { body: [0, window.innerWidth], log: r('.log.on'), textarea: r('textarea'), picks: r('#picks'), tabs: r('#tabs') };
        }""")
        print(json.dumps({"outer": outer, "inner": inner}, indent=1))
        page.screenshot(path=str(pathlib.Path.home() / ".pt" / "measure.png"))
        browser.close()


if __name__ == "__main__":
    main()
