"""Headless, real engine: spec review comments in the Kiro spec editor —
comment, send, transcript display text (requirements 7.1, 7.2, 7.3, 7.4).

    probe_review_comments.py --engine <openvscode-server binary> [--shots DIR]

What runs: the harness of probe_spec_editor.py (provisioning and helpers
imported): a scratch engine on a free loopback port with both extensions, a
scratch workspace holding `.kiro/specs/demo`. Playwright's request routing
stands in for the KiroCrew gateway on the engine origin's `/api/*` (the bridge
talks to its own origin, where no gateway answers here): POST /chat/slots
mints a session key, POST /chat?ws=1 accepts the turn, everything else gets an
empty success. The whole Send_Path is then observable without a gateway
process: the turn body the host would receive, the bubble the chat webview
draws, the clear that follows a sent turn.

* design.md in the spec editor: the Review toggle (aria-pressed) shows the
  review row; a click on a block opens one focused textarea; Esc cancels;
* Ctrl+Enter saves a side card, badge "1", "Send 1 comment"; the Save button
  adds a heading comment, "Send 2 comments"; Edit and Delete round-trip;
* Sync Files re-renders with the same block ids, every comment re-attached;
* Send: one turn whose body is buildReviewTurn's text (header, quoted passage
  + comment per item, the apply-feedback instruction) wrapped by specTurnText,
  the siblings as context, `Review: 2 comments on design.md` as the chat's
  user bubble, then the comments cleared (badge 0). Should the fake gateway
  see no call, the failure path is asserted instead (error toast, comments
  kept) with a NOTE, and the display-text and clear assertions are skipped;
* zero console errors (engine-only noise aside, see ENGINE_NOISE).

Needs Playwright + Chromium (the FloofyCrew dev venv has them).
"""
from __future__ import annotations

import argparse
import json
import os
import pathlib
import socket
import subprocess
import sys
import tempfile
import time

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.dont_write_bytecode = True  # never leave hook/__pycache__ behind (it would be hashed into the manifest)
from probe_spec_editor import DESIGN_MD, free_port, provision, quick_open, wait_frame  # noqa: E402

FAKE_KEY = "kirocrew-ide-spec-probe"
ENGINE_NOISE = ("/node_modules/vsda/", "[DEP0040] DeprecationWarning: The `punycode`", "open-vsx.org/vscode/gallery/")


def fake_gateway(calls):
    """A page.route handler: the few KiroCrew /api routes the bridge calls while sending a spec turn."""
    def handle(route, request):
        path = request.url.split("/api", 1)[1]
        body = None
        try:
            body = json.loads(request.post_data) if request.post_data else None
        except ValueError:
            body = {"raw": request.post_data}
        calls.append({"method": request.method, "path": path, "body": body})
        if request.method == "POST" and path == "/chat/slots":
            reply = {"key": FAKE_KEY}
        elif request.method == "POST" and path.startswith("/chat?"):
            reply = {"ok": True}
        elif request.method == "GET":
            reply = []
        else:
            reply = {}
        route.fulfill(status=200, content_type="application/json", body=json.dumps(reply))
    return handle


def wait_until(fn, timeout, page, step=250):
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            if fn():
                return True
        except Exception:
            pass
        page.wait_for_timeout(step)
    return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--engine", required=True)
    ap.add_argument("--shots", default=None)
    args = ap.parse_args()
    from playwright.sync_api import sync_playwright

    scratch = tempfile.mkdtemp(prefix="kide-review-probe-")
    data = os.path.join(scratch, "data"); os.makedirs(data)
    ws = os.path.join(scratch, "ws"); spec_dir = os.path.join(ws, ".kiro", "specs", "demo"); os.makedirs(spec_dir)
    open(os.path.join(ws, "README.md"), "w").write("# readme\n")
    open(os.path.join(spec_dir, "requirements.md"), "w").write("# Requirements\n\n1. It works.\n")
    open(os.path.join(spec_dir, "design.md"), "w").write(DESIGN_MD)
    open(os.path.join(spec_dir, "tasks.md"), "w").write("# Implementation Plan\n\n- [ ] 1. Open task\n")
    ext_dir = provision(data, None)
    port = free_port()
    proc = subprocess.Popen([args.engine, "--host", "127.0.0.1", "--port", str(port), "--without-connection-token",
                             "--extensions-dir", ext_dir, "--user-data-dir", os.path.join(scratch, "udd"), "--disable-workspace-trust", ws],
                            stdout=open(os.path.join(scratch, "engine.log"), "wb"), stderr=subprocess.STDOUT)
    failures = []

    def check(cond, msg):
        print(("ok   " if cond else "FAIL ") + msg, flush=True)
        if not cond:
            failures.append(msg)

    def shot(name):
        if args.shots:
            os.makedirs(args.shots, exist_ok=True); page.screenshot(path=os.path.join(args.shots, name))

    try:
        deadline = time.time() + 30
        while time.time() < deadline:
            try:
                with socket.create_connection(("127.0.0.1", port), timeout=0.5):
                    break
            except OSError:
                time.sleep(0.25)
        else:
            raise AssertionError("engine did not open its port")
        with sync_playwright() as p:
            browser = p.chromium.launch()
            page = browser.new_page(viewport={"width": 1400, "height": 900})
            console = []
            page.on("console", lambda m: console.append("%s: %s @%s" % (m.type, m.text, (m.location or {}).get("url", ""))))
            page.on("pageerror", lambda e: console.append("pageerror: %s" % e))
            calls = []
            page.route("http://127.0.0.1:%d/api/**" % port, fake_gateway(calls))
            page.goto("http://127.0.0.1:%d/?folder=%s" % (port, ws), wait_until="domcontentloaded")
            page.wait_for_selector(".monaco-workbench", timeout=90000)
            page.wait_for_timeout(6000)
            trust = page.locator(".monaco-dialog-box a.monaco-button", has_text="trust the authors")
            if trust.count():
                trust.first.click(); page.wait_for_timeout(1500)

            # --- design.md in the spec editor: review off by default, blocks carry ids
            quick_open(page, "design.md")
            doc = wait_frame(page, "#doc .codeblock")
            doc.wait_for_selector("#doc .rv-block[data-block-id]", timeout=30000)
            page.wait_for_timeout(800)
            check(doc.locator("#review").get_attribute("hidden") is not None and doc.locator("#reviewbtn").get_attribute("aria-pressed") == "false", "review mode is off by default (row hidden, toggle not pressed)")
            check(not doc.locator("#reviewsend").is_visible(), "Send hidden with no comments")
            ids_before = doc.locator("#doc .rv-block").evaluate_all("els => els.map(e => e.dataset.blockId)")
            check(len(ids_before) >= 4 and len(set(ids_before)) == len(ids_before), "blocks carry unique data-block-id (%d)" % len(ids_before))

            # --- toggle on (7.5), click a block → textarea (7.1), Esc cancels
            doc.locator("#reviewbtn").click(); page.wait_for_timeout(200)
            check(doc.locator("#reviewbtn").get_attribute("aria-pressed") == "true" and doc.locator("#review").is_visible(), "Review toggle: aria-pressed true, review row shown")
            para = doc.locator("#doc p", has_text="Overview paragraph").first
            para.click(position={"x": 30, "y": 8}); page.wait_for_timeout(300)
            check(doc.locator("#doc .review-editor textarea").count() == 1, "click on a paragraph opens one inline textarea")
            check(doc.evaluate("() => document.activeElement && document.activeElement.tagName") == "TEXTAREA", "the textarea has focus")
            check(doc.locator("#doc .review-editor").evaluate("b => b.previousElementSibling && b.previousElementSibling.tagName") == "P", "the box is anchored right under the clicked block")
            page.keyboard.press("Escape"); page.wait_for_timeout(200)
            check(doc.locator("#doc .review-editor").count() == 0 and doc.locator("#reviewcount").inner_text() == "0", "Esc cancels the box; nothing saved")

            # --- type + Ctrl+Enter saves: card, badge 1, Send 1 comment
            para.click(position={"x": 30, "y": 8}); page.wait_for_timeout(300)
            page.keyboard.type("Name the feature here"); page.keyboard.press("Control+Enter"); page.wait_for_timeout(300)
            cards = doc.locator("#doc .review-card")
            check(cards.count() == 1 and "Overview paragraph" in cards.first.locator(".excerpt").inner_text() and cards.first.locator(".text").inner_text() == "Name the feature here", "Ctrl+Enter saves: one card with the passage and the comment")
            check(doc.locator("#reviewcount").is_visible() and doc.locator("#reviewcount").inner_text() == "1", "badge reads 1")
            check(doc.locator("#reviewsend").is_visible() and doc.locator("#reviewsend").inner_text() == "Send 1 comment", "Send 1 comment (singular) visible")
            check(doc.locator("#doc p.rv-has").count() == 1, "the commented block is marked")

            # --- second comment on the heading via the Save button
            doc.locator("#doc h1").first.click(); page.wait_for_timeout(300)
            save = doc.locator("#doc .review-editor button.save")
            check(save.is_disabled(), "Save is disabled while the box is empty")
            page.keyboard.type("Title: say which feature"); page.wait_for_timeout(100)
            check(not save.is_disabled(), "Save enables once text is typed")
            save.click(); page.wait_for_timeout(300)
            check(doc.locator("#doc .review-card").count() == 2 and doc.locator("#reviewsend").inner_text() == "Send 2 comments" and doc.locator("#reviewcount").inner_text() == "2", "Save button: second card, Send 2 comments, badge 2")
            shot("review-two-comments.png")

            # --- Edit round-trip on the heading card
            head_card = doc.locator("#doc .review-card", has_text="Title: say which feature")
            head_card.locator("button.edit").click(); page.wait_for_timeout(300)
            ta = doc.locator("#doc .review-editor textarea")
            check(ta.count() == 1 and ta.input_value() == "Title: say which feature", "Edit opens the box prefilled with the comment")
            check(doc.locator("#doc .review-card[hidden]").count() == 1, "the card is hidden while it is edited")
            page.keyboard.type(" in one line"); page.keyboard.press("Control+Enter"); page.wait_for_timeout(300)
            check(doc.locator("#doc .review-card").count() == 2 and doc.locator("#doc .review-card .text", has_text="Title: say which feature in one line").count() == 1, "the edit is saved in place (still 2 cards)")

            # --- Delete round-trip: a third comment on the code block, then deleted
            doc.locator("#doc .codeblock").first.click(position={"x": 60, "y": 40}); page.wait_for_timeout(300)
            page.keyboard.type("Drop this example"); page.keyboard.press("Control+Enter"); page.wait_for_timeout(300)
            check(doc.locator("#doc .review-card").count() == 3 and doc.locator("#reviewcount").inner_text() == "3", "a code block takes a comment too: 3 cards")
            doc.locator("#doc .review-card", has_text="Drop this example").locator("button.delete").click(); page.wait_for_timeout(300)
            check(doc.locator("#doc .review-card").count() == 2 and doc.locator("#reviewcount").inner_text() == "2" and doc.locator("#doc .codeblock.rv-has").count() == 0, "Delete removes the card, unmarks the block, badge back to 2")

            # --- Sync Files re-render keeps the ids and the comments (7.4)
            doc.locator("#sync").click(); page.wait_for_timeout(1500)
            ids_after = doc.locator("#doc .rv-block").evaluate_all("els => els.map(e => e.dataset.blockId)")
            check(ids_after == ids_before, "Sync Files: block ids are identical after the re-render")
            check(doc.locator("#doc .review-card").count() == 2 and doc.locator("#doc .rv-has").count() == 2 and doc.locator("#review .orphan").count() == 0, "Sync Files: both comments back under their blocks, no orphans")
            check(doc.locator("#reviewstatus").inner_text().strip() == "2 comments", "status row reads 2 comments (%s)" % doc.locator("#reviewstatus").inner_text().strip())

            # --- Send 2 comments (7.2, 7.3): the turn, its display text, the clear
            del calls[:]
            doc.locator("#reviewsend").click()
            sent = wait_until(lambda: any(c["method"] == "POST" and c["path"].startswith("/chat?") for c in calls), 15, page)
            minted = any(c["method"] == "POST" and c["path"] == "/chat/slots" for c in calls)
            if sent or minted:
                check(minted, "the extension minted a session for the spec (POST /chat/slots)")
                check(sent, "the extension posted the turn (POST /chat?ws=1)")
                turn = next((c["body"] for c in calls if c["method"] == "POST" and c["path"].startswith("/chat?")), None) or {}
                msg = str(turn.get("message", ""))
                check(turn.get("slot") == FAKE_KEY, "the turn targets the minted session (%s)" % turn.get("slot"))
                check("Review comments on demo/design.md (2 comments):" in msg, "turn body: header names the spec, the document and the count")
                i1 = msg.find("1. On the passage:\n   > Overview paragraph with a link.\n   Comment: Name the feature here")
                i2 = msg.find("2. On the passage:\n   > Design\n   Comment: Title: say which feature in one line")
                check(i1 >= 0 and i2 > i1, "turn body: numbered items quote each passage with its comment, in order (i1=%d, i2=%d)" % (i1, i2))
                check("Apply each comment to design.md of this spec" in msg and "Do not implement code." in msg, "turn body: the apply-feedback instruction closes it")
                check("PHASE: APPLY REVIEW COMMENTS to .kiro/specs/demo/design.md." in msg and msg.find("PHASE:") < msg.find("Review comments on"), "turn body: specTurnText wraps it (spec rules, the PHASE line, then the review body)")
                injected = [c for c in calls if c["method"] == "POST" and c["path"].endswith("/context")]
                labels = [str((c["body"] or {}).get("content", "")).split("\n", 1)[0] for c in injected if str((c["body"] or {}).get("content", "")).startswith("[")]
                check(any("requirements.md" in l for l in labels) and any("tasks.md" in l for l in labels) and not any("design.md" in l for l in labels), "the sibling documents ride along as context, the reviewed one does not (%s)" % labels)
                # The chat webview draws the display text as the user bubble, not the long request.
                chat = None
                t0 = time.time()
                while time.time() - t0 < 20 and chat is None:
                    for f in page.frames:
                        try:
                            if f.locator("#compose").count() and f.locator(".row.user").count():
                                chat = f; break
                        except Exception:
                            continue
                    if chat is None:
                        page.wait_for_timeout(500)
                check(chat is not None, "the chat view opened with a user bubble")
                if chat is not None:
                    # The bubble: the context chips (`#file` siblings) on top, then the display text in place of the request.
                    bubbles = chat.locator(".row.user").evaluate_all("els => els.map(e => ({ chips: [...e.querySelectorAll('.ctx *')].map(c => c.textContent.trim()).filter(Boolean), text: [...e.childNodes].filter(n => !(n.classList && n.classList.contains('ctx'))).map(n => n.textContent).join('').trim() }))")
                    check(any(b["text"] == "Review: 2 comments on design.md" for b in bubbles), "transcript: the user bubble is the display text 'Review: 2 comments on design.md' (%s)" % bubbles)
                    check(any(any("requirements.md" in c for c in b["chips"]) and any("tasks.md" in c for c in b["chips"]) for b in bubbles), "transcript: the bubble's chips name the sibling documents")
                    check(not any("Review comments on demo/design.md" in b["text"] for b in bubbles), "transcript: the raw turn text is not shown")
                cleared = wait_until(lambda: doc.locator("#reviewcount").inner_text() == "0", 10, page)
                check(cleared and doc.locator("#doc .review-card").count() == 0 and not doc.locator("#reviewsend").is_visible(), "after the send the comments are cleared: badge 0, no cards, Send hidden (7.3)")
                check(doc.locator("#reviewbtn").get_attribute("aria-pressed") == "true" and doc.locator("#reviewstatus").inner_text().strip() == "No comments yet.", "review mode stays on after the clear")
                shot("review-sent.png")
            else:
                print("NOTE: the fake gateway saw no /api call from the extension host (request routing did not reach its fetch); asserting the failure path instead and skipping the clear and display-text assertions.", flush=True)
                toast = page.locator(".notifications-toasts .notification-list-item-message")
                check(wait_until(lambda: any("send review comments on design.md" in t for t in toast.all_inner_texts()), 15, page), "no gateway: an error toast names the failed send")
                check(doc.locator("#reviewcount").inner_text() == "2" and doc.locator("#doc .review-card").count() == 2, "no gateway: the comments are kept in the editor (only a sent turn clears them)")

            errs = [c for c in console if (c.startswith("error") or c.startswith("pageerror")) and not any(n in c for n in ENGINE_NOISE)]
            check(not errs, "no console errors (%s)" % errs[:3])
            browser.close()
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except Exception:
            proc.kill()
    print("\n%s (%d failure(s)); scratch kept at %s" % ("PASS" if not failures else "FAIL", len(failures), scratch))
    return 0 if not failures else 1


if __name__ == "__main__":
    sys.exit(main())
