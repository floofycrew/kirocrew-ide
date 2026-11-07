<a id="readme-top"></a>

<div align="center">
  <a href="https://github.com/floofycrew/kirocrew-ide">
    <img src="app/ui/art/icon.svg" alt="KiroCrew IDE" width="160" height="160">
  </a>
  <h1><b>KiroCrew IDE</b></h1>
  <p>
    A full VS Code workbench inside your <a href="https://github.com/kirodotdev/KiroCrew">KiroCrew</a> dashboard &mdash; with KiroCrew chat, durable sessions and the Kiro spec workflow in the editor. One port, no extra tunnel.
  </p>
  <p>
    <a href="https://github.com/floofycrew/kirocrew-ide/issues/new?labels=bug">Report a bug</a>
    &middot;
    <a href="https://github.com/floofycrew/kirocrew-ide/issues/new?labels=enhancement">Request a feature</a>
    &middot;
    <a href="https://github.com/floofycrew/FloofyCrew">FloofyCrew, the mod manager</a>
  </p>
  <p>
    <a href="https://github.com/floofycrew/kirocrew-ide/releases/latest"><img alt="Release" src="https://img.shields.io/github/v/release/floofycrew/kirocrew-ide?style=for-the-badge&color=ff6b4a"></a>
    <a href="https://github.com/floofycrew/kirocrew-ide/blob/main/LICENSE"><img alt="License" src="https://img.shields.io/github/license/floofycrew/kirocrew-ide?style=for-the-badge&color=2d2d34"></a>
    <a href="https://github.com/floofycrew/kirocrew-ide/stargazers"><img alt="Stars" src="https://img.shields.io/github/stars/floofycrew/kirocrew-ide?style=for-the-badge&color=ffb347"></a>
    <a href="https://github.com/floofycrew/kirocrew-ide/issues"><img alt="Issues" src="https://img.shields.io/github/issues/floofycrew/kirocrew-ide?style=for-the-badge&color=2d2d34"></a>
  </p>
  <br>
  <img src=".github/shots/kirocrew-ide.png" alt="The KiroCrew IDE: a VS Code workbench docked in the KiroCrew dashboard, with KiroCrew chat in the side bar" width="900">
</div>

<br>

<details>
  <summary><b>Table of contents</b></summary>
  <ol>
    <li><a href="#what-is-it">What is it?</a></li>
    <li><a href="#why-use-it">Why use it?</a></li>
    <li><a href="#install">Install</a></li>
    <li><a href="#a-tour">A tour</a></li>
    <li><a href="#everything-it-does">Everything it does</a></li>
    <li><a href="#spec-coding-like-kiro">Spec coding like Kiro</a></li>
    <li><a href="#workflows-like-kiro">Workflows like Kiro</a></li>
    <li><a href="#parts">Parts</a></li>
    <li><a href="#requirements">Requirements</a></li>
    <li><a href="#install--develop">Install / develop</a></li>
    <li><a href="#config-keys-mod-config">Config keys</a></li>
    <li><a href="#one-port-only-remote-hosts">One port only</a></li>
    <li><a href="#tests">Tests</a></li>
    <li><a href="#license">License</a></li>
  </ol>
</details>

## What is it?

KiroCrew IDE is a [FloofyCrew](https://github.com/floofycrew/FloofyCrew) mod
that turns KiroCrew into your main IDE. It runs a VS Code web engine
(openvscode-server) as a loopback sidecar of the KiroCrew gateway, serves the
whole workbench **inside the dashboard, on the dashboard's own port**, and puts
KiroCrew into the workbench: chat with any crew agent, sessions that survive a
dropped ssh connection, tool approvals from the editor, and the Kiro spec
workflow (requirements &rarr; design &rarr; tasks &rarr; **Run all tasks**) over
`.kiro/specs`.

## Why use it?

- **One port** &mdash; the workbench is served same-origin at `/kirocrew-ide`;
  the port you already forward carries the IDE, nothing extra to tunnel.
- **KiroCrew inside** &mdash; chat tabs, per-project history, approvals and
  question cards in the editor; sessions run in the gateway, so closing the
  laptop loses nothing.
- **Kiro's spec workflow** &mdash; Specs, Steering, Skills and Agent Hooks views,
  **Run all tasks** on a `tasks.md`, a completeness donut per workspace.
- **Several workspaces, one engine** &mdash; a tab row like a browser's; idle
  workspaces sleep and wake in seconds.

Unofficial. Not affiliated with Kiro or the KiroCrew maintainers.

## Install

Needs [FloofyCrew](https://github.com/floofycrew/FloofyCrew) on the gateway
host. Then:

```bash
floofy install kirocrew-ide
```

or click *Install* on the dashboard's **FloofyCrew** page, restart the gateway
once (the same-origin route is added while it composes its router; the
FloofyCrew page has the button), and open **Apps &rarr; KiroCrew IDE**: pick a
folder, press **Start**. The first start offers to download the engine
(openvscode-server, MIT, ~100 MB) after your confirmation; an
`openvscode-server` or `code-server` already on PATH is used instead.

<div align="right">[<a href="#readme-top">back to top</a>]</div>

---

## A tour

**The App page** is where a workspace starts: a folder picker with recent
workspaces, Start/Stop, engine install, and the workbench docked right there
while the engine runs. **Fullscreen** raises it over the whole dashboard.

<div align="center">
  <img src=".github/shots/kirocrew-ide-app.png" alt="The KiroCrew IDE App page before a workspace is opened" width="860">
</div>

**The workbench** is VS Code with KiroCrew in the secondary side bar: one
session per chat tab, every installed agent in the picker, approvals inline,
file paths as links into editor tabs. Out of the box the workbench follows the
dashboard's light or dark mode with the matching stock VS Code theme; pick any
other theme and it stays yours. A stock theme follows a dashboard toggle you
make while the window is open; opening a window never changes your theme
(until 0.30.11 it did: the first poll counted as a change, so a stock theme of
the other polarity was flipped on every window load, and a fresh engine start
flipped every workspace at once).

<div align="right">[<a href="#readme-top">back to top</a>]</div>

---

## Everything it does

- **KiroCrew IDE** in the Apps sidebar: a folder picker (recent workspaces +
  browse; its list opens over the docked workbench, not under it), Start/Stop,
  engine install, and the workbench **docked in the
  page** while the engine runs, with a **Fullscreen** button that raises it
  over the whole dashboard (not the OS fullscreen). It is one persistent
  layer either way: it stays warm while hidden or docked, so going back to
  KiroCrew, leaving the page and returning never reloads it. A bouncing
  FloofyCrew fox covers the workbench while it boots; the empty-editor
  watermark is the fox in grey.
- **Tag stacks** to move without leaving the IDE: in KiroCrew's own crew
  switcher the host's chip grows an attached **`IDE`** segment
  (`[host]IDE]`) while the IDE runs there, lit while it is fullscreen. The
  layer's title bar has ◁ KiroCrew, a host dropdown (the crew on screen as the
  trigger; the menu lists Local and every remote the desktop app knows, the
  current host marked "you are here" and returning to its dashboard, the
  others switching hosts through the desktop window exactly as KiroCrew's own
  bar does; colours follow the workbench's menu theme) with the same lit
  `IDE` segment joined to it (`[host ▾]IDE · folder ▾]`). Esc closes a menu,
  then leaves fullscreen like ◁ KiroCrew does — onto the App page's dock when
  that page is open, otherwise back to the dashboard. In a plain browser tab
  without a crew bar a standalone
  `<host> IDE` chip sits in the top bar.
- **Several workspaces on one host.** The `IDE` segment is a dropdown — the
  workspace manager: every folder open on the engine (the one on screen
  marked, a × to close it) and **Open a folder…**, which opens **KiroCrew's
  own folder picker** (the Recent / Browse picker the chat composer and the
  Spec Builder use, fed by the dashboard's recent-projects and browse APIs),
  anchored under the tag and painted over the fullscreen IDE, so another
  project opens without leaving fullscreen. The App page's folder field opens
  the same picker. The dashboard does not export that component, so the mod
  reaches it through the chunk the dashboard preloads (`spa/hostpicker.mjs`,
  no build hash hardcoded); a dashboard without it gets the mod's own
  combobox (recent workspaces, then the engine-side directory listing). The picker's box is
  raised above the fullscreen IDE by a rule keyed on its own `pp-…` element ids on *any*
  of its tabs; until 0.30.7 the rule named the Recent and Browse lists only, and KiroCrew
  0.11's picker, which opens on a Favorites tab when favourites exist, flashed for its
  first paint and then vanished behind the IDE. One engine serves them all; each
  workspace is its own workbench document, created when first shown and kept
  warm, so switching never reloads anything. The App page mirrors this: Start
  reads **Open** while the engine runs and adds the folder, and a tab row sits
  on the workbench like a browser's (click to switch, × to close, **+** opens
  the folder picker). Closing the last one leaves the engine up with nothing
  open. Each warm workspace is a live workbench: on the client it is a full
  VS Code renderer (roughly 300–450 MB of browser memory each), and on the
  host it is its own extension host, file watcher and language servers
  (150–400 MB each, growing with the extensions a folder activates). So
  **inactive workspaces sleep**: a document that has been off screen (another
  workspace in front, or the IDE left for other dashboard pages) for 15
  minutes is unloaded, which frees both sides within a second. The workspace
  stays open; its tab shows ☾ and the menu row reads *asleep*; switching to
  it reconnects in a few seconds, with the workbench's own hot exit and
  terminal persistence covering the gap. The limit is the **Sleep inactive
  workspaces after** select at the bottom of the workspace menu (never, 5,
  15, 30, 60 min), a host-wide setting (`idle_unload_minutes`). A freshly
  created document (first show, or a wake) that has not connected to the
  engine within 20 s is reloaded once by the layer: the host counts the
  WebSocket bridges that reached the engine (`status.proxy.websockets`), and
  a document whose budget passes with that count unchanged is the blank page
  the desktop client could show after a wake. One reload, never a loop; a
  second miss is left to the workbench's own connection-error dialog.
- **Task completeness per workspace.** A tiny donut and percentage sit at
  the workbench's top right, just left of its own layout controls (measured
  from the live title bar so they never overlap), in docked and fullscreen
  mode alike: the share of ticked boxes in the workspace's
  `.kiro/specs/*/tasks.md` files, every box counted (parent and sub-task,
  optional `*` ones too), the done share in the theme's chart green and the
  queued / in-progress share Kiro's orchestrator writes (`[~]` / `[-]`) in
  its chart blue. Several specs combine into the one figure; click it for
  the breakdown: the combined count, then a row per spec directory with its
  own donut, `done/total` and the live states. The workspace menu's rows and
  the App page's tabs carry the same mini donut per workspace, so every open
  folder's progress is one glance away. The hook counts the files on each
  status poll (re-read only when a file changes), so a tick the agent writes
  shows within seconds. Nothing is shown for a folder without spec tasks.
- **The bar keeps out of the workbench's way.** In fullscreen the layer's bar
  (`◁ KiroCrew | host ▾ | IDE · folder ▾`) ends where the workbench's own
  title-bar centre (the ← → arrows and the command centre) begins, measured
  from the live document and re-measured on resize. The command centre itself
  is served at half its stock width (`command_center_scale`, default `0.5`):
  the stock 38vw / 600px pill shows only "Search <folder>" and took most of
  the title bar once docked in the dashboard. Under that budget the
  folder name is the piece that gives way: it is not ellipsised but faded at
  the cut edge, like KiroCrew's crew row. Rest the pointer on the chip and
  the name glides to its end (and back when you leave); a wheel or trackpad
  anywhere on the chip scrolls it by hand; the full path is in the tooltip
  and the menu. The bar's text colours are derived for readability rather
  than copied from the theme: the command-centre foreground is used only
  when it reaches 3:1 on the pill, else black or white by luminance; the
  accent for the lit `IDE` word and the count badge keep their theme colour
  only when it reads, so a light theme with a pale foreground (Tempest) no
  longer paints the folder name in near-invisible grey.
- **Profiles follow you.** The web workbench keeps the profile list in the
  browser, per origin, so a profile imported in the desktop app used to be
  missing in a browser tab (or after the app's storage moved) while its data
  sat on the host. The mod now seeds every client's list from the engine's
  own record of the profiles that exist on disk. The Profiles editor's **Use
  for New Windows** choice is honoured too: a folder opened from the mod with
  no profile of its own boots into that profile (the web workbench alone only
  reads the URL and the folder's association, never that setting; the mod reads
  it from the browser's user-data store and rewrites the URL before the
  workbench starts, with one early reload the first time after you toggle it).
  A profile you picked for a folder with *Switch Profile* still wins — and
  that choice follows you too. The web workbench keeps *which profile a folder
  opens in* in the browser as well, and never tells the server (the engine's
  mirror of it is always empty), so a folder you had given a profile in the
  desktop app used to open in Default from a browser tab. The layer, which
  shares the dashboard origin with every workbench document, now reports the
  browser's folder → profile map to the host (once at start, and after every
  change a workbench makes to it), the host keeps it by folder path, and every
  served document seeds the record into the browser before the workbench boots
  — only for folders that browser has no entry of its own for, so a choice
  made in this browser (switching a folder back to Default included) is never
  overwritten. The same seed heals a second, quieter loss: the workbench keys
  those entries by the engine's `127.0.0.1:<port>`, so a relaunch that landed
  on the next free port orphaned every earlier choice; an entry held under an
  old port is copied to the current one. **A relaunch now keeps its port.** Until
  0.30.4 every relaunch (each new bridge version relaunches) flipped the engine
  between 35476 and 35477: the stop watched the `sh` wrapper's pid, which dies
  at once, while `node` was still closing the listener, so the port read busy
  250 ms later and the next one was taken. The workbench writes
  `__default__profile__` itself the first time a folder boots with no entry
  under the current port, and that stale Default came back on every other
  relaunch, so a folder given a profile on one port opened in Default on the
  other (2026-11-05). The stop now waits for the port to be released and the
  relaunch takes it again (the probe binds with `SO_REUSEADDR`, like node, so
  TIME_WAIT leftovers do not count). The seed also repairs the damage already
  in a browser's map: a Default under the current port gives way to a real
  profile the same browser holds under an earlier port, and once a folder has
  its entry under the workbench's own authority the copies under earlier ports
  are dropped, so they cannot come back. (A Default you chose on purpose for a
  folder that still has an old-port entry is undone once by that repair; pick
  it again and it stays, there is no old entry left to fight it.) **A Default
  is never a choice.** The web workbench writes the profile it booted into for
  the folder on *every* boot (`web.main`'s `setProfileForWorkspace` right
  after picking it), so a folder's first boot in any browser, or under any
  engine port, leaves `__default__profile__` behind, indistinguishable from a
  user switching to Default. Until 0.30.5 the host recorded those, the seed
  copied them into every other browser, and a Default association switched the
  folder off "Use for New Windows" for good: one new client booting a folder
  put every other client into Default on its next reload. Now a Default is
  never recorded, shipped or copied (stale ones in the host record are purged
  on the next write), and "Use for New Windows" applies to a folder whose only
  association is a Default. The one casualty: a folder you switched back to
  Default on purpose boots into the new-window profile again while that setting
  names one; clear the setting to keep a folder in Default. **Two faults fixed in
  0.30.6, both found live in a user's browser.** The profile-list seed copied
  the server's records with the server's `location` shape (a bare id); the
  browser service stores a URI object and its loader aborts the whole list at
  the first string, so a browser whose list the seed had filled saw *no*
  profiles at all: an empty picker, every folder in Default, and the list
  rewritten to `[]` on the next save ("my profile disappeared"). The seed now
  writes `{"$mid":1,"scheme":"vscode-userdata","path":"/User/profiles/<id>"}`
  and repairs entries an earlier seed stored. And the association seed keyed
  entries by the configuration meta's `remoteAuthority` (the engine's own
  `127.0.0.1:<port>`, since the proxy drops the browser's Host) while the
  workbench keys them by the page's `location.host` (openvscode's
  `workbench.ts`); from 0.30.4 that seed moved every real entry to the dead
  authority and pruned it, so a folder switched to a profile booted into
  Default on the next reload. The seed now keys by `location.host`, repairs
  the dead-authority copies back, and a real profile (this browser's own or
  the host record's) replaces a Default under the live key, a Default being
  never a choice. The one shape of Default that *is* a choice, a switch in a
  live document (real → Default), is reported by the layer as `cleared` and
  removed from the host record, so it is not brought back. The host pins the
  record by the dashboard host the browser reported from (its `Host` header).
- **KiroCrew Chat** in the IDE's secondary side bar (the built-in AI chat is
  turned off): tabs, one KiroCrew session per tab, per-project **History**
  (every session whose project is the open folder — created here or in the
  dashboard — reopens in a tab; most recent activity first, each row dated
  by its age), any installed agent, live streaming, paths
  as links into editor tabs, Approve/Reject and question cards inline. A chat
  pane that comes up blank is reloaded by the bridge itself (twice, 8 s apart)
  before it tells you; **KiroCrew: Reload chat view** (also in the view's ⋯
  menu) does the same by hand, and the **KiroCrew IDE** output channel says
  what happened. The composer's model/effort/Autopilot picks are yours alone:
  what a live session actually runs with is shown on its tab but never
  inherited by the next tab, and a model id the host's catalog has retired is
  dropped (with a note) instead of pinned on a new session. The tab that was in
  front is remembered with the tabs: a reopened window comes back on it (until
  0.30.8 it always opened the first, oldest tab); a record without that memory
  opens on the newest chat.
- **Steering, Kiro's way.** Every chat started here runs on kiro-cli with the
  open folder as its working directory, so the workspace's `.kiro/steering`
  and `~/.kiro/steering` load exactly as Kiro CLI loads them: a file with no
  front matter or `inclusion: always` is in every turn, while `fileMatch` and
  `manual` files are left out by the agent itself (verified against kiro-cli
  2.33). Subdirectories count: the agent's `steering/**/*.md` resource walks
  them (verified on kiro-cli 2.34, `steering/a/b/c.md` loads like
  `steering/c.md`), and the bridge's own inventory walks them too, naming a
  nested file by its path under the steering dir (`#amazon-builder/git`, or
  the bare `#git` when no other file has that name). Who loads the `always`
  tier depends on the host's agent engine, so the receipt says which: on KAS
  (`acp_backend: kas`, the default) both tiers load for **every** agent, Kiro's
  built-in Spec mode included, whatever the agent's `resources` say (verified on
  kiro-cli 2.34 `--v3`: an agent with no `resources` key and one whose
  `resources` omit steering both got the files, `manual` ones excluded); on the
  legacy engine steering comes only through the agent's `resources`, and the
  receipt warns when they leave it out. A Spec tab whose mode agent the host
  refuses re-posts the receipt for the agent it falls back to. The bridge adds the other two modes the way Kiro's IDE does
  ([inclusion modes](https://kiro.dev/docs/steering/)): a `fileMatch` file
  whose `fileMatchPattern` matches a file in the turn's context (a `#` file or
  open-files pick, the editors on screen) and a `manual` or `auto` file the
  message names with `#file-name` ride along as context, each shown as a
  `#steering: name` chip on the turn. A compass indicator in the composer
  counts the always-included files and lists every steering file with its
  mode (click a manual one to include it now, an always one to open it); a
  session's first turn prints a *Steered by …* receipt naming the always files
  per tier, and warns when the chosen agent's `resources` leave steering out.
- **The input box is yours to size.** It grows with what you type (to about
  45% of the pane); drag the grip on its top edge for a height of your own,
  remembered per workspace; double-click the grip to go back to automatic.
- **Your turn shows the instant you send it.** The page draws your bubble
  (text, `#` chips, image thumbnails) and starts the working foxes on Enter,
  before the extension has created the session, applied your picks, uploaded
  the files, scanned steering and injected the contexts; the extension's own
  copy of the turn then completes that bubble in place (the uploaded paths,
  for the lightbox's Open file) rather than adding a second one. If the send
  fails, the error lands under the bubble and the pane is released. The
  steering inventory, read on every send through the remote fs, is cached for
  20 s and dropped the moment a steering file changes.
- **Pictures in the chat.** An image pasted into the composer, picked with 📎
  or dropped onto the composer shows as a thumbnail in the chip row (× to
  remove, click to preview) before it is sent; in your bubble it is the picture
  itself, with any other file as a 📎 chip that opens it. A transcript loaded
  from history shows the same: the `[attached_file N]` markers are resolved
  against the row's file list (a path with a space survives) and each image is
  fetched through the extension, since the page cannot read the disk and the
  dashboard keeps uploads outside the workspace (`~/.kiro/crew/uploads/`). A
  markdown image in an answer (`![chart](/tmp/out/chart.png)`, an https URL
  too) is drawn in place instead of linking to the file. Every picture opens a
  lightbox on click (full size, the file name, **Open file** for an editor tab,
  Esc to close). Images over 8 MB are not previewed: the card names the file and
  opens it; a missing file is an error note with the path as a link. Fetched
  images are cached per path for the window.
- **Scroll up to read; jump back when you want.** The transcript follows new
  rows only while it is at the bottom (within 8px, the dashboard's rule).
  Scrolled up, streaming text and new rows land without moving the view, and a
  **Jump to latest** pill appears over the pane's bottom edge; it reads **New
  messages** and takes the accent colour once something arrived unseen. A click
  scrolls to the end (smoothly, instantly under reduced motion) and following
  resumes; scrolling back down by hand does the same. Your own turn and a
  reload always land at the bottom. The pill is the active tab's: each tab
  keeps its own position.
- **A reading column in a wide pane.** The transcript, the pinned prompt and
  the composer sit in a centred column, with the dashboard's three Chat
  settings presets (`kirocrew.chatWidth`): **compact** (default) is an 800px
  column (816px for the composer) scaled by the message font size, so no line
  runs the width of a 1400px panel; **comfortable** is 84% of the pane, **full**
  92%. A pane narrower than the column is unaffected (its 8px gutters stay).
- **KiroCrew** activity-bar views: *Specs* (`.kiro/specs/<name>/`, phase
  commands, ▶ Start task per row, ⏵⏵ Run all tasks per spec, ⟳ Resume run on a
  spec whose tasks.md still carries a run's `[~]` / `[-]` marks, Kiro's queued /
  in-progress / done marks; the rest is under *Spec coding like Kiro* below),
  *Steering*, *Skills*, *Agent Hooks* — each showing
  the workspace's `.kiro/` and the global `~/.kiro/` tier, with a ＋ that
  scaffolds a new file or skill folder (a wizard for a hook); their generate,
  refine and import actions are under *Workflows like Kiro* below. The bridge is registered for **every
  VS Code profile** (application-scoped), so a profile you create or import
  keeps the chat and these views, and its activity bar gets KiroCrew in
  second place too.
- The model's reasoning renders the way KiroCrew's own transcript renders it:
  one collapsed **Thinking** block per thinking phase with a one-line live
  tail while it streams, **Thought process** once it goes quiet, the full text
  a click away; a tool call or the answer closes the block and later reasoning
  opens a new one.
- The transcript takes KiroCrew's own shape: your turn is a fit-width bubble
  on the right (small radius, the workbench's input colours), the agent's
  answer is bare text, tool lines are quiet mono rows, code blocks have the
  dashboard's padding and a hairline. **Your last prompt stays in view:** once
  the transcript scrolls past a user turn, that turn is pinned at the top right
  as a one-line card in the bubble's colours (KiroCrew's pinned prompt): three
  lines on hover, the whole prompt on its ⌄, and a click on the text scrolls
  back to where the turn starts. The card slides away as the next turn reaches
  it and that turn takes its place. **Tool calls open on click:** a 🔧 row's
  header toggles a body with the call's Input (a shell call shows its command,
  a one-field call its value, anything else pretty JSON) and Output (the
  result once the tool returned; a pulsing dot and "running…" until then),
  paths linked into editor tabs, both clipped at 20 KB with a marker. **Rest
  the pointer on a collapsed row and it shows what it ran** (KiroCrew's own
  tool-command tip, since 0.30.9): a shell call's command in a hover widget
  above the row, one line per pipeline segment with `$` and then each operator
  (`&&`, `||`, `;`, a pipe in the accent colour) in the gutter; a command with
  newlines verbatim; an MCP row whose label is its purpose shows its raw title
  instead. **The colours are the editor's own** (0.30.10): the command is
  tokenized in the engine's extension host with the workbench's own
  vscode-textmate and the built-in shellscript grammar (`source.shell`), and
  coloured by the rules of the colour theme you have on, its `include` chain
  and your `editor.tokenColorCustomizations` included, so the tip reads
  exactly like a `.sh` file in the editor, under Dark Modern, Nord, Horizon or
  whatever you installed. A theme switch repaints the next tip. The bridge
  cannot do this itself (a browser-worker host has no tokenizer, and a webview
  gets only the workbench colours as variables, never a theme's token colours),
  so it asks the mod's engine-host extension through the
  `kirocrew.preview.highlight` command; where that is unavailable the tip
  falls back to its own four kinds (program, flag, string, redirect) from
  `--vscode-*` variables. Twelve segments or lines and 1200 characters at most, then "Open the
  step to see the rest". The tip appears 100 ms after the pointer rests (at
  once on keyboard focus), only while the row is collapsed, and only when it
  says more than the label does: a row labelled with its whole command has
  none, as in the dashboard. A click, a scroll, a tab switch or Esc hides it.
  The header's native tooltip is gone (it collided with the tip); a task-status
  bookkeeping row keeps its note there. While the agent works and no answer is
  streaming yet (reasoning, tool calls, the wait for the first token) four
  small FloofyCrew foxes hop in turn under the last row, where KiroCrew shows
  its ghosts; they go still under *prefers-reduced-motion*.
- **The host's own notices are cards, not prose.** KiroCrew writes what it did
  to a turn as `inject` rows: a tool call its safety policy stopped (`[Tool
  blocked — reason sent to the agent] policy …`), a turn it resumed after a
  dropped connection or a stall, a Continue you asked for, a sub-agent
  synthesis. The IDE folds each into the dashboard's collapsed recovery card —
  a one-line header with the dashboard's own title and detail ("Tool call
  blocked · safety policy blocked the call · the agent was told why, in this
  turn"), the matched policy pattern as a mono chip (or "N patterns"), the
  whole notice under it on click, paths in it as links. Blocked, refused and
  stalled kinds carry the warning icon; resumed turns, a Continue and a
  synthesis are routine. A gateway notice with no known prefix is a generic
  "System notice" card; an automation notice draws nothing; cron notifications
  stay the quiet row they were.
- **Kiro's `task_status` rows say what they are.** Every status change the
  task orchestrator writes into `tasks.md` (`[~]` queued, `[-]` in progress,
  `[x]` done) is announced as a `task_status` action with no input, no output
  and no title; kiro-cli relays it as a completed tool call and KiroCrew
  persists it as such (one spec run had 410 of them among 698 tool rows). The
  only trace of *which* task is the action id (`…_taskStatus_1_1_Create__conne`:
  the task's line sanitized, capped at 64 chars), so the row reads "Task
  status · 1.1 Create conne…" with a 📋, and opening it shows a note saying what
  the row is instead of "(no output)".
- Attachments travel exactly as the dashboard composer sends them: each file
  is uploaded to the host and referenced by an `[attached_file N] <path>`
  marker with the path list in the send's `meta.files`, so the host inlines an
  image as a real image block, leaves other files on disk for the agent's
  tools, and its own transcript shows the same attachment cards for a session
  started here. (Earlier builds pasted `Attached file: <path>` prose, a shape
  the host never writes itself.)
- Sessions run in the gateway. Close the laptop, drop the tunnel, come back
  from the dashboard or your phone: same session, same transcript.

<div align="right">[<a href="#readme-top">back to top</a>]</div>

---

## Spec coding like Kiro

Since 0.31.0 the bridge reads and writes specs the way Kiro's IDE does, so a
`.kiro/specs/<name>/` directory moves between the two without translation.
Everything below works in the plain text editor; the Kiro spec editor (the
rendered view) adds review comments on top.

- **`.config.kiro`.** Kiro's per-spec settings file next to the documents:
  `{"specId", "workflowType", "specType"}`. `workflowType` is
  `requirements-first` (default), `design-first` or `fast-task`; `specType` is
  `feature` (default) or `bugfix`. A missing or unreadable file means the
  defaults; an invalid one (bad JSON, an unknown value) gets a warning in
  Problems (source `kirocrew-spec`) and is still read with defaults. The type
  decides the **document order** — requirements → design → tasks,
  design → requirements → tasks, tasks first for a fast task, and `bugfix.md`
  in place of `requirements.md` for a bugfix — which the Specs view, the
  title-bar actions and the hovers all follow. The active editor's spec sets
  the `kirocrew.spec.workflowType` / `kirocrew.spec.specType` context keys, so
  your own keybindings can key on them too.
- **The Specs view.** ＋ is **New spec from an idea**: type the idea, pick the
  workflow type, pick the spec type, and the bridge creates the directory with
  a fresh `specId`, then sends the create turn to the Spec agent in a tab
  titled with your idea. A spec row has **Rename** (`^[A-Za-z0-9_-]+$`, a name
  already taken is refused), **Delete** (asks first, names the directory, then
  removes it), **View session** (the latest run that touched it) and the
  phase commands as before; a document row has **Review**, which opens it in
  the spec editor with review mode on. Rows follow the document order: a fast
  task lists `tasks` first with `requirements` and `design` as *generated*
  rows, a bugfix lists `bugfix.md`. The view refreshes on its own when a spec
  directory or `.config.kiro` changes.
- **Title-bar actions on a spec document.** Every `requirements.md`,
  `design.md`, `tasks.md` or `bugfix.md` under `.kiro/specs` gets **Go to
  requirements / design / tasks / bugfix** in its document order with the
  current one left out (a missing target is created empty and opened), then
  **Sync with project files** (`Ctrl+Shift+Enter` / `⌘⇧↩`, shown once the
  document has content or unsaved edits: the Spec agent re-reads the project
  and updates this document), **Next document** (opens the next one when it
  has content, otherwise asks the agent to write it; absent on `tasks.md`) and,
  on `tasks.md`, **Run all tasks** (`Ctrl+Alt+Enter` / `⌘⌥↩`). **Previous
  document** and **Next document** are in the palette as well. Each of these
  turns reuses the spec's own chat tab when it is idle and attaches the sibling
  documents as `#file` context.
- **Task ↔ session links.** Start task and Run all tasks record which session
  ran which tasks (`kirocrew.taskSessionLinks` in workspace state, the 200 most
  recent, with the turn's outcome: ok, error or stopped). **View session** — a
  lens on the task, a Specs view row, or `KiroCrew Spec: View session` — brings
  that tab to the front, or reopens the session from history when the tab is
  gone; a task that never ran falls back to the spec's latest run.
- **Code lenses and borders in `tasks.md`.** One lens row above every task,
  titled for its state: **Start task**, **Queued** (`[~]`), **In progress**
  (`[-]`), **Done** (`[x]`), **Failed · Retry · Ask the agent to fix** (the
  last run ended in an error; *Ask the agent to fix* sends the task block with
  the spec as context and asks for the root cause, not the symptom, then a
  stop after that task), **Stopped · Retry** (the run was interrupted and
  that session is no longer running). **View session** follows whenever a run
  is on record; an optional `[ ]*` task reads **Start task · Make required**,
  which drops the `*` on that line alone. Each task block carries a 2 px left
  border in a theme colour per state (code-lens grey, info blue, highlight,
  untracked green, error red, warning yellow), and optional tasks are dimmed to
  60%. Lenses and borders redraw within a second of a change to the file or to
  a run — a tick the agent writes shows while you watch.
- **Task format diagnostics.** `tasks.md` is checked as you type (source
  `kirocrew-spec`): a box that is not `[ ]`, `[~]`, `[-]` or `[x]`; a task line
  with no number, or a number not shaped `1`, `1.2`, `1.2.3`; a nesting jump of
  more than one level; a duplicate number. Every warning has the **Fix task
  line** quick fix: the box becomes `[ ]`, a missing or duplicate number
  becomes the parent's next free index, the title is untouched. A file with no
  task lines gets nothing.
- **Hovers.** Rest the pointer on a `_Requirements: 1.2, 3_` line in any spec
  document and each reference shows its requirement heading (a link that
  reveals the heading in `requirements.md`, or `bugfix.md` for a bugfix spec),
  the user story and the acceptance criteria named — all of them when the
  reference has no sub-number. A `Property N` / `**Property N**` reference or a
  `Validates: Requirements …` line shows the property's title from the
  design's *Correctness Properties* section and the criteria it validates.
- **Review comments in the spec editor.** The rendered spec editor has a
  **💬 Review** toggle with a count badge. With it on, click a heading,
  paragraph, list item, task row, code block or table and a comment box opens
  there (Esc cancels, `Ctrl+Enter` / `⌘↩` saves); saved comments sit beside
  their block as cards with **Edit** and **Delete**, survive **⟳ Sync Files**
  (re-attached by block id; a block that disappeared keeps its comment in an
  *unanchored* list), and are dropped when the editor closes. **Send N
  comments** packs them into one turn — the document, each quoted passage with
  its comment, and the instruction to apply them to this document and nothing
  else — sent to the Spec agent through the spec's tab and shown in the
  transcript as `Review: N comments on design.md`; the comments clear once the
  turn is away. Review mode covers requirements, design and tasks; other files
  open as text.

<div align="right">[<a href="#readme-top">back to top</a>]</div>

---

## Workflows like Kiro

0.32.0 adds the rest of what Kiro's IDE does around the chat: its keyboard
flow and find bar, the context kinds its `#` picker offers, the editor,
terminal and source-control hand-offs, steering generation and import, skill
import and an Agent Hooks view that edits hook files. Every turn these send
goes through the same send path as a typed message — agent, model, autopilot,
steering and the KiroCrew policy apply as they would in the composer — and the
instruction text is the mod's own.

### Chat shortcuts, rename and find

- **Tabs from the keyboard** (while the chat view has focus): `Ctrl+Alt+→` /
  `⌘⌥→` and `Ctrl+Alt+←` / `⌘⌥←` switch to the next / previous tab,
  `Ctrl+T` / `⌘T` opens a new one, `Ctrl+W` / `⌘W` closes the active tab — a
  tab whose session is still running asks first (the session keeps running in
  the gateway; it stays under History). Each is a palette command too
  (**KiroCrew: Next chat tab**, **Previous chat tab**, **New chat tab**,
  **Close chat tab**).
- **Rename chat tab** — the view's ⋯ menu, a double-click on a tab, or
  *Rename* in a tab's right-click menu (next to *Close tab*). The title is kept
  with the tab (120 characters at most) and, when the tab has a session, the
  gateway is asked once to rename it as well (`PATCH /chat/slots/<key>/title`,
  the call the dashboard's title edit uses); a refused rename leaves the label
  local.
- **Find in the transcript** — `Ctrl+F` / `⌘F` (or **KiroCrew: Find in chat
  transcript**; `F3` / `Shift+F3` step without opening the box) opens a find
  bar over the active tab: a match count, `Enter` / `↓` and `Shift+Enter` /
  `↑` for next and previous, **Aa** for match case, `Esc` closes. Matches are
  marked in message text, tool-row labels and code blocks, and the current one
  is scrolled into view; following the bottom of the transcript is suspended
  while the bar is open (the jump pill shows what arrived meanwhile).
- **Approve all / reject all** — with approval cards pending in the active
  tab, `Ctrl+Enter` / `⌘↩` approves every one of them and `Ctrl+Shift+C` /
  `⌘⇧C` rejects them, exactly as pressing each card's buttons would; with
  nothing pending the shortcuts do nothing (`Ctrl+Enter` in the composer then
  sends, as before).
- **Tool rows**: the setting `kirocrew.toolCardDisplayMode` is Kiro's Tool Card
  Display Mode — `collapseOnComplete` (default: a row folds to its header when
  the call returns; one you opened or closed yourself stays as you set it) or
  `alwaysExpanded`. A change applies to the rows already on screen.

### Context providers

The composer's `#` picker (also the **#** button, or `#` typed into an empty
composer) lists **File**, **Currently Open Files** and **Steering** as before,
then the providers Kiro has:

- **Problems** — the diagnostics of the active file or of every file (asked
  when an editor is open), one line each: `file:line:col severity [source
  code]: message`.
- **Terminal** — the active terminal's selection; without one, the last 200
  lines of what shell integration recorded (`$ command` + output); without
  that, the last command's output; else a note asking you to select text.
- **Git Diff** — working-tree and staged diff of the workspace, through the
  built-in git extension when it runs in this host, else the gateway's own
  `gitdiff` route; an explicit message when neither answers.
- **Folder** — a directory's listing followed by the contents of its text
  files (binaries skipped, at most 200 files).
- **Spec** — a spec's documents concatenated, one `## <file>` section each, in
  that spec's document order.

Each resolved text is one context document on the turn, injected the same way a
`#file` is. The cap is 36 000 bytes per item (the host's own limit, less room
for the label line): a longer item is cut on a character boundary and ends in
`… [truncated: N of M bytes shown]`. The item is a chip in the composer and, on
send, in your bubble; the chip's tooltip names the source and says when it was
cut.

### Editor, terminal and source control

- **The KiroCrew submenu** of the editor's right-click menu, shown while text
  is selected: **Ask about this** stages the selection as a `#selection` chip
  (path, range and language ride along) and leaves the composer to you; **Fix
  grammar and spelling**, **Write comments**, **Write a docstring**, **Fix
  this code** and **Optimize this code** attach the same chip and send the
  mod's instruction for that action, shown in the transcript under the
  action's title; **Add code block to chat** inserts the selection into the
  composer as a fenced block tagged with the language, to write around. The
  instructions are yours to change: `kirocrew.editorActions.prompts` is an
  object keyed by action id (`ask`, `fixGrammar`, `writeComments`,
  `writeDocstring`, `fixCode`, `optimize`); an id left out keeps the built-in
  text.
- **Ask the agent to fix: <message>** — a quick fix (the light bulb, `Ctrl+.`)
  on any diagnostic of any language: the message, its range and the file go
  with the request as context, and the transcript shows `Fix: <message>`.
- **Send terminal to chat** — the terminal's right-click menu or
  `Ctrl+Shift+R` / `⌘⇧R` while a terminal has focus: the selection when there
  is one, else the last 200 lines (same fallbacks as the Terminal provider),
  staged as a chip in the composer for you to ask about.
- **Add to chat context** — in the explorer's right-click menu for one or
  more selected files and folders (20 at most): a file becomes the `#file` entry
  the picker would build (binaries skipped), a folder the Folder provider's
  entry; they land in the composer as chips.
- **Generate commit message** — the ✨ in the Source Control title: the staged
  diff (the working-tree diff when nothing is staged) goes to a background
  session of the default agent with "Generating commit message…" in the SCM
  title; the first assistant reply is cleaned (fences, a *Commit message:*
  lead-in) and written into the commit input box, and the throw-away session is
  deleted. 60 s without an answer is an error message. A host whose built-in
  git extension is not reachable (the commit input box belongs to it) gets a
  message saying so.

### Steering: generate, refine, import

- **Generate steering docs** — the ✨ in the Steering view's title, and the
  first line of the view's welcome content while `.kiro/steering/` is empty:
  creates the directory, opens a tab in the workspace and asks the agent to
  write the standard Kiro documents (`product.md`, `tech.md`, `structure.md`,
  each with `inclusion: always` front matter) from what the files show; the
  transcript reads **Generate steering documents** in place of the instruction.
- **Refine this steering document** — the ✨ in the title bar of any
  `.kiro/steering/**/*.md` (and inline on a Steering view row): the file is
  attached as `#file` context and the agent is asked to check every statement
  against the workspace as it is now, drop or correct what is stale, tighten
  the wording, keep the front matter, and write it back to the same file.
- **Import from other assistants** — the Steering view title (and its welcome
  content): the workspace is scanned for `AGENTS.md`, `CLAUDE.md`,
  `.cursorrules`, `.cursor/rules/**`, `.clinerules`, `.continue/**` and
  `.github/copilot-instructions.md`; pick any number and each is copied to
  `.kiro/steering/<name>.md` with `inclusion: always` front matter (a source
  that has front matter keeps it, gaining `inclusion: always` when it names no
  mode) and an `imported from` comment. The name is the source's stem with its
  origin for the directory sources (`cursor-<file>`, `clinerules-<file>`,
  `continue-<file>`, `copilot-instructions`); a target that exists is skipped
  and listed. The view refreshes by itself.

### Skill import

**Import skill** in the Skills view title takes a **local folder** holding a
`SKILL.md` or a **public GitHub URL** — `https://github.com/<owner>/<repo>`,
`…/tree/<ref>/<path>` for a subfolder, or just `<owner>/<repo>` — and asks for
the scope: the workspace's `.kiro/skills/` or the global `~/.kiro/skills/`. A
GitHub import goes through the hook (`POST skills/import {url, scope}`): the
repository tarball is downloaded from `codeload.github.com` (which joins the
declared `network.hosts`), the folder holding
`SKILL.md` (the subfolder when the URL names one) is extracted into a temporary
directory and moved into place. The skill's name is the folder's name (or
`SKILL.md`'s `name`); a name already present in that scope is refused. The
Skills view refreshes and reveals the new skill.

### Agent hooks

- **The Agent Hooks view** lists every `*.kiro.hook` and `*.json` under the
  workspace's `.kiro/hooks/` and the global `~/.kiro/hooks/`: name, trigger →
  action kind (`askAgent` or `runCommand`), the matcher when the trigger has
  one, and whether it is enabled; a file that does not parse is listed with
  its error. The inline **Enable hook** / **Disable hook** (and *Toggle hook*
  in the row's menu) writes `enabled` back into the file; ⟳ **Refresh hooks**
  re-reads both directories.
- **Run hook** (inline ▶, `userTriggered` hooks only, enabled ones): an
  `askAgent` hook's prompt is sent through the chat, shown as **Run hook:
  <name>**; a `runCommand` hook's command runs in a terminal named for the
  hook after you confirm.
- **＋ New agent hook** walks through scope, name, trigger (`fileEdited`,
  `fileCreated`, `fileDeleted`, `userTriggered`, `promptSubmit`, `agentStop`,
  `preToolUse`, `postToolUse`, `sessionStart`), the matcher where the trigger
  takes one (a file glob for the file triggers, `**/*` by default; a tool name
  for the tool triggers), the action kind and its prompt or command, and writes
  `<name>.kiro.hook`, enabled, in Kiro's `when` / `then` shape, then reveals the
  row and opens the file.
- Hooks are **executed by kiro-cli**, not by the bridge: the view says so in
  its standing message and links the documentation
  (<https://kiro.dev/docs/hooks/>; also the 📖 in the view's title).

### MCP servers (read-only)

- **The MCP Servers view** lists the servers kiro-cli reads from the
  workspace's `.kiro/settings/mcp.json` and the global
  `~/.kiro/settings/mcp.json`: one row per server with its name and route
  (`stdio · <command>` or `http · <host>`), a dimmed icon and `· disabled`
  when the file disables it; a file that does not parse is listed as one
  warning row with the error. Clicking a row opens the file at that server's
  entry. `env` values are never read or shown.
- It is **read-only**: kiro-cli owns MCP, so there is no enable, disable or
  edit here, only ⟳ **Refresh MCP servers** and **Open MCP config file**
  (the workspace file; an information message when there is none, nothing is
  created). The empty view links the documentation
  (<https://kiro.dev/docs/mcp/>).

<div align="right">[<a href="#readme-top">back to top</a>]</div>

---

## Parts

| Part | Seam | What |
|---|---|---|
| `hook/` (python-hook, early) | gateway | engine supervisor + control API (`status` with per-workspace spec-task counts and engine health, `start` `stop` `relaunch` `workspaces/open` `workspaces/close` `engines` `engines/install` `extensions/install` `browse`), the same-origin proxy at `/kirocrew-ide`, bridge-extension provisioning |
| `app/` (app) | App Kit | the **KiroCrew IDE** App page. `app/ui/art/icon.svg` is the App's face in the Apps sidebar and the store (manifest `iconPath`): the fox wearing a `</>` badge |
| `extension/` | the engine | the KiroCrew web extension (chat, sessions, approvals, specs), provisioned per start |
| `preview/` | the engine | the spec-preview extension (engine-side host): a markdown-it plugin + styles for the built-in Markdown preview (Kiro task rows, spec header), the mermaid preview script, and `highlight.js`, the `kirocrew.preview.highlight` command that colours the chat's command tip with the engine's own vscode-textmate, the shellscript grammar and the active theme's rules; provisioned per start beside the bridge |
| `ui/page.mjs` (ui) | FloofyCrew App | engine status and settings; points at the App. `ui/icon.svg` is the mod's face in FloofyCrew's Mod pages and Installed mods (the same fox as the App page's loading splash) |

## Requirements

An IDE engine on the gateway host (not bundled — your choice, your license).
With none found, the App offers **Install engine**: it downloads an
openvscode-server release (MIT, ~100 MB) from GitHub into the mod's data
directory after your confirmation — the mod's only network use
(`network.hosts`: github.com, api.github.com, objects.githubusercontent.com).
Alternatives: `openvscode-server` or `code-server` on PATH, or
`engine.command` in the mod config.

**Extensions.** The engine's store is [Open VSX](https://open-vsx.org), where
many Marketplace extensions were never published (the Microsoft Marketplace
serves only Microsoft's own builds). So the Extensions view searches **both
stores at once**: the mod runs a small merged gallery on the host's loopback
(both stores speak the same gallery protocol; each query fans out to Open VSX
and the Marketplace, results are interleaved by each store's own rank with
duplicates collapsed to the Marketplace copy). Two clients are pointed at it,
because they read different things: the engine's `product.json` (the server's
own gallery client, used for installs and update downloads; original kept
beside for restore) and the **workbench page** the proxy serves, whose
`productConfiguration` the hook fills in — the Extensions view searches from
the browser, with a product configuration baked into the web bundle (Open
VSX) that openvscode-server 1.109 never overrides from `product.json` (it
serves that object empty). The browser tries the loopback URL itself, fails
(it is the gateway's loopback, not yours) and forwards the request over the
workbench connection to the engine, which reaches it; the view's other
gallery routes (`…/latest` per installed extension, install stats) are served
too. Install, update and readme assets come from whichever store an entry
came from; a store that is down just drops out of the merge. `engine.gallery`
in the mod config: `merged` (default), `openvsx` (the engine's own store,
product.json restored) or `marketplace`. The gallery is per gateway process
and listens on `127.0.0.1` only, on a stable port (first free of 35486–35495,
or `engine.gallery_port`), closed and rebound on a mod reload; `open-vsx.org`
joins the declared hosts. `status.gallery.recent` lists the last requests it
answered (a query with its text and hit count), so an empty search is a
one-line diagnosis: no entry means the view never reached the gallery. For a
link you already have, the Extensions view title also has **Install from
Marketplace link…** (and the command palette): paste the
`marketplace.visualstudio.com/items?itemName=publisher.name` link (or just
`publisher.name`), and the hook downloads that extension's VSIX and installs
it with the engine's own CLI, with a **Reload Window** button when done.
`marketplace.visualstudio.com` is a declared host. Extensions
that hard-depend on Microsoft-proprietary services (Pylance, C# Dev Kit, Live
Share, Remote) do not work in a non-Microsoft build whichever way they are
installed.

The engine binds `127.0.0.1` only and, by default, runs without a connection
token (see `engine.token`); the dashboard's own session is what guards the
proxy.

**The four modes** (Spec, Quick Spec, Bug Fix, Plan) are the IDE's own
prompt-guided workflows: a workflow frame injected on `kirocrew.agent` (or
`kirocrew.specAgent` for task runs), listed in the chat's Agent picker under
"Workflows (prompt-guided)". The **kiro-spec-plan** mod's mode agents
(`spec`, `quick-spec`, `bug-fix`, `plan` in `~/.kiro/agents`) are no longer
picked by default: on current kiro-cli `--agent spec` loads that mod's
tool-less handle file, not Kiro's bundled Spec mode. Seen 2026-11-07 (host
0.11.2.1, kiro-cli 2.22.1): the host accepted the id, and the design phase
answered "Kiro Spec & Plan needs the KAS backend" with the backend already on
kas. Set `kirocrew.kiroModeAgents: true` to opt back in; the picker then lists
the installed mode agents under "Kiro modes" (and, when they are missing, a
row with the install command), and a host that still refuses a reserved mode
id ("Rename this crewmate's template: 'spec' is reserved for a built-in
agent …" on KiroCrew 0.8.0.9+, or 0.11's "Agent mode 'spec' is not available
on this session … its ~/.kiro/agents/spec.json is likely missing", for the
four mode ids only) is caught on the first send, noted once in the transcript,
and the turn is re-sent as the prompt-guided workflow on your picked agent for
the rest of the window.

**Running tasks** works the way Kiro's IDE does. On a `tasks.md` the
editor's primary action is **Run all tasks** (or **Resume tasks** once some
are ticked): one click, one durable session, every remaining required task
back to back — no "run task N" per task. Each open row has its own **Start
task** for a single task; queued (`[~]`) and in-progress (`[-]`) rows show
their state instead. Both run with Autopilot on (`kirocrew.specAutopilot`),
as Kiro does, so the run is not interrupted by tool approvals. With
`kirocrew.kiroModeAgents` on and the mode agents installed, the request sent
is the very text Kiro's IDE sends
its engine ("Run all tasks for this spec." with the resume suffix; "Execute
the following task …" with Kiro's `<task>` block), so the engine's own Task
Orchestrator queues the tasks, runs them through its task-execution sub-agent
and writes `[~]` / `[-]` / `[x]` back into `tasks.md` as it goes. Without it a
paraphrase carrying the same task block asks your crew agent for the same
non-stop loop. Optional tasks (`- [ ]* …`) are skipped by Run all; the spec's
context menu has **Run all required and optional tasks**, which removes the
`*` marks first (Kiro's "make all required").

**An interrupted run resumes itself.** A long Run all tasks gets cut: by the
host's turn limit (`agent.chat_turn_timeout_secs`, 4 hours by default, 24 at
most, in `~/.kiro/crew/config.json`: "⏱️ This turn hit the 4-hour limit and was
stopped …"), by a dropped connection, a backend error, a gateway restart, or a
model that simply ends its turn mid-list. The IDE does not key on the error
text for any of these. It judges the run from `tasks.md`: Kiro's orchestrator
writes `[~]` (queued) and `[-]` (in progress) as it goes and leaves neither
behind when it finishes, so a turn that ends with either still in the file did
not finish the run (for a run this IDE dispatched, open required rows count
too). A moment after each turn ends, with the session idle, the bridge
re-reads `tasks.md` and, if work is left, sends the run's own request again
(Kiro's "Run all tasks for this spec." with the ticked tasks to skip, or the
single task's request; a note asks the engine to check a `[-]` row before
trusting it), up to `kirocrew.specResumeLimit` times per run (default 3, so a
run can span four turns), each resume announced with its cause ("The host
stopped this turn at its 4-hour limit", "The turn ended on an error (…)",
"The turn ended with 1 task in progress and 10 queued, without finishing the
run"). It holds back, and shows a card with a **Resume run** button instead,
when you pressed Stop, when a question card is waiting, when the answer
ended on a question (an `[OPTIONS:` line or a trailing "?"), past the cap, with
`kirocrew.specAutoResume` off, and at startup (a reloaded window judges each
restored tab once and never sends on its own). A Spec tab with no run record
of its own (a tab from before 0.27, a run the dashboard started) adopts the
one spec whose `tasks.md` carries those marks. The ⏱ card keeps its red box
and **Continue from where it stopped** button for plain chats. Outside the
chat, the same run is one click away: the **Specs view** marks a spec with
marks left behind as *interrupted: 1 task in progress and 10 queued* with a
⟳ **Resume run** action, and the spec editor's primary action on such a
`tasks.md` reads **Resume run (N left)**; both resume in the session that ran
it when its tab is still open and idle (the orchestrator keeps its context),
and start a fresh Run all tasks otherwise. Nothing is sent while the session
is still running or when every task is already ticked.

**The spec editor's page** is rendered by the engine's own markdown renderer
(the built-in preview's markdown-it, through its `markdown.api.render`
command): GFM tables, the same highlight.js colouring on fenced code as the
built-in preview, one palette per theme kind. On top of that the page keeps
what the built-in preview does not have: a language label and **Copy** on
every code block, Kiro's task boxes and Start buttons, and `mermaid` fences
drawn in place (see *Mermaid* below). Relative links open against the spec's
own directory; relative images load from it. Should the markdown extension be
disabled, the mod's own renderer takes over, without the colouring.
**Shift+Cmd+V / Ctrl+Shift+V and Ctrl+K V on a spec file open the spec
editor** (beside the source for Ctrl+K V), and the title-bar preview button on
a spec file's source is the spec editor's; every other markdown file keeps the
built-in preview and its keys. **Edit source** in the banner (or *Reopen
Editor With → Text Editor*) is the way back to the text.

**Find in a spec document.** Ctrl+F (⌘F) in the spec editor, the 🔍 Find
button, or *KiroCrew Spec: Find in document* opens a find bar in the sticky
banner: every match is marked, the current one stronger and scrolled into
view, with "3 of 12", ↑ ↓ (Enter / Shift+Enter, F3), an **Aa** match-case
toggle and Esc to close. The search covers headings, text and code (not the
page's own labels or drawn diagrams), case-insensitive by default, and stays
live across a Sync Files or an edit on disk. On `tasks.md` a **Filter tasks**
toggle hides the task rows that do not match, keeping a matching task's
sub-tasks and a matching sub-task's parent, so a long plan reduces to the
tasks about one thing. The webview host swallows Ctrl+F before the browser
sees it and forwards the key to the workbench; the page opens the bar on its
own keydown and the extension's keybinding (while a spec editor is active)
sends the same request, so the shortcut works whichever way it arrives.
Matches are found within one run of text: a phrase split by inline markup
(`**bold** text`) is not matched across the split.

**Mermaid.** The engine has no renderer for ```` ```mermaid ```` fences, and
Kiro's `design.md` is full of them. The mod does not ship the library: the
first time an engine starts, the hook fetches one pinned build of mermaid
(`MERMAID_VERSION` in the hook, SHA-256 checked, 3.5 MB, from
`cdn.jsdelivr.net`) into `<data>/vendor/` and copies it into both provisioned
extensions as `media/mermaid.min.js`. The spec editor draws its fences with
it, and the **built-in markdown preview** of any file does too, through the
mod's second extension (`preview/`, see *Parts*): that extension also marks
Kiro's task rows in the built-in preview of a spec `tasks.md` (state boxes, the
optional tag, a progress strip) and puts a spec header on `requirements.md` /
`design.md` there. A diagram that does not parse keeps its source with the
parser's message under it. Offline, the start goes on without diagrams and the
fetch is retried at the next start; `status.mermaid` says which.
`mermaid.enabled: false` in the mod config turns all of it off.

## Install / develop

```bash
floofy install kirocrew-ide          # from the FloofyCrew registry, or the Install box on the FloofyCrew page
# restart the gateway once: the same-origin proxy is added while it composes its router
# then Apps -> KiroCrew IDE -> pick a folder -> Start
```

From a checkout of this repository, `floofy dev <checkout> --follow` runs the
mod live against your dashboard.

### Where the source lives (internal package)

`github:floofycrew/kirocrew-ide` is the source of record for this mod: every
change lands there first, and a release is a `kirocrew-ide-X.Y.Z` tag there.
The GitFarm package `KirocrewIdeMod` is an internal **overlay** of one such tag,
not a second copy of the mod: `PUBLIC_PIN` at its root names the tag, the commit
it must peel to and the sha256 of its tree; `Config` (the Brazil package file) is
what the package lays on top; `python tools/overlay.py build` fetches the pinned
tag, verifies it, refuses any path present on both sides and composes the two
into the installable tree (`--check` proves two composes are byte-identical;
`pin set kirocrew-ide-X.Y.Z` bumps the pin at a release, `pin verify` re-checks
it). The pin format and the composer are FloofyCrew's own `pin.py` and
`compose.py`, vendored byte-for-byte under `tools/vendor/` and hash-pinned by
`tools/vendor/VENDORED_FROM`. Nothing is exported, filtered or reviewed on its
way to GitHub any more; the former `.github/tools/export_public.py` is gone.

On the internal edition the mod is also installable straight from its package:
`floofy install ssh://git.amazon.com/pkg/KirocrewIdeMod@release`; a checkout
develops with `git clone ssh://git.amazon.com/pkg/KirocrewIdeMod && floofy dev KirocrewIdeMod`.

Design, the display-strategy analysis, the bridge architecture and the "why a
mod, not an App" proof: [DESIGN.md](DESIGN.md).

## Config keys (mod config)

| Key | Meaning |
|---|---|
| `default_folder` | folder the picker starts in / Start opens when none is given |
| `idle_unload_minutes` | minutes an off-screen workspace document stays warm before it is unloaded (default 15, `0` never); set from the workspace menu's footer, route `POST settings/idle-unload {"minutes"}` |
| `command_center_scale` | width of the title bar's command centre (the search pill) relative to the stock 38vw / 600px (default `0.5`, so half; `1` = stock width; floor 0.25). Served in the workbench page, so a reload applies it |
| `engine.heap_mb` | V8 heap ceiling (MB) handed to the engine and every extension host through `NODE_OPTIONS --max-old-space-size` (default 8192; `0` leaves node's own ~4 GB). A ceiling, not a reservation. |
| `engine.command` | full engine command template (`{port}` `{token}` `{folder}` `{auth}` `{basepath}` `{extensions}`) |
| `engine.version` | pin the auto-installed openvscode-server version (default: latest release) |
| `engine.port` | pin the engine's loopback port (default: first free of 35476–35485) |
| `engine.token` | `true` runs the engine with a connection token; breaks embedding (its cookie is `SameSite=Lax`) |
| `engine.gallery` | `merged` (default: Open VSX + Microsoft Marketplace in one Extensions view), `openvsx` (engine's own store), `marketplace` |
| `engine.gallery_port` | pin the merged gallery's loopback port (default: first free of 35486–35495) |
| `mermaid.enabled` | `false` skips the pinned mermaid download and leaves ```` ```mermaid ```` fences as code blocks everywhere (default `true`) |

IDE-side settings (VS Code settings, `kirocrew.*`): `agent` (default agent
for chats and spec phases), `specAgent` (agent that executes tasks),
`specAutopilot` (task runs approve their tools, default on), `specAutoResume`
and `specResumeLimit` (an interrupted task run resumes itself from tasks.md,
whatever cut it, default on, 3 times), `chatFontSize` and `chatWidth` (the
transcript's font size and reading column: `compact` | `comfortable` | `full`),
`folderName` (dashboard folder, default "KiroCrew IDE"), `notifyApprovals`,
`toolCardDisplayMode` (`collapseOnComplete` | `alwaysExpanded`, see *Workflows
like Kiro*), `editorActions.prompts` (your instruction per action of the
editor's KiroCrew menu, keyed by action id).

## One port only (remote hosts)

The workbench is served same-origin at `/kirocrew-ide` on the dashboard, so the
port you already forward carries the IDE — nothing extra to tunnel. The route
is added while the gateway composes its router, hence the one restart after
installing. Should the early shim be unavailable, the mod falls back to the
engine's own loopback port and the App tells you the `ssh -L` line.

**A stuck engine.** An extension host that dies (on 2026-10-20 one reached
node's default heap limit and was SIGABRT'd) can leave the engine answering
HTTP while servicing no new workbench connection: `status.running` stays true,
the page loads and stays blank through every client reload. The hook now
watches for exactly that on the proxy's own WebSocket bridges: a workbench
connected 25 s ago, sent its frames, and the engine has answered nothing on
that bridge or any other since (a bridge the engine answers or closes itself
is a live engine; one the client never spoke on proves nothing). `status.health.stuck`
turns true, the layer replaces the bouncing fox with the reason and a
**Relaunch engine** button (the App page shows the same banner), and `POST
relaunch` stops and starts the engine with the same workspaces; every document
reconnects on its own. The heap ceiling (`engine.heap_mb`, 8 GB by default)
makes the death itself rarer.

The proxy's WebSocket bridge connects the engine side first and only then
accepts the browser's upgrade: an engine that refuses, is gone, or does not
answer within 10 s is a plain 502 before any upgrade, so the workbench shows
its connection error and retries instead of sitting on a blank page. Every
bridge's outcome is in `GET debug/proxylog` (`ws`, `ws-closed after Ns`,
`ws-upstream-failed: …`), and `status.proxy.websockets` carries the running
counts (`opened`, `failed`, `live`).

## Tests

```
python tests/<name>_test.py            # hook units (stub floofy module, no host code)
python tests/overlay_test.py           # the overlay build: a scratch public repository tagged kirocrew-ide-9.9.9 is pinned, composed with Config, --check'd; the vendored pin.py/compose.py are re-hashed
python tests/skills_import_test.py     # the hook's skill importer: GitHub URL parser (URL table shared with steering_import.test.mjs), tarball extraction, import_skill error paths; no network
node --test tests/*.test.mjs       # includes preview_highlight.test.mjs: the engine-host highlighter on fakes, and against the engine installed under the mod's data dir (KIDE_ENGINE_ROOT overrides; skipped without one)
                                   # the spec_*.test.mjs / task_session_links files cover the spec-coding bridge; context_providers (the # providers, the cap and marker, chips), editor_actions (prompt overrides, fenced block, diff pick, background turn, quick fix), steering_import (assistant files → steering names, front matter, skill folder import) and agent_hooks (hook file validation, the wizard's output) cover the workflows
tests/e2e/probe_extension.py <url>     # headless: the extension activates in the workbench
tests/e2e/probe_profile.py <url> <profile> <udd>   # headless: bridge + seeded order in a non-default profile
tests/e2e/probe_hosts.py               # headless, self-contained: the layer (host switcher, modes, workspaces) in stub realms
tests/e2e/probe_chat_webview.py        # headless, self-contained: the chat webview's transcript (the thinking block) driven with the extension's own messages
tests/e2e/probe_chat_shortcuts.py      # headless, self-contained: the chat webview's Kiro shortcuts — tab messages, the find bar's counts and Aa, approve-all / reject-all over staged approval cards, toolCardDisplayMode — plus a regression pass over the follow pill, lightbox, command tip, pinned prompt, recovery cards and thinking blocks
tests/e2e/probe_gallery.py <url> <gallery> <text>   # headless: the Extensions view searches through the merged gallery (browser route aborted = remote browser; --direct keeps it)
tests/e2e/probe_spec_editor.py --engine <bin> [--mermaid <mermaid.min.js>]   # headless, scratch engine: the spec editor renders through the engine's renderer (hljs spans, code bars, task boxes, mermaid) Ctrl+Shift+V on a spec file opens it, and Ctrl+F through the workbench opens its find bar
tests/e2e/probe_spec_find.py           # headless, self-contained: the spec editor's find bar (marks, count, Enter/Shift+Enter, Aa, Filter tasks, refresh, Esc) driven with the keyboard
tests/e2e/probe_spec_lenses.py --engine <bin>      # headless, scratch engine: task code lenses and borders per state in the text editor, the redraw after a box changes on disk, Go to … per workflow type
tests/e2e/probe_review_comments.py --engine <bin>  # headless, scratch engine + a routed fake gateway: review comments in the spec editor (toggle, box, Esc / Ctrl+Enter, Edit, Delete, Sync Files), Send → the turn body and the "Review: N comments on design.md" bubble
tests/e2e/chat_roundtrip.py <url>      # headless: a message round-trips through a gateway session
```

The e2e scripts drive a workbench URL; through the dashboard (with a session)
the chat round-trip is real, directly on the engine port only activation is.

## License

MIT. The IDE engine you install has its own license (openvscode-server: MIT;
code-server: MIT; Microsoft's VS Code builds/marketplace have their own terms
— this mod ships none of them).
