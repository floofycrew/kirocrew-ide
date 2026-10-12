"""Rendered markdown in the real chat webview: inject an assistant row, assert the DOM, screenshot.

Usage: probe_markdown.py <workbench-url> [--shot PATH]
"""

import sys

from playwright.sync_api import sync_playwright

sys.path.insert(0, __file__.rsplit("/", 1)[0])
from probe_extension import open_kirocrew_view  # noqa: E402

SAMPLE = """## Root cause

The service worker fetch in `hook/__init__.py:912` dropped the cookie — see [the fix](https://docs.example.invalid) and tests/e2e/proxy_harness.py.

1. Reproduce with **`curl`**
2. Fix the *rewrite*
   - [x] classic worker
   - [ ] ~~module~~ worker

| Client | Before | After |
|:-------|:------:|------:|
| Firefox | ok | ok |
| App | blank | ok |

```python
def f(x):
    return x < 2
```

> Verified through the gated harness.

[OPTIONS: Ship it | Explain more]"""


def main():
    url = sys.argv[1]
    shot = sys.argv[sys.argv.index("--shot") + 1] if "--shot" in sys.argv else "/tmp/kirocrew-ide-markdown.png"
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        page = browser.new_context(viewport={"width": 1400, "height": 900}).new_page()
        errors = []
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        page.goto(url, wait_until="domcontentloaded")
        frame = open_kirocrew_view(page, 90)
        assert frame is not None
        frame.evaluate("(s) => window.dispatchEvent(new MessageEvent('message', {data: {type: 'row', id: active, row: {role: 'assistant', content: s, meta: {}}}}))", SAMPLE)
        frame.wait_for_selector(".assistant.md table", timeout=5000)
        got = frame.evaluate("""() => ({
          h2: document.querySelector('.md h2') && document.querySelector('.md h2').textContent,
          paths: Array.from(document.querySelectorAll('.md a.path')).map(a => a.dataset.path + (a.dataset.line ? ':' + a.dataset.line : '')),
          links: Array.from(document.querySelectorAll('.md a.link')).map(a => a.dataset.url),
          table: document.querySelectorAll('.md td').length,
          code: document.querementsByClassName ? null : (document.querySelector('.md .codeblock .lang') || {}).textContent,
          boxes: document.querySelectorAll('.md .box').length,
          options: Array.from(document.querySelectorAll('.options button')).map(b => b.textContent),
          rawMarker: document.querySelector('.assistant').textContent.includes('[OPTIONS'),
        })""")
        print(got)
        assert got["h2"] == "Root cause"
        assert got["paths"] == ["hook/__init__.py:912", "tests/e2e/proxy_harness.py"], got["paths"]
        assert got["links"] == ["https://docs.example.invalid"], got["links"]
        assert got["table"] == 6 and got["boxes"] == 2 and got["code"] == "python"
        assert got["options"] == ["Ship it", "Explain more"] and not got["rawMarker"]
        # Clicking a path anchor posts an open message (the host stub in this harness has no editor; we only check no error).
        frame.click(".md a.path")
        page.screenshot(path=shot)
        browser.close()
    bad = [e for e in errors if "kirocrew" in e.lower() or "webview" in e.lower()]
    assert not bad, bad
    print("MARKDOWN OK: headings, path/link anchors, table, task boxes, code block with lang, options chips")


if __name__ == "__main__":
    main()
