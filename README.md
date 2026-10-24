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
other theme and it stays yours.

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
  combobox (recent workspaces, then the engine-side directory listing). One engine serves them all; each
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
  from the live document and re-measured on resize. Under that budget the
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
  old port is copied to the current one.
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
  dropped (with a note) instead of pinned on a new session.
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
- **KiroCrew** activity-bar views: *Specs* (`.kiro/specs/<name>/`, phase
  commands, ▶ Start task per row, ⏵⏵ Run all tasks per spec, Kiro's queued /
  in-progress / done marks), *Steering*, *Skills*, *Agent Hooks* — each showing
  the workspace's `.kiro/` and the global `~/.kiro/` tier, with a ＋ that
  scaffolds a new file or skill folder. The bridge is registered for **every
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
  paths linked into editor tabs, both clipped at 20 KB with a marker. While the agent works and no answer is
  streaming yet (reasoning, tool calls, the wait for the first token) four
  small FloofyCrew foxes hop in turn under the last row, where KiroCrew shows
  its ghosts; they go still under *prefers-reduced-motion*.
- Attachments travel exactly as the dashboard composer sends them: each file
  is uploaded to the host and referenced by an `[attached_file N] <path>`
  marker with the path list in the send's `meta.files`, so the host inlines an
  image as a real image block, leaves other files on disk for the agent's
  tools, and its own transcript shows the same attachment cards for a session
  started here. (Earlier builds pasted `Attached file: <path>` prose, a shape
  the host never writes itself.)
- Sessions run in the gateway. Close the laptop, drop the tunnel, come back
  from the dashboard or your phone: same session, same transcript.

## Parts

| Part | Seam | What |
|---|---|---|
| `hook/` (python-hook, early) | gateway | engine supervisor + control API (`status` with per-workspace spec-task counts and engine health, `start` `stop` `relaunch` `workspaces/open` `workspaces/close` `engines` `engines/install` `extensions/install` `browse`), the same-origin proxy at `/kirocrew-ide`, bridge-extension provisioning |
| `app/` (app) | App Kit | the **KiroCrew IDE** App page. `app/ui/art/icon.svg` is the App's face in the Apps sidebar and the store (manifest `iconPath`): the fox wearing a `</>` badge |
| `extension/` | the engine | the KiroCrew web extension (chat, sessions, approvals, specs), provisioned per start |
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

**Kiro's own modes** (Spec, Quick Spec, Bug Fix, Plan as real agents) come
from the **kiro-spec-plan** mod, which this mod *recommends* rather than
requires: `floofy install kiro-spec-plan` (or the FloofyCrew page) adds its
four agents to `~/.kiro/agents`, and the chat's Agent picker then lists them
under "Kiro modes". Without it the same four names appear under "Workflows
(prompt-guided)" — a prompt frame injected on your default agent, not Kiro's
procedure — headed by a row that says so and hands you the install command.

Hosts from KiroCrew 0.8.0.9 on reserve KAS's bundled mode ids (`spec`,
`quick-spec`, `bug-fix`, `plan`, …) and refuse a session whose agent carries one
("Rename this crewmate's template: 'spec' is reserved for a built-in agent …"),
which is exactly the name kiro-spec-plan's handles use. The bridge catches that
refusal on the first send, says so once in the transcript, and re-sends the
turn as the prompt-guided workflow on your picked agent, skipping the doomed
attempt for the rest of the window. A kiro-spec-plan that activates the modes
another way will be picked up as before.

**Running tasks** works the way Kiro's IDE does. On a `tasks.md` the
editor's primary action is **Run all tasks** (or **Resume tasks** once some
are ticked): one click, one durable session, every remaining required task
back to back — no "run task N" per task. Each open row has its own **Start
task** for a single task; queued (`[~]`) and in-progress (`[-]`) rows show
their state instead. Both run with Autopilot on (`kirocrew.specAutopilot`),
as Kiro does, so the run is not interrupted by tool approvals. With
kiro-spec-plan installed the request sent is the very text Kiro's IDE sends
its engine ("Run all tasks for this spec." with the resume suffix; "Execute
the following task …" with Kiro's `<task>` block), so the engine's own Task
Orchestrator queues the tasks, runs them through its task-execution sub-agent
and writes `[~]` / `[-]` / `[x]` back into `tasks.md` as it goes. Without it a
paraphrase carrying the same task block asks your crew agent for the same
non-stop loop. Optional tasks (`- [ ]* …`) are skipped by Run all; the spec's
context menu has **Run all required and optional tasks**, which removes the
`*` marks first (Kiro's "make all required").

## Install / develop

```bash
floofy install kirocrew-ide          # from the FloofyCrew registry, or the Install box on the FloofyCrew page
# restart the gateway once: the same-origin proxy is added while it composes its router
# then Apps -> KiroCrew IDE -> pick a folder -> Start
```

From a checkout of this repository, `floofy dev <checkout> --follow` runs the
mod live against your dashboard.

Design, the display-strategy analysis, the bridge architecture and the "why a
mod, not an App" proof: [DESIGN.md](DESIGN.md).

## Config keys (mod config)

| Key | Meaning |
|---|---|
| `default_folder` | folder the picker starts in / Start opens when none is given |
| `idle_unload_minutes` | minutes an off-screen workspace document stays warm before it is unloaded (default 15, `0` never); set from the workspace menu's footer, route `POST settings/idle-unload {"minutes"}` |
| `engine.heap_mb` | V8 heap ceiling (MB) handed to the engine and every extension host through `NODE_OPTIONS --max-old-space-size` (default 8192; `0` leaves node's own ~4 GB). A ceiling, not a reservation. |
| `engine.command` | full engine command template (`{port}` `{token}` `{folder}` `{auth}` `{basepath}` `{extensions}`) |
| `engine.version` | pin the auto-installed openvscode-server version (default: latest release) |
| `engine.port` | pin the engine's loopback port (default: first free of 35476–35485) |
| `engine.token` | `true` runs the engine with a connection token; breaks embedding (its cookie is `SameSite=Lax`) |
| `engine.gallery` | `merged` (default: Open VSX + Microsoft Marketplace in one Extensions view), `openvsx` (engine's own store), `marketplace` |
| `engine.gallery_port` | pin the merged gallery's loopback port (default: first free of 35486–35495) |

IDE-side settings (VS Code settings, `kirocrew.*`): `agent` (default agent
for chats and spec phases), `specAgent` (agent that executes tasks),
`specAutopilot` (task runs approve their tools, default on),
`folderName` (dashboard folder, default "KiroCrew IDE"), `notifyApprovals`.

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
node --test tests/extension_unit.test.mjs
tests/e2e/probe_extension.py <url>     # headless: the extension activates in the workbench
tests/e2e/probe_profile.py <url> <profile> <udd>   # headless: bridge + seeded order in a non-default profile
tests/e2e/probe_hosts.py               # headless, self-contained: the layer (host switcher, modes, workspaces) in stub realms
tests/e2e/probe_chat_webview.py        # headless, self-contained: the chat webview's transcript (the thinking block) driven with the extension's own messages
tests/e2e/probe_gallery.py <url> <gallery> <text>   # headless: the Extensions view searches through the merged gallery (browser route aborted = remote browser; --direct keeps it)
tests/e2e/chat_roundtrip.py <url>      # headless: a message round-trips through a gateway session
```

The e2e scripts drive a workbench URL; through the dashboard (with a session)
the chat round-trip is real, directly on the engine port only activation is.

## License

MIT. The IDE engine you install has its own license (openvscode-server: MIT;
code-server: MIT; Microsoft's VS Code builds/marketplace have their own terms
— this mod ships none of them).
