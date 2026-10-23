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

/**
 * Parse any CSS colour the frame's window can render into [r, g, b, a] (0–255,
 * alpha 0–1), by letting the browser normalise it; null when it cannot.
 */
export function parseColor(win, value) {
  if (!value) return null;
  try {
    const el = win.document.createElement("span");
    el.style.color = value;
    if (!el.style.color) return null;
    win.document.body.appendChild(el);
    const rgb = win.getComputedStyle(el).color;
    el.remove();
    const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)/.exec(rgb);
    if (!m) return null;
    let a = m[4] === undefined ? 1 : parseFloat(m[4]);
    if (m[4] && m[4].endsWith("%")) a /= 100;
    return [+m[1], +m[2], +m[3], a];
  } catch {
    return null;
  }
}

/** WCAG relative luminance of an [r, g, b] in 0–255. */
export function luminance([r, g, b]) {
  const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio between two [r, g, b] colours. */
export function contrast(a, b) {
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * The foreground to paint on `bg`: `themed` when it reaches 3:1 against it
 * (the WCAG floor for UI text this size), otherwise black or white by the
 * background's luminance. A translucent background is read as painted over
 * the title bar, which is what the eye sees. Returns a CSS colour string;
 * `themed` itself when nothing can be measured.
 */
export function readableForeground(win, bg, themed, under, floor = 3) {
  const back = parseColor(win, bg);
  if (!back) return themed || "inherit";
  let rgb = back.slice(0, 3);
  if (back[3] < 1) {
    const base = parseColor(win, under) || (luminance(rgb) > 0.5 ? [255, 255, 255, 1] : [30, 30, 30, 1]);
    rgb = rgb.map((c, i) => Math.round(c * back[3] + base[i] * (1 - back[3])));
  }
  const fore = parseColor(win, themed);
  if (fore && fore[3] > 0.5 && contrast(fore.slice(0, 3), rgb) >= floor) return themed;
  return luminance(rgb) > 0.4 ? "#000" : "#fff";
}

/** {badgeBg, badgeFg}: the accent with white text when that reads (3:1), else the bar's own foreground with a tint of itself behind. */
export function badgeColors(win, accent, fg) {
  const acc = parseColor(win, accent);
  if (!acc) return { badgeBg: accent, badgeFg: "#fff" }; // unmeasurable: the theme's word stands
  if (contrast(acc.slice(0, 3), [255, 255, 255]) >= 3) return { badgeBg: accent, badgeFg: "#fff" };
  if (contrast(acc.slice(0, 3), [0, 0, 0]) >= 4.5 && fg === "#000") return { badgeBg: accent, badgeFg: "#000" };
  return { badgeBg: fg === "#fff" ? "rgba(255,255,255,.22)" : "rgba(0,0,0,.14)", badgeFg: fg };
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
    // The pill's text: the theme's command-centre foreground when it actually
    // reads on the pill's background, else black or white by the background's
    // luminance. Light themes with a dark title bar (Tempest, several "mist"
    // themes) ship a pale grey foreground for a dark command centre while the
    // pill ends up painted on a light surface, and the folder name in it was
    // unreadable. Measured in the frame's own window, so rgb() strings resolve.
    const themedFg = pick("--vscode-commandCenter-foreground", "--vscode-titleBar-activeForeground");
    const fg = readableForeground(doc.defaultView, bg, themedFg, pick("--vscode-titleBar-activeBackground"));
    return {
      bg,
      fg,
      // A muted shade for secondary text, derived from the chosen foreground so
      // it stays on the right side of the background whichever the theme is.
      muted: fg === "#000" ? "rgba(0,0,0,.62)" : fg === "#fff" ? "rgba(255,255,255,.72)" : fg,
      // The count badge: the accent only when white reads on it; else the
      // foreground on a translucent pill of itself (a pale accent on a light
      // title bar made the white "2" vanish).
      ...badgeColors(doc.defaultView, pick("--vscode-focusBorder", "--vscode-button-background") || "#7c5cff", fg),
      // The current chip ("IDE") paints its text in the accent over the hover
      // colour: the accent when it reads there (bold text, so a 2.5:1 floor —
      // the usual purple-on-dark-grey stays), else black or white.
      accentText: readableForeground(doc.defaultView,
        pick("--vscode-commandCenter-activeBackground", "--vscode-toolbar-hoverBackground") || bg,
        pick("--vscode-focusBorder", "--vscode-button-background") || "#7c5cff",
        pick("--vscode-titleBar-activeBackground"), 2.5),
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
