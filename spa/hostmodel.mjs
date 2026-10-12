// KiroCrew crew switching from inside the IDE overlay.
//
// In the desktop app a remote crew's dashboard runs as an embedded pane (an
// <iframe> the desktop window keeps warm). The pane never switches crews
// itself: its own switcher posts `mc-switch-instance` to the desktop window,
// which validates the sender (a warm loopback tunnel origin) and flips the
// active pane; the list of crews reaches the pane as `mc-host-model`
// broadcasts (website/src/components/InstancesViewport.tsx and
// EmbeddedHostBridge.tsx upstream). This module speaks that protocol on the
// overlay's behalf so the user can change hosts without leaving fullscreen:
//
//  * `HostModelStore` captures every `mc-host-model` the parent posts and, on
//    first use, asks for the current one the same way the pane does on mount
//    (`mc-embedded-ready`; the parent answers with the model and an ack, and
//    the pane's own bridge ignores a repeat ack).
//  * `switchTo(id)` posts the switch request; `null` is the Local dashboard.
//
// Outside a pane (the desktop app's local dashboard, or a browser tab) there is
// no parent to ask. There the switcher can only see what KiroCrew's own bar
// paints as chips (`crew-chip-row`: Local, the active crew, the pinned ones)
// and switches by clicking the chip — the dropdown behind the bar is a Radix
// menu that plain clicks cannot open. `localEntries()` / `clickLocalChip()`
// cover that, honestly limited to the chips on screen.

/** True when this document is an embedded remote-crew pane (or any cross-origin frame). */
export function isEmbedded(win = globalThis.window) {
  try {
    return !!win && win.self !== win.top;
  } catch {
    return true;
  }
}

/** Narrow an untrusted `mc-host-model` payload; null for anything else. Mirrors upstream parseHostModel. */
export function parseHostModel(data) {
  if (!data || typeof data !== "object" || data.type !== "mc-host-model") return null;
  const tabs = (Array.isArray(data.tabs) ? data.tabs : [])
    .filter((t) => t && typeof t === "object")
    .map((t) => ({
      id: String(t.id ?? ""),
      name: String(t.name ?? ""),
      sshHost: String(t.sshHost ?? ""),
      state: typeof t.state === "string" ? t.state : undefined,
      unread: Number(t.unread) || 0,
    }))
    .filter((t) => t.id);
  return { tabs, activeId: typeof data.activeId === "string" ? data.activeId : null };
}

/** The switcher rows for a model: Local first, then every crew tab. */
export function entriesFor(model) {
  const rows = [{ id: null, name: "Local", detail: "Local dashboard", state: undefined, unread: 0 }];
  for (const t of (model && model.tabs) || []) {
    rows.push({ id: t.id, name: t.name, detail: t.sshHost && t.sshHost !== t.name ? t.sshHost : "", state: t.state, unread: t.unread });
  }
  return rows;
}

const REQUEST_DELAYS_MS = [0, 400, 1200, 3000, 6000];

/**
 * Capture the parent's host model. `subscribe(fn)` calls fn with the current
 * model (possibly null) and on every change; the first subscriber arms the
 * listener and the bounded request retries, the last one disarms.
 */
export class HostModelStore {
  constructor(win = globalThis.window) {
    this.win = win;
    this.model = null;
    this.subscribers = new Set();
    this.timers = [];
    this.onMessage = (event) => {
      if (!this.win || event.source !== this.win.parent) return;
      const model = parseHostModel(event.data);
      if (!model) return;
      this.model = model;
      this.clearTimers();
      for (const fn of this.subscribers) fn(model);
    };
  }

  clearTimers() {
    for (const t of this.timers) this.win.clearTimeout(t);
    this.timers = [];
  }

  /** Ask the parent for the model now (the pane's mount handshake, repeated on a bounded schedule until one lands). */
  request() {
    if (!isEmbedded(this.win)) return;
    this.clearTimers();
    for (const delay of REQUEST_DELAYS_MS) {
      this.timers.push(this.win.setTimeout(() => {
        if (this.model) return;
        try {
          this.win.parent.postMessage({ type: "mc-embedded-ready", v: 1 }, "*");
        } catch {
          /* no reachable parent — a later retry or broadcast covers it */
        }
      }, delay));
    }
  }

  subscribe(fn) {
    if (this.subscribers.size === 0) {
      this.win.addEventListener("message", this.onMessage);
      if (!this.model) this.request();
    }
    this.subscribers.add(fn);
    fn(this.model);
    return () => {
      this.subscribers.delete(fn);
      if (this.subscribers.size === 0) {
        this.win.removeEventListener("message", this.onMessage);
        this.clearTimers();
      }
    };
  }
}

/** Ask the desktop window to show crew `id` (null = Local). Returns false when there is no parent to ask. */
export function switchTo(id, win = globalThis.window) {
  if (!isEmbedded(win)) return false;
  try {
    win.parent.postMessage({ type: "mc-switch-instance", v: 1, id: id === null ? null : String(id) }, "*");
    return true;
  } catch {
    return false;
  }
}

const CHIP_ROW = '[data-testid="crew-chip-row"]';

/**
 * The crews KiroCrew's own bar shows as chips in this document (local
 * dashboard): one entry per chip, from its accessible name "<name> (<host>) — <state>"
 * (Local carries no parenthesis). Empty when the bar is absent.
 */
export function localEntries(doc = globalThis.document) {
  const row = doc && doc.querySelector(CHIP_ROW);
  if (!row) return [];
  // The Switcher renders the crew on screen as a leading chip BESIDE the pinned
  // row, so read the group wrapping both; the dropdown trigger (aria-haspopup)
  // and the layer's own tag are not crews.
  const group = row.parentElement || row;
  const rows = [];
  for (const button of group.querySelectorAll("button")) {
    if (button.id === "kirocrew-ide-chip" || button.hasAttribute("aria-haspopup")) continue;
    if (button.closest("[role=menu]")) continue;
    const label = button.getAttribute("aria-label") || button.getAttribute("title") || button.textContent || "";
    // "<name> (<host>) — <state>": the separator is whatever dash the host's i18n string uses.
    const m = /^(.*?)\s*\(([^)]*)\)(?:\s*[—–-]\s*(.*))?$/.exec(label.trim());
    const name = (m ? m[1] : label).trim();
    if (!name) continue;
    // Only the Local chip lacks the "(host)" part of the accessible name.
    const isLocal = !m;
    rows.push({ id: isLocal ? null : name, name, detail: m ? m[2] : "Local dashboard", state: m ? m[3] : undefined, unread: 0, active: button.getAttribute("aria-current") === "true", chip: button });
  }
  // Local first, as the relayed model orders it (the leading chip is whoever is on screen).
  return [...rows.filter((r) => r.id === null), ...rows.filter((r) => r.id !== null)];
}

/** Click the chip named `name` in KiroCrew's bar (local dashboard). False when no such chip is on screen. */
export function clickLocalChip(name, doc = globalThis.document) {
  const hit = localEntries(doc).find((e) => e.name === name);
  if (!hit) return false;
  hit.chip.click();
  return true;
}
