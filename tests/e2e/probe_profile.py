"""Non-default VS Code profile, end to end: the bridge is present and the
activity-bar seed lands in the PROFILE's store.

Usage: probe_profile.py <workbench-url> <profile-name> <user-data-dir> [--shot PATH]

Boots the workbench through the (gated) proxy in a persistent browser context
with ?payload=[["profile","<name>"]] — the workbench's own switch-profile form —
twice. Boot 1 creates the profile (an empty extensions.json on the server, the
shape of a freshly created or imported profile) and asserts the bridge's
container is there anyway: only application-scoped entries of the default
registry are merged into another profile's extensions, so this is the 0.14.1
regression. Boot 2 asserts the seed opened the profile's own store
(vscode-web-state-db-global-<id>, the id read from the browser's
userDataProfiles list after boot 1) and that KiroCrew is the second activity
item there.
"""
import json
import sys

from playwright.sync_api import sync_playwright

OURS = "workbench.view.extension.kirocrew"
MARK = "kirocrew-ide.activityOrderSeeded.v2"
READ_STORE = """
(name) => new Promise((resolve) => {
  const open = indexedDB.open(name);
  open.onupgradeneeded = () => { open.transaction.abort(); resolve({__missing: true}); };
  open.onsuccess = () => {
    const db = open.result;
    if (!db.objectStoreNames.contains("ItemTable")) { db.close(); resolve({__nostore: true}); return; }
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
ORDER = """
() => Array.from(document.querySelectorAll('.activitybar .composite-bar .action-item'))
  .map(el => el.getAttribute('aria-label') || el.querySelector('.action-label')?.getAttribute('aria-label') || '')
"""
# The same derivation the seed script makes: id = last segment of the stored location.
PROFILE_ID = """
(name) => {
  const list = JSON.parse(localStorage.getItem("userDataProfiles") || "[]");
  const p = list.find(p => p && p.name === name);
  if (!p) return null;
  const loc = typeof p.location === "string" ? p.location : (p.location && (p.location.path || p.location.external)) || "";
  return loc.replace(/\\/+$/, "").split("/").pop() || null;
}
"""


def summary(store):
    if not isinstance(store, dict):
        return store
    pinned = store.get("workbench.activity.pinnedViewlets2")
    ids = [e["id"] for e in json.loads(pinned)] if pinned else None
    return {"seeded": MARK in store, "pinned": ids, "keys": len(store)}


def boot(ctx, target, profile, label, shot=None):
    page = ctx.new_page()
    console = []
    page.on("console", lambda m: console.append(m.text))
    page.goto(target, wait_until="domcontentloaded")
    page.wait_for_selector(".monaco-workbench .activitybar", timeout=60000)
    try:
        page.wait_for_selector('.activitybar [aria-label*="KiroCrew"]', timeout=45000)
        found = True
    except Exception:
        found = False
    page.wait_for_timeout(1000)
    pid = page.evaluate(PROFILE_ID, profile)
    db = "vscode-web-state-db-global-%s" % pid if pid else None
    print("[%s] profile id: %s -> store %s" % (label, pid, db))
    print("[%s] container present: %s" % (label, found))
    print("[%s] bar order (t+1s): %s" % (label, page.evaluate(ORDER)))
    if db:
        print("[%s] profile store (t+1s): %s" % (label, summary(page.evaluate(READ_STORE, db))))
    page.wait_for_timeout(9000)
    order = page.evaluate(ORDER)
    print("[%s] bar order (t+10s): %s" % (label, order))
    if db:
        print("[%s] profile store (t+10s): %s" % (label, summary(page.evaluate(READ_STORE, db))))
    print("[%s] default store: %s" % (label, summary(page.evaluate(READ_STORE, "vscode-web-state-db-global"))))
    bad = [c for c in console if "kirocrew" in c.lower() and any(w in c.lower() for w in ("obsolete", "skipping", "removed", "error"))]
    print("[%s] suspicious console: %s" % (label, bad[:4]))
    if shot:
        page.screenshot(path=shot)
    store = page.evaluate(READ_STORE, db) if db else None
    page.close()
    return found, order, store


def main():
    url, profile, udd = sys.argv[1:4]
    shot = sys.argv[sys.argv.index("--shot") + 1] if "--shot" in sys.argv else None
    sep = "&" if "?" in url else "?"
    target = url + sep + "payload=" + json.dumps([["profile", profile]])
    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(udd, viewport={"width": 1280, "height": 800})
        found1, order1, _ = boot(ctx, target, profile, "boot1")
        found2, order2, store2 = boot(ctx, target, profile, "boot2", shot)
        ctx.close()
    second = [o for o in order2 if o]
    seeded = isinstance(store2, dict) and MARK in store2
    ok = found1 and found2 and seeded and len(second) > 1 and "KiroCrew" in second[1]
    print("RESULT:", "PASS" if ok else "FAIL",
          "(bridge in profile: boot1=%s boot2=%s; profile store seeded: %s; boot2 second item: %s)"
          % (found1, found2, seeded, second[1] if len(second) > 1 else None))
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
