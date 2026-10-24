// kirocrew-ide — the IDE layer: the workbench as a persistent tab of the dashboard.
//
// A `spa` runtime part, so it lives as long as the dashboard document does. It
// owns the workbench <iframe>s — one per open WORKSPACE (folder), all served
// by the one engine, each created when first shown and never unmounted so it
// stays warm (no reload on the way back or on a switch); only the active one
// is displayed. Across every dashboard route, in one of three modes:
//
//  * `fullscreen` — a fixed overlay covering the KiroCrew UI;
//  * `docked` — the same element, positioned over the App page's dock box
//    (/apps/kirocrew-ide), so the IDE is usable inside the page like any app;
//    the iframe is NOT reparented (that would reload it), the layer just follows
//    the box's rectangle;
//  * `hidden` — `display:none`.
//
// The App page is the controller: start/stop, folder, engine install, a dock
// box it registers through `window.__kirocrewIde.dock(el)`, and Fullscreen.
// Leaving fullscreen (Esc, ◁ KiroCrew, the "here" row) lands on the dock when
// the App page is open, otherwise back on the dashboard; the public API's
// `exitFullscreen()` always returns to the App page, navigating there when
// needed (no bar button — ◁ KiroCrew is the one way out).
//
// Two "tag stacks" show where you are and let you move without leaving
// fullscreen:
//
//  * KiroCrew's own crew switcher (`crew-chip-row`: Local, the crew on screen,
//    the pinned crews) gets one more chip, "<host> IDE", while the IDE is
//    running on this host; clicking it raises the layer. It is re-inserted
//    whenever the host re-renders the row, and lit while the layer is up.
//  * The layer's title bar mirrors that row: "◁ KiroCrew", then a host dropdown
//    (the crew on screen as the trigger; the menu from the desktop window's
//    relayed model in an embedded pane, or from the chips on screen on a local
//    dashboard), the current host's row returning to its dashboard, the others
//    switching crews (spa/hostmodel.mjs), and the lit "IDE · folder" segment
//    joined to the trigger — the same `[host]IDE]` shape as the chip in
//    KiroCrew's bar. That segment is the WORKSPACE MANAGER dropdown: the open
//    folders (switch, close ×) and "Open a folder…", an in-menu picker over
//    the mod's `browse` route, so another project opens without leaving
//    fullscreen (`workspaces/open`, `workspaces/close` on the hook).
//
// Everything is same-origin: the mod's own routes, the workbench through the
// dashboard proxy, and postMessage to the desktop window that embeds this pane.
import { HostModelStore, clickLocalChip, entriesFor, isEmbedded, localEntries, switchTo } from "./hostmodel.mjs";
import { dashboardScheme, injectLetterpressStyle, readWorkbenchTheme, withScheme, workbenchCentreLeft, workbenchRightLeft } from "./workbench.mjs";
import { donutMarkup, progressLabel, summarize } from "./progress.mjs";
import { HOST_PICKER_RAISE_CSS, loadHostPicker, mountHostPicker } from "./hostpicker.mjs";

export const API = "/api/apps/floofycrew/mods/kirocrew-ide/api/";
export const APP_ROUTE = "/apps/kirocrew-ide";
const LAYER_ID = "kirocrew-ide-layer";
const CHIP_ID = "kirocrew-ide-chip";
const STYLE_ID = "kirocrew-ide-layer-style";
const CHIP_ROW = '[data-testid="crew-chip-row"]';
const STATUS_POLL_MS = 8000;
const DOCK_POLL_MS = 500;
// Idle unloading: a workspace document that has not been on screen for the
// host's `idleUnloadMinutes` (status; default 15, 0 = never) is dropped — its
// iframe removed, which closes the connection and frees the engine's extension
// host and file watcher within a second, and the client's renderer with it. The
// workspace stays open (its tab stays; the engine's list is untouched); the
// next switch to it recreates the document, a few seconds of reconnect. The
// workbench's own hot exit and terminal persistence survive the gap.
const IDLE_CHECK_MS = 30000;
const IDLE_CHOICES = [0, 5, 15, 30, 60];
const IDLE_DEFAULT_MIN = 15;
// Wake guard: a document the layer has just created (first show, or waking a
// slept one) must get its WebSocket through to the engine within this budget.
// The host counts the bridges that reached the engine (`status.proxy.websockets
// .opened`); a document whose budget passes with the count where it stood is
// reloaded ONCE — the 2026-10-20 blank page was exactly such a document, in the
// desktop client, after waking from idle sleep: HTML served, no connection ever
// made, and a client restart (a fresh load) cured it. One reload, not a loop:
// a second miss is left for the workbench's own error path to report.
const WAKE_BUDGET_MS = 20000;
// Where the task indicator sits when the workbench's title-bar right part (the layout
// controls) cannot be measured yet: clear of those four buttons on any window width.
const PROGRESS_RIGHT_FALLBACK = 150;
const PROGRESS_GAP = 8;
const FOX = "/apps/kirocrew-ide/ui/art/fox.svg";
// The browser's folder -> profile map (the web workbench keeps it in localStorage on the
// dashboard origin, which this layer shares with every workbench document). The layer
// reports it to the host — once at start, and after every write a workbench document
// makes to it, which reaches this document as a `storage` event — so the host's seed can
// hand it to the next browser or desktop client. Debounced: a profile switch writes twice.
const ASSOCIATIONS_KEY = "profileAssociations";
const ASSOCIATIONS_DEBOUNCE_MS = 1000;

/**
 * The inline style that joins an "IDE" segment flush to the chip before it
 * (`[host]IDE]`): left corners squared, left border dropped, and the row's gap
 * cancelled with a negative margin. Shared by the chip in KiroCrew's bar
 * (gap 4px) and the tag in the layer's title bar (gap 6px).
 */
export function subTagStyle(gapPx) {
  return "border-top-left-radius:0;border-bottom-left-radius:0;margin-left:-" + gapPx + "px;border-left-width:0;padding-left:6px;";
}

const CSS = `
#${LAYER_ID} { position: fixed; inset: 0; z-index: 2147483000; display: none; flex-direction: column; background: var(--kide-titlebar, #1e1e1e); }
#${LAYER_ID}[data-shown="true"] { display: flex; }
#${LAYER_ID}[data-mode="docked"] { z-index: 10; inset: auto; border-radius: 8px; overflow: hidden; border: 1px solid var(--kide-border, rgba(128,128,128,.35)); box-sizing: border-box; }
#${LAYER_ID}[data-mode="docked"] .kide-bar { display: none; }
#${LAYER_ID} > iframe { display: none; flex: 1; width: 100%; border: 0; opacity: 0; transition: opacity .25s; }
#${LAYER_ID} > iframe[data-active="true"] { display: block; }
#${LAYER_ID} > iframe[data-ready="true"] { opacity: 1; }
#${LAYER_ID} .kide-bar { position: absolute; top: 6.5px; left: 84px; right: 140px; height: 22px; display: flex; align-items: center; gap: 6px; z-index: 1; font: 12px system-ui; color: var(--kide-fg, #ccc); }
#${LAYER_ID} .kide-btn { height: 22px; line-height: 20px; padding: 0 10px; border-radius: 6px; cursor: pointer; box-sizing: border-box; display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; font: inherit; color: inherit;
  border: 1px solid var(--kide-border, rgba(128,128,128,.35)); background: var(--kide-bg, rgba(128,128,128,.15)); }
#${LAYER_ID} .kide-btn:hover { background: var(--kide-hover, rgba(128,128,128,.28)); }
#${LAYER_ID} .kide-hosts { position: relative; min-width: 0; }
#${LAYER_ID} .kide-trigger { max-width: 200px; border-top-right-radius: 0; border-bottom-right-radius: 0; }
#${LAYER_ID} .kide-chip[data-sub="true"] { ${subTagStyle(6)} }
#${LAYER_ID} .kide-trigger > .kide-name { overflow: hidden; text-overflow: ellipsis; }
#${LAYER_ID} .kide-caret { opacity: .7; font-size: 10px; }
#${LAYER_ID} .kide-menu { position: absolute; top: 100%; left: 0; margin-top: 4px; min-width: 240px; max-width: 340px; max-height: 60vh; overflow-y: auto; padding: 4px; box-sizing: border-box;
  border-radius: 6px; box-shadow: 0 8px 24px rgba(0,0,0,.35); font: 12px system-ui; z-index: 2;
  background: var(--kide-menu-bg, var(--kide-titlebar, #252526)); color: var(--kide-menu-fg, var(--kide-fg, #ccc)); border: 1px solid var(--kide-menu-border, var(--kide-border, rgba(128,128,128,.35))); }
#${LAYER_ID} .kide-menu[hidden] { display: none; }
#${LAYER_ID} .kide-row { display: flex; align-items: center; gap: 8px; width: 100%; text-align: left; padding: 5px 8px; border-radius: 4px; cursor: pointer; border: 0; background: transparent; font: inherit; color: inherit; }
#${LAYER_ID} .kide-row:hover, #${LAYER_ID} .kide-row:focus-visible { background: var(--kide-menu-hover, rgba(128,128,128,.18)); color: var(--kide-menu-hover-fg, inherit); outline: none; }
#${LAYER_ID} .kide-row .kide-text { display: flex; flex-direction: column; min-width: 0; flex: 1; }
#${LAYER_ID} .kide-row .kide-text > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#${LAYER_ID} .kide-row .kide-detail { opacity: .6; font-size: 11px; }
#${LAYER_ID} .kide-row .kide-word { opacity: .7; font-size: 11px; }
#${LAYER_ID} .kide-row[data-kind="here"] { font-weight: 700; border-left: 2px solid var(--kide-accent, #7c5cff); border-radius: 0 4px 4px 0; }
#${LAYER_ID} .kide-row[data-kind="here"] .kide-detail { opacity: .8; color: var(--kide-accent, #b9a6ff); }
#${LAYER_ID} .kide-sep { height: 1px; margin: 4px 6px; background: var(--kide-menu-border, var(--kide-border, rgba(128,128,128,.35))); opacity: .6; }
#${LAYER_ID} .kide-chip { max-width: 220px; overflow: hidden; text-overflow: ellipsis; }
#${LAYER_ID} .kide-chip[aria-current="true"] { font-weight: 700; border-color: transparent; background: var(--kide-accent-bg, rgba(124,92,255,.22)); color: var(--kide-accent-text, var(--kide-accent, #b9a6ff)); }
#${LAYER_ID} .kide-chip { min-width: 0; flex: 0 1 auto; }
/* Shrink order under a tight budget: the folder name gives way long before the host name does. */
#${LAYER_ID} .kide-ws { flex-shrink: 20; }
/* The folder name is the bar's one flexible piece. When the bar's budget (see fitBar) cuts it short it
   is not ellipsised but faded at the clipped edge, like KiroCrew's own crew row, and it scrolls
   sideways (wheel / trackpad) with the scrollbar hidden; the fade is the affordance. */
#${LAYER_ID} .kide-chip .kide-ws-name { font-weight: 400; color: var(--kide-muted, inherit); overflow-x: auto; overflow-y: hidden; text-overflow: clip; white-space: nowrap; min-width: 3ch; scrollbar-width: none; flex: 0 1 auto; }
#${LAYER_ID} .kide-chip .kide-ws-name::-webkit-scrollbar { display: none; }
#${LAYER_ID} .kide-chip .kide-ws-name[data-clipped="end"] { mask-image: linear-gradient(90deg, #000 calc(100% - 18px), transparent); -webkit-mask-image: linear-gradient(90deg, #000 calc(100% - 18px), transparent); }
#${LAYER_ID} .kide-chip .kide-ws-name[data-clipped="start"] { mask-image: linear-gradient(90deg, transparent, #000 18px); -webkit-mask-image: linear-gradient(90deg, transparent, #000 18px); }
#${LAYER_ID} .kide-chip .kide-ws-name[data-clipped="both"] { mask-image: linear-gradient(90deg, transparent, #000 18px, #000 calc(100% - 18px), transparent); -webkit-mask-image: linear-gradient(90deg, transparent, #000 18px, #000 calc(100% - 18px), transparent); }
#${LAYER_ID} .kide-idle { padding: 4px 8px 2px; font-size: 11px; opacity: .8; }
#${LAYER_ID} .kide-idle label { display: flex; align-items: center; justify-content: space-between; gap: 8px; cursor: default; }
#${LAYER_ID} .kide-idle select { font: 11px system-ui; color: inherit; background: var(--kide-bg, rgba(128,128,128,.15)); border: 1px solid var(--kide-menu-border, var(--kide-border, rgba(128,128,128,.35))); border-radius: 4px; padding: 1px 4px; }
#${LAYER_ID} .kide-row[data-asleep="true"] .kide-text { opacity: .6; }
#${LAYER_ID} .kide-chip .kide-count { min-width: 14px; height: 14px; padding: 0 3px; border-radius: 7px; font-size: 9px; line-height: 14px; text-align: center; font-weight: 700; background: var(--kide-badge-bg, var(--kide-accent, #7c5cff)); color: var(--kide-badge-fg, #fff); }
#${LAYER_ID} .kide-ws { position: relative; min-width: 0; display: inline-flex; }
#${LAYER_ID} .kide-ws .kide-menu { min-width: 280px; max-width: 420px; }
#${LAYER_ID} .kide-row[data-kind="workspace"][aria-checked="true"] { font-weight: 700; border-left: 2px solid var(--kide-accent, #7c5cff); border-radius: 0 4px 4px 0; }
#${LAYER_ID} .kide-row .kide-x { flex-shrink: 0; width: 18px; height: 18px; border-radius: 4px; border: 0; background: transparent; color: inherit; opacity: .55; cursor: pointer; font: 14px/18px system-ui; padding: 0; }
#${LAYER_ID} .kide-row .kide-x:hover { opacity: 1; background: var(--kide-menu-hover, rgba(128,128,128,.25)); }
#${LAYER_ID} .kide-open { display: flex; flex-direction: column; gap: 6px; padding: 6px 8px 4px; }
#${LAYER_ID} .kide-open .kide-path { display: flex; gap: 6px; }
#${LAYER_ID} .kide-open input { flex: 1; min-width: 0; height: 24px; padding: 0 8px; border-radius: 4px; font: 12px system-ui; color: inherit; box-sizing: border-box;
  background: var(--kide-bg, rgba(128,128,128,.15)); border: 1px solid var(--kide-menu-border, var(--kide-border, rgba(128,128,128,.35))); }
#${LAYER_ID} .kide-open input:focus { outline: 1px solid var(--kide-accent, #7c5cff); }
#${LAYER_ID} .kide-open .kide-go { height: 24px; padding: 0 10px; border-radius: 4px; border: 0; cursor: pointer; font: 12px system-ui; font-weight: 600; background: var(--kide-accent, #7c5cff); color: #fff; }
#${LAYER_ID} .kide-open .kide-go:disabled { opacity: .5; cursor: default; }
#${LAYER_ID} .kide-open .kide-dirs { max-height: 180px; overflow-y: auto; display: flex; flex-direction: column; }
#${LAYER_ID} .kide-open .kide-dir { padding: 3px 8px; font-size: 12px; }
#${LAYER_ID} .kide-open .kide-dir .kide-detail { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#${LAYER_ID} .kide-open .kide-head { font-size: 10px; text-transform: uppercase; letter-spacing: .04em; opacity: .55; padding: 2px 8px 0; }
#${LAYER_ID} .kide-open .kide-err { font-size: 11px; color: #e5534b; padding: 0 8px; }
#${LAYER_ID} .kide-here-mark { display: inline-flex; width: 12px; height: 12px; flex-shrink: 0; color: var(--kide-accent, #b9a6ff); }
#${LAYER_ID} .kide-here-mark svg { width: 12px; height: 12px; }
#${LAYER_ID} .kide-dot { width: 6px; height: 6px; border-radius: 3px; flex-shrink: 0; display: inline-block; }
#${LAYER_ID} .kide-badge { min-width: 16px; height: 16px; padding: 0 4px; border-radius: 8px; font-size: 10px; line-height: 16px; text-align: center; font-weight: 700; background: var(--kide-accent, #7c5cff); color: #fff; }
#${LAYER_ID} .kide-loading { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px; font: 14px system-ui; color: var(--kide-fg, #ccc); pointer-events: none; }
#${LAYER_ID}[data-ready="true"] .kide-loading { display: none; }
#${LAYER_ID} .kide-stuck { position: absolute; left: 50%; top: 40%; transform: translate(-50%, -50%); z-index: 2; max-width: 520px; display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 16px 20px; border-radius: 4px; border: 1px solid var(--kide-menu-border, var(--kide-border, rgba(128,128,128,.35))); background: var(--kide-menu-bg, var(--kide-titlebar, #2b2b2b)); color: var(--kide-menu-fg, var(--kide-fg, #ccc)); font: 13px system-ui; text-align: center; box-shadow: 0 8px 24px rgba(0,0,0,.35); }
#${LAYER_ID} .kide-stuck[hidden] { display: none; }
#${LAYER_ID} .kide-stuck-btn { padding: 4px 12px; border: 1px solid var(--kide-accent, #7c5cff); background: var(--kide-accent, #7c5cff); color: #fff; }
#${LAYER_ID}[data-stuck="true"] .kide-loading { display: none; }
#${LAYER_ID} .kide-fox { width: 96px; height: 96px; animation: kide-fox 1.4s cubic-bezier(.45,.05,.55,.95) infinite; transform-origin: 50% 100%; }
#${LAYER_ID} .kide-shadow { width: 64px; height: 8px; border-radius: 50%; background: currentColor; margin-top: -4px; animation: kide-shadow 1.4s cubic-bezier(.45,.05,.55,.95) infinite; }
@keyframes kide-fox { 0%,100% { transform: translateY(0) scale(1, 1); } 30% { transform: translateY(-14px) scale(0.94, 1.06); } 50% { transform: translateY(-18px) scale(1, 1); } 70% { transform: translateY(0) scale(1.08, 0.9); } 80% { transform: translateY(0) scale(0.98, 1.03); } }
@keyframes kide-shadow { 0%,100% { transform: scaleX(1); opacity: .35; } 50% { transform: scaleX(.6); opacity: .15; } }
#${CHIP_ID} .kide-glyph, #${LAYER_ID} .kide-glyph { width: 12px; height: 12px; flex-shrink: 0; }
/* The task indicator: a tiny donut + percentage at the title bar's top right, just left of the
   workbench's own layout controls (fitProgress measures them; see PROGRESS_RIGHT_FALLBACK).
   Shown in both modes (the bar is fullscreen-only, this is not), hidden when the workspace
   has no spec tasks. Click: the per-spec breakdown, right-aligned under it. */
#${LAYER_ID} .kide-progress { position: absolute; top: 6.5px; right: ${PROGRESS_RIGHT_FALLBACK}px; height: 22px; z-index: 1; display: flex; align-items: center; font: 12px system-ui; color: var(--kide-fg, #ccc); }
#${LAYER_ID} .kide-progress[hidden] { display: none; }
#${LAYER_ID} .kide-progress-btn { height: 22px; padding: 0 6px; border-radius: 6px; border: 1px solid transparent; background: transparent; color: inherit; font: inherit; cursor: pointer; display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; box-sizing: border-box; }
#${LAYER_ID} .kide-progress-btn:hover, #${LAYER_ID} .kide-progress-btn[aria-expanded="true"] { background: var(--kide-hover, rgba(128,128,128,.28)); border-color: var(--kide-border, rgba(128,128,128,.35)); }
#${LAYER_ID} .kide-pct { font-size: 11px; font-variant-numeric: tabular-nums; opacity: .9; }
#${LAYER_ID} .kide-donut { flex-shrink: 0; display: block; }
#${LAYER_ID} .kide-donut-track { stroke: currentColor; opacity: .22; }
#${LAYER_ID} .kide-donut-done { stroke: var(--kide-done, #3fb950); }
#${LAYER_ID} .kide-donut-active { stroke: var(--kide-active, #4a9eff); }
#${LAYER_ID} .kide-progress .kide-menu { left: auto; right: 0; min-width: 280px; max-width: 400px; }
#${LAYER_ID} .kide-prog-head { display: flex; align-items: center; gap: 10px; padding: 6px 8px 6px; }
#${LAYER_ID} .kide-prog-head .kide-text, #${LAYER_ID} .kide-prog-row .kide-text { display: flex; flex-direction: column; min-width: 0; flex: 1; }
#${LAYER_ID} .kide-prog-head .kide-text > span, #${LAYER_ID} .kide-prog-row .kide-text > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#${LAYER_ID} .kide-prog-head .kide-text > span:first-child { font-weight: 700; font-size: 13px; }
#${LAYER_ID} .kide-prog-head .kide-detail, #${LAYER_ID} .kide-prog-row .kide-detail { opacity: .6; font-size: 11px; }
#${LAYER_ID} .kide-prog-row { display: flex; align-items: center; gap: 8px; padding: 5px 8px; border-radius: 4px; }
#${LAYER_ID} .kide-prog-row .kide-nums { font-variant-numeric: tabular-nums; opacity: .85; white-space: nowrap; }
#${LAYER_ID} .kide-prog-row .kide-pct { min-width: 32px; text-align: right; }
#${LAYER_ID} .kide-prog-foot { padding: 4px 8px 4px; font-size: 10px; opacity: .55; }
#${LAYER_ID} .kide-row .kide-mini { margin-left: auto; flex-shrink: 0; display: inline-flex; align-items: center; gap: 4px; font-size: 10px; font-variant-numeric: tabular-nums; opacity: .85; }
#${LAYER_ID} .kide-row[data-kind="workspace"] .kide-x { margin-left: 0; }
`;

const GLYPH = '<svg class="kide-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="16 18 22 12 16 6"></polyline><polyline points="8 6 2 12 8 18"></polyline></svg>';
// The "you are here" mark on the current host's row: a dashboard/home outline.
const HOME = '<span class="kide-here-mark" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11l9-8 9 8"></path><path d="M5 10v10h14V10"></path><rect x="10" y="14" width="4" height="6"></rect></svg></span>';

function dotColour(state) {
  return state === "connected" ? "#3fb950" : state === "connecting" ? "#d29922" : state ? "#f85149" : "rgba(128,128,128,.6)";
}

/**
 * The rows of the layer's tag stack. `entries` are the crews this document can
 * see (Local first, from spa/hostmodel.mjs), `activeId` the crew on screen
 * (null = Local), `host` the IDE's host label. The crew on screen becomes the
 * "here" row (its dashboard, i.e. hide the layer); when nothing is known, the
 * host itself stands in. The "<host> IDE" row always closes the stack.
 */
export function stackEntries({ entries = [], activeId = null, host = "this host" }) {
  const rows = [];
  let sawHere = false;
  for (const entry of entries) {
    const here = (entry.id ?? null) === (activeId ?? null);
    sawHere = sawHere || here;
    rows.push({ kind: here ? "here" : "crew", id: entry.id ?? null, label: entry.name, detail: entry.detail || "", state: entry.id === null ? "connected" : entry.state, unread: entry.unread || 0 });
  }
  if (!sawHere) rows.push({ kind: "here", id: activeId ?? null, label: host, detail: "this host's dashboard", state: "connected", unread: 0 });
  rows.push({ kind: "ide", id: "ide", label: host + " IDE", detail: "the IDE on this host", state: undefined, unread: 0 });
  return rows;
}

/**
 * The tag in KiroCrew's bar: the host's own chip classes so it looks like its
 * neighbours. `sub` = rendered as a segment joined to the host's chip
 * (`[host]IDE]`): left corners squared, left border dropped, the row gap
 * cancelled, and the label reduced to "IDE" since the host name is the chip
 * it hangs off. Standalone (no host chip to attach to) it reads "<host> IDE".
 */
export function chipMarkup(host, lit, { sub = false } = {}) {
  const base = "flex items-center gap-1.5 h-6 px-2 rounded-md text-[12px] whitespace-nowrap transition-colors border focus-ring shrink-0 ";
  const state = lit ? "bg-accent-subtle text-accent font-bold border-transparent" : "border-border text-text hover:bg-bg-hover";
  const label = sub ? "IDE" : host + " IDE";
  // The row is `gap-1` (4px): -4px marginLeft butts the segment against the chip.
  const style = sub ? subTagStyle(4) : "";
  return { className: base + state, style, html: GLYPH + '<span class="tb-drop-crew-name truncate max-w-[140px]">' + escapeHtml(label) + "</span>" };
}

/** The style a host chip wears while the IDE segment hangs off it (right corners squared). */
const ANCHOR_STYLE = { borderTopRightRadius: "0", borderBottomRightRadius: "0" };

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export class IdeLayer {
  constructor(ctx, { win = globalThis.window, doc = globalThis.document, fetchFn = globalThis.fetch } = {}) {
    this.ctx = ctx;
    this.win = win;
    this.doc = doc;
    // Called as a method below: keep the global's own `this` or Chromium throws "Illegal invocation".
    this.fetch = (...args) => fetchFn(...args);
    this.status = null;          // last GET status body
    this.mode = "hidden";        // hidden | docked | fullscreen
    this.shown = false;          // mode === "fullscreen": the IDE tab is up over KiroCrew
    this.dockEl = null;          // the App page's dock box while that page is mounted
    this.dockDisposers = [];
    this.frameSrc = null;        // the active frame's src
    this.frames = new Map();     // folder -> iframe: one warm workbench document per open workspace
    this.asleep = new Set();     // folders whose document idle unloading dropped (open, no iframe until shown)
    this.activeFolder = null;    // which of them is on screen
    this.wsMenuOpen = false;     // the IDE tag's workspace dropdown
    this.progressOpen = false;   // the task indicator's breakdown popover
    this.rightEdge = null;       // {edge, width}: the workbench's layout controls, last measured
    this.wakes = new Map();      // iframe -> {opened, at, reloaded}: the wake guard's record per fresh document
    this.wakeReloads = 0;        // how many documents the guard has reloaded (probes, diagnostics)
    this.opener = null;          // state of the "Open a folder…" form while it is up
    this.theme = null;
    this.hostModel = null;
    this.subscribers = new Set();
    this.embedded = isEmbedded(win);
    this.store = new HostModelStore(win);
    this.disposers = [];
    this.root = null;
    this.frame = null;
    this.associationsSent = null;   // the last map string the host accepted (skip unchanged reports)
    this.associationsTimer = null;
  }

  // ---------------------------------------------------------------- lifecycle

  start() {
    this.ensureStyle();
    this.disposers.push(this.store.subscribe((model) => { this.hostModel = model; this.render(); }));
    // Escape closes the host menu first, then leaves fullscreen (docked mode is not a tab to close).
    // The task breakdown closes on Escape in either mode: it is a popover, not a tab.
    const onKey = (event) => {
      if (event.key !== "Escape") return;
      if (this.progressOpen && this.mode !== "hidden") { event.stopPropagation(); this.setProgressOpen(false); return; }
      if (!this.shown) return;
      if (this.menuOpen) { event.stopPropagation(); this.setMenuOpen(false); return; }
      if (this.wsMenuOpen) { event.stopPropagation(); this.setWsMenuOpen(false); return; }
      this.hide();
    };
    this.win.addEventListener("keydown", onKey, true);
    this.disposers.push(() => this.win.removeEventListener("keydown", onKey, true));
    const onDocClick = (event) => {
      if (!this.root) return;
      if (this.menuOpen) {
        const hosts = this.root.querySelector(".kide-hosts");
        if (!(hosts && hosts.contains(event.target))) this.setMenuOpen(false); // the trigger's own click toggles
      }
      if (this.wsMenuOpen) {
        const ws = this.root.querySelector(".kide-ws");
        // The host picker's box portals to document.body: a click in it belongs to the menu.
        const inHostPicker = this.hostPicker && this.hostPicker.isOpen() && event.target.closest && event.target.closest("body > div:has(#pp-recent-list), body > div:has(#pp-browse-list)");
        if (!(ws && ws.contains(event.target)) && !inHostPicker) this.setWsMenuOpen(false);
      }
      if (this.progressOpen) {
        const prog = this.root.querySelector(".kide-progress");
        if (!(prog && prog.contains(event.target))) this.setProgressOpen(false);
      }
    };
    this.doc.addEventListener("mousedown", onDocClick);
    this.disposers.push(() => this.doc.removeEventListener("mousedown", onDocClick));
    // A click INTO the workbench iframe never reaches this document's mousedown
    // listeners (the event stays in the frame), so an open menu or picker would
    // outlive it; the window losing focus to the frame is the signal instead.
    const onBlur = () => {
      this.win.setTimeout(() => {
        const active = this.doc.activeElement;
        if (!(active && active.tagName === "IFRAME" && this.frames.size && [...this.frames.values()].includes(active))) return;
        if (this.menuOpen) this.setMenuOpen(false);
        if (this.wsMenuOpen) this.setWsMenuOpen(false);
        if (this.progressOpen) this.setProgressOpen(false);
      }, 0);
    };
    this.win.addEventListener("blur", onBlur);
    this.disposers.push(() => this.win.removeEventListener("blur", onBlur));
    // Re-insert the switcher chip whenever the host re-renders its bar.
    let scheduled = false;
    const observer = new MutationObserver(() => {
      if (scheduled) return;
      scheduled = true;
      this.win.requestAnimationFrame(() => { scheduled = false; this.placeChip(); });
    });
    observer.observe(this.doc.body, { childList: true, subtree: true });
    this.disposers.push(() => observer.disconnect());
    // The workbench applies its theme after load and can switch any time.
    const themeTimer = this.win.setInterval(() => this.readTheme(), 1000);
    this.disposers.push(() => this.win.clearInterval(themeTimer));
    // Follow the dashboard scheme: report it to the mod (the bridge syncs the workbench live).
    this.publishScheme();
    const schemeObserver = new MutationObserver(() => this.publishScheme());
    schemeObserver.observe(this.doc.documentElement, { attributes: true, attributeFilter: ["data-mode", "data-theme"] });
    this.disposers.push(() => schemeObserver.disconnect());
    const poll = this.win.setInterval(() => { if (this.doc.visibilityState !== "hidden") this.refresh(); }, STATUS_POLL_MS);
    this.disposers.push(() => this.win.clearInterval(poll));
    const idle = this.win.setInterval(() => this.sleepIdle(), IDLE_CHECK_MS);
    this.disposers.push(() => this.win.clearInterval(idle));
    const fit = () => { this.fitBar(); this.fitProgress(); };
    this.win.addEventListener("resize", fit);
    this.disposers.push(() => this.win.removeEventListener("resize", fit));
    // A workbench document's write to the folder -> profile map reaches this document as a storage event.
    const onStorage = (event) => { if (!event || event.key === null || event.key === ASSOCIATIONS_KEY) this.scheduleAssociationReport(); };
    this.win.addEventListener("storage", onStorage);
    this.disposers.push(() => this.win.removeEventListener("storage", onStorage));
    this.disposers.push(() => { if (this.associationsTimer) { this.win.clearTimeout(this.associationsTimer); this.associationsTimer = null; } });
    this.scheduleAssociationReport();
    // The dashboard's own folder picker for "Open a folder…", when this dashboard carries it.
    this.hostPicker = null;       // mounted controller, or null (the menu's own browser then)
    loadHostPicker(this.doc).then((Component) => {
      if (!Component || this.disposed) return;
      const picker = mountHostPicker(Component, {
        win: this.win, doc: this.doc,
        onSelect: (path) => this.openWorkspace(path).then(() => this.setWsMenuOpen(false)).catch((err) => { this.ctx.log.warn("open failed", err); }),
        onClose: () => { if (this.opener && this.opener.host) { this.opener = null; this.render(); } },
      });
      if (!picker) return;
      this.hostPicker = picker;
      this.disposers.push(() => picker.dispose());
      if (!this.doc.getElementById(STYLE_ID + "-hostpicker")) {
        const style = this.doc.createElement("style");
        style.id = STYLE_ID + "-hostpicker";
        style.textContent = HOST_PICKER_RAISE_CSS;
        this.doc.head.appendChild(style);
        this.disposers.push(() => style.remove());
      }
    });
    this.refresh();
    this.win.__kirocrewIde = Object.freeze({
      show: () => this.show(), hide: () => this.hide(), toggle: () => (this.shown ? this.hide() : this.show()),
      dock: (el) => this.dock(el), undock: () => this.undock(), exitFullscreen: () => this.exitFullscreen(),
      refresh: () => this.refresh(), state: () => this.state(), subscribe: (fn) => this.subscribe(fn),
      workspaces: () => this.workspaces(), activate: (folder) => this.activateWorkspace(folder),
      open: (folder) => this.openWorkspace(folder), close: (folder) => this.closeWorkspace(folder),
      sleepIdle: (now) => this.sleepIdle(now), setIdleUnload: (minutes) => this.setIdleUnload(minutes),
      checkWakes: (now) => this.checkWakes(now), wakeReloads: () => this.wakeReloads,
      stuck: () => this.stuck(), relaunch: () => this.relaunch(),
      // The browser's folder -> profile map and its report to the host (see the hook's association seed).
      associations: () => this.readAssociations(), reportAssociations: () => this.reportAssociations(),
      // The dashboard's own folder picker for "Open a folder…" (default on when the dashboard carries it);
      // `false` falls back to the menu's built-in path box and directory list.
      useHostPicker: (on) => { this.useHostPicker = on !== false; return !!(this.hostPicker && this.useHostPicker); },
      hasHostPicker: () => !!this.hostPicker,
      progress: (folder) => summarize(folder ? this.workspace(folder) : this.currentWorkspace()),
    });
  }

  dispose() {
    this.disposed = true;
    for (const off of this.disposers.splice(0)) off();
    this.dockEl = null;
    this.setMode("hidden");
    if (this.root) this.root.remove();
    this.root = null;
    this.frame = null;
    this.frames.clear();
    this.wakes.clear();
    this.activeFolder = null;
    const chip = this.doc.getElementById(CHIP_ID);
    if (chip) chip.remove();
    this.setAnchor(null);
    if (this.win.__kirocrewIde) delete this.win.__kirocrewIde;
  }

  state() {
    return { running: !!(this.status && this.status.running), shown: this.shown, mode: this.mode, docked: this.mode === "docked", host: this.hostLabel(), status: this.status,
      workspaces: this.workspaces(), activeFolder: this.activeFolder, asleep: [...this.asleep], idleUnloadMinutes: this.idleUnloadMinutes(),
      progress: summarize(this.currentWorkspace()) };
  }

  /** The workspace on screen (or the first open one before any was chosen). */
  currentWorkspace() {
    return this.workspace(this.activeFolder) || this.workspaces()[0] || null;
  }

  /** Minutes before an off-screen document is unloaded; the host's setting (status), 0 = never. */
  idleUnloadMinutes() {
    const raw = this.status && this.status.idleUnloadMinutes;
    return typeof raw === "number" && raw >= 0 ? raw : IDLE_DEFAULT_MIN;
  }

  async setIdleUnload(minutes) {
    const value = Math.max(0, Math.floor(Number(minutes) || 0));
    const reply = await this.post("settings/idle-unload", { minutes: value });
    if (reply && reply.ok) {
      if (this.status) this.status.idleUnloadMinutes = value;
      this.render();
      this.notify();
    }
    return reply;
  }

  /** The browser's folder -> profile map ({"<folder uri>": "<profile id>"}), or null when there is none to report. */
  readAssociations() {
    let raw = null;
    try { raw = this.win.localStorage.getItem(ASSOCIATIONS_KEY); } catch { return null; }
    if (!raw) return null;
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch { return null; }
    const workspaces = parsed && typeof parsed === "object" && parsed.workspaces;
    if (!workspaces || typeof workspaces !== "object" || Array.isArray(workspaces)) return null;
    const map = {};
    for (const key of Object.keys(workspaces).sort()) {
      if (typeof workspaces[key] === "string") map[key] = workspaces[key];
    }
    return Object.keys(map).length ? map : null;
  }

  scheduleAssociationReport() {
    if (this.disposed) return;
    if (this.associationsTimer) this.win.clearTimeout(this.associationsTimer);
    this.associationsTimer = this.win.setTimeout(() => { this.associationsTimer = null; this.reportAssociations(); }, ASSOCIATIONS_DEBOUNCE_MS);
  }

  /** POST the browser's map to the host (keyed by folder path there); skipped when nothing changed since the last accepted report. */
  async reportAssociations() {
    const map = this.readAssociations();
    if (!map) return null;
    const text = JSON.stringify(map);
    if (text === this.associationsSent) return null;
    const reply = await this.post("profiles/associations", { workspaces: map });
    if (reply && reply.ok) this.associationsSent = text;
    return reply;
  }

  /**
   * Drop the documents that have been off screen longer than the limit. A
   * document is off screen when it is not the active one, or when the layer
   * itself is hidden (the user is on another dashboard page); the stamp is set
   * where a frame leaves the screen and cleared where it comes back.
   */
  sleepIdle(now = Date.now()) {
    const minutes = this.idleUnloadMinutes();
    if (!minutes) return [];
    const limit = minutes * 60000;
    const dropped = [];
    for (const [folder, frame] of [...this.frames]) {
      const off = this.mode === "hidden" || frame.getAttribute("data-active") !== "true";
      const since = Number(frame.dataset.hiddenAt || 0);
      if (!off || !since || now - since < limit) continue;
      frame.remove();
      this.frames.delete(folder);
      this.asleep.add(folder);
      if (this.frame === frame) { this.frame = null; this.frameSrc = null; }
      dropped.push(folder);
    }
    if (dropped.length) { this.render(); this.notify(); }
    return dropped;
  }

  /** Stamp every frame that is not on screen; clear the one that is. */
  stampHidden(now = Date.now()) {
    for (const [folder, frame] of this.frames) {
      const off = this.mode === "hidden" || folder !== this.activeFolder;
      if (off) { if (!frame.dataset.hiddenAt) frame.dataset.hiddenAt = String(now); } else delete frame.dataset.hiddenAt;
    }
  }

  // -------------------------------------------------------------- workspaces

  /** The folders open on the engine, as `status` reports them: [{folder, name, embedUrl}]. */
  workspaces() {
    const rows = this.status && Array.isArray(this.status.workspaces) ? this.status.workspaces : [];
    return rows.filter((r) => r && r.folder && r.embedUrl);
  }

  workspace(folder) {
    return this.workspaces().find((r) => r.folder === folder) || null;
  }

  /** Bring one open workspace's document to the front (it stays warm either way). */
  activateWorkspace(folder) {
    if (!this.workspace(folder)) return false;
    this.activeFolder = folder;
    if (this.mode !== "hidden") this.ensureFrame();
    this.render();
    this.notify();
    return true;
  }

  /** One more folder on the same engine; its document is created and shown. */
  async openWorkspace(folder) {
    const reply = await this.post("workspaces/open", { folder });
    if (!reply.ok) throw new Error((reply.body && reply.body.error) || "open failed");
    await this.refresh();
    const match = this.workspaces().find((r) => r.folder === folder) || this.workspaces().find((r) => r.folder === reply.body.workspaces?.slice(-1)[0]?.folder);
    if (match) this.activateWorkspace(match.folder);
    return match ? match.folder : null;
  }

  /** Forget a workspace: its document goes, the others and the engine stay. */
  async closeWorkspace(folder) {
    const frame = this.frames.get(folder);
    if (frame) { frame.remove(); this.frames.delete(folder); }
    if (this.frame === frame) { this.frame = null; this.frameSrc = null; }
    if (this.activeFolder === folder) this.activeFolder = null;
    const reply = await this.post("workspaces/close", { folder });
    await this.refresh();
    if (!this.workspaces().length && this.mode === "fullscreen") this.exitFullscreen();
    return reply.ok;
  }

  async post(path, body) {
    let reply;
    try {
      reply = await this.fetch(API + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}), credentials: "same-origin" });
    } catch (err) {
      return { ok: false, body: { error: String(err && err.message || err) } };
    }
    let parsed = null;
    try { parsed = await reply.json(); } catch { parsed = null; }
    return { ok: reply.ok, body: parsed };
  }

  subscribe(fn) {
    this.subscribers.add(fn);
    fn(this.state());
    return () => this.subscribers.delete(fn);
  }

  notify() {
    const state = this.state();
    for (const fn of this.subscribers) {
      try { fn(state); } catch (err) { this.ctx.log.warn("subscriber threw", err); }
    }
    try { this.doc.dispatchEvent(new CustomEvent("kirocrew-ide:state", { detail: state })); } catch { /* no CustomEvent */ }
  }

  hostLabel() {
    return (this.status && this.status.host) || "this host";
  }

  // ------------------------------------------------------------------- status

  async refresh() {
    let body = null;
    try {
      const reply = await this.fetch(API + "status", { credentials: "same-origin" });
      if (reply.ok) body = await reply.json();
    } catch {
      body = null;
    }
    const wasRunning = !!(this.status && this.status.running);
    this.status = body;
    const running = !!(body && body.running);
    if (wasRunning && !running) {
      // Engine gone: every document is dead; drop them so the next start boots fresh.
      this.setMode("hidden");
      this.dropFrames();
    } else if (running && this.mode === "hidden" && this.dockConnected()) {
      // Started from the App page: the dock box was waiting for the engine.
      this.setMode("docked");
    }
    this.reconcileWorkspaces();
    if (running) this.checkWakes();
    this.renderStuck();
    this.placeChip();
    this.render();
    this.notify();
  }

  publishScheme() {
    const scheme = dashboardScheme(this.doc);
    if (scheme === this.lastScheme) return;
    this.lastScheme = scheme;
    this.fetch(API + "theme", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scheme }), credentials: "same-origin" }).catch(() => undefined);
  }

  // ---------------------------------------------------------------- the layer

  ensureStyle() {
    if (this.doc.getElementById(STYLE_ID)) return;
    const style = this.doc.createElement("style");
    style.id = STYLE_ID;
    style.textContent = CSS;
    this.doc.head.appendChild(style);
  }

  ensureRoot() {
    if (this.root && this.root.isConnected) return this.root;
    let root = this.doc.getElementById(LAYER_ID);
    if (!root) {
      root = this.doc.createElement("div");
      root.id = LAYER_ID;
      root.setAttribute("data-testid", "kirocrew-ide-layer");
      root.innerHTML =
        '<div class="kide-bar" role="toolbar" aria-label="KiroCrew IDE">' +
        '<button type="button" class="kide-btn" data-testid="kirocrew-ide-back" title="Back to KiroCrew (Esc)">◁ KiroCrew</button>' +
        '<div class="kide-hosts" data-testid="kirocrew-ide-hosts">' +
        '<button type="button" class="kide-btn kide-trigger" data-testid="kirocrew-ide-hosts-trigger" title="Switch KiroCrew host" aria-haspopup="menu" aria-expanded="false"></button>' +
        '<div class="kide-menu" data-testid="kirocrew-ide-hosts-menu" role="menu" hidden></div>' +
        "</div>" +
        '<div class="kide-ws" data-testid="kirocrew-ide-workspaces">' +
        '<button type="button" class="kide-btn kide-chip" data-testid="kirocrew-ide-tag" data-sub="true" aria-current="true" title="Workspaces on this IDE" aria-haspopup="menu" aria-expanded="false"></button>' +
        '<div class="kide-menu" data-testid="kirocrew-ide-workspaces-menu" role="menu" hidden></div>' +
        "</div>" +
        "</div>" +
        '<div class="kide-progress" data-testid="kirocrew-ide-progress" hidden>' +
        '<button type="button" class="kide-progress-btn" data-testid="kirocrew-ide-progress-trigger" aria-haspopup="dialog" aria-expanded="false"></button>' +
        '<div class="kide-menu" data-testid="kirocrew-ide-progress-menu" role="dialog" aria-label="Spec task progress" hidden></div>' +
        "</div>" +
        '<div class="kide-loading" data-testid="kirocrew-ide-loading" aria-live="polite"><img class="kide-fox" src="' + FOX + '" alt="" draggable="false"><div class="kide-shadow"></div><span>Loading the IDE…</span></div>' +
        '<div class="kide-stuck" data-testid="kirocrew-ide-stuck" role="alert" hidden><span class="kide-stuck-text"></span><button type="button" class="kide-btn kide-stuck-btn" data-testid="kirocrew-ide-relaunch">Relaunch engine</button></div>';
      this.doc.body.appendChild(root);
      root.querySelector('[data-testid="kirocrew-ide-relaunch"]').addEventListener("click", (event) => { event.stopPropagation(); this.relaunch(); });
      root.querySelector('[data-testid="kirocrew-ide-progress-trigger"]').addEventListener("click", (event) => {
        event.stopPropagation();
        this.setProgressOpen(!this.progressOpen);
      });
      root.querySelector(".kide-progress .kide-menu").addEventListener("click", (event) => event.stopPropagation());
      root.querySelector('[data-testid="kirocrew-ide-back"]').addEventListener("click", () => this.hide());
      root.querySelector('[data-testid="kirocrew-ide-hosts-trigger"]').addEventListener("click", (event) => {
        event.stopPropagation();
        this.setMenuOpen(!this.menuOpen);
      });
      root.querySelector(".kide-hosts .kide-menu").addEventListener("click", (event) => event.stopPropagation());
      root.querySelector('[data-testid="kirocrew-ide-tag"]').addEventListener("click", (event) => {
        event.stopPropagation();
        this.setWsMenuOpen(!this.wsMenuOpen);
      });
      root.querySelector(".kide-ws .kide-menu").addEventListener("click", (event) => event.stopPropagation());
      // A clipped folder name scrolls sideways. The wheel works anywhere on the chip (the name's
      // own box is a few pixels wide under a tight budget) and a mouse wheel's vertical delta
      // counts as horizontal; resting the pointer on the chip glides the name to its end and
      // leaving glides it back, so the whole name can be read without scrolling at all. Registered
      // once here: the tag's children are rebuilt on every render, the tag itself is not.
      const tag = root.querySelector('[data-testid="kirocrew-ide-tag"]');
      tag.addEventListener("wheel", (event) => {
        const name = this.nameEl();
        if (!name || name.scrollWidth - name.clientWidth <= 1) return;
        const delta = Math.abs(event.deltaX) >= Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
        if (!delta) return;
        event.preventDefault();
        event.stopPropagation();
        this.glideToken = (this.glideToken || 0) + 1; // a glide in flight yields to the hand
        this.wsNameGlide = null;
        name.scrollLeft += delta;
        this.wsNameScroll = name.scrollLeft;
      }, { passive: false });
      tag.addEventListener("mouseenter", () => {
        const name = this.nameEl();
        if (!name || name.scrollWidth - name.clientWidth <= 1) return;
        this.wsNameGlide = "end";
        this.glideName(name.scrollWidth - name.clientWidth);
      });
      tag.addEventListener("mouseleave", () => {
        if (this.wsNameGlide !== "end") return;
        this.wsNameGlide = null;
        this.glideName(0);
      });
    }
    this.root = root;
    return root;
  }

  /** The folder-name span in the tag, whichever render built it. */
  nameEl() {
    return this.root ? this.root.querySelector(".kide-chip .kide-ws-name") : null;
  }

  /**
   * The active workspace's document, created on first need. Every open
   * workspace keeps its own iframe (created when first shown, never reloaded
   * by a switch); only the active one is displayed. `this.frame` is the
   * active one, for the theme reader and the probes.
   */
  ensureFrame() {
    const root = this.ensureRoot();
    if (!(this.status && this.status.running)) return null;
    const rows = this.workspaces();
    if (!rows.length) {
      // Engine up, nothing open (every workspace closed): no document to show.
      this.frame = null;
      this.frameSrc = null;
      root.setAttribute("data-ready", "true");
      return null;
    }
    if (!this.activeFolder || !this.workspace(this.activeFolder)) this.activeFolder = rows[0].folder;
    const row = this.workspace(this.activeFolder);
    const src = withScheme(row.embedUrl, dashboardScheme(this.doc));
    let frame = this.frames.get(row.folder);
    if (frame && (!frame.isConnected || (frame.dataset.src || "").split("?")[0] !== src.split("?")[0])) {
      frame.remove();
      this.frames.delete(row.folder);
      frame = null;
    }
    if (!frame) {
      frame = this.doc.createElement("iframe");
      frame.src = src;
      frame.dataset.src = src;
      frame.dataset.folder = row.folder;
      frame.title = "KiroCrew IDE — " + row.name;
      frame.setAttribute("allow", "clipboard-read; clipboard-write");
      frame.setAttribute("data-ready", "false");
      const cap = this.win.setTimeout(() => this.frameReady(frame), 20000);
      frame.addEventListener("load", () => {
        injectLetterpressStyle(frame);
        this.win.setTimeout(() => { this.frameReady(frame); this.win.clearTimeout(cap); }, 1200);
      });
      root.appendChild(frame);
      this.frames.set(row.folder, frame);
      this.asleep.delete(row.folder); // shown again: awake (a fresh document, reconnecting)
      this.armWake(frame);
    }
    for (const [folder, other] of this.frames) other.setAttribute("data-active", folder === row.folder ? "true" : "false");
    this.stampHidden();
    root.setAttribute("data-ready", frame.getAttribute("data-ready") === "true" ? "true" : "false");
    this.frame = frame;
    this.frameSrc = src;
    return frame;
  }

  frameReady(frame) {
    frame.setAttribute("data-ready", "true");
    if (frame === this.frame && this.root) this.root.setAttribute("data-ready", "true");
  }

  /** The host's count of WebSocket bridges that reached the engine, or null when status does not carry it (direct-port mode, older hook). */
  wsOpened() {
    const ws = this.status && this.status.proxy && this.status.proxy.websockets;
    return ws && typeof ws.opened === "number" ? ws.opened : null;
  }

  /** Start the wake guard for a document just created: remember the count it must raise. */
  armWake(frame) {
    const opened = this.wsOpened();
    if (opened === null) return;
    this.wakes.set(frame, { opened, at: Date.now(), reloaded: false });
    frame.setAttribute("data-wake", "pending");
  }

  /**
   * Called on every status poll: a fresh document whose budget has passed with
   * the host's bridge count unchanged never reached the engine; reload it once.
   * A count that rose clears the guard (some document connected — with several
   * waking at once that is the best a host-wide counter can tell, and a stuck
   * sibling is caught by its own next wake).
   */
  checkWakes(now = Date.now()) {
    const opened = this.wsOpened();
    if (opened === null) return [];
    const reloaded = [];
    for (const [frame, wake] of [...this.wakes]) {
      if (!frame.isConnected) { this.wakes.delete(frame); continue; }
      if (opened > wake.opened) { this.wakes.delete(frame); frame.setAttribute("data-wake", "connected"); continue; }
      if (now - wake.at < WAKE_BUDGET_MS) continue;
      if (wake.reloaded) { this.wakes.delete(frame); frame.setAttribute("data-wake", "failed"); continue; }
      wake.reloaded = true;
      wake.at = now;
      wake.opened = opened;
      this.wakeReloads += 1;
      frame.setAttribute("data-wake", "reloaded");
      frame.setAttribute("data-ready", "false");
      if (frame === this.frame && this.root) this.root.setAttribute("data-ready", "false");
      this.ctx.log.warn("KiroCrew IDE: document for " + frame.dataset.folder + " never reached the engine within " + WAKE_BUDGET_MS / 1000 + "s; reloading it once");
      // Re-assign src rather than contentWindow.location.reload(): works whatever the frame's document state is.
      try { frame.src = frame.dataset.src; } catch { /* detached */ }
      reloaded.push(frame.dataset.folder);
    }
    return reloaded;
  }

  /** The host's verdict on the engine (status.health): stuck = it serves HTML but accepts no workbench connection. */
  stuck() {
    const health = this.status && this.status.health;
    return !!(this.status && this.status.running && health && health.stuck);
  }

  /**
   * Over a document the engine will never service, the fox would bounce
   * forever (or the page sit blank): show the host's reason and the one cure
   * instead. Hidden again the moment status stops reporting the condition.
   */
  renderStuck() {
    if (!this.root) return;
    const box = this.root.querySelector(".kide-stuck");
    if (!box) return;
    const stuck = this.stuck() && this.mode !== "hidden";
    this.root.setAttribute("data-stuck", stuck ? "true" : "false");
    box.hidden = !stuck;
    if (stuck) box.querySelector(".kide-stuck-text").textContent = "The IDE engine looks stuck: " + (this.status.health.reason || "it accepts no connection.");
    box.querySelector(".kide-stuck-btn").disabled = !!this.relaunching;
  }

  /** Stop and start the engine with the same workspaces; every document is rebuilt against the new one. */
  async relaunch() {
    if (this.relaunching) return null;
    this.relaunching = true;
    this.renderStuck();
    let reply;
    try {
      reply = await this.post("relaunch", {});
    } finally {
      this.relaunching = false;
    }
    if (reply && reply.ok) {
      // The old engine's documents are dead: rebuild them against the new one.
      const active = this.activeFolder;
      for (const frame of this.frames.values()) frame.remove();
      this.frames.clear();
      this.wakes.clear();
      this.activeFolder = active;
      this.frame = null;
      this.frameSrc = null;
    }
    await this.refresh();
    return reply;
  }

  dropFrames() {
    for (const frame of this.frames.values()) frame.remove();
    this.frames.clear();
    this.wakes.clear();
    this.asleep.clear();
    this.frame = null;
    this.frameSrc = null;
    this.activeFolder = null;
  }

  /** `status` is the truth for what is open: drop documents of workspaces closed elsewhere, keep the active one valid. */
  reconcileWorkspaces() {
    const open = new Set(this.workspaces().map((r) => r.folder));
    for (const [folder, frame] of [...this.frames]) {
      if (open.has(folder)) continue;
      frame.remove();
      this.frames.delete(folder);
      if (this.frame === frame) { this.frame = null; this.frameSrc = null; }
    }
    for (const folder of [...this.asleep]) if (!open.has(folder)) this.asleep.delete(folder);
    if (this.activeFolder && !open.has(this.activeFolder)) this.activeFolder = null;
    if (this.mode !== "hidden") this.ensureFrame();
  }

  // ------------------------------------------------------------------- modes

  /** Raise the IDE over KiroCrew. */
  show() {
    if (!(this.status && this.status.running)) return false;
    this.setMode("fullscreen");
    if (!this.workspaces().length) {
      // Engine up with nothing open: the only useful thing on screen is the opener.
      this.setWsMenuOpen(true);
      this.startOpener();
    }
    return true;
  }

  /**
   * Begin "Open a folder…": the dashboard's own picker when it is mounted
   * (anchored under the IDE tag, over the fullscreen layer), otherwise the
   * menu's built-in path box and directory list.
   */
  startOpener() {
    if (this.hostPicker && this.useHostPicker !== false) {
      this.opener = { host: true, path: "", listing: null, error: null, busy: false };
      this.render();
      const tag = this.root && this.root.querySelector('[data-testid="kirocrew-ide-tag"]');
      const rect = tag ? tag.getBoundingClientRect() : { top: 0, bottom: 30, left: 84, right: 484, width: 400, height: 30 };
      this.hostPicker.open(rect);
      return;
    }
    this.opener = { path: "", listing: null, error: null, busy: false };
    this.render();
    this.browse("~");
    const input = this.root && this.root.querySelector(".kide-open input");
    if (input) input.focus();
  }

  /**
   * Leave fullscreen: onto the App page's dock when that page is open,
   * otherwise off the screen (the frame stays mounted and warm).
   */
  hide() {
    if (!this.shown) return;
    this.setMode(this.dockConnected() ? "docked" : "hidden");
  }

  /**
   * The App page registers its dock box: the IDE is shown inside it (unless the
   * layer is fullscreen right now, which then lands here on the way out). An
   * engine that is not running yet is picked up by `refresh` when it starts.
   */
  dock(el) {
    if (!el) return;
    const changed = this.dockEl !== el;
    this.dockEl = el;
    if (this.mode === "fullscreen") return;
    if (this.mode === "docked") { if (changed) this.trackDock(); return; }
    if (this.status && this.status.running) this.setMode("docked");
  }

  /** The App page unmounted: a docked IDE goes off screen; a fullscreen one stays up. */
  undock() {
    this.dockEl = null;
    if (this.mode === "docked") this.setMode("hidden");
  }

  /**
   * API only (`window.__kirocrewIde.exitFullscreen()`; the bar has no button
   * for it) — back to the App page with the IDE docked in it. With
   * the page already open that is one mode change; otherwise the dashboard is
   * navigated there (the SPA router follows a history push + popstate) and the
   * page docks the layer as it mounts.
   */
  exitFullscreen() {
    if (this.dockConnected()) { this.setMode("docked"); return; }
    this.setMode("hidden");
    const path = this.win.location && this.win.location.pathname;
    if (path !== APP_ROUTE && this.win.history && typeof this.win.history.pushState === "function") {
      this.win.history.pushState({}, "", APP_ROUTE);
      this.win.dispatchEvent(new PopStateEvent("popstate"));
    }
  }

  dockConnected() {
    return !!(this.dockEl && this.dockEl.isConnected);
  }

  setMode(mode) {
    if (mode !== "hidden") this.ensureFrame();
    if (!this.root && mode === "hidden") { this.mode = mode; this.shown = false; return; }
    const root = this.ensureRoot();
    const previous = this.mode;
    if (previous === mode) return;
    this.mode = mode;
    this.shown = mode === "fullscreen";
    this.stampHidden(); // hidden: every document is off screen from now; shown: the active one is back
    this.setMenuOpen(false);
    this.setWsMenuOpen(false);
    this.setProgressOpen(false);
    root.setAttribute("data-mode", mode);
    root.setAttribute("data-shown", mode === "hidden" ? "false" : "true");
    if (mode === "fullscreen") {
      this.previousOverflow = this.doc.body.style.overflow;
      this.doc.body.style.overflow = "hidden";
    } else if (previous === "fullscreen") {
      this.doc.body.style.overflow = this.previousOverflow || "";
    }
    if (mode === "docked") this.trackDock(); else this.untrackDock();
    this.placeChip();
    this.render();
    this.notify();
  }

  /** Follow the dock box's rectangle while docked: its size, page scroll, viewport resizes and layout shifts. */
  trackDock() {
    this.untrackDock();
    const place = () => this.placeDocked();
    if (typeof this.win.ResizeObserver === "function" && this.dockEl) {
      const ro = new this.win.ResizeObserver(place);
      ro.observe(this.dockEl);
      this.dockDisposers.push(() => ro.disconnect());
    }
    this.win.addEventListener("resize", place);
    this.doc.addEventListener("scroll", place, true);
    const poll = this.win.setInterval(place, DOCK_POLL_MS);
    this.dockDisposers.push(() => this.win.removeEventListener("resize", place), () => this.doc.removeEventListener("scroll", place, true), () => this.win.clearInterval(poll));
    place();
  }

  untrackDock() {
    for (const off of this.dockDisposers.splice(0)) off();
    if (this.root) for (const key of ["top", "left", "width", "height"]) this.root.style[key] = "";
  }

  placeDocked() {
    if (this.mode !== "docked" || !this.root) return;
    if (!this.dockConnected()) { this.undock(); return; }
    const r = this.dockEl.getBoundingClientRect();
    const s = this.root.style;
    s.top = r.top + "px";
    s.left = r.left + "px";
    s.width = r.width + "px";
    s.height = r.height + "px";
  }

  /**
   * Keep the bar clear of the workbench's own title-bar centre (the ← → arrows
   * and the command centre), whose left edge moves with the window width. The
   * bar's right edge is set to that edge; the flex row then shrinks the folder
   * name (the only elastic piece) and `updateClip` fades its cut edge.
   */
  fitBar(width = this.win.innerWidth || this.doc.documentElement.clientWidth) {
    if (!this.root) return;
    const bar = this.root.querySelector(".kide-bar");
    if (!bar || !width) return;
    const edge = this.mode === "fullscreen" ? workbenchCentreLeft(this.frame) : null;
    // While a document is still loading the centre part is not readable yet: keep the last
    // measured edge (the window is the same), and with none known leave the bar unclamped.
    if (edge !== null) this.centreEdge = { edge, width };
    const known = this.centreEdge && this.centreEdge.width === width ? this.centreEdge.edge : null;
    const right = known !== null ? Math.max(140, Math.round(width - known + 10)) : 140;
    if (bar.style.right !== right + "px") bar.style.right = right + "px";
    this.updateClip();
  }

  /**
   * Keep the task indicator clear of the workbench's own title-bar RIGHT part
   * (the layout-control buttons), whose left edge moves with the window width:
   * the indicator's right edge is set a gap left of it, measured from the live
   * document in both modes (the frame fills the layer either way). While a
   * document is still loading the last measurement for this width stands, and
   * with none known the fallback clears the four buttons on any width.
   */
  fitProgress() {
    const wrap = this.root && this.root.querySelector(".kide-progress");
    if (!wrap || this.mode === "hidden") return;
    const frame = this.frame;
    const width = frame ? frame.clientWidth || 0 : 0;
    const edge = width ? workbenchRightLeft(frame) : null;
    if (edge !== null) this.rightEdge = { edge, width };
    const known = this.rightEdge && width && this.rightEdge.width === width ? this.rightEdge.edge : null;
    const right = known !== null ? Math.max(PROGRESS_GAP, Math.round(width - known + PROGRESS_GAP)) : PROGRESS_RIGHT_FALLBACK;
    if (wrap.style.right !== right + "px") wrap.style.right = right + "px";
  }

  /**
   * Slide the folder name to `left` (~3 ms per px, 0.3–1.5 s, eased) with requestAnimationFrame,
   * jumping where rAF is missing. Each frame looks the span up again, so a render that rebuilt
   * the tag mid-glide (the new span starts at the carried-over position) does not strand it.
   */
  glideName(left) {
    const name = this.nameEl();
    if (!name) return;
    const raf = this.win.requestAnimationFrame ? this.win.requestAnimationFrame.bind(this.win) : null;
    const from = name.scrollLeft;
    const distance = left - from;
    if (!raf || !distance) { name.scrollLeft = left; this.wsNameScroll = left; return; }
    const duration = Math.min(1500, Math.max(300, Math.abs(distance) * 3));
    const clock = () => (this.win.performance && this.win.performance.now()) || Date.now();
    const start = clock();
    const token = this.glideToken = (this.glideToken || 0) + 1;
    const step = () => {
      if (token !== this.glideToken) return;
      const el = this.nameEl();
      if (!el) return;
      const t = Math.min(1, (clock() - start) / duration);
      const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      el.scrollLeft = from + distance * eased;
      this.wsNameScroll = el.scrollLeft;
      if (t < 1) raf(step);
    };
    raf(step);
  }

  /** Mark which edge(s) of the folder name are cut off, for the fade mask. */
  updateClip() {
    const name = this.root && this.root.querySelector(".kide-chip .kide-ws-name");
    if (!name) return;
    const over = name.scrollWidth - name.clientWidth > 1;
    let clipped = "none";
    if (over) {
      const atStart = name.scrollLeft <= 1;
      const atEnd = name.scrollLeft + name.clientWidth >= name.scrollWidth - 1;
      clipped = atStart ? "end" : atEnd ? "start" : "both";
    }
    if (name.dataset.clipped !== clipped) name.dataset.clipped = clipped;
  }

  readTheme() {
    if (this.mode === "hidden" || !this.frame) return;
    this.fitBar();
    this.fitProgress();
    const next = readWorkbenchTheme(this.frame);
    if (!next || (this.theme && this.theme.bg === next.bg && this.theme.fg === next.fg)) return;
    this.theme = next;
    const s = this.root.style;
    s.setProperty("--kide-titlebar", next.titleBar);
    s.setProperty("--kide-bg", next.bg);
    s.setProperty("--kide-fg", next.fg);
    s.setProperty("--kide-muted", next.muted || next.fg);
    s.setProperty("--kide-badge-bg", next.badgeBg || next.accent);
    s.setProperty("--kide-badge-fg", next.badgeFg || "#fff");
    s.setProperty("--kide-accent-text", next.accentText || next.accent);
    s.setProperty("--kide-border", next.border);
    s.setProperty("--kide-hover", next.hover);
    s.setProperty("--kide-accent", next.accent);
    s.setProperty("--kide-accent-bg", next.hover);
    s.setProperty("--kide-done", next.done);
    s.setProperty("--kide-active", next.active);
    // The host menu wears the workbench's own menu colours.
    s.setProperty("--kide-menu-bg", next.menuBg);
    s.setProperty("--kide-menu-fg", next.menuFg);
    s.setProperty("--kide-menu-border", next.menuBorder);
    s.setProperty("--kide-menu-hover", next.menuHover);
    s.setProperty("--kide-menu-hover-fg", next.menuHoverFg);
  }

  setMenuOpen(open) {
    if (!this.root) return;
    this.menuOpen = !!open;
    if (this.menuOpen) { this.setWsMenuOpen(false); this.setProgressOpen(false); }
    const menu = this.root.querySelector(".kide-hosts .kide-menu");
    const trigger = this.root.querySelector(".kide-trigger");
    if (menu) menu.hidden = !this.menuOpen;
    if (trigger) trigger.setAttribute("aria-expanded", this.menuOpen ? "true" : "false");
    if (this.menuOpen) this.render();
  }

  /** The task indicator's popover: the combined figure and the per-spec breakdown. */
  setProgressOpen(open) {
    if (!this.root) return;
    const next = !!open;
    if (next) { this.setMenuOpen(false); this.setWsMenuOpen(false); }
    if (this.progressOpen === next) return;
    this.progressOpen = next;
    const menu = this.root.querySelector(".kide-progress .kide-menu");
    const trigger = this.root.querySelector(".kide-progress-btn");
    if (menu) menu.hidden = !next;
    if (trigger) trigger.setAttribute("aria-expanded", next ? "true" : "false");
    if (next) this.renderProgressMenu();
  }

  /** The IDE tag's dropdown: the open workspaces, and a form to open one more. */
  setWsMenuOpen(open) {
    if (!this.root) return;
    const next = !!open;
    if (next) { this.setMenuOpen(false); this.setProgressOpen(false); }
    this.wsMenuOpen = next;
    if (!next) { this.opener = null; if (this.hostPicker) this.hostPicker.close(); }
    const menu = this.root.querySelector(".kide-ws .kide-menu");
    const tag = this.root.querySelector('[data-testid="kirocrew-ide-tag"]');
    if (menu) menu.hidden = !next;
    if (tag) tag.setAttribute("aria-expanded", next ? "true" : "false");
    if (next) this.render();
  }

  /** The crews this document can see right now. */
  crewEntries() {
    if (this.embedded) return { entries: this.hostModel ? entriesFor(this.hostModel) : [], activeId: this.hostModel ? this.hostModel.activeId : null };
    const local = localEntries(this.doc);
    const active = local.find((e) => e.active);
    return { entries: local, activeId: active ? active.id : null };
  }

  /**
   * The bar: "◁ KiroCrew", a host dropdown (trigger = the crew on screen; menu =
   * every destination, the current host's row marked as "here") with the lit
   * "IDE" segment joined to it. A dropdown rather than
   * a chip row so a long crew list can never grow into the workbench's command
   * centre (search box) in the middle of the title bar.
   */
  render() {
    if (!this.root) return;
    const trigger = this.root.querySelector(".kide-trigger");
    const menu = this.root.querySelector(".kide-menu");
    const tag = this.root.querySelector('[data-testid="kirocrew-ide-tag"]');
    if (!trigger || !menu || !tag) return;
    const { entries, activeId } = this.crewEntries();
    const rows = stackEntries({ entries, activeId, host: this.hostLabel() });
    const here = rows.find((r) => r.kind === "here");
    const ide = rows.find((r) => r.kind === "ide");
    // Trigger: the current host, with its state dot and a caret.
    trigger.textContent = "";
    const dot = this.doc.createElement("span");
    dot.className = "kide-dot";
    dot.style.background = dotColour(here.state);
    trigger.appendChild(dot);
    const name = this.doc.createElement("span");
    name.className = "kide-name";
    name.textContent = here.label;
    trigger.appendChild(name);
    const caret = this.doc.createElement("span");
    caret.className = "kide-caret";
    caret.textContent = "▾";
    trigger.appendChild(caret);
    // Tag: where you are — the "IDE" segment hanging off the host trigger,
    // `[host ▾]IDE · folder ▾]`; it opens the workspace dropdown.
    const spaces = this.workspaces();
    const current = this.workspace(this.activeFolder) || spaces[0] || null;
    tag.innerHTML = GLYPH;
    tag.appendChild(this.doc.createTextNode("IDE"));
    if (current) {
      const name = this.doc.createElement("span");
      name.className = "kide-ws-name";
      name.textContent = "· " + current.name;
      name.addEventListener("scroll", () => { this.wsNameScroll = name.scrollLeft; this.updateClip(); }, { passive: true });
      tag.appendChild(name);
      // The tag is rebuilt on every render (status poll): the scroll position carries over, and a
      // glide in flight keeps going on the new node (glideName looks the element up per frame).
      if (this.wsNameScroll) name.scrollLeft = this.wsNameScroll;
    }
    if (spaces.length > 1) {
      const count = this.doc.createElement("span");
      count.className = "kide-count";
      count.textContent = String(spaces.length);
      count.title = spaces.length + " workspaces open";
      tag.appendChild(count);
    }
    const wsCaret = this.doc.createElement("span");
    wsCaret.className = "kide-caret";
    wsCaret.textContent = "▾";
    tag.appendChild(wsCaret);
    tag.title = ide.label + " — " + ide.detail + (current ? "\n" + current.folder : "") + "\nWorkspaces: switch, close, open another";
    tag.setAttribute("aria-label", ide.label + (current ? ", " + current.name : "") + ", workspaces");
    this.fitBar();
    this.renderWorkspaceMenu();
    this.renderProgress();
    // Menu rows: Local first, then the crews; the current host marked.
    menu.textContent = "";
    let index = 0;
    for (const row of rows) {
      if (row.kind === "ide") continue;
      if (index === 1 && rows[0].id === null) {
        const sep = this.doc.createElement("div");
        sep.className = "kide-sep";
        menu.appendChild(sep);
      }
      index += 1;
      const item = this.doc.createElement("button");
      item.type = "button";
      item.className = "kide-row";
      item.setAttribute("role", "menuitemradio");
      item.setAttribute("data-kind", row.kind);
      item.setAttribute("aria-checked", row.kind === "here" ? "true" : "false");
      item.title = row.kind === "here" ? row.label + " — back to its dashboard" : "switch to " + row.label + (row.detail ? " (" + row.detail + ")" : "");
      if (row.kind === "here") {
        item.insertAdjacentHTML("afterbegin", HOME);
      } else {
        const d = this.doc.createElement("span");
        d.className = "kide-dot";
        d.style.background = dotColour(row.state);
        item.appendChild(d);
      }
      const text = this.doc.createElement("span");
      text.className = "kide-text";
      const label = this.doc.createElement("span");
      label.textContent = row.label;
      text.appendChild(label);
      const detail = this.doc.createElement("span");
      detail.className = "kide-detail";
      detail.textContent = row.kind === "here" ? "you are here — open its dashboard" : row.detail;
      if (detail.textContent) text.appendChild(detail);
      item.appendChild(text);
      if (row.unread > 0) {
        const badge = this.doc.createElement("span");
        badge.className = "kide-badge";
        badge.textContent = row.unread > 99 ? "99+" : String(row.unread);
        item.appendChild(badge);
      }
      if (row.state && row.state !== "connected" && row.kind === "crew") {
        const word = this.doc.createElement("span");
        word.className = "kide-word";
        word.textContent = row.state;
        item.appendChild(word);
      }
      item.addEventListener("click", () => { this.setMenuOpen(false); this.pick(row); });
      menu.appendChild(item);
    }
  }

  /** A menu row was picked. */
  pick(row) {
    if (row.kind === "ide") return;
    if (row.kind === "here") { this.hide(); return; }
    if (this.embedded) switchTo(row.id, this.win);
    else clickLocalChip(row.label, this.doc);
  }

  /**
   * The workspace dropdown: one row per open folder (the one on screen marked,
   * each with a close ×), then "Open a folder…", which unfolds a small picker
   * right in the menu — recent workspaces and the engine-side directory list
   * from `browse` — so another project opens without leaving fullscreen.
   */
  renderWorkspaceMenu() {
    const menu = this.root && this.root.querySelector(".kide-ws .kide-menu");
    if (!menu || !this.wsMenuOpen) return;
    // Rows are rebuilt; the opener's box (with the user's caret in it) is kept in place.
    const keep = this.opener && this.opener.box && this.opener.box.parentNode === menu ? this.opener.box : null;
    for (const child of [...menu.children]) if (child !== keep) child.remove();
    const add = (el) => (keep ? menu.insertBefore(el, keep) : menu.appendChild(el));
    const spaces = this.workspaces();
    const current = this.workspace(this.activeFolder) || spaces[0] || null;
    for (const row of spaces) {
      const item = this.doc.createElement("div");
      item.className = "kide-row";
      item.setAttribute("role", "menuitemradio");
      item.setAttribute("data-kind", "workspace");
      item.setAttribute("data-folder", row.folder);
      item.setAttribute("aria-checked", current && current.folder === row.folder ? "true" : "false");
      item.tabIndex = 0;
      item.title = row.folder;
      item.insertAdjacentHTML("afterbegin", GLYPH);
      const text = this.doc.createElement("span");
      text.className = "kide-text";
      const label = this.doc.createElement("span");
      label.textContent = row.name;
      text.appendChild(label);
      const detail = this.doc.createElement("span");
      detail.className = "kide-detail";
      detail.textContent = row.folder;
      text.appendChild(detail);
      item.appendChild(text);
      const rowProgress = summarize(row);
      if (rowProgress) {
        const mini = this.doc.createElement("span");
        mini.className = "kide-mini";
        mini.setAttribute("data-testid", "kirocrew-ide-ws-progress");
        mini.innerHTML = donutMarkup(rowProgress, { size: 12, stroke: 2 });
        mini.appendChild(this.doc.createTextNode(rowProgress.pct + "%"));
        mini.title = "Spec tasks: " + progressLabel(rowProgress);
        item.appendChild(mini);
      }
      if (this.asleep.has(row.folder)) {
        const word = this.doc.createElement("span");
        word.className = "kide-word";
        word.textContent = "asleep";
        word.title = "Unloaded after sitting off screen; switching to it reconnects";
        item.setAttribute("data-asleep", "true");
        item.appendChild(word);
      }
      const close = this.doc.createElement("button");
      close.type = "button";
      close.className = "kide-x";
      close.textContent = "×";
      close.title = "Close " + row.name + " (the engine keeps running)";
      close.setAttribute("aria-label", "Close workspace " + row.name);
      close.addEventListener("click", (event) => { event.stopPropagation(); this.closeWorkspace(row.folder).then(() => this.render()); });
      item.appendChild(close);
      const choose = () => { this.setWsMenuOpen(false); this.activateWorkspace(row.folder); };
      item.addEventListener("click", choose);
      item.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); choose(); } });
      add(item);
    }
    if (spaces.length) {
      const sep = this.doc.createElement("div");
      sep.className = "kide-sep";
      add(sep);
    }
    if (!this.opener) {
      const open = this.doc.createElement("button");
      open.type = "button";
      open.className = "kide-row";
      open.setAttribute("role", "menuitem");
      open.setAttribute("data-kind", "open");
      open.setAttribute("data-testid", "kirocrew-ide-open-folder");
      open.textContent = "Open a folder…";
      open.addEventListener("click", () => this.startOpener());
      add(open);
    } else if (!this.opener.host) {
      const box = this.renderOpener();
      if (box.parentNode !== menu) menu.appendChild(box);
    }
    menu.appendChild(this.renderIdleControl());
  }

  /**
   * The task indicator for the workspace on screen: a tiny donut and the
   * percentage, hidden when that workspace has no spec task at all. Painted on
   * every render (the status poll carries fresh counts) and placed by
   * `fitProgress`.
   */
  renderProgress() {
    const wrap = this.root && this.root.querySelector(".kide-progress");
    const trigger = wrap && wrap.querySelector(".kide-progress-btn");
    if (!wrap || !trigger) return;
    const current = this.currentWorkspace();
    const p = summarize(current);
    if (!p || this.mode === "hidden") {
      if (!wrap.hidden) wrap.hidden = true;
      if (this.progressOpen) this.setProgressOpen(false);
      return;
    }
    wrap.hidden = false;
    wrap.setAttribute("data-folder", current.folder);
    wrap.setAttribute("data-pct", String(p.pct));
    trigger.innerHTML = donutMarkup(p, { size: 16, stroke: 2.5 });
    const pctEl = this.doc.createElement("span");
    pctEl.className = "kide-pct";
    pctEl.textContent = p.pct + "%";
    trigger.appendChild(pctEl);
    const lines = p.specs.map((s) => "  " + s.name + ": " + s.done + "/" + s.total + " (" + s.pct + "%)");
    trigger.title = "Spec tasks in " + current.name + " — " + progressLabel(p) + (lines.length ? "\n" + lines.join("\n") : "") + "\nClick for the breakdown";
    trigger.setAttribute("aria-label", "Spec tasks " + p.pct + " percent complete, " + p.done + " of " + p.total + "; breakdown");
    this.fitProgress();
    if (this.progressOpen) this.renderProgressMenu();
  }

  /**
   * The breakdown under the indicator: the combined figure (a larger donut,
   * the percentage, the counts and Kiro's live states), then one row per spec
   * directory with its own donut and counts — the combined number is their
   * sum, so the rows are what it is made of. Closes by itself when the
   * workspace loses its tasks.
   */
  renderProgressMenu() {
    const menu = this.root && this.root.querySelector(".kide-progress .kide-menu");
    if (!menu || !this.progressOpen) return;
    const current = this.currentWorkspace();
    const p = summarize(current);
    menu.textContent = "";
    if (!p) { this.setProgressOpen(false); return; }
    const head = this.doc.createElement("div");
    head.className = "kide-prog-head";
    head.setAttribute("data-testid", "kirocrew-ide-progress-head");
    head.innerHTML = donutMarkup(p, { size: 28, stroke: 4 });
    const text = this.doc.createElement("span");
    text.className = "kide-text";
    const title = this.doc.createElement("span");
    title.textContent = p.pct + "% complete";
    text.appendChild(title);
    const detail = this.doc.createElement("span");
    detail.className = "kide-detail";
    const parts = [p.done + "/" + p.total + (p.total === 1 ? " task" : " tasks") + (p.specs.length > 1 ? " across " + p.specs.length + " specs" : p.specs.length === 1 ? " in " + p.specs[0].name : "")];
    if (p.inProgress) parts.push(p.inProgress + " running");
    if (p.queued) parts.push(p.queued + " queued");
    if (p.optional) parts.push(p.optional + " optional");
    detail.textContent = parts.join(" · ");
    text.appendChild(detail);
    const where = this.doc.createElement("span");
    where.className = "kide-detail";
    where.textContent = current.folder;
    text.appendChild(where);
    head.appendChild(text);
    menu.appendChild(head);
    if (p.specs.length) {
      const sep = this.doc.createElement("div");
      sep.className = "kide-sep";
      menu.appendChild(sep);
    }
    for (const spec of p.specs) {
      const row = this.doc.createElement("div");
      row.className = "kide-prog-row";
      row.setAttribute("data-testid", "kirocrew-ide-progress-spec");
      row.setAttribute("data-spec", spec.name);
      row.title = spec.tasks || spec.dir || spec.name;
      row.innerHTML = donutMarkup(spec, { size: 14, stroke: 2.5 });
      const t = this.doc.createElement("span");
      t.className = "kide-text";
      const name = this.doc.createElement("span");
      name.textContent = spec.name;
      t.appendChild(name);
      const states = [];
      if (spec.inProgress) states.push(spec.inProgress + " running");
      if (spec.queued) states.push(spec.queued + " queued");
      if (spec.optional) states.push(spec.optional + " optional");
      if (states.length) {
        const d = this.doc.createElement("span");
        d.className = "kide-detail";
        d.textContent = states.join(" · ");
        t.appendChild(d);
      }
      row.appendChild(t);
      const nums = this.doc.createElement("span");
      nums.className = "kide-nums";
      nums.textContent = spec.done + "/" + spec.total;
      row.appendChild(nums);
      const pctEl = this.doc.createElement("span");
      pctEl.className = "kide-pct";
      pctEl.textContent = spec.pct + "%";
      row.appendChild(pctEl);
      menu.appendChild(row);
    }
    const foot = this.doc.createElement("div");
    foot.className = "kide-prog-foot";
    foot.textContent = "Counted from the boxes in .kiro/specs/*/tasks.md — every box, optional (*) ones included.";
    menu.appendChild(foot);
  }

  /**
   * The menu's footer: how long an off-screen workspace stays warm before its
   * document is unloaded. A host-wide setting (every client shares it), so it
   * lives here next to the workspaces it governs rather than on a settings page.
   */
  renderIdleControl() {
    const sep = this.doc.createElement("div");
    sep.className = "kide-sep";
    const row = this.doc.createElement("div");
    row.className = "kide-idle";
    row.setAttribute("data-testid", "kirocrew-ide-idle-control");
    const label = this.doc.createElement("label");
    label.textContent = "Sleep inactive workspaces after";
    label.title = "An off-screen workspace keeps a full workbench alive on this computer and an extension host on the engine's host. After this long it is unloaded (its tab stays; switching back reconnects in a few seconds). Shared by every client of this host.";
    const select = this.doc.createElement("select");
    select.setAttribute("aria-label", "Sleep inactive workspaces after");
    const current = this.idleUnloadMinutes();
    const choices = IDLE_CHOICES.includes(current) ? IDLE_CHOICES : [...IDLE_CHOICES, current].sort((a, b) => a - b);
    for (const minutes of choices) {
      const option = this.doc.createElement("option");
      option.value = String(minutes);
      option.textContent = minutes === 0 ? "never" : minutes + " min";
      option.selected = minutes === current;
      select.appendChild(option);
    }
    select.addEventListener("change", () => this.setIdleUnload(Number(select.value)));
    label.appendChild(select);
    row.appendChild(label);
    const wrap = this.doc.createDocumentFragment();
    wrap.appendChild(sep);
    wrap.appendChild(row);
    return wrap;
  }

  /**
   * The "Open a folder…" form: a path box, the directory list under it, recents
   * first. Built once per opening and patched on later renders (the status poll
   * re-renders every few seconds; rebuilding the input would eat the caret).
   */
  renderOpener() {
    const o = this.opener;
    if (!o.box) {
      const box = this.doc.createElement("div");
      box.className = "kide-open";
      box.setAttribute("data-testid", "kirocrew-ide-opener");
      const line = this.doc.createElement("div");
      line.className = "kide-path";
      const input = this.doc.createElement("input");
      input.type = "text";
      input.value = o.path;
      input.placeholder = "folder path — click a directory below, or type";
      input.setAttribute("aria-label", "Folder to open");
      input.spellcheck = false;
      input.addEventListener("input", () => { o.path = input.value; o.error = null; o.go.disabled = !o.path.trim(); if (o.path.endsWith("/")) this.browse(o.path); });
      input.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); this.submitOpen(); } });
      line.appendChild(input);
      const go = this.doc.createElement("button");
      go.type = "button";
      go.className = "kide-go";
      go.setAttribute("data-testid", "kirocrew-ide-open-go");
      go.addEventListener("click", () => this.submitOpen());
      line.appendChild(go);
      box.appendChild(line);
      const err = this.doc.createElement("div");
      err.className = "kide-err";
      box.appendChild(err);
      const dirs = this.doc.createElement("div");
      dirs.className = "kide-dirs";
      box.appendChild(dirs);
      Object.assign(o, { box, input, go, err, dirs, listedPath: undefined });
    }
    if (o.input.value !== o.path && this.doc.activeElement !== o.input) o.input.value = o.path;
    o.go.textContent = o.busy ? "Opening…" : "Open";
    o.go.disabled = o.busy || !o.path.trim();
    o.err.textContent = o.error || "";
    o.err.hidden = !o.error;
    const listing = o.listing;
    const listKey = listing ? listing.path + "|" + this.workspaces().map((r) => r.folder).join(",") : null;
    if (listing && o.listedPath !== listKey) {
      o.listedPath = listKey;
      const dirs = o.dirs;
      dirs.textContent = "";
      const open = new Set(this.workspaces().map((r) => r.folder));
      const suggestions = (listing.suggestions || []).filter((f) => !open.has(f));
      if (suggestions.length) {
        const head = this.doc.createElement("div");
        head.className = "kide-head";
        head.textContent = "Recent";
        dirs.appendChild(head);
        for (const folder of suggestions.slice(0, 6)) dirs.appendChild(this.dirRow(folder.split("/").filter(Boolean).pop() || folder, folder, () => { o.path = folder; this.submitOpen(); }));
      }
      const head = this.doc.createElement("div");
      head.className = "kide-head";
      head.style.textTransform = "none"; // a path keeps its case
      head.textContent = listing.path;
      dirs.appendChild(head);
      if (listing.parent && listing.parent !== listing.path) dirs.appendChild(this.dirRow("..", listing.parent, () => { o.path = listing.parent + "/"; this.browse(listing.parent); }));
      for (const entry of listing.entries || []) {
        if (entry.hidden && !(o.path.split("/").pop() || "").startsWith(".")) continue;
        const full = (listing.path.replace(/\/+$/, "") || "") + "/" + entry.name;
        dirs.appendChild(this.dirRow(entry.name, full, () => { o.path = full + "/"; this.browse(full); }));
      }
      if (listing.path) dirs.appendChild(this.dirRow("Use this folder", listing.path, () => { o.path = listing.path; this.submitOpen(); }, true));
    }
    return o.box;
  }

  dirRow(label, detail, onPick, strong = false) {
    const row = this.doc.createElement("button");
    row.type = "button";
    row.className = "kide-row kide-dir";
    row.setAttribute("role", "menuitem");
    row.setAttribute("data-dir", detail);
    const text = this.doc.createElement("span");
    text.className = "kide-text";
    const name = this.doc.createElement("span");
    name.textContent = label;
    if (strong) name.style.fontWeight = "600";
    text.appendChild(name);
    if (detail && detail !== label) {
      const d = this.doc.createElement("span");
      d.className = "kide-detail";
      d.textContent = detail;
      text.appendChild(d);
    }
    row.appendChild(text);
    row.addEventListener("click", (event) => { event.stopPropagation(); onPick(); });
    return row;
  }

  async browse(path) {
    if (!this.opener) return;
    let body = null;
    try {
      const reply = await this.fetch(API + "browse?path=" + encodeURIComponent(path || "~"), { credentials: "same-origin" });
      body = reply.ok ? await reply.json() : null;
    } catch {
      body = null;
    }
    if (!this.opener) return;
    if (body) { this.opener.listing = body; this.opener.error = null; }
    this.render();
  }

  async submitOpen() {
    const o = this.opener;
    if (!o || o.busy || !o.path.trim()) return;
    o.busy = true;
    o.error = null;
    this.render();
    try {
      await this.openWorkspace(o.path.trim().replace(/\/+$/, "") || "/");
      this.setWsMenuOpen(false);
    } catch (err) {
      if (this.opener) { this.opener.busy = false; this.opener.error = String(err && err.message || err); }
    }
    this.render();
  }

  // ------------------------------------------------- the chip in KiroCrew's bar

  placeChip() {
    const running = !!(this.status && this.status.running);
    let chip = this.doc.getElementById(CHIP_ID);
    if (!running) {
      if (chip) chip.remove();
      this.setAnchor(null);
      return;
    }
    // KiroCrew's crew switcher when it is on the page (desktop app with crews);
    // otherwise the FloofyCrew `topbar` surface, so a plain browser tab on the
    // gateway host still has a way back into the IDE.
    let row = this.doc.querySelector(CHIP_ROW);
    let floating = false;
    if (!row) {
      const topbar = this.ctx.surfaces && typeof this.ctx.surfaces.get === "function" ? this.ctx.surfaces.get("topbar") : null;
      if (!topbar) {
        if (chip) chip.remove();
        this.setAnchor(null);
        return;
      }
      row = topbar;
      floating = true;
    }
    if (!chip) {
      chip = this.doc.createElement("button");
      chip.type = "button";
      chip.id = CHIP_ID;
      chip.setAttribute("data-testid", CHIP_ID);
      chip.addEventListener("click", () => this.show());
    }
    // In KiroCrew's row the tag hangs off the chip of the crew on screen (the
    // host the IDE runs on): `[host]IDE]`. Standalone (top bar, or a row with no
    // current chip) it carries the host name itself.
    // KiroCrew's Switcher renders the crew on screen as a leading chip BESIDE
    // `crew-chip-row` (the row holds the pinned crews), or inside it in the
    // stable-order mode; look in the switcher group that wraps both.
    const group = floating ? null : (row.parentElement || row);
    const anchor = group ? group.querySelector('button[aria-current="true"]:not(#' + CHIP_ID + ")") : null;
    const { className, style, html } = chipMarkup(this.hostLabel(), this.shown, { sub: !!anchor });
    chip.className = className;
    chip.title = this.hostLabel() + " IDE — the workbench running on this host";
    chip.setAttribute("aria-label", chip.title);
    chip.setAttribute("aria-current", this.shown ? "true" : "false");
    chip.setAttribute("data-sub", anchor ? "true" : "false");
    if (chip.innerHTML !== html) chip.innerHTML = html;
    chip.style.cssText = style + (floating ? "margin-left:8px;" : "");
    this.setAnchor(anchor);
    if (anchor) {
      if (anchor.nextElementSibling !== chip) anchor.after(chip);
    } else if (chip.parentNode !== row || row.lastElementChild !== chip) {
      row.appendChild(chip);
    }
  }

  /** Square the right corners of the host chip the tag hangs off; restore the previous one. */
  setAnchor(anchor) {
    if (this.anchor === anchor) return;
    if (this.anchor) for (const key of Object.keys(ANCHOR_STYLE)) this.anchor.style[key] = "";
    this.anchor = anchor || null;
    if (anchor) for (const [key, value] of Object.entries(ANCHOR_STYLE)) anchor.style[key] = value;
  }
}

export default function activate(ctx) {
  const layer = new IdeLayer(ctx);
  layer.start();
  return () => layer.dispose();
}
