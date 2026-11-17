#!/usr/bin/env python3
"""Headless, self-contained: the mod page's "Kiro modes (kiro-cli)" card (requirement 6.4).

    probe_mod_page_kas.py [--shot PATH]

Mounts ui/page.mjs in a blank page with a stub FloofyCrew `api` whose routes
answer fixture JSON (status, engines, kas/status, kas/sessions, a transcript),
then checks the card: the status line, one table row per session with the
mode / spec / state / source columns, a click that shows the read-only
transcript rendered from the hook's frame log, and the note that nothing is
written to KiroCrew's store. Needs Playwright with Chromium.
"""
import argparse
import json
import os
import pathlib
import sys

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent.parent

FIXTURES = {
    "status": {"running": True, "server": {"engine": "openvscode-server", "folder": "/w", "port": 1}, "proxy": {"inUse": True, "base": "/kirocrew-ide"}, "engine": "openvscode-server"},
    "engines": {"install": {"state": "idle"}},
    "kas/status": {"available": True, "kiroCli": {"version": "kiro-cli 3.3.0"}, "login": {"loggedIn": True}, "idleMinutes": 30,
                   "workspaces": [{"folder": "/w/proj", "pid": 4242, "sessions": ["sess_1"]}]},
    "kas/sessions": {"sessions": [
        {"sessionId": "sess_1", "folder": "/w/proj", "mode": "plan", "title": "Plan the thing", "feature": None, "state": "running", "lastActivity": 1794909785, "source": "hook", "transcript": True},
        {"sessionId": "sess_2", "folder": "/w/proj", "mode": "spec", "title": "", "feature": "feat", "state": "detached", "pendingAsks": 1, "lastActivity": 1794900000, "source": "kas", "transcript": False},
    ], "count": 2},
    "kas/sessions/sess_1/transcript": {"sessionId": "sess_1", "count": 5, "frames": [
        {"seq": 1, "kind": "userPrompt", "text": "hello there"},
        {"seq": 2, "kind": "update", "update": {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "Hi, "}}},
        {"seq": 3, "kind": "update", "update": {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "how can I help?"}}},
        {"seq": 4, "kind": "ask", "ask": "permission", "requestId": 7, "title": "Write File"},
        {"seq": 5, "kind": "turnEnd", "stopReason": "end_turn"},
    ]},
    "kas/sessions/sess_2/transcript": {"sessionId": "sess_2", "frames": [], "reason": "the hook never relayed this session"},
}

HTML = """<!doctype html><html><body><div id="root"></div>
<script type="module">
  import mount from "/ui/page.mjs";
  const fixtures = %s;
  const calls = [];
  window.__calls = calls;
  const api = {
    routes: { fetch: async (route, init) => { calls.push(route); const body = fixtures[route]; return { ok: body !== undefined, json: async () => body === undefined ? { error: "no fixture " + route } : body }; } },
    config: { get: async () => ({}), set: async () => {} },
    dialog: { alert: async () => {}, confirm: async () => false },
  };
  window.__unmount = await mount(document.getElementById("root"), api);
  window.__mounted = true;
</script></body></html>"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--shot", default=None)
    args = ap.parse_args()
    from playwright.sync_api import sync_playwright

    failures = []

    def check(cond, msg):
        print(("ok   " if cond else "FAIL ") + msg, flush=True)
        if not cond:
            failures.append(msg)

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1000, "height": 1200})
        console = []
        page.on("console", lambda m: console.append("%s: %s" % (m.type, m.text)))
        page.on("pageerror", lambda e: console.append("pageerror: %s" % e))

        def route(r):
            url = r.request.url
            if url.endswith("/ui/page.mjs"):
                r.fulfill(status=200, content_type="text/javascript", body=(ROOT / "ui" / "page.mjs").read_text())
            elif url.endswith("/harness"):
                r.fulfill(status=200, content_type="text/html", body=HTML % json.dumps(FIXTURES))
            else:
                r.fulfill(status=404, body="")
        page.route("http://probe.local/**", route)
        page.goto("http://probe.local/harness", wait_until="domcontentloaded")
        page.wait_for_function("window.__mounted === true", timeout=15000)
        page.wait_for_timeout(500)
        card = page.locator("div:has(> strong:text-is('Kiro modes (kiro-cli)'))").first
        check(card.count() == 1, "the Kiro modes card is on the page")
        text = card.inner_text()
        check("nothing is written to KiroCrew's session store" in text, "the card says nothing is written to KiroCrew's store")
        check("kiro-cli kiro-cli 3.3.0" in text or "kiro-cli 3.3.0" in text, "status line names the kiro-cli version")
        check("running for proj (pid 4242, 1 session)" in text, "status line names the running child: %s" % text.split("\n")[2][:120])
        rows = card.locator("table tr")
        check(rows.count() == 3, "header + 2 session rows (%d)" % rows.count())
        first = rows.nth(1).locator("td").all_inner_texts()
        check(first[:4] == ["Plan the thing", "plan", "", "running"] and first[6] == "hook relay", "row 1 columns: %s" % first)
        second = rows.nth(2).locator("td").all_inner_texts()
        check(second[0] == "sess_2" and second[2] == "feat" and second[3] == "detached (waiting)" and second[6] == "kiro-cli store", "row 2 columns: %s" % second)
        rows.nth(1).click()
        page.wait_for_timeout(400)
        pre = card.locator("pre")
        check(pre.is_visible(), "the transcript pane opens on click")
        body = pre.inner_text()
        check("user: hello there" in body and "assistant: Hi, how can I help?" in body and "permission asked: Write File (#7)" in body and "turn ended: end_turn" in body, "transcript rendered from the frame log: %r" % body[:200])
        rows.nth(2).click()
        page.wait_for_timeout(400)
        check("never relayed" in pre.inner_text(), "a session without a log shows the route's reason")
        check("kas/sessions/sess_1/transcript" in page.evaluate("window.__calls"), "the transcript route was called for sess_1")
        errors = [c for c in console if c.startswith("error") or c.startswith("pageerror")]
        check(not errors, "zero console errors (%s)" % errors[:2])
        if args.shot:
            os.makedirs(os.path.dirname(os.path.abspath(args.shot)), exist_ok=True)
            page.screenshot(path=args.shot, full_page=True)
        browser.close()
    if failures:
        print("\n%d FAILED" % len(failures))
        sys.exit(1)
    print("\nprobe_mod_page_kas: all checks passed")


if __name__ == "__main__":
    main()
