// The dashboard's own folder picker (its `ProjectPicker`: Recent / Browse tabs,
// drive roots, keyboard navigation, backed by the host's /api/recent-projects
// and /api/browse-dirs), reused for the IDE's folder choice so the two pickers
// are one. The host does not export it through `@kirocrew/ui`, so it is reached
// by its own chunk: the dashboard document carries
// `<link rel="modulepreload" href="/assets/ProjectPicker-<hash>.js">`, and the
// chunk's one export is the component. No hash is hardcoded; a dashboard that
// lacks the link (another version, the probe's stub realm) simply has no host
// picker and the callers fall back to the mod's own.
//
// The component is a React component bound to the HOST's React instance
// (`window.__kirocrew_modules.react`), which is the same instance the App page's
// `react` import resolves to, so it renders inside the page's tree; the layer
// (plain DOM) mounts it on a root of its own with the host's `react-dom`.
//
// Props (read from the chunk): { open, onOpenChange(bool), anchorRef | anchorRect,
// onSelect(path), errorHandoff? }. It portals a `position: fixed; z-index: 9999`
// box onto document.body, placed under (or over) the anchor rectangle.

const LINK_SELECTOR = 'link[rel="modulepreload"][href*="/assets/ProjectPicker-"]';
const cache = new Map(); // document -> Promise<component | null>

/** The chunk URL the dashboard preloads, or null. */
export function hostPickerUrl(doc = globalThis.document) {
  const link = doc && doc.querySelector && doc.querySelector(LINK_SELECTOR);
  return link ? link.getAttribute("href") : null;
}

/**
 * Resolve the host's ProjectPicker component once per document: null when the
 * dashboard does not carry it (or the import fails), never a rejection.
 */
export function loadHostPicker(doc = globalThis.document, importer = (url) => import(/* @vite-ignore */ url)) {
  if (!cache.has(doc)) {
    const url = hostPickerUrl(doc);
    const promise = !url ? Promise.resolve(null) : importer(url)
      .then((mod) => {
        const component = mod && (mod.t || mod.default || mod.ProjectPicker);
        return typeof component === "function" ? component : null;
      })
      .catch(() => null);
    cache.set(doc, promise);
  }
  return cache.get(doc);
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
 * picker's own stable element ids (`pp-recent-list` / `pp-browse-list`, source
 * identifiers, not build hashes).
 */
export const HOST_PICKER_RAISE_CSS =
  "body > div:has(#pp-recent-list), body > div:has(#pp-browse-list) { z-index: 2147483100 !important; }";

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
