// The dashboard's own folder picker (its `ProjectPicker`: Recent / Favorites /
// Browse tabs, drive roots, keyboard navigation, backed by the host's
// /api/recent-projects, /api/favorite-projects and /api/browse-dirs), reused for
// the IDE's folder choice so the two pickers are one. Two ways to reach it, by
// host generation, tried in this order:
//
// 1. KiroCrew 0.13+ (App Kit level 7): the App SDK exports the picker as
//    `ProjectPicker` on `window.__kirocrew_modules["@kirocrew/app-sdk"]` (what
//    `import { ProjectPicker } from "@kirocrew/app-sdk"` resolves to through the
//    dashboard's import map). It is gated: it renders only under an app scope
//    whose declared `permissions.api` covers the four listing paths
//    (`SDK_PICKER_PATHS`), else an inline "not declared" notice. The mod's App
//    page runs under the App Kit's own scope, and `app/app.json` declares those
//    paths; the layer (plain DOM over the dashboard, no app scope of its own)
//    renders the picker under the SDK's `AppApiProvider` with the mod's app name
//    and the same four paths — the scope the user granted at install, restated.
// 2. KiroCrew ≤ 0.12: the picker was a chunk of its own, and the dashboard
//    document carried `<link rel="modulepreload" href="/assets/ProjectPicker-<hash>.js">`;
//    the chunk's one export is the component. No hash is hardcoded. (0.13's
//    bundler folded the picker into a `first-load-*` chunk with ~1000 exports, so
//    this link is gone there — the testing host's 0.13.0.4 fell back to the mod's
//    own combobox, 2026-11-20.)
//
// A dashboard with neither (an older build, the probe's stub realm) has no host
// picker and the callers fall back to the mod's own.
//
// The component is a React component bound to the HOST's React instance
// (`window.__kirocrew_modules.react`), which is the same instance the App page's
// `react` import resolves to, so it renders inside the page's tree; the layer
// (plain DOM) mounts it on a root of its own with the host's `react-dom`.
//
// Props (both routes): { open, onOpenChange(bool), anchorRef | anchorRect,
// onSelect(path), startPath? }. It portals a `position: fixed; z-index: 9999`
// box onto document.body, placed under (or over) the anchor rectangle.

const LINK_SELECTOR = 'link[rel="modulepreload"][href*="/assets/ProjectPicker-"]';
const SDK_KEY = "@kirocrew/app-sdk";
/** The mod's App identity (app/app.json `name`), the scope the layer's picker renders under. */
export const APP_NAME = "kirocrew-ide";
export const APP_DISPLAY_NAME = "KiroCrew IDE";
/** The dashboard API paths the SDK picker reads; app/app.json's `permissions.api` declares exactly these. */
export const SDK_PICKER_PATHS = Object.freeze(["/api/browse-dirs", "/api/browse-dirs/create", "/api/recent-projects", "/api/favorite-projects"]);
/** How long to wait for the host's module registry (set by the dashboard's main bundle) before deciding. */
export const MODULES_WAIT_MS = 5000;
const MODULES_POLL_MS = 50;
const cache = new Map(); // document -> { app: Promise, standalone: Promise }

/** The chunk URL the dashboard preloads (KiroCrew ≤ 0.12), or null. */
export function hostPickerUrl(doc = globalThis.document) {
  const link = doc && doc.querySelector && doc.querySelector(LINK_SELECTOR);
  return link ? link.getAttribute("href") : null;
}

/**
 * The host's shared module registry, waiting up to `waitMs` for the dashboard's
 * main bundle to install it (the SPA host imports mod parts after a network
 * round trip, so it is normally there already); null when it never shows up.
 */
export function hostModules(win = globalThis.window, { waitMs = MODULES_WAIT_MS, setTimer = (fn, ms) => setTimeout(fn, ms), now = () => Date.now() } = {}) {
  const read = () => (win && win.__kirocrew_modules) || null;
  const first = read();
  if (first || waitMs <= 0) return Promise.resolve(first);
  const deadline = now() + waitMs;
  return new Promise((resolve) => {
    const tick = () => { const mods = read(); if (mods || now() >= deadline) resolve(mods); else setTimer(tick, MODULES_POLL_MS); };
    setTimer(tick, MODULES_POLL_MS);
  });
}

/**
 * The App SDK's picker from the host's module registry (KiroCrew 0.13+), or null.
 * `scoped: false` is the SDK component itself, for a render inside the mod's own
 * App (the App Kit supplies the scope; app.json declares the paths).
 * `scoped: true` wraps it in the SDK's `AppApiProvider` under the mod's app name
 * with `SDK_PICKER_PATHS`, for a render outside any app (the layer).
 */
export function sdkPicker(mods, { scoped = false } = {}) {
  const sdk = mods && mods[SDK_KEY];
  const Picker = sdk && sdk.ProjectPicker;
  const Provider = sdk && sdk.AppApiProvider;
  const React = mods && mods.react;
  if (typeof Picker !== "function" || typeof Provider !== "function" || !React || typeof React.createElement !== "function") return null;
  if (!scoped) return Picker;
  function ScopedProjectPicker(props) {
    return React.createElement(Provider, { appName: APP_NAME, appDisplayName: APP_DISPLAY_NAME, allowedApiPaths: [...SDK_PICKER_PATHS] }, React.createElement(Picker, props));
  }
  ScopedProjectPicker.displayName = "KirocrewIdeScopedProjectPicker";
  return ScopedProjectPicker;
}

/**
 * Resolve the host's picker component once per document (and per scope): the
 * SDK's on a 0.13+ host, the preloaded chunk's export on an older one, null when
 * the dashboard carries neither (or the import fails) — never a rejection.
 * `scoped` as in `sdkPicker`; the chunk route is unscoped by nature.
 */
export function loadHostPicker(doc = globalThis.document, { win = globalThis.window, importer = (url) => import(/* @vite-ignore */ url), scoped = false, waitMs = MODULES_WAIT_MS, setTimer, now } = {}) {
  const slot = scoped ? "standalone" : "app";
  let entry = cache.get(doc);
  if (!entry) { entry = {}; cache.set(doc, entry); }
  if (!entry[slot]) {
    entry[slot] = hostModules(win, { waitMs, ...(setTimer ? { setTimer } : {}), ...(now ? { now } : {}) })
      .then((mods) => {
        const fromSdk = sdkPicker(mods, { scoped });
        if (fromSdk) return fromSdk;
        const url = hostPickerUrl(doc);
        if (!url) return null;
        return importer(url).then((mod) => {
          const component = mod && (mod.t || mod.default || mod.ProjectPicker);
          return typeof component === "function" ? component : null;
        });
      })
      .catch(() => null);
  }
  return entry[slot];
}

/** The host's React and ReactDOM (the instance the picker is bound to), or null. */
export function hostReact(win = globalThis.window) {
  const mods = win && win.__kirocrew_modules;
  const React = mods && mods.react;
  const ReactDOM = mods && mods["react-dom"];
  return React && ReactDOM && typeof ReactDOM.createRoot === "function" ? { React, ReactDOM } : null;
}

/**
 * CSS that lets the host picker's box paint over the fullscreen IDE layer. The
 * picker portals to document.body at `z-index: 9999`; the layer sits far above
 * that so the IDE covers every dashboard surface. The box is recognised by the
 * picker's own stable element ids: every list and row it renders is `pp-…`
 * (`pp-recent-list`, `pp-browse-list`, `pp-favorite-list`, `pp-favorite-0`,
 * `pp-dir-…`; source identifiers, not build hashes), on ANY of its tabs. Until
 * 0.30.7 the rule named the Recent and Browse lists only; KiroCrew 0.11's
 * picker opens on a Favorites tab when favourites exist, so the box was raised
 * for the first paint (state starts on Recent), then dropped back under the
 * fullscreen IDE as the tab switched: it flashed and vanished (2026-11-06).
 */
export const HOST_PICKER_SELECTOR = 'body > div:has([id^="pp-"])';
export const HOST_PICKER_RAISE_CSS = HOST_PICKER_SELECTOR + " { z-index: 2147483100 !important; }";

/**
 * Mount the host picker from plain DOM. Returns a controller
 * { open(anchorRect), close(), dispose() }; `onSelect(path)` fires with the
 * chosen folder, `onClose()` whenever it closes (select, Escape, outside click).
 */
export function mountHostPicker(Component, { win = globalThis.window, doc = globalThis.document, onSelect, onClose } = {}) {
  const host = hostReact(win);
  if (!host) return null;
  const { React, ReactDOM } = host;
  const container = doc.createElement("div");
  container.setAttribute("data-kide-hostpicker", "");
  doc.body.appendChild(container);
  const root = ReactDOM.createRoot(container);
  let state = { open: false, rect: null };
  const render = () => {
    root.render(React.createElement(Component, {
      open: state.open,
      anchorRect: state.rect,
      onOpenChange: (next) => { if (!next) { state = { ...state, open: false }; render(); if (onClose) onClose(); } },
      onSelect: (path) => { state = { ...state, open: false }; render(); if (onSelect) onSelect(path); },
    }));
  };
  render();
  return {
    open(rect) { state = { open: true, rect }; render(); },
    close() { if (state.open) { state = { ...state, open: false }; render(); } },
    isOpen() { return state.open; },
    dispose() { try { root.unmount(); } catch { /* already gone */ } container.remove(); },
  };
}
