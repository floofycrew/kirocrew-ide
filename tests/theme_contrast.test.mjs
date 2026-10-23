// The bar's text colour is derived for readability, not trusted from the theme:
// the command-centre foreground is used only when it reaches 3:1 on the pill's
// background, otherwise black or white by luminance; the count badge keeps the
// accent only when white reads on it. Tempest (light title bar, pale grey
// foreground, pale blue accent) was unreadable before this.
import { test } from "node:test";
import assert from "node:assert/strict";
import { badgeColors, contrast, luminance, parseColor, readableForeground } from "../spa/workbench.mjs";

// A stand-in window whose createElement/getComputedStyle normalise a few colour spellings.
const NAMED = { white: "rgb(255, 255, 255)", black: "rgb(0, 0, 0)", transparent: "rgba(0, 0, 0, 0)" };
function hexToRgb(h) {
  h = h.slice(1);
  if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join("");
  const n = parseInt(h.slice(0, 6), 16);
  const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
  return a === 1 ? `rgb(${n >> 16}, ${(n >> 8) & 255}, ${n & 255})` : `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}
function normalise(v) {
  v = v.trim();
  if (NAMED[v]) return NAMED[v];
  if (/^#[0-9a-f]{3,8}$/i.test(v)) return hexToRgb(v);
  if (/^rgba?\(/.test(v)) return v;
  return "";
}
const win = {
  document: {
    body: { appendChild() {} },
    createElement() {
      const el = { style: {}, remove() {} };
      Object.defineProperty(el.style, "color", { set(v) { this._c = normalise(v); }, get() { return this._c || ""; } });
      return el;
    },
  },
  getComputedStyle(el) { return { color: el.style.color }; },
};

test("parseColor normalises hex, rgb and names; rejects garbage", () => {
  assert.deepEqual(parseColor(win, "#fff"), [255, 255, 255, 1]);
  assert.deepEqual(parseColor(win, "#1e1e1e"), [30, 30, 30, 1]);
  assert.deepEqual(parseColor(win, "rgba(10, 20, 30, 0.5)"), [10, 20, 30, 0.5]);
  assert.deepEqual(parseColor(win, "white"), [255, 255, 255, 1]);
  assert.equal(parseColor(win, "not-a-colour"), null);
  assert.equal(parseColor(win, ""), null);
});

test("luminance and contrast follow WCAG", () => {
  assert.equal(luminance([255, 255, 255]), 1);
  assert.equal(luminance([0, 0, 0]), 0);
  assert.equal(Math.round(contrast([255, 255, 255], [0, 0, 0])), 21);
  assert.ok(contrast([118, 118, 118], [255, 255, 255]) > 4.4 && contrast([118, 118, 118], [255, 255, 255]) < 4.6);
});

test("the themed foreground is kept when it reads, replaced when it does not", () => {
  // Dark pill, light text: the theme's own colour stays.
  assert.equal(readableForeground(win, "#3a3a3a", "#dddddd"), "#dddddd");
  // Tempest's shape: pale blue pill, pale grey foreground -> black.
  assert.equal(readableForeground(win, "#cfe3ee", "#9aa7b0"), "#000");
  // Dark pill, dark grey foreground (a theme bug) -> white.
  assert.equal(readableForeground(win, "#202020", "#404040"), "#fff");
  // No foreground declared: by luminance.
  assert.equal(readableForeground(win, "#f5f5f5", ""), "#000");
  assert.equal(readableForeground(win, "#101010", ""), "#fff");
  // A translucent pill is read over the title bar it sits on.
  assert.equal(readableForeground(win, "rgba(255, 255, 255, 0.1)", "#e0e0e0", "#1e1e1e"), "#e0e0e0", "10% white over dark is dark: light text stays");
  assert.equal(readableForeground(win, "rgba(0, 0, 0, 0.08)", "#c0c0c0", "#f0f4f8"), "#000", "8% black over light is light: grey text goes black");
  // The floor is a parameter (the accent text uses 2.5 for bold): the stock purple on a mid-dark
  // hover is 2.6:1 — kept at 2.5, replaced at the default 3.
  assert.equal(readableForeground(win, "#3a3a3a", "#7c5cff", "#2b2b2b", 2.5), "#7c5cff");
  assert.equal(readableForeground(win, "#3a3a3a", "#7c5cff", "#2b2b2b"), "#fff", "the default 3:1 floor rejects it");
  assert.equal(readableForeground(win, "#4a4a4a", "#7c5cff", "#2b2b2b", 2.5), "#fff", "2.0:1 is dim even for bold");
  // Nothing measurable: the theme's word stands.
  assert.equal(readableForeground(win, "nonsense", "#abc"), "#abc");
  assert.equal(readableForeground(win, "nonsense", ""), "inherit");
});

test("the badge keeps the accent only when white reads on it", () => {
  assert.deepEqual(badgeColors(win, "#7c5cff", "#fff"), { badgeBg: "#7c5cff", badgeFg: "#fff" });
  assert.deepEqual(badgeColors(win, "#0a4a8a", "#000"), { badgeBg: "#0a4a8a", badgeFg: "#fff" });
  // A pale accent on a light bar: black on the accent reads (>= 4.5:1), so the accent stays with black text.
  assert.deepEqual(badgeColors(win, "#b7d3e6", "#000"), { badgeBg: "#b7d3e6", badgeFg: "#000" });
  // A mid-grey accent: white falls short of 3:1 but black clears 4.5:1, so the accent stays with black text.
  assert.deepEqual(badgeColors(win, "#9a9a9a", "#000"), { badgeBg: "#9a9a9a", badgeFg: "#000" });
  // The same accent on a white-text bar: black text is not the bar's colour, so the tint branch.
  assert.deepEqual(badgeColors(win, "#9a9a9a", "#fff"), { badgeBg: "rgba(255,255,255,.22)", badgeFg: "#fff" });
  assert.deepEqual(badgeColors(win, "nonsense", "#fff"), { badgeBg: "nonsense", badgeFg: "#fff" }, "unmeasurable: the theme's word stands");
  // A pale accent on a dark bar (white text): white on a faint white tint.
  assert.deepEqual(badgeColors(win, "#ffe08a", "#fff"), { badgeBg: "rgba(255,255,255,.22)", badgeFg: "#fff" });
});
