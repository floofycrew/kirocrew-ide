// node --test: the spec-task completeness helpers the IDE layer paints from.
import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { donutMarkup, pct, progressLabel, summarize } = await import(pathToFileURL(path.join(here, "..", "spa", "progress.mjs")).href);

// The hook's record for a workspace with two specs (see tests/progress_test.py).
const RECORD = {
  total: 14, done: 7, inProgress: 1, queued: 1, optional: 2,
  specs: [
    { name: "alpha", dir: ".kiro/specs/alpha", tasks: ".kiro/specs/alpha/tasks.md", total: 11, done: 5, inProgress: 1, queued: 1, optional: 2 },
    { name: "beta", dir: ".kiro/specs/beta", tasks: ".kiro/specs/beta/tasks.md", total: 3, done: 2, inProgress: 0, queued: 0, optional: 0 },
  ],
};

test("pct rounds to a whole number and clamps", () => {
  assert.equal(pct(7, 14), 50);
  assert.equal(pct(5, 11), 45);
  assert.equal(pct(0, 0), 0);
  assert.equal(pct(3, 0), 0);
  assert.equal(pct(20, 10), 100);
});

test("summarize: the record or a workspace row carrying it; active = queued + in progress; specs normalised", () => {
  const s = summarize(RECORD);
  assert.equal(s.pct, 50);
  assert.equal(s.active, 2);
  assert.deepEqual(s.specs.map((x) => [x.name, x.done, x.total, x.pct, x.active]), [["alpha", 5, 11, 45, 2], ["beta", 2, 3, 67, 0]]);
  assert.deepEqual(summarize({ folder: "/x", name: "x", progress: RECORD }), s, "a status row is unwrapped");
  // Nothing to show: no record, no specs directory, or no box yet.
  assert.equal(summarize(null), null);
  assert.equal(summarize({ folder: "/x", progress: null }), null);
  assert.equal(summarize({ total: 0, done: 0, specs: [] }), null);
  // Hostile numbers never break the donut.
  const odd = summarize({ total: "3", done: 9, inProgress: "nope", specs: [{ name: 1, total: -2, done: 1 }] });
  assert.deepEqual([odd.total, odd.done, odd.inProgress, odd.active, odd.pct], [3, 3, 0, 0, 100]);
  assert.deepEqual([odd.specs[0].name, odd.specs[0].total, odd.specs[0].done], ["1", 0, 0]);
});

test("the label reads percentage, count, spec count and Kiro's live states", () => {
  assert.equal(progressLabel(RECORD), "50% · 7/14 tasks · 2 specs · 1 running · 1 queued");
  assert.equal(progressLabel(RECORD, { specs: false }), "50% · 7/14 tasks · 1 running · 1 queued");
  assert.equal(progressLabel({ total: 1, done: 1, specs: [{ name: "a", total: 1, done: 1 }] }), "100% · 1/1 task");
  assert.equal(progressLabel(null), "");
});

test("the donut: a track, the done arc from 12 o'clock, the active arc continuing it", () => {
  const svg = donutMarkup(RECORD, { size: 16, stroke: 2.5 });
  const r = (16 - 2.5) / 2;
  const c = 2 * Math.PI * r;
  assert.match(svg, /^<svg class="kide-donut" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" data-pct="50">/);
  assert.match(svg, /class="kide-donut-track"/);
  assert.match(svg, /rotate\(-90 8 8\)/);
  const done = svg.match(/class="kide-donut-done"[^>]*stroke-dasharray="([\d.]+) ([\d.]+)" stroke-dashoffset="(-?[\d.]+)"/);
  assert.ok(done, "a done arc");
  assert.equal(Number(done[1]).toFixed(2), (c / 2).toFixed(2), "half the circumference for 7/14");
  assert.equal(Number(done[2]).toFixed(2), c.toFixed(2));
  assert.equal(Number(done[3]), 0, "starting at the top");
  const active = svg.match(/class="kide-donut-active"[^>]*stroke-dasharray="([\d.]+) [\d.]+" stroke-dashoffset="(-?[\d.]+)"/);
  assert.ok(active, "an active arc for the running + queued tasks");
  assert.equal(Number(active[1]).toFixed(2), ((c * 2) / 14).toFixed(2));
  assert.equal(Number(active[2]).toFixed(2), (-c / 2).toFixed(2), "picking up where the done arc ends");
  // Nothing done, nothing active: the track alone.
  const empty = donutMarkup({ total: 4, done: 0, specs: [] });
  assert.match(empty, /kide-donut-track/);
  assert.doesNotMatch(empty, /kide-donut-done|kide-donut-active/);
  // No record at all still draws a track (callers hide it; the markup never throws).
  assert.match(donutMarkup(null, { size: 12, className: "mini" }), /^<svg class="mini" viewBox="0 0 12 12"[^>]*data-pct="0"/);
});
