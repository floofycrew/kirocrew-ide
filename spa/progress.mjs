// Spec-task completeness, as the IDE layer paints it: the hook reports, per
// open workspace, the boxes of its `.kiro/specs/*/tasks.md` files by state
// (`status.workspaces[].progress`, see hook `_spec_progress`); this module
// turns that record into a percentage, a label and a tiny donut (an inline
// SVG string) — the same geometry for the title-bar indicator, the workspace
// menu rows and the breakdown. Pure: no DOM, so it unit-tests in node.

/** Whole-number percentage of `done` in `total`; 0 when there is nothing to count. */
export function pct(done, total) {
  if (!(total > 0)) return 0;
  return Math.max(0, Math.min(100, Math.round((done / total) * 100)));
}

/**
 * The hook's record (or a workspace row carrying one) normalised: numbers
 * guaranteed, `active` = queued + in progress, `pct` computed, `specs` as rows
 * of the same shape. `null` when there is nothing to show (no specs
 * directory, or no task box in any spec yet) — the indicator hides then.
 */
export function summarize(record) {
  const raw = record && typeof record === "object" && "progress" in record && !("total" in record) ? record.progress : record;
  if (!raw || typeof raw !== "object") return null;
  const n = (v) => (Number.isFinite(Number(v)) ? Math.max(0, Math.floor(Number(v))) : 0);
  const total = n(raw.total);
  if (total <= 0) return null;
  const done = Math.min(total, n(raw.done));
  const inProgress = n(raw.inProgress);
  const queued = n(raw.queued);
  const specs = (Array.isArray(raw.specs) ? raw.specs : [])
    .map((s) => {
      const t = n(s && s.total);
      const d = Math.min(t, n(s && s.done));
      return { name: String((s && s.name) || ""), dir: String((s && s.dir) || ""), tasks: String((s && s.tasks) || ""),
        total: t, done: d, inProgress: n(s && s.inProgress), queued: n(s && s.queued), optional: n(s && s.optional), active: n(s && s.inProgress) + n(s && s.queued), pct: pct(d, t) };
    });
  return { total, done, inProgress, queued, optional: n(raw.optional), active: Math.min(total - done, inProgress + queued), pct: pct(done, total), specs };
}

/** "62% · 8/14 tasks" (+ " · 2 specs" when there are several; + " · 1 running" / " · 1 queued" while Kiro works). */
export function progressLabel(p, { specs = true } = {}) {
  const s = summarize(p);
  if (!s) return "";
  let label = s.pct + "% · " + s.done + "/" + s.total + (s.total === 1 ? " task" : " tasks");
  if (specs && s.specs.length > 1) label += " · " + s.specs.length + " specs";
  if (s.inProgress) label += " · " + s.inProgress + " running";
  if (s.queued) label += " · " + s.queued + " queued";
  return label;
}

/**
 * A donut as an inline SVG: a faint full track, the done share as a solid arc
 * from 12 o'clock, then the active share (queued + in progress) continuing it
 * in a second colour. Colours are CSS variables the layer sets from the
 * workbench theme (`--kide-done`, `--kide-active`), with fallbacks.
 */
export function donutMarkup(p, { size = 16, stroke = 2.5, className = "kide-donut" } = {}) {
  const s = summarize(p);
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const centre = size / 2;
  const doneLen = s ? (c * s.done) / s.total : 0;
  const activeLen = s ? (c * s.active) / s.total : 0;
  const arc = (len, offset, cls) =>
    len > 0
      ? '<circle class="' + cls + '" cx="' + centre + '" cy="' + centre + '" r="' + r + '" fill="none" stroke-width="' + stroke + '" stroke-linecap="butt"' +
        ' stroke-dasharray="' + len.toFixed(2) + " " + c.toFixed(2) + '" stroke-dashoffset="' + (-offset).toFixed(2) + '"></circle>'
      : "";
  return (
    '<svg class="' + className + '" viewBox="0 0 ' + size + " " + size + '" width="' + size + '" height="' + size + '" aria-hidden="true" data-pct="' + (s ? s.pct : 0) + '">' +
    '<circle class="kide-donut-track" cx="' + centre + '" cy="' + centre + '" r="' + r + '" fill="none" stroke-width="' + stroke + '"></circle>' +
    '<g transform="rotate(-90 ' + centre + " " + centre + ')">' +
    arc(doneLen, 0, "kide-donut-done") +
    arc(activeLen, doneLen, "kide-donut-active") +
    "</g></svg>"
  );
}
