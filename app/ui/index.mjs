// KiroCrew IDE — the App page (App Kit ui.entry): the controller.
//
// The host's AppHost renders this default export as a React component when
// the user opens /apps/kirocrew-ide. `react` resolves through the host's import
// map; no bundler, no JSX — plain createElement and inline styles. All backend
// work goes through the kirocrew-ide MOD's routes (served by the FloofyCrew
// Loader, same-origin, behind the dashboard session). If the FloofyCrew mod is
// disabled, the API is gone and the page says so instead of breaking.
//
// The workbench iframe is NOT owned by this page. It lives in the mod's `spa`
// runtime part (spa/layer.mjs), a fixed element owned by the dashboard
// document, so it survives leaving this route and never reloads. This page
// starts/stops the engine, picks the folder, and hands the layer a DOCK BOX
// (`window.__kirocrewIde.dock(el)`): while the page is open the layer sits over
// that box, so the IDE is used inside the page like before; "Fullscreen" raises
// it over the whole dashboard, and Esc / ◁ KiroCrew / "Exit fullscreen" in the
// layer's bar bring it back onto the box. The layer's own tag stack (and the
// "<host> IDE" chip it adds to KiroCrew's crew switcher) does the rest.
//
// Workspaces: one engine serves any number of folders, each its own workbench
// document in the layer. On a running engine the Start button reads "Open" and
// adds the picked folder; a tab row sitting on the dock lists the open
// workspaces like a browser's tab strip (click to switch, × to close, + for the
// folder picker) through the layer's API, which is the owner of which document
// is on screen.
//
// The folder field is a combobox rather than a blind text box: recent
// workspaces first, then a browsable directory list from the mod's `browse`
// route (walk down by clicking, up with "..").
//
// Its menu is rendered through a portal at `document.body`, fixed to the
// field's rectangle, one step above the docked layer (z-index 10). Inside the
// page it would paint UNDER the IDE: the layer is a body-level fixed element,
// and whatever stacking context the host's route container opens, the page's
// own z-index cannot reach past it (seen on a live host: the list cut off at
// the workbench's top edge).

import React from "react";
import { createPortal } from "react-dom";
import { loadHostPicker } from "/api/apps/floofycrew/spa/kirocrew-ide/hostpicker.mjs";

const h = React.createElement;
const API = "/api/apps/floofycrew/mods/kirocrew-ide/api/";
/** Above the docked layer (10), below the host's own overlays (50+). */
const MENU_Z = 11;

async function call(path, init) {
  const reply = await fetch(API + path, init);
  let body = null;
  try {
    body = await reply.json();
  } catch {
    /* non-JSON error page (mod disabled, auth) — handled by ok flag */
  }
  return { ok: reply.ok, status: reply.status, body };
}

/** The layer's public handle, when the spa part is active in this document. */
export function ideLayer(win = globalThis.window) {
  const api = win && win.__kirocrewIde;
  return api && typeof api.show === "function" ? api : null;
}

/** Follow the layer's state (running / shown) so the page's buttons stay true; null when no layer is present. */
function useLayerState() {
  const [state, setState] = React.useState(() => { const api = ideLayer(); return api ? api.state() : null; });
  React.useEffect(() => {
    let off = null;
    const attach = () => {
      const api = ideLayer();
      if (!api || off) return;
      off = api.subscribe(setState);
    };
    attach();
    // The layer may start after this page (the SPA host imports runtime parts once the bundle is up).
    const timer = setInterval(() => { attach(); if (off) clearInterval(timer); }, 1000);
    return () => { clearInterval(timer); if (off) off(); };
  }, []);
  return state;
}

const border = "1px solid var(--border-color, #4444)";
const styles = {
  root: { display: "flex", flexDirection: "column", height: "calc(100vh - 90px)", gap: 8 },
  bar: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", font: "13px system-ui" },
  button: { padding: "4px 12px", borderRadius: 6, cursor: "pointer", border, background: "transparent", color: "inherit" },
  primary: { padding: "4px 12px", borderRadius: 6, cursor: "pointer", border: "1px solid var(--accent, #7c5cff)", background: "var(--accent, #7c5cff)", color: "#fff" },
  picker: { position: "relative", flex: 1, minWidth: 260 },
  stuck: { display: "flex", gap: 10, alignItems: "center", justifyContent: "space-between", padding: "6px 10px", borderRadius: 4, border: "1px solid var(--warning, #d29922)", background: "rgba(210,153,34,.12)", font: "12px system-ui" },
  input: { width: "100%", boxSizing: "border-box", padding: "4px 8px", borderRadius: 6, border, background: "transparent", color: "inherit" },
  menu: {
    // Portaled to document.body: `position: fixed`, placed from the field's rectangle (see FolderPicker).
    position: "fixed", zIndex: MENU_Z, maxHeight: 320, overflowY: "auto", boxSizing: "border-box",
    background: "var(--bg-elevated, var(--background, #1e1e1e))", border, borderRadius: 6, boxShadow: "0 8px 24px rgba(0,0,0,.35)",
    font: "13px system-ui", padding: 4,
  },
  menuHead: { padding: "4px 8px", opacity: 0.55, fontSize: 11, textTransform: "uppercase", letterSpacing: ".04em" },
  menuItem: { display: "flex", justifyContent: "space-between", gap: 8, padding: "5px 8px", borderRadius: 4, cursor: "pointer", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
  notice: {
    flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 14, whiteSpace: "pre-wrap", opacity: 0.85,
    font: "13px/1.6 system-ui", border: "1px dashed var(--border-color, #4444)", borderRadius: 8, padding: 16, textAlign: "center",
  },
  // The workspace tab row sits on the dock like a browser's tab strip: tabs are
  // open at the bottom and the active one merges into the workbench under it.
  // The dock's top border is the rule the inactive tabs rest on.
  // (-9 = the root's 8px gap plus 1px so the tabs overlap the dock's top border.)
  strip: { display: "flex", alignItems: "flex-end", gap: 2, padding: "0 8px", marginBottom: -9, overflowX: "auto", overflowY: "hidden", flexShrink: 0, position: "relative", zIndex: 1 },
  wsTab: {
    display: "inline-flex", alignItems: "center", maxWidth: 260, flexShrink: 0,
    borderRadius: "6px 6px 0 0", borderWidth: 1, borderStyle: "solid",
    borderTopColor: "var(--border-color, #4444)", borderLeftColor: "var(--border-color, #4444)", borderRightColor: "var(--border-color, #4444)", borderBottomColor: "transparent",
    background: "transparent", opacity: 0.72, fontFamily: "system-ui", fontSize: 12, fontWeight: 400,
  },
  wsTabActive: {
    borderTopColor: "var(--accent, #7c5cff)", borderLeftColor: "var(--accent, #7c5cff)", borderRightColor: "var(--accent, #7c5cff)",
    background: "color-mix(in srgb, var(--accent, #7c5cff) 14%, var(--bg-elevated, var(--background, transparent)))", opacity: 1, fontWeight: 600,
  },
  wsName: { border: 0, background: "transparent", color: "inherit", font: "inherit", padding: "5px 4px 5px 10px", cursor: "pointer", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
  wsClose: { border: 0, background: "transparent", color: "inherit", font: "14px/1 system-ui", padding: "0 8px 2px 4px", opacity: 0.55, cursor: "pointer" },
  wsProgress: { display: "inline-flex", alignItems: "center", gap: 4, fontSize: 10, fontVariantNumeric: "tabular-nums", opacity: 0.85, padding: "0 2px 0 4px", whiteSpace: "nowrap", cursor: "default" },
  wsNew: { border: 0, background: "transparent", color: "inherit", font: "16px/1 system-ui", padding: "4px 8px 5px", opacity: 0.6, cursor: "pointer", alignSelf: "center" },
  // The dock box: the layer positions the workbench over this rectangle while the page is open.
  dock: { flex: 1, minHeight: 240, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 8, border: "1px dashed var(--border-color, #4444)", opacity: 0.7, font: "13px/1.6 system-ui", whiteSpace: "pre-wrap", textAlign: "center", padding: 16 },
  dockUnderTabs: { borderTopLeftRadius: 0, borderTopRightRadius: 0, borderTopStyle: "solid" },
};

/**
 * Spec-task completeness of a workspace row (`status.workspaces[].progress`,
 * the hook's count of the boxes in `.kiro/specs/*\/tasks.md`): the whole
 * percentage, the counts, and the per-spec rows; null when there is nothing to
 * show. Same reading as the layer's spa/progress.mjs (which paints the
 * title-bar indicator and its breakdown); this page only needs the glance on
 * each tab, so the geometry is repeated here rather than imported across parts.
 */
function progressOf(row) {
  const p = row && row.progress;
  const n = (v) => (Number.isFinite(Number(v)) ? Math.max(0, Math.floor(Number(v))) : 0);
  if (!p || !(n(p.total) > 0)) return null;
  const total = n(p.total);
  const done = Math.min(total, n(p.done));
  const active = Math.min(total - done, n(p.inProgress) + n(p.queued));
  const specs = (Array.isArray(p.specs) ? p.specs : []).map((s) => ({ name: String((s && s.name) || ""), done: Math.min(n(s && s.total), n(s && s.done)), total: n(s && s.total) }));
  return { total, done, active, pct: Math.round((done / total) * 100), specs };
}

/** A tiny donut: faint track, the done share from 12 o'clock, the running/queued share after it. */
function Donut({ progress, size = 12, stroke = 2 }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const centre = size / 2;
  const doneLen = (c * progress.done) / progress.total;
  const activeLen = (c * progress.active) / progress.total;
  const arc = (len, offset, colour) => len > 0 && h("circle", { cx: centre, cy: centre, r, fill: "none", strokeWidth: stroke, stroke: colour, strokeDasharray: len.toFixed(2) + " " + c.toFixed(2), strokeDashoffset: (-offset).toFixed(2) });
  return h("svg", { viewBox: "0 0 " + size + " " + size, width: size, height: size, "aria-hidden": "true", "data-pct": progress.pct, style: { flexShrink: 0, display: "block" }, className: "kide-donut" },
    h("circle", { cx: centre, cy: centre, r, fill: "none", strokeWidth: stroke, stroke: "currentColor", opacity: 0.22 }),
    h("g", { transform: "rotate(-90 " + centre + " " + centre + ")" },
      arc(doneLen, 0, "var(--success, #3fb950)"),
      arc(activeLen, doneLen, "var(--info, #4a9eff)")));
}

/** "50% · 7/14 tasks" plus one line per spec, for the tab's tooltip. */
function progressTitle(progress) {
  const head = progress.pct + "% · " + progress.done + "/" + progress.total + (progress.total === 1 ? " task" : " tasks") + (progress.specs.length > 1 ? " · " + progress.specs.length + " specs" : "");
  return "Spec tasks: " + head + progress.specs.map((s) => "\n  " + s.name + ": " + s.done + "/" + s.total).join("");
}

/**
 * The folder field. With the dashboard's own ProjectPicker reachable (its
 * preloaded chunk; see spa/hostpicker.mjs) the field opens THAT — the same
 * Recent / Browse picker the chat composer and the Spec Builder use, so the
 * IDE's folder choice looks and behaves like the rest of the dashboard. A
 * dashboard without it gets the mod's own combobox below.
 */
function FolderPicker(props) {
  // Boxed: a bare component function handed to setState would be taken for an updater.
  const [host, setHost] = React.useState({ Picker: undefined }); // undefined = resolving, null = not available
  React.useEffect(() => { let live = true; loadHostPicker().then((c) => { if (live) setHost({ Picker: c }); }); return () => { live = false; }; }, []);
  if (host.Picker) return h(HostFolderPicker, { ...props, Picker: host.Picker });
  return h(OwnFolderPicker, props);
}

/** The host's picker anchored to our field: typing still works, a click (or focus) opens the picker. */
function HostFolderPicker({ value, onChange, disabled, inputRef, Picker }) {
  const [open, setOpen] = React.useState(false);
  const anchorRef = React.useRef(null);
  return h("div", { style: styles.picker, ref: anchorRef, "data-testid": "kirocrew-ide-folder", "data-picker": "host" },
    h("input", {
      ref: inputRef,
      style: styles.input,
      placeholder: "workspace folder — click to browse, or type a path",
      value: value || "",
      disabled,
      onFocus: () => setOpen(true),
      onClick: () => setOpen(true),
      onChange: (event) => onChange(event.target.value),
      onKeyDown: (event) => { if (event.key === "Escape" || event.key === "Enter") setOpen(false); },
      "aria-expanded": open,
      "aria-haspopup": "dialog",
      role: "combobox",
    }),
    !disabled && h(Picker, { open, onOpenChange: setOpen, anchorRef, onSelect: (path) => { onChange(path); setOpen(false); } }),
  );
}

/** The mod's own combobox: recent workspaces + a browsable directory list (the hook's `browse` route). */
function OwnFolderPicker({ value, onChange, disabled, inputRef }) {
  const [open, setOpen] = React.useState(false);
  const [listing, setListing] = React.useState(null); // last GET browse body
  const [error, setError] = React.useState("");
  const [rect, setRect] = React.useState(null);       // the field's viewport rectangle while open
  const rootRef = React.useRef(null);
  const menuRef = React.useRef(null);

  const browse = React.useCallback(async (path) => {
    const reply = await call("browse?path=" + encodeURIComponent(path || "~"));
    if (reply.ok && reply.body) {
      setListing(reply.body);
      setError("");
    } else {
      setError((reply.body && reply.body.error) || "cannot list " + path);
    }
  }, []);

  React.useEffect(() => {
    if (!open) return undefined;
    browse(value && value.trim() ? value : "~");
    // The menu lives at document.body (portal): a click in it is a click inside the picker.
    const onDoc = (event) => {
      const inRoot = rootRef.current && rootRef.current.contains(event.target);
      const inMenu = menuRef.current && menuRef.current.contains(event.target);
      if (!inRoot && !inMenu) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Follow the field while the menu is open: the page scrolls, the window resizes, the bar wraps.
  React.useLayoutEffect(() => {
    if (!open) { setRect(null); return undefined; }
    const place = () => {
      const el = rootRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setRect((prev) => (prev && prev.top === r.bottom && prev.left === r.left && prev.width === r.width) ? prev : { top: r.bottom, left: r.left, width: r.width });
    };
    place();
    window.addEventListener("resize", place);
    document.addEventListener("scroll", place, true);
    return () => { window.removeEventListener("resize", place); document.removeEventListener("scroll", place, true); };
  }, [open]);

  const pick = (path) => {
    onChange(path);
    setOpen(false);
  };
  const descend = (path) => {
    onChange(path);
    browse(path);
  };
  const filter = (value || "").trim().toLowerCase();
  const suggestions = ((listing && listing.suggestions) || []).filter((p) => !filter || p.toLowerCase().includes(filter));
  const entries = (listing && listing.entries) || [];
  const typedPrefix = listing && value && value.startsWith(listing.path) && value.length > listing.path.length ? value.slice(listing.path.length).replace(/^\/+/, "").toLowerCase() : "";
  const shown = entries.filter((e) => (!typedPrefix || e.name.toLowerCase().startsWith(typedPrefix)) && (!e.hidden || typedPrefix.startsWith(".")));

  return h("div", { style: styles.picker, ref: rootRef, "data-testid": "kirocrew-ide-folder" },
    h("input", {
      ref: inputRef,
      style: styles.input,
      placeholder: "workspace folder — click to browse, or type a path",
      value: value || "",
      disabled,
      onFocus: () => setOpen(true),
      onClick: () => setOpen(true),
      onChange: (event) => {
        onChange(event.target.value);
        const typed = event.target.value;
        if (typed.endsWith("/")) browse(typed);
      },
      onKeyDown: (event) => {
        if (event.key === "Escape") setOpen(false);
        if (event.key === "Enter") setOpen(false);
      },
      "aria-expanded": open,
      "aria-autocomplete": "list",
      role: "combobox",
    }),
    open && !disabled && rect && createPortal(h("div", {
      style: { ...styles.menu, top: rect.top + 4, left: rect.left, width: rect.width }, role: "listbox", ref: menuRef, "data-testid": "kirocrew-ide-folder-menu",
    },
      error && h("div", { style: { ...styles.menuHead, color: "var(--danger, #e5484d)", textTransform: "none" } }, error),
      suggestions.length > 0 && h("div", { style: styles.menuHead }, "Recent"),
      ...suggestions.map((path) => h("div", {
        key: "s:" + path, style: styles.menuItem, role: "option", onMouseDown: (e) => e.preventDefault(), onClick: () => pick(path),
      }, h("span", null, path))),
      listing && h("div", { style: styles.menuHead }, "Browse " + listing.path),
      listing && listing.parent && h("div", {
        key: "..", style: styles.menuItem, role: "option", onMouseDown: (e) => e.preventDefault(), onClick: () => descend(listing.parent),
      }, h("span", null, ".."), h("span", { style: { opacity: 0.5 } }, "up")),
      listing && h("div", {
        key: "use", style: { ...styles.menuItem, fontWeight: 600 }, role: "option", onMouseDown: (e) => e.preventDefault(), onClick: () => pick(listing.path),
      }, h("span", null, "Use this folder"), h("span", { style: { opacity: 0.5 } }, listing.path)),
      ...shown.map((entry) => h("div", {
        key: entry.path, style: { ...styles.menuItem, opacity: entry.hidden ? 0.6 : 1 }, role: "option",
        onMouseDown: (e) => e.preventDefault(), onClick: () => descend(entry.path),
      }, h("span", null, entry.name + "/"), h("span", { style: { opacity: 0.4 } }, "open"))),
      listing && listing.truncated && h("div", { style: styles.menuHead }, "list truncated — type to narrow"),
    ), document.body),
  );
}

export default function KirocrewIdeApp() {
  const [status, setStatus] = React.useState(null);   // last GET status body
  const [engines, setEngines] = React.useState(null); // last GET engines body
  const [folder, setFolder] = React.useState("");
  const [busy, setBusy] = React.useState("");
  const [error, setError] = React.useState("");
  const layer = useLayerState();
  const dockRef = React.useRef(null);
  const pickerRef = React.useRef(null);
  const running0 = React.useRef(false);

  const refresh = React.useCallback(async () => {
    const reply = await call("status");
    if (!reply.ok || !reply.body) {
      setError(
        reply.status === 404 || reply.status === 403
          ? "The kirocrew-ide FloofyCrew mod is not active — enable it in the FloofyCrew app."
          : "IDE backend unreachable (HTTP " + reply.status + ")"
      );
      return;
    }
    setError("");
    setStatus(reply.body);
    // The picker starts on the lead workspace once; after that it is the user's own text.
    if (!running0.current && reply.body.server && reply.body.server.folder) {
      setFolder((current) => current || reply.body.server.folder);
    }
    running0.current = !!reply.body.running;
    if (!reply.body.engine) setEngines((await call("engines")).body);
    const api = ideLayer();
    if (api) api.refresh();
  }, []);

  React.useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, [refresh]);

  // Start boots the engine on the folder; on a running engine the same button
  // reads "Open" and adds the folder as one more workspace (the engine serves
  // any number, each its own document), which the layer then brings to the front.
  const start = async () => {
    const wasRunning = !!(status && status.running);
    setBusy(wasRunning ? "opening…" : "starting…");
    const reply = await call("start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(folder ? { folder } : {}),
    });
    setBusy("");
    if (!reply.ok) { setError((reply.body && reply.body.error) || (wasRunning ? "open failed" : "start failed")); await refresh(); return; }
    await refresh();
    const api = ideLayer();
    const rows = (reply.body && reply.body.workspaces) || [];
    const opened = folder && rows.find((r) => r.folder === folder || r.folder === folder.replace(/\/+$/, ""));
    if (api && opened && typeof api.activate === "function") { await api.refresh(); api.activate(opened.folder); }
    if (wasRunning) setFolder("");
  };

  const activate = (f) => { const api = ideLayer(); if (api && typeof api.activate === "function") api.activate(f); };
  const closeWorkspace = async (f) => {
    const api = ideLayer();
    if (api && typeof api.close === "function") await api.close(f);
    else await call("workspaces/close", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ folder: f }) });
    await refresh();
  };

  const stop = async () => {
    setBusy("stopping…");
    const api = ideLayer();
    if (api) api.hide();
    await call("stop", { method: "POST" });
    setBusy("");
    await refresh();
  };

  // The remedy for a stuck engine (status.health.stuck: a document loaded, the engine
  // accepted no connection since): the same workspaces on a fresh engine. The layer
  // drops its documents when status reports the engine gone and rebuilds them on return.
  const relaunch = async () => {
    setBusy("relaunching engine…");
    const reply = await call("relaunch", { method: "POST", body: "{}" });
    if (!reply.ok) setError((reply.body && reply.body.error) || "relaunch failed");
    setBusy("");
    const api = ideLayer();
    if (api && typeof api.refresh === "function") await api.refresh();
    await refresh();
  };

  const install = async () => {
    setBusy("installing engine…");
    await call("engines/install", { method: "POST", body: "{}" });
    const poll = setInterval(async () => {
      const reply = await call("engines");
      setEngines(reply.body);
      const state = reply.body && reply.body.install && reply.body.install.state;
      if (!["resolving", "downloading", "extracting"].includes(state)) {
        clearInterval(poll);
        setBusy("");
        await refresh();
      } else if (state === "downloading") {
        setBusy("downloading… " + ((reply.body.install.bytes || 0) / 1048576).toFixed(0) + " MB");
      } else {
        setBusy(state + "…");
      }
    }, 2000);
  };

  const fullscreen = () => {
    const api = ideLayer();
    if (api) api.show();
  };

  const running = !!(status && status.running);
  const host = (status && status.host) || "this host";
  const hasLayer = !!layer;
  const workspaces = (status && Array.isArray(status.workspaces) ? status.workspaces : []).filter((r) => r && r.folder);
  const activeFolder = (layer && layer.activeFolder) || (workspaces[0] && workspaces[0].folder) || null;
  const asleep = new Set((layer && Array.isArray(layer.asleep)) ? layer.asleep : []);

  // Hand the layer the dock box while the page is open and the engine runs;
  // leaving the page (or the engine stopping) takes it back.
  React.useEffect(() => {
    const api = ideLayer();
    const el = dockRef.current;
    if (!api || !running || !el) return undefined;
    api.dock(el);
    return () => api.undock();
  }, [running, hasLayer]);
  const barText = busy || error ||
    (running
      ? "running: " + status.server.engine + (status.proxy && status.proxy.inUse ? "" : " on 127.0.0.1:" + status.server.port)
      : status
        ? (status.engine ? "stopped (engine: " + status.engine + ")" : "no engine installed")
        : "loading…");

  let main;
  if (running && !layer) {
    main = h("div", { style: styles.notice },
      "The IDE is running, but its layer (the mod's spa part) is not active in this page.\n" +
      "Reload the dashboard once; if it stays away, check the FloofyCrew app for a fault on kirocrew-ide.");
  } else if (running) {
    // The layer paints the workbench over this box; the text underneath only shows while it is fullscreen.
    main = h("div", { style: workspaces.length > 0 ? { ...styles.dock, ...styles.dockUnderTabs } : styles.dock, ref: dockRef, "data-testid": "kirocrew-ide-dock", "data-mode": layer.mode },
      layer.shown
        ? "The IDE is fullscreen over KiroCrew.\nEsc or \u25C1 KiroCrew in its title bar bring it back here."
        : "");
  } else if (status && !status.engine) {
    main = h("div", { style: styles.notice },
      (engines && engines.install && engines.install.state === "error"
        ? "Engine install failed:\n" + engines.install.error + "\n\n"
        : "No IDE engine on this host.\n\n") +
      ((engines && engines.hint) || ""));
  } else {
    main = h("div", { style: styles.notice }, error || "Engine ready. Pick a folder and press Start.");
  }

  return h("div", { style: styles.root },
    h("div", { style: styles.bar },
      h("span", { "data-testid": "kirocrew-ide-status" }, barText),
      h(FolderPicker, { value: folder, onChange: setFolder, disabled: !!busy, inputRef: pickerRef }),
      status && status.engine &&
        h("button", { style: styles.primary, onClick: start, disabled: !!busy || (running && !folder.trim()), "data-testid": "kirocrew-ide-start",
          title: running ? "Open this folder as another workspace on the running IDE" : "Start the IDE on this folder" }, running ? "Open" : "Start"),
      !running && status && !status.engine &&
        h("button", { style: styles.primary, onClick: install, disabled: !!busy }, "Install engine (~100 MB)"),
      running && layer && h("button", { style: styles.button, onClick: fullscreen, disabled: !!layer.shown, title: host + " IDE over the whole dashboard (Esc comes back)", "data-testid": "kirocrew-ide-expand" }, "Fullscreen"),
      running && h("button", { style: styles.button, onClick: stop, disabled: !!busy }, "Stop"),
      h("button", { style: styles.button, onClick: refresh }, "Refresh"),
    ),
    // The engine answers HTTP but services no workbench connection (its extension host died):
    // the page would stay blank through every reload, so say so and offer the one cure.
    running && status.health && status.health.stuck && h("div", { style: styles.stuck, role: "alert", "data-testid": "kirocrew-ide-stuck" },
      h("span", null, "The IDE engine looks stuck: " + status.health.reason),
      h("button", { style: styles.primary, onClick: relaunch, disabled: !!busy, "data-testid": "kirocrew-ide-relaunch" }, "Relaunch engine")),
    // Only the unusual case gets a line: the normal same-origin serve is silent.
    running && !(status.proxy && status.proxy.inUse) && h("div", { style: { font: "11px system-ui", opacity: 0.55 } },
      "engine on 127.0.0.1:" + status.server.port + " — same-origin proxy unavailable" +
        ((status.proxy && status.proxy.error) ? " (" + status.proxy.error + ")" : "") +
        "; forward that port too: ssh -L " + status.server.port + ":127.0.0.1:" + status.server.port + " <gateway-host>"),
    // One tab per open workspace, sitting on the workbench; + opens the folder picker for another.
    running && workspaces.length > 0 && h("div", { style: styles.strip, "data-testid": "kirocrew-ide-workspace-strip", role: "tablist", "aria-label": "Open workspaces" },
      workspaces.map((w) => {
        const progress = progressOf(w);
        return h("span", { key: w.folder, style: Object.assign({}, styles.wsTab, w.folder === activeFolder ? styles.wsTabActive : null), role: "tab", "aria-selected": w.folder === activeFolder ? "true" : "false", "data-folder": w.folder, "data-asleep": asleep.has(w.folder) ? "true" : "false", "data-pct": progress ? progress.pct : undefined },
          h("button", { style: styles.wsName, onClick: () => activate(w.folder), title: w.folder + (asleep.has(w.folder) ? "\nasleep: unloaded after sitting off screen; click to reconnect" : "") },
            asleep.has(w.folder) && h("span", { "aria-label": "asleep", title: "asleep", style: { opacity: 0.7, marginRight: 5 } }, "\u263E"),
            w.name || w.folder),
          progress && h("span", { style: styles.wsProgress, title: progressTitle(progress), "data-testid": "kirocrew-ide-tab-progress", "aria-label": "spec tasks " + progress.pct + " percent complete" },
            h(Donut, { progress }), progress.pct + "%"),
          h("button", { style: styles.wsClose, onClick: () => closeWorkspace(w.folder), title: "Close " + (w.name || w.folder) + " (the engine keeps running)", "aria-label": "Close workspace " + (w.name || w.folder) }, "\u00d7"));
      }),
      h("button", {
        style: styles.wsNew, "data-testid": "kirocrew-ide-new-tab", "aria-label": "Open another folder as a new workspace", title: "Open another folder as a new workspace",
        onClick: () => { const el = pickerRef.current; if (el) { el.focus(); el.click(); } },
      }, "+")),
    main,
  );
}
