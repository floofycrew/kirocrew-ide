// Mermaid for the built-in Markdown preview. Loaded as a preview script next to
// media/mermaid.min.js (the pinned build the KiroCrew IDE hook vendors in at
// provisioning). The preview adds its scripts with `async`, so this one waits
// for the `mermaid` global rather than assuming load order, then renders every
// ```mermaid fence in place and again whenever the preview swaps its content
// (`vscode.markdown.updateContent`). A diagram that does not parse keeps its
// source visible with the parser's message under it, never a blank.
(function () {
  "use strict";
  const LANGS = ["language-mermaid", "language-mmd"];
  let seq = 0;

  function themeName() {
    const body = document.body;
    if (body.classList.contains("vscode-high-contrast") && !body.classList.contains("vscode-high-contrast-light")) return "dark";
    if (body.classList.contains("vscode-dark")) return "dark";
    return "default";
  }

  function blocks() {
    const out = [];
    for (const code of document.querySelectorAll("pre > code")) {
      if (!LANGS.some((c) => code.classList.contains(c))) continue;
      const pre = code.parentElement;
      if (pre && !pre.dataset.kcMermaid) out.push(pre);
    }
    return out;
  }

  async function render() {
    const mermaid = window.mermaid;
    if (!mermaid) return;
    const pres = blocks();
    if (!pres.length) return;
    mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: themeName(), suppressErrorRendering: true });
    for (const pre of pres) {
      pre.dataset.kcMermaid = "1";
      const source = pre.textContent || "";
      const host = document.createElement("div");
      host.className = "kc-mermaid";
      host.id = "kc-mermaid-" + (++seq);
      if (pre.hasAttribute("data-line")) host.setAttribute("data-line", pre.getAttribute("data-line"));
      pre.parentNode.insertBefore(host, pre);
      try {
        const out = await mermaid.render(host.id + "-svg", source);
        host.innerHTML = out.svg;
        if (typeof out.bindFunctions === "function") out.bindFunctions(host);
        pre.style.display = "none";
      } catch (error) {
        host.className = "kc-mermaid kc-mermaid-error";
        host.textContent = "mermaid: " + ((error && error.message) || String(error)).split("\n")[0];
        pre.dataset.kcMermaid = "error";
      }
    }
  }

  function whenReady(cb) {
    if (window.mermaid) return void cb();
    const started = Date.now();
    const timer = setInterval(() => {
      if (window.mermaid) { clearInterval(timer); cb(); }
      else if (Date.now() - started > 20000) clearInterval(timer);
    }, 50);
  }

  function schedule() { whenReady(() => { render().catch(() => undefined); }); }
  window.addEventListener("vscode.markdown.updateContent", schedule);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", schedule); else schedule();
})();
