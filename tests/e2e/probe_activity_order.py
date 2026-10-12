"""Activity-bar order, end to end, in a FRESH browser profile.

Usage: probe_activity_order.py <workbench-url> [--wait SECONDS] [--shot PATH]

Boots the workbench through the (gated) proxy in a brand-new browser context
and asserts three things the unit tests cannot: the seed script actually ran
(the marker is in IndexedDB), the workbench read the seeded order (KiroCrew is
the SECOND activity-bar item in the DOM), and a second boot of the same profile
keeps it there (the workbench's own write-back preserved it). Then the drag
guarantee: an order the "user" changes after seeding is left alone on the next
boot because the marker is already set.
"""

import json
import sys

from playwright.sync_api import sync_playwright

OURS = "workbench.view.extension.kirocrew"
READ_STORE = """
() => new Promise((resolve) => {
  const open = indexedDB.open("vscode-web-state-db-global");
  open.onsuccess = () => {
    const db = open.result;
    const tx = db.transaction("ItemTable", "readonly");
    const store = tx.objectStore("ItemTable");
    const all = store.getAll(); const keys = store.getAllKeys();
    tx.oncomplete = () => {
      const out = {}; keys.result.forEach((k, i) => { out[k] = all.result[i]; }); db.close(); resolve(out);
    };
  };
  open.onerror = () => resolve(null);
})
"""
WRITE_ORDER = """
(value) => new Promise((resolve) => {
  const open = indexedDB.open("vscode-web-state-db-global");
  open.onsuccess = () => {
    const db = open.result;
    const tx = db.transaction("ItemTable", "readwrite");
    tx.objectStore("ItemTable").put(value, "workbench.activity.pinnedViewlets2");
    tx.oncomplete = () => { db.close(); resolve(true); };
  };
})
"""
BAR_IDS = """
() => Array.from(document.querySelectorAll('.part.activitybar .composite-bar .action-item'))
  .map((el) => (el.querySelector('.action-label') || el).getAttribute('aria-label') || el.className)
"""


def bar_labels(page):
    return page.evaluate(BAR_IDS)


def boot(context, url, wait):
    page = context.new_page()
    page.goto(url, wait_until="domcontentloaded")
    page.wait_for_selector(".part.activitybar .composite-bar .action-item", timeout=wait * 1000)
    # Give the extension host time to register our container so its label
    # appears; the order itself is fixed at boot.
    page.wait_for_function(
        "() => Array.from(document.querySelectorAll('.part.activitybar .action-item .action-label'))"
        ".some((el) => /kirocrew/i.test(el.getAttribute('aria-label') || ''))",
        timeout=wait * 1000)
    return page


def main():
    url = sys.argv[1]
    wait = float(sys.argv[sys.argv.index("--wait") + 1]) if "--wait" in sys.argv else 60
    shot = sys.argv[sys.argv.index("--shot") + 1] if "--shot" in sys.argv else "/tmp/kirocrew-ide-order.png"
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        context = browser.new_context(viewport={"width": 1400, "height": 900})

        # Boot 1: fresh profile.
        page = boot(context, url, wait)
        labels = bar_labels(page)
        store = page.evaluate(READ_STORE) or {}
        pinned = json.loads(store.get("workbench.activity.pinnedViewlets2") or "[]")
        marker = [k for k in store if "activityOrderSeeded" in k]
        print("boot1 activity bar:", labels)
        print("boot1 marker keys:", marker)
        print("boot1 stored order:", [e["id"] for e in sorted(pinned, key=lambda e: e.get("order", 99))][:3])
        assert marker, "seed script never ran (no marker in IndexedDB)"
        assert len(labels) >= 2 and "kirocrew" in labels[1].lower(), "KiroCrew is not second on first boot: %r" % labels
        page.screenshot(path=shot)

        # Boot 2: same profile; the workbench's own write-back must have kept it.
        page.close()
        page = boot(context, url, wait)
        labels2 = bar_labels(page)
        print("boot2 activity bar:", labels2)
        assert "kirocrew" in labels2[1].lower(), "order lost on reboot: %r" % labels2

        # The drag guarantee: move ours to the end "by hand" and reboot; the
        # marker is set, so the seed must NOT put it back.
        pinned = json.loads((page.evaluate(READ_STORE) or {}).get("workbench.activity.pinnedViewlets2") or "[]")
        others = [e for e in pinned if e["id"] != OURS]
        ours = [e for e in pinned if e["id"] == OURS]
        for i, e in enumerate(others + ours):
            e["order"] = i
        page.evaluate(WRITE_ORDER, json.dumps(others + ours))
        page.close()
        page = boot(context, url, wait)
        labels3 = bar_labels(page)
        print("boot3 (after user drag) activity bar:", labels3)
        assert "kirocrew" not in labels3[1].lower(), "seed overrode the user's drag: %r" % labels3
        browser.close()
    print("ACTIVITY ORDER OK: seeded second on first boot, kept across reboot, user drag respected")


if __name__ == "__main__":
    main()
