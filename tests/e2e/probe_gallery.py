"""Headless: the Extensions view searches the merged gallery through a real workbench.

    probe_gallery.py <workbench url> <gallery url> <search text> [--direct]

Loads the workbench, opens the Extensions view, types the search text and prints
what the view shows, plus every browser-side request aimed at the gallery and the
console lines about it. By default the browser-side route to the gallery is
ABORTED, which is what a browser on another machine sees (the gallery binds the
gateway host's loopback), so the workbench must fall back to its server-side
request channel. ``--direct`` leaves the route open (a browser on the gateway host).
"""
import asyncio
import json
import sys
import time

from playwright.async_api import async_playwright


async def main(url, gallery, text, direct):
    attempts = []
    console = []
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        page = await browser.new_page(viewport={"width": 1400, "height": 900})
        page.on("console", lambda m: console.append("%s: %s" % (m.type, m.text)))

        async def on_route(route):
            attempts.append(route.request.method + " " + route.request.url)
            if direct:
                await route.continue_()
            else:
                await route.abort("connectionrefused")

        await page.route(gallery.rstrip("/") + "/**", on_route)
        await page.goto(url, wait_until="domcontentloaded")
        await page.wait_for_selector(".monaco-workbench", timeout=60000)
        await page.wait_for_timeout(5000)
        trust = page.locator(".monaco-dialog-box a.monaco-button", has_text="trust the authors")
        if await trust.count():
            await trust.first.click()
            await page.wait_for_timeout(1500)
        # Open the Extensions view via the command palette and type the search text.
        await page.screenshot(path="/tmp/probe_gallery_0.png")
        await page.keyboard.press("F1")
        await page.wait_for_selector(".quick-input-widget", timeout=15000)
        await page.keyboard.type("View: Show Extensions")
        await page.wait_for_timeout(800)
        await page.keyboard.press("Enter")
        await page.wait_for_selector(".extensions-viewlet", timeout=30000)
        box = page.locator(".extensions-viewlet .suggest-input-container").first
        await box.click()
        await page.keyboard.type(text)
        t0 = time.time()
        rows = []
        message = ""
        while time.time() - t0 < 25:
            await page.wait_for_timeout(1000)
            rows = await page.eval_on_selector_all(
                ".extensions-viewlet .extensions-list .monaco-list-row",
                "els => els.map(e => (e.querySelector('.name')||{}).textContent + ' | ' + (e.querySelector('.publisher-name, .publisher')||{}).textContent)")
            message = await page.evaluate(
                "() => Array.from(document.querySelectorAll('.extensions-viewlet .message, .extensions-viewlet .extensions-list .message')).map(e => e.textContent.trim()).filter(Boolean).join(' / ')")
            if rows or message:
                break
        await page.screenshot(path="/tmp/probe_gallery.png")
        await browser.close()
    print(json.dumps({
        "direct": direct,
        "rows": rows,
        "message": message,
        "gallery_attempts_from_browser": attempts,
        "console": [c for c in console if any(k in c.lower() for k in ("gallery", "extensionquery", "request", "37705", "marketplace", "open-vsx", "error"))][:30],
    }, indent=1))


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    asyncio.run(main(args[0], args[1], args[2], "--direct" in sys.argv))
