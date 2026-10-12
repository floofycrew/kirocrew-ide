// Helpers shared by the IDE layer (spa/layer.mjs) and the App page: reading the
// dashboard's colour scheme, decorating the workbench URL with it, and reading
// the same-origin workbench frame for its title-bar colours and letterpress.

/**
 * Override the workbench's empty-editor watermark from OUTSIDE the iframe.
 *
 * The engine's workbench.css (and the stock letterpress SVGs it references)
 * were served with a one-year Cache-Control before the proxy started swapping
 * them, so an already-primed browser — the KiroCrew desktop app in particular,
 * where nobody hard-reloads — keeps showing the stock book icon forever. The
 * iframe is same-origin, so appending a style sheet into its document beats
 * any cached CSS; the image URL carries a query so the cached stock SVG can
 * never answer it (the proxy matches on the path and serves the fox).
 */
export function injectLetterpressStyle(frame) {
  try {
    const doc = frame && frame.contentDocument;
    if (!doc || !doc.head || doc.getElementById("kirocrew-fox-letterpress")) return false;
    const base = ".monaco-workbench .part.editor>.content .editor-group-container>.editor-group-watermark .letterpress";
    const url = (v) => 'url("./stable-latest/static/out/media/letterpress-' + v + '.svg?fox=1")';
    const style = doc.createElement("style");
    style.id = "kirocrew-fox-letterpress";
    style.textContent =
      base + "{background-image:" + url("light") + "!important}\n" +
      base.replace(".monaco-workbench", ".monaco-workbench.vs-dark") + "{background-image:" + url("dark") + "!important}\n" +
      base.replace(".monaco-workbench", ".monaco-workbench.hc-black") + "{background-image:" + url("hcDark") + "!important}\n" +
      base.replace(".monaco-workbench", ".monaco-workbench.hc-light") + "{background-image:" + url("hcLight") + "!important}";
    doc.head.appendChild(style);
    return true;
  } catch {
    return false; // a cross-origin or torn-down frame is not ours to style
  }
}

/**
 * The dashboard's resolved colour scheme: `data-mode` on <html> (set by the
 * host's useTheme from its `mc-theme` choice, `system` already resolved), with
 * the OS preference as the fallback before hydration.
 */
export function dashboardScheme(doc = globalThis.document) {
  const mode = doc && doc.documentElement && (doc.documentElement.dataset.mode || doc.documentElement.dataset.theme || "");
  if (/dark/.test(mode)) return "dark";
  if (/light/.test(mode)) return "light";
  return (typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches) ? "dark" : "light";
}

/** The frame URL with the dashboard scheme attached, so the proxy can seed the matching default theme before boot. */
export function withScheme(url, scheme) {
  if (!url) return url;
  const bare = url.replace(/([?&])kideScheme=[a-z]*&?/, "$1").replace(/[?&]$/, "");
  return bare + (bare.includes("?") ? "&" : "?") + "kideScheme=" + scheme;
}

/**
 * Read the workbench's title-bar theme colours out of the same-origin iframe
 * (the `--vscode-*` custom properties VS Code sets on <body>). Returns null
 * until the workbench has painted, or when the frame is cross-origin.
 */
/**
 * The left edge (px, in the frame's viewport, which is the layer's) of the
 * workbench title bar's centre part — the ← → arrows and the command centre —
 * or null when the workbench is not readable or has no such part. The layer's
 * bar must end before it.
 */
export function workbenchCentreLeft(frame) {
  return partLeft(frame, ".monaco-workbench .part.titlebar .titlebar-center", true);
}

/**
 * The left edge (px, frame viewport) of the title bar's RIGHT part's content —
 * the layout controls (`.action-toolbar-container`, right-aligned inside a
 * part that itself spans ~20% of the width) — or null when not readable. The
 * layer's task indicator sits just left of it.
 */
export function workbenchRightLeft(frame) {
  return partLeft(frame, ".monaco-workbench .part.titlebar .titlebar-right", false);
}

/**
 * The leftmost visible edge of a title-bar part: its own box too when `ownBox`
 * (the centre part IS the budget edge, its arrows may only sit further left),
 * its children only otherwise (the right part's toolbar is pushed to the far
 * end by `margin-left: auto`, so the part's own box would steal budget).
 */
function partLeft(frame, selector, ownBox) {
  try {
    const doc = frame && frame.contentDocument;
    const part = doc && doc.querySelector && doc.querySelector(selector);
    if (!part) return null;
    const rect = part.getBoundingClientRect();
    if (!(rect.width > 0)) return null;
    let left = ownBox ? rect.left : null;
    for (const child of part.children) {
      const r = child.getBoundingClientRect();
      if (r.width > 0 && (left === null || r.left < left)) left = r.left;
    }
    return left === null ? null : Math.round(left);
  } catch {
    return null;
  }
}

export function readWorkbenchTheme(frame) {
  try {
    const doc = frame && frame.contentDocument;
    const body = doc && doc.body;
    if (!body) return null;
    // VS Code emits its theme as one rule, `.monaco-workbench { --vscode-…: …; }`
    // (the workbench root, a child of <body>). Custom properties inherit down,
    // never up, so read the workbench element; <body> only as a fallback.
    const scope = (body.querySelector && body.querySelector(".monaco-workbench")) || body;
    const css = doc.defaultView.getComputedStyle(scope);
    const pick = (...names) => {
      for (const name of names) {
        const value = css.getPropertyValue(name).trim();
        if (value) return value;
      }
      return "";
    };
    const bg = pick("--vscode-commandCenter-background", "--vscode-titleBar-activeBackground");
    if (!bg) return null;
    return {
      bg,
      fg: pick("--vscode-commandCenter-foreground", "--vscode-titleBar-activeForeground") || "inherit",
      border: pick("--vscode-commandCenter-border", "--vscode-titleBar-border") || "transparent",
      hover: pick("--vscode-commandCenter-activeBackground", "--vscode-toolbar-hoverBackground") || bg,
      titleBar: pick("--vscode-titleBar-activeBackground") || bg,
      accent: pick("--vscode-focusBorder", "--vscode-button-background") || "#7c5cff",
      // The workbench's own menu palette, for the layer's host dropdown.
      menuBg: pick("--vscode-menu-background", "--vscode-quickInput-background", "--vscode-editorWidget-background") || bg,
      menuFg: pick("--vscode-menu-foreground", "--vscode-quickInput-foreground") || "inherit",
      menuBorder: pick("--vscode-menu-border", "--vscode-widget-border", "--vscode-commandCenter-border") || "transparent",
      menuHover: pick("--vscode-menu-selectionBackground", "--vscode-list-hoverBackground") || "rgba(128,128,128,.18)",
      menuHoverFg: pick("--vscode-menu-selectionForeground", "--vscode-list-hoverForeground") || "inherit",
      // The task donut's arcs: done in the theme's chart green (the extension ticks boxes with
      // it), the queued / in-progress share in its chart blue.
      done: pick("--vscode-charts-green", "--vscode-testing-iconPassed") || "#3fb950",
      active: pick("--vscode-charts-blue", "--vscode-progressBar-background") || "#4a9eff",
    };
  } catch {
    return null; // cross-origin frame: keep the neutral fallback
  }
}
