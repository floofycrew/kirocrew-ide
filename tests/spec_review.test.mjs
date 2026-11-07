// node --test: the spec review comments' pure pieces (requirements 7.1–7.3) —
// `reviewBlockId` (the anchor a comment is keyed by, hashed from kind + text),
// `reviewExcerpt` (the quoted passage, collapsed and capped) and
// `buildReviewTurn` (the one turn "Send N comments" builds and its transcript
// display text). Same stub `vscode` module as spec_editor.test.mjs.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const stub = {
  EventEmitter: class { constructor() { this.event = () => ({ dispose() {} }); } fire() {} },
  TreeItem: class { constructor(label, state) { this.label = label; this.collapsibleState = state; } },
  TreeItemCollapsibleState: { None: 0, Expanded: 2 },
  ThemeIcon: class { constructor(id) { this.id = id; } },
  FileType: { Directory: 2, File: 1 },
  Uri: { joinPath: (base, ...parts) => ({ path: [base.path, ...parts].join("/") }), parse: (s) => ({ toString: () => s }) },
  workspace: { getConfiguration: () => ({ get: () => undefined }), workspaceFolders: [] },
  window: {}, commands: {}, StatusBarAlignment: { Left: 1 }, ConfigurationTarget: { Global: 1 },
};
const Module = require("node:module");
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "vscode") return "vscode-stub";
  return originalResolve.call(this, request, ...rest);
};
require.cache["vscode-stub"] = { id: "vscode-stub", filename: "vscode-stub", loaded: true, exports: stub };
const ext = require(path.join(here, "..", "extension", "extension.js"));
const { REVIEW_EXCERPT_MAX, reviewBlockId, reviewExcerpt, buildReviewTurn, SPEC_REVIEW_CONTEXT_KEYS } = ext.__test;

// --- reviewBlockId (requirement 7.4: the anchor survives a re-render of an unchanged passage)

test("reviewBlockId: same kind and text give the same id; the shape is b<base36>", () => {
  const a = reviewBlockId("p", "Overview paragraph with a link.", 0);
  const b = reviewBlockId("p", "Overview paragraph with a link.", 0);
  assert.equal(a, b);
  assert.match(a, /^b[0-9a-z]+$/);
  assert.equal(reviewBlockId("p", "Overview paragraph with a link."), a, "occurrence 0 and omitted are the same id");
});

test("reviewBlockId: whitespace-insensitive, text- and kind-sensitive", () => {
  const base = reviewBlockId("li", "2. Manifest", 0);
  assert.equal(reviewBlockId("li", "  2.   Manifest\n", 0), base, "runs of whitespace and the ends collapse away");
  assert.equal(reviewBlockId("li", "2.\tManifest", 0), base, "tabs are whitespace too");
  assert.notEqual(reviewBlockId("li", "2. Manifest and loader", 0), base, "a changed passage gets a new id");
  assert.notEqual(reviewBlockId("h", "2. Manifest", 0), base, "the same text as a heading is another block");
  assert.notEqual(reviewBlockId("li", "2. manifest", 0), base, "case matters");
});

test("reviewBlockId: repeated blocks are told apart by an occurrence suffix", () => {
  const first = reviewBlockId("li", "_Requirements: 1.1_", 0);
  const second = reviewBlockId("li", "_Requirements: 1.1_", 1);
  const third = reviewBlockId("li", "_Requirements: 1.1_", 2);
  assert.equal(second, first + "-1");
  assert.equal(third, first + "-2");
  assert.notEqual(first, second);
  assert.match(second, /^[a-z0-9-]+$/, "the id stays a safe attribute value (the page's selector pattern)");
});

test("reviewBlockId: empty or missing text still yields an id, defaulting the kind to p", () => {
  assert.equal(reviewBlockId(undefined, undefined, 0), reviewBlockId("p", "", 0));
  assert.match(reviewBlockId("code", "", 0), /^b[0-9a-z]+$/);
  assert.notEqual(reviewBlockId("code", "", 0), reviewBlockId("p", "", 0));
});

// --- reviewExcerpt

test("reviewExcerpt: collapses whitespace and trims; short text is kept whole", () => {
  assert.equal(REVIEW_EXCERPT_MAX, 160);
  assert.equal(reviewExcerpt("  Overview\n\n  paragraph\twith   a link.  "), "Overview paragraph with a link.");
  assert.equal(reviewExcerpt(""), "");
  assert.equal(reviewExcerpt(undefined), "");
  assert.equal(reviewExcerpt(null), "");
  const exact = "x".repeat(REVIEW_EXCERPT_MAX);
  assert.equal(reviewExcerpt(exact), exact, "exactly the cap is not cut");
});

test("reviewExcerpt: longer passages are cut to the cap with an ellipsis", () => {
  const words = Array.from({ length: 60 }, (_, i) => "word" + i).join(" ");
  assert.ok(words.length > REVIEW_EXCERPT_MAX);
  const cut = reviewExcerpt(words);
  assert.equal(cut.length <= REVIEW_EXCERPT_MAX, true, "the excerpt never exceeds the cap (got " + cut.length + ")");
  assert.ok(cut.endsWith("…"));
  assert.equal(cut, words.slice(0, REVIEW_EXCERPT_MAX - 1).trimEnd() + "…");
  assert.ok(!cut.endsWith(" …"), "no trailing space before the ellipsis");
  // A space right at the cut: the ellipsis follows the last word, not a blank.
  const spaced = "a".repeat(REVIEW_EXCERPT_MAX - 1) + " tail";
  assert.equal(reviewExcerpt(spaced), "a".repeat(REVIEW_EXCERPT_MAX - 1) + "…");
});

// --- buildReviewTurn (requirement 7.2)

const COMMENTS = [
  { blockId: "b1", excerpt: "Overview paragraph with a link.", text: "Name the feature here." },
  { blockId: "b2", excerpt: "def greet(name): return f\"hello {name}\"", text: "Drop the example;\nit is not part of the design." },
];

test("buildReviewTurn: header names the spec and document with the count", () => {
  const turn = buildReviewTurn({ feature: "demo", file: "design.md", comments: COMMENTS });
  const lines = turn.text.split("\n");
  assert.equal(lines[0], "Review comments on demo/design.md (2 comments):");
  assert.equal(lines[1], "", "a blank line follows the header");
  assert.equal(turn.displayText, "Review: 2 comments on design.md");
});

test("buildReviewTurn: numbered items quote the excerpt and carry the comment, multi-line comments indented", () => {
  const turn = buildReviewTurn({ feature: "demo", file: "design.md", comments: COMMENTS });
  const text = turn.text;
  assert.ok(text.includes("\n1. On the passage:\n   > Overview paragraph with a link.\n   Comment: Name the feature here.\n"), "item 1:\n" + text);
  assert.ok(text.includes("\n2. On the passage:\n   > def greet(name): return f\"hello {name}\"\n   Comment: Drop the example;\n   it is not part of the design.\n"), "item 2 continuation lines are indented under Comment:\n" + text);
  assert.equal(text.indexOf("1. On the passage") < text.indexOf("2. On the passage"), true, "items keep their order");
  assert.ok(!text.includes("\n3. "), "no third item");
});

test("buildReviewTurn: the document path is reduced to its file name; the apply-feedback instruction closes the turn", () => {
  const turn = buildReviewTurn({ feature: "demo", file: "/ws/.kiro/specs/demo/tasks.md", comments: COMMENTS.slice(0, 1) });
  assert.ok(turn.text.startsWith("Review comments on demo/tasks.md (1 comment):"));
  const last = turn.text.split("\n").pop();
  assert.ok(last.startsWith("Apply each comment to tasks.md of this spec, in the passage it quotes"), last);
  assert.ok(last.includes("do not edit the other documents"), "the siblings are left alone");
  assert.ok(last.includes("Do not implement code."), "the Spec_Agent writes the document, not code");
  assert.ok(last.includes("list what changed, comment by comment"), "the agent reports per comment");
  assert.equal(turn.displayText, "Review: 1 comment on tasks.md", "singular display text");
});

test("buildReviewTurn: a comment without an excerpt is on the document as a whole; excerpts are re-capped", () => {
  const long = "y".repeat(400);
  const turn = buildReviewTurn({ feature: "demo", file: "design.md", comments: [
    { blockId: "b1", excerpt: "", text: "Whole document: too long." },
    { blockId: "b2", excerpt: "  spaced   out  ", text: "tighten" },
    { blockId: "b3", excerpt: long, text: "cap me" },
  ] });
  assert.ok(turn.text.includes("\n1. On the document as a whole:\n   Comment: Whole document: too long.\n"), turn.text);
  assert.ok(!turn.text.includes("1. On the document as a whole:\n   > "), "no empty quote line for a missing excerpt");
  assert.ok(turn.text.includes("\n2. On the passage:\n   > spaced out\n"), "the excerpt is whitespace-collapsed again");
  assert.ok(turn.text.includes("\n   > " + "y".repeat(REVIEW_EXCERPT_MAX - 1) + "…\n"), "a foreign over-long excerpt is cut to the cap");
  assert.ok(!turn.text.includes(long), "the raw 400-char excerpt is not in the turn");
  assert.equal(turn.displayText, "Review: 3 comments on design.md");
});

test("buildReviewTurn: comments with no text are skipped, and the count follows what is left", () => {
  const turn = buildReviewTurn({ feature: "demo", file: "design.md", comments: [
    { blockId: "b1", excerpt: "kept", text: "  real comment  " },
    { blockId: "b2", excerpt: "dropped", text: "   " },
    { blockId: "b3", excerpt: "dropped too" },
    null,
  ] });
  assert.ok(turn.text.startsWith("Review comments on demo/design.md (1 comment):"));
  assert.ok(turn.text.includes("   Comment: real comment\n"), "the comment text is trimmed");
  assert.ok(!turn.text.includes("dropped"), "skipped comments leave no trace");
  assert.ok(!turn.text.includes("\n2. "));
  assert.equal(turn.displayText, "Review: 1 comment on design.md");
});

test("buildReviewTurn: nothing to send gives two empty strings", () => {
  assert.deepEqual(buildReviewTurn({ feature: "demo", file: "design.md", comments: [] }), { text: "", displayText: "" });
  assert.deepEqual(buildReviewTurn({ feature: "demo", file: "design.md", comments: [{ blockId: "b1", excerpt: "x", text: "" }] }), { text: "", displayText: "" });
  assert.deepEqual(buildReviewTurn({ feature: "demo", file: "design.md" }), { text: "", displayText: "" });
  assert.deepEqual(buildReviewTurn(), { text: "", displayText: "" });
  assert.deepEqual(buildReviewTurn({ comments: "not a list" }), { text: "", displayText: "" });
});

test("buildReviewTurn: missing feature and file fall back to spec/document", () => {
  const turn = buildReviewTurn({ comments: [{ blockId: "b1", excerpt: "e", text: "t" }] });
  assert.ok(turn.text.startsWith("Review comments on spec/document (1 comment):"), turn.text.split("\n")[0]);
  assert.equal(turn.displayText, "Review: 1 comment on document");
  const spaced = buildReviewTurn({ feature: "  demo  ", file: "design.md", comments: [{ excerpt: "e", text: "t" }] });
  assert.ok(spaced.text.startsWith("Review comments on demo/design.md"), "the feature name is trimmed");
});

test("SPEC_REVIEW_CONTEXT_KEYS name the count and mode keys the title badge reads", () => {
  assert.deepEqual(SPEC_REVIEW_CONTEXT_KEYS, { count: "kirocrew.spec.reviewCount", on: "kirocrew.spec.reviewMode" });
});
