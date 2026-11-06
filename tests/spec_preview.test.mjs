// node --test: the spec-preview plugin for the built-in Markdown preview, driven
// with a token stream shaped like markdown-it's and a renderer stand-in that
// follows markdown-it's Renderer contract (render / renderInline / renderToken,
// rules keyed by token type). No markdown-it dependency: the plugin only touches
// renderer rules and `render`, which is exactly what the stand-in provides.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const plugin = require(path.join(here, "..", "preview", "extension.js"));

class Token {
  constructor(type, tag, nesting) { this.type = type; this.tag = tag; this.nesting = nesting; this.attrs = null; this.map = null; this.children = null; this.content = ""; this.hidden = false; }
  attrIndex(name) { return this.attrs ? this.attrs.findIndex((a) => a[0] === name) : -1; }
  attrPush(a) { (this.attrs = this.attrs || []).push(a); }
  attrSet(name, value) { const i = this.attrIndex(name); if (i < 0) this.attrPush([name, value]); else this.attrs[i][1] = value; }
  attrGet(name) { const i = this.attrIndex(name); return i < 0 ? null : this.attrs[i][1]; }
  attrJoin(name, value) { const i = this.attrIndex(name); if (i < 0) this.attrPush([name, value]); else this.attrs[i][1] += " " + value; }
}
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** markdown-it's Renderer, reduced to what the plugin relies on. */
function makeMd() {
  const renderer = {
    rules: { text: (tokens, idx) => esc(tokens[idx].content) },
    renderAttrs(token) { return token.attrs ? token.attrs.map(([k, v]) => " " + k + '="' + esc(v) + '"').join("") : ""; },
    renderToken(tokens, idx) {
      const t = tokens[idx];
      if (t.hidden) return "";
      return "<" + (t.nesting === -1 ? "/" : "") + t.tag + (t.nesting === -1 ? "" : this.renderAttrs(t)) + ">" + (t.type.endsWith("_open") || t.type.endsWith("_close") ? "\n" : "");
    },
    renderInline(tokens, options, env) {
      let out = "";
      for (let i = 0; i < tokens.length; i++) {
        const rule = this.rules[tokens[i].type];
        out += rule ? rule(tokens, i, options, env, this) : this.renderToken(tokens, i, options);
      }
      return out;
    },
    render(tokens, options, env) {
      let out = "";
      for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        if (t.type === "inline") out += this.renderInline(t.children, options, env);
        else if (this.rules[t.type]) out += this.rules[t.type](tokens, i, options, env, this);
        else out += this.renderToken(tokens, i, options);
      }
      return out;
    },
  };
  return { renderer, options: {} };
}

/** A bullet list of task rows the way markdown-it tokenizes it (tight unless `loose`). */
function listTokens(rows, { loose = false, split = false } = {}) {
  const toks = [new Token("bullet_list_open", "ul", 1)];
  rows.forEach((text, i) => {
    const li = new Token("list_item_open", "li", 1); li.map = [i + 1, i + 2]; toks.push(li);
    const p = new Token("paragraph_open", "p", 1); p.hidden = !loose; toks.push(p);
    const inline = new Token("inline", "", 0); inline.content = text;
    if (split) {
      // before text_join: `[`, ` `, `]` and the rest as separate text tokens
      inline.children = [text.slice(0, 1), text.slice(1, 2), text.slice(2, 3), text.slice(3)].map((c) => { const t = new Token("text", "", 0); t.content = c; return t; });
    } else {
      const t = new Token("text", "", 0); t.content = text; inline.children = [t];
    }
    toks.push(inline);
    const pc = new Token("paragraph_close", "p", -1); pc.hidden = !loose; toks.push(pc);
    toks.push(new Token("list_item_close", "li", -1));
  });
  toks.push(new Token("bullet_list_close", "ul", -1));
  return toks;
}

const TASKS_ENV = { currentDocument: { fsPath: "/ws/.kiro/specs/my-feature/tasks.md", path: "/ws/.kiro/specs/my-feature/tasks.md" } };

test("specOf reads the spec name and phase from the render env; anything else is null", () => {
  assert.deepEqual(plugin.specOf(TASKS_ENV), { name: "my-feature", phase: "tasks" });
  assert.deepEqual(plugin.specOf({ currentDocument: { path: "C:\\ws\\.kiro\\specs\\x\\Design.md" } }), { name: "x", phase: "design" });
  assert.equal(plugin.specOf({ currentDocument: { path: "/ws/README.md" } }), null);
  assert.equal(plugin.specOf({ currentDocument: { path: "/ws/.kiro/specs/x/notes.md" } }), null);
  assert.equal(plugin.specOf({}), null, "a string render (markdown.api.render) has no document");
});

test("taskOf reads Kiro's four states and the optional mark off the leading text, with the rendered marker length", () => {
  const inline = (s) => ({ children: [{ type: "text", content: s }] });
  assert.deepEqual(plugin.taskOf(inline("[ ] 1. Open")), { state: "not_started", optional: false, markerLen: 4 });
  assert.deepEqual(plugin.taskOf(inline("[x] 1. Done")), { state: "completed", optional: false, markerLen: 4 });
  assert.deepEqual(plugin.taskOf(inline("[-]  2. Running")), { state: "in_progress", optional: false, markerLen: 5 });
  assert.deepEqual(plugin.taskOf(inline("[~] 3. Queued")), { state: "queued", optional: false, markerLen: 4 });
  assert.deepEqual(plugin.taskOf(inline("[ ]* 4. Optional")), { state: "not_started", optional: true, markerLen: 5 });
  assert.equal(plugin.taskOf(inline("plain bullet")), null);
  assert.equal(plugin.taskOf(inline("[ ]")), null, "a box with nothing after it is not a task");
  assert.equal(plugin.taskOf({ children: [{ type: "code_inline", content: "[ ] x" }] }), null, "only leading TEXT counts");
});

test("a tasks.md render boxes every task row, strips the bracket text and prepends the strip with counts", () => {
  const md = plugin.extendMarkdownIt(makeMd());
  const tokens = listTokens(["[ ] 1. Open task", "[x] 2. Done task", "[-] 3. Running", "[~] 4. Queued", "[ ]* 5. Optional", "a plain bullet"]);
  const html = md.renderer.render(tokens, md.options, { ...TASKS_ENV });
  assert.match(html, /^<div class="kc-spec-strip" data-kc-phase="tasks"><span class="kc-name">my-feature<\/span><span class="kc-phase">Task list<\/span>/);
  assert.match(html, /<span class="kc-count">1\/5 done<\/span><span class="kc-count kc-live">1 in progress<\/span><span class="kc-count kc-live">1 queued<\/span><span class="kc-count kc-opt">1 optional<\/span>/);
  assert.match(html, /aria-valuenow="20"/, "1 of 5 done");
  assert.match(html, /<li data-kc-state="not_started" class="kc-task kc-not_started">\n<span class="kc-box kc-box-not_started"[^>]*><\/span>1\. Open task/);
  assert.match(html, /<li data-kc-state="completed" class="kc-task kc-completed">\n<span class="kc-box kc-box-completed"[^>]*>✓<\/span>2\. Done task/);
  assert.match(html, /kc-box-in_progress"[^>]*>▶<\/span>3\. Running/);
  assert.match(html, /kc-box-queued"[^>]*>…<\/span>4\. Queued/);
  assert.match(html, /class="kc-task kc-not_started kc-optional-task">\n<span class="kc-box kc-box-not_started"[^>]*><\/span><span class="kc-optional"[^>]*>optional<\/span>5\. Optional/);
  assert.match(html, /<li>\na plain bullet/, "a bullet that is not a task is left alone");
  assert.ok(!/\[ \]|\[x\]|\[-\]|\[~\]/.test(html), "no bracket text survives");
});

test("loose lists (a <p> in every item) and pre-join split text tokens render the same", () => {
  const md = plugin.extendMarkdownIt(makeMd());
  const loose = md.renderer.render(listTokens(["[x] 1. Done"], { loose: true }), md.options, { ...TASKS_ENV });
  assert.match(loose, /<li data-kc-state="completed" class="kc-task kc-completed">\n<p>\n<span class="kc-box kc-box-completed"[^>]*>✓<\/span>1\. Done<\/p>/);
  const split = md.renderer.render(listTokens(["[ ] 1. Split"], { split: true }), md.options, { ...TASKS_ENV });
  assert.match(split, /<span class="kc-box kc-box-not_started"[^>]*><\/span>1\. Split/, "the marker budget spans several text tokens; the box is emitted once");
  assert.equal((split.match(/kc-box/g) || []).length, 2, "one box (class + modifier class), not one per text token");
});

test("design.md gets the header strip only; a non-spec document and a string render are untouched", () => {
  const md = plugin.extendMarkdownIt(makeMd());
  const tokens = listTokens(["[ ] looks like a task but this is design.md"]);
  const design = md.renderer.render(tokens, md.options, { currentDocument: { path: "/ws/.kiro/specs/my-feature/design.md" } });
  assert.match(design, /^<div class="kc-spec-strip" data-kc-phase="design"><span class="kc-name">my-feature<\/span><span class="kc-phase">Design<\/span><\/div>/);
  assert.match(design, /<li>\n\[ \] looks like a task/, "design.md rows keep their text");
  const readme = md.renderer.render(tokens, md.options, { currentDocument: { path: "/ws/README.md" } });
  assert.ok(!readme.includes("kc-"), "nothing of ours in a plain markdown file: " + readme);
  const str = md.renderer.render(tokens, md.options, {});
  assert.ok(!str.includes("kc-"));
});

test("rendering twice from the same cached tokens does not double the classes, and previously installed rules keep running", () => {
  const base = makeMd();
  let lineRuleCalls = 0;
  base.renderer.rules.list_item_open = (tokens, idx, options, env, self) => { lineRuleCalls++; tokens[idx].attrSet("data-line", String(tokens[idx].map[0])); return self.renderToken(tokens, idx, options); };
  const md = plugin.extendMarkdownIt(base);
  const tokens = listTokens(["[ ] 1. Open"]);
  const first = md.renderer.render(tokens, md.options, { ...TASKS_ENV });
  const second = md.renderer.render(tokens, md.options, { ...TASKS_ENV });
  assert.equal(first, second);
  const li = second.match(/<li [^>]*>/)[0];
  assert.match(li, /data-line="1"/, "the preview's own data-line renderer still ran");
  assert.match(li, /data-kc-state="not_started"/);
  assert.match(li, /class="kc-task kc-not_started"/, "class joined once across renders");
  assert.equal(lineRuleCalls, 2);
  assert.equal(tokens[1].attrGet("class"), "kc-task kc-not_started", "class joined once across renders");
  assert.equal(tokens[3].children[0].content, "[ ] 1. Open", "the cached inline text is never mutated");
});

test("summarize counts by state over a token stream", () => {
  assert.deepEqual(plugin.summarize(listTokens(["[ ] a", "[x] b", "[x] c", "[-] d", "[~]* e", "plain"])), { total: 5, not_started: 1, queued: 1, in_progress: 1, completed: 2, optional: 1 });
});
