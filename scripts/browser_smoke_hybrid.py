#!/usr/bin/env python3
"""Hybrid Delta real-browser smoke test (page actions + optional cloud Executor).

Run OUTSIDE the Claude sandbox (it binds Chrome's debugging port):

    cd extension && npm run build
    python3 ../scripts/browser_smoke_hybrid.py

What it verifies end-to-end against a real Chrome:
  1. Loads the unpacked extension from extension/dist/.
  2. Opens a local test page (served via stdlib http.server on a loopback port)
     that contains a text input, a button with an onclick handler, and a <select>.
  3. Drives the SAME CDP primitives that tab.type / tab.click / tab.select use
     (DOM.getDocument → DOM.querySelector → Runtime.evaluate / Input.dispatch*)
     directly through the Python CDP layer, and asserts real DOM mutation:
       • tab.type mechanics:  input#q .value === "wireless headphones"
       • tab.click mechanics: window.__clicked === true
       • tab.select mechanics: select#sort .value === "price"
  4. (Optional) If POLARIS_SMOKE_CLOUD=1 and DEEPSEEK_API_KEY is set, sends one
     chat completion to the DeepSeek V4-Flash endpoint and asserts a non-empty
     assistant response returns.  This is a pure network smoke for the cloud key
     and endpoint — it does NOT wire up the full agent Executor turn (the agent
     stack inside the SW is not reachable from this Python harness).

SCOPE NOTE:
  The Polaris extension's page-action tools (tab.type / tab.click / tab.select)
  run inside the extension's service worker and call chrome.debugger to drive
  a tab.  Python cannot reach into the SW to call those JS functions directly.
  What this harness DOES instead is replicate the EXACT CDP call sequence those
  tools use (documented in extension/src/agent/tools/browser/actions.ts) and
  drives it against a real Chrome tab.  This is a direct test of the protocol
  mechanics — if these CDP calls work, the extension's wrappers around them will
  too.  End-to-end extension → tab wiring requires manual / browser-based
  testing on a real Chrome (run this harness on the Linux box; see README's
  "Dual-model Ollama setup" for the local-model config).

Stdlib only (matches browser_smoke.py dependency baseline).
"""
from __future__ import annotations

import importlib.util
import json
import os
import platform
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
import urllib.error
from contextlib import closing
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

# ──────────────────────────────────────────────────────────────────────────────
# Locate siblings
# ──────────────────────────────────────────────────────────────────────────────

SCRIPTS_DIR = Path(__file__).resolve().parent
REPO = SCRIPTS_DIR.parent
DIST = REPO / "extension" / "dist"
if platform.system() == "Linux":
    CHROME = os.environ.get("CHROME_BIN", "/usr/bin/google-chrome")
else:
    CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

# ──────────────────────────────────────────────────────────────────────────────
# Import proven helpers from browser_smoke.py
# (WS, CDP, find_free_port, http_get, wait_for, _collect_sw)
# ──────────────────────────────────────────────────────────────────────────────

_smoke_path = SCRIPTS_DIR / "browser_smoke.py"
_spec = importlib.util.spec_from_file_location("browser_smoke", _smoke_path)
_smoke = importlib.util.module_from_spec(_spec)  # type: ignore[arg-type]
_spec.loader.exec_module(_smoke)  # type: ignore[union-attr]

WS             = _smoke.WS
CDP            = _smoke.CDP
find_free_port = _smoke.find_free_port
http_get       = _smoke.http_get
wait_for       = _smoke.wait_for
_collect_sw    = _smoke._collect_sw

# ──────────────────────────────────────────────────────────────────────────────
# Test page — served locally so domain-tier keys work on a stable host
# ──────────────────────────────────────────────────────────────────────────────

TEST_PAGE_HTML = """<!doctype html><meta charset=utf-8><title>polaris smoke</title>
<input id="q" type="text">
<button id="go" onclick="window.__clicked=true">Go</button>
<select id="sort"><option value="rel">Relevance</option><option value="price">Price</option></select>
"""

# ──────────────────────────────────────────────────────────────────────────────
# Result tracking
# ──────────────────────────────────────────────────────────────────────────────

_results: list[tuple[str, bool, str]] = []

def check(name: str, ok: bool, detail: str = "") -> bool:
    """Record and print one PASS/FAIL line."""
    status = "PASS" if ok else "FAIL"
    line = f"  [{status}] {name}"
    if detail:
        line += f"  ({detail})"
    print(line)
    _results.append((name, ok, detail))
    return ok

# ──────────────────────────────────────────────────────────────────────────────
# Minimal local HTTP server for the test page
# ──────────────────────────────────────────────────────────────────────────────

class _PageHandler(BaseHTTPRequestHandler):
    html_bytes: bytes = TEST_PAGE_HTML.encode()

    def do_GET(self) -> None:  # noqa: N802
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(self.html_bytes)))
        self.end_headers()
        self.wfile.write(self.html_bytes)

    def log_message(self, *_args: object) -> None:  # suppress access log noise
        pass


def _start_page_server() -> tuple[HTTPServer, int]:
    port = find_free_port()
    server = HTTPServer(("127.0.0.1", port), _PageHandler)
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()
    return server, port

# ──────────────────────────────────────────────────────────────────────────────
# CDP helpers for page targets
# ──────────────────────────────────────────────────────────────────────────────

def open_page_cdp(cdp_port: int, url: str, timeout: float = 15) -> tuple[str, CDP]:
    """Open a new tab to `url` and return its targetId + a CDP session on it."""
    # Get browser WebSocket URL
    ver = json.loads(http_get(f"http://localhost:{cdp_port}/json/version", timeout=timeout))
    browser_ws = ver.get("webSocketDebuggerUrl")
    if not browser_ws:
        raise RuntimeError(f"No browser WebSocket URL: {ver}")
    # Use Target.createTarget over WebSocket (HTTP /json/new is 405 on Chrome 148+)
    browser_cdp = CDP(browser_ws)
    result = browser_cdp.call("Target.createTarget", {
        "url": url,
        "newWindow": False,
    }, timeout=timeout)
    browser_cdp.close()
    target_id = result.get("targetId")
    if not target_id:
        raise RuntimeError(f"Target.createTarget failed: {result}")
    # Discover the page's WebSocket URL from /json list
    targets = json.loads(http_get(f"http://localhost:{cdp_port}/json", timeout=timeout))
    ws_url = None
    for t in targets:
        if t.get("id") == target_id:
            ws_url = t.get("webSocketDebuggerUrl")
            break
    if not ws_url:
        raise RuntimeError(f"Could not find WS URL for target {target_id}")
    page_cdp = CDP(ws_url)
    page_cdp.call("Runtime.enable")
    page_cdp.call("DOM.enable")
    return target_id, page_cdp


def wait_page_loaded(page_cdp: CDP, timeout: float = 15) -> bool:
    """Poll document.readyState until 'complete'."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            result = page_cdp.call("Runtime.evaluate", {
                "expression": "document.readyState",
                "returnByValue": True,
            }, timeout=5)
            if result.get("result", {}).get("value") == "complete":
                return True
        except Exception:
            pass
        time.sleep(0.3)
    return False


def page_eval(page_cdp: CDP, expr: str, await_promise: bool = False, timeout: float = 10) -> object:
    """Run JS in the page context and return the primitive result value."""
    params: dict = {"expression": expr, "returnByValue": True}
    if await_promise:
        params["awaitPromise"] = True
    result = page_cdp.call("Runtime.evaluate", params, timeout=timeout)
    exc = result.get("exceptionDetails")
    if exc:
        raise RuntimeError(f"JS exception: {exc.get('text')} — {exc}")
    return result.get("result", {}).get("value")


def cdp_get_document(page_cdp: CDP) -> int:
    """Return the root document nodeId (required before DOM queries)."""
    result = page_cdp.call("DOM.getDocument", {"depth": 0})
    node_id = result.get("root", {}).get("nodeId")
    if not isinstance(node_id, int):
        raise RuntimeError(f"DOM.getDocument returned no root nodeId: {result}")
    return node_id


def cdp_query_selector(page_cdp: CDP, document_node_id: int, selector: str) -> int:
    """Run DOM.querySelector and return the nodeId (0 = not found)."""
    result = page_cdp.call("DOM.querySelector", {
        "nodeId": document_node_id,
        "selector": selector,
    })
    return result.get("nodeId", 0)


def cdp_get_content_quads(page_cdp: CDP, node_id: int) -> list:
    """Return quads from DOM.getContentQuads for the given nodeId."""
    result = page_cdp.call("DOM.getContentQuads", {"nodeId": node_id})
    return result.get("quads", [])

# ──────────────────────────────────────────────────────────────────────────────
# Page-action replication helpers
# (mirror the EXACT CDP sequences from actions.ts, documented in the file header)
# ──────────────────────────────────────────────────────────────────────────────

def action_type(page_cdp: CDP, selector: str, text: str) -> None:
    """
    Replicate tab.type mechanics:
      DOM.getDocument → DOM.querySelector → Runtime.evaluate (clear+focus)
      → Input.dispatchKeyEvent (char) per character.
    """
    doc_node_id = cdp_get_document(page_cdp)
    el_node_id = cdp_query_selector(page_cdp, doc_node_id, selector)
    if not el_node_id:
        raise RuntimeError(f"action_type: selector {selector!r} not found")

    # Clear + focus (matches tab.type's Runtime.evaluate clear pass)
    page_cdp.call("Runtime.evaluate", {
        "expression": (
            f"(()=>{{const el=document.querySelector({json.dumps(selector)});"
            f"if(!el)return;"
            f"if(el instanceof HTMLInputElement||el instanceof HTMLTextAreaElement)"
            f"  el.value='';"
            f"else if(el.isContentEditable) el.textContent='';"
            f"el.focus();}})();"
        ),
        "returnByValue": True,
    })

    # Dispatch one char event per character (matches tab.type's keyEvent loop)
    for char in text:
        page_cdp.call("Input.dispatchKeyEvent", {
            "type": "char",
            "text": char,
            "key": char,
            "windowsVirtualKeyCode": ord(char),
        })


def action_click(page_cdp: CDP, selector: str) -> tuple[int, int]:
    """
    Replicate tab.click mechanics (CSS selector path):
      DOM.getDocument → DOM.querySelector → DOM.scrollIntoViewIfNeeded
      → DOM.getContentQuads → Input.dispatchMouseEvent(pressed+released).
    Returns (x, y) click coordinates.
    """
    doc_node_id = cdp_get_document(page_cdp)
    el_node_id = cdp_query_selector(page_cdp, doc_node_id, selector)
    if not el_node_id:
        raise RuntimeError(f"action_click: selector {selector!r} not found")

    # Scroll into view (best-effort, matches tab.click)
    try:
        page_cdp.call("DOM.scrollIntoViewIfNeeded", {"nodeId": el_node_id})
    except Exception:
        pass

    quads = cdp_get_content_quads(page_cdp, el_node_id)
    if not quads:
        raise RuntimeError(f"action_click: element {selector!r} has no visible bounding box")
    quad = quads[0]
    # Quad: [x1,y1, x2,y2, x3,y3, x4,y4] — top-left then clockwise
    x0, y0, x2, y2 = quad[0], quad[1], quad[4], quad[5]
    cx = int(x0 + (x2 - x0) / 2)
    cy = int(y0 + (y2 - y0) / 2)

    for event_type in ("mousePressed", "mouseReleased"):
        page_cdp.call("Input.dispatchMouseEvent", {
            "type": event_type,
            "x": cx, "y": cy,
            "button": "left",
            "clickCount": 1,
        })

    return cx, cy


def action_select(page_cdp: CDP, selector: str, value: str) -> None:
    """
    Replicate tab.select mechanics:
      Runtime.evaluate to set .value + dispatch change event.
    """
    expr = (
        f"(()=>{{const el=document.querySelector({json.dumps(selector)});"
        f"if(!el) return {{ok:false,error:'not found'}};"
        f"if(el.tagName!=='SELECT') return {{ok:false,error:'not a select'}};"
        f"el.value={json.dumps(value)};"
        f"el.dispatchEvent(new Event('change',{{bubbles:true}}));"
        f"return {{ok:true}};}})();"
    )
    result = page_cdp.call("Runtime.evaluate", {
        "expression": expr,
        "returnByValue": True,
    })
    val = result.get("result", {}).get("value")
    if not isinstance(val, dict) or not val.get("ok"):
        err = val.get("error") if isinstance(val, dict) else repr(val)
        raise RuntimeError(f"action_select: {err}")

# ──────────────────────────────────────────────────────────────────────────────
# Optional cloud check
# ──────────────────────────────────────────────────────────────────────────────

def run_cloud_check() -> bool:
    """
    Send one completion request to the DeepSeek V4-Flash endpoint and assert a
    non-empty assistant message comes back.  This is a network smoke for the
    cloud key + endpoint — it uses raw urllib (no SDK) mirroring CloudClient.
    Returns True on pass, False on fail.
    """
    api_key = os.environ.get("DEEPSEEK_API_KEY", "")
    if not api_key:
        print("  [SKIP] cloud check: DEEPSEEK_API_KEY not set")
        return True  # skipped is not a failure

    endpoint = os.environ.get(
        "DEEPSEEK_BASE_URL", "https://api.deepseek.com"
    ).rstrip("/") + "/chat/completions"

    body = json.dumps({
        "model": "deepseek-chat",
        "messages": [{"role": "user", "content": "Reply with exactly one word: polaris"}],
        "stream": False,
        "max_tokens": 32,
    }).encode()

    req = urllib.request.Request(
        endpoint,
        data=body,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode())
        content = data.get("choices", [{}])[0].get("message", {}).get("content", "")
        ok = bool(content.strip())
        check(
            "cloud: DeepSeek V4-Flash round-trip",
            ok,
            f"content={content[:80]!r}" if ok else f"empty response: {data!r}"[:120],
        )
        return ok
    except Exception as exc:
        check("cloud: DeepSeek V4-Flash round-trip", False, str(exc)[:120])
        return False

# ──────────────────────────────────────────────────────────────────────────────
# Main
# ──────────────────────────────────────────────────────────────────────────────

def main() -> int:
    # Pre-flight
    if not DIST.exists():
        print(f"FAIL: build first — {DIST} not found", file=sys.stderr)
        return 1
    if not Path(CHROME).exists():
        print(f"FAIL: Chrome not at {CHROME}", file=sys.stderr)
        return 1

    # Start the local test-page server
    page_server, page_port = _start_page_server()
    test_url = f"http://127.0.0.1:{page_port}/"
    print(f"[hybrid-smoke] test page: {test_url}")

    cdp_port = find_free_port()
    profile = Path(tempfile.mkdtemp(prefix="polaris-hybrid-test-"))
    print(f"[hybrid-smoke] profile:   {profile}")
    print(f"[hybrid-smoke] ext dist:  {DIST}")
    print(f"[hybrid-smoke] CDP port:  {cdp_port}")

    args = [
        CHROME,
        f"--user-data-dir={profile}",
        f"--load-extension={DIST}",
        f"--remote-debugging-port={cdp_port}",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-default-apps",
        "--disable-features=TranslateUI",
        "about:blank",
    ]
    proc = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    page_cdp: CDP | None = None

    try:
        # ── 1. Chrome CDP up ──────────────────────────────────────────────────
        if not wait_for(
            lambda: bool(http_get(f"http://localhost:{cdp_port}/json/version")),
            deadline_s=20,
        ):
            print("FAIL: CDP didn't come up", file=sys.stderr)
            return 2
        ver = json.loads(http_get(f"http://localhost:{cdp_port}/json/version"))
        print(f"[hybrid-smoke] Chrome: {ver.get('Browser', '?')}")

        # ── 2. Extension SW registered ────────────────────────────────────────
        sw_targets: list = []
        sw_ok = wait_for(
            lambda: bool(_collect_sw(cdp_port, sw_targets)), deadline_s=20
        )
        check("extension SW registered", sw_ok)
        if not sw_ok:
            print("[hybrid-smoke] all targets at failure:")
            for t in json.loads(http_get(f"http://localhost:{cdp_port}/json")):
                print(f"  type={t.get('type')} url={t.get('url','')!r}")
            return 3

        sw_target = sw_targets[0]
        ext_id = sw_target["url"].split("/")[2]
        print(f"[hybrid-smoke] extension id: {ext_id}")

        # ── 3. Open test page ─────────────────────────────────────────────────
        try:
            _target_id, page_cdp = open_page_cdp(cdp_port, test_url)
        except Exception as exc:
            check("test page opened", False, str(exc))
            return 4

        loaded = wait_page_loaded(page_cdp, timeout=15)
        check("test page loaded", loaded, test_url)
        if not loaded:
            return 4

        # ── 4. tab.type mechanics ─────────────────────────────────────────────
        # Replicates the EXACT CDP sequence from tab.type (actions.ts):
        #   DOM.getDocument → DOM.querySelector → Runtime.evaluate (clear+focus)
        #   → Input.dispatchKeyEvent (char) × N
        typed_ok = False
        typed_detail = ""
        try:
            action_type(page_cdp, "#q", "wireless headphones")
            # Read back via Runtime.evaluate to assert real DOM mutation
            val = page_eval(page_cdp, "document.querySelector('#q').value")
            typed_ok = (val == "wireless headphones")
            typed_detail = f"value={val!r}"
        except Exception as exc:
            typed_detail = str(exc)[:120]
        check("tab.type  → input#q .value === 'wireless headphones'", typed_ok, typed_detail)

        # ── 5. tab.click mechanics ────────────────────────────────────────────
        # Replicates the EXACT CDP sequence from tab.click (CSS selector path,
        # actions.ts):
        #   DOM.getDocument → DOM.querySelector → DOM.scrollIntoViewIfNeeded
        #   → DOM.getContentQuads → Input.dispatchMouseEvent ×2
        clicked_ok = False
        clicked_detail = ""
        try:
            cx, cy = action_click(page_cdp, "#go")
            val = page_eval(page_cdp, "window.__clicked")
            clicked_ok = val is True
            clicked_detail = f"coords=({cx},{cy}) __clicked={val!r}"
        except Exception as exc:
            clicked_detail = str(exc)[:120]
        check("tab.click → window.__clicked === true", clicked_ok, clicked_detail)

        # ── 6. tab.select mechanics ───────────────────────────────────────────
        # Replicates the EXACT CDP sequence from tab.select (actions.ts):
        #   Runtime.evaluate: el.value = value + dispatchEvent(change)
        selected_ok = False
        selected_detail = ""
        try:
            action_select(page_cdp, "#sort", "price")
            val = page_eval(page_cdp, "document.querySelector('#sort').value")
            selected_ok = (val == "price")
            selected_detail = f"value={val!r}"
        except Exception as exc:
            selected_detail = str(exc)[:120]
        check("tab.select → select#sort .value === 'price'", selected_ok, selected_detail)

        # ── 7. Optional cloud check ───────────────────────────────────────────
        if os.environ.get("POLARIS_SMOKE_CLOUD") == "1":
            print("[hybrid-smoke] POLARIS_SMOKE_CLOUD=1 — running cloud check …")
            run_cloud_check()
        else:
            print("[hybrid-smoke] cloud check skipped (set POLARIS_SMOKE_CLOUD=1 to enable)")

    finally:
        if page_cdp is not None:
            try:
                page_cdp.close()
            except Exception:
                pass
        proc.send_signal(signal.SIGTERM)
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
        shutil.rmtree(profile, ignore_errors=True)
        page_server.shutdown()
        print("[hybrid-smoke] Chrome stopped, profile cleaned")

    # ── Summary ───────────────────────────────────────────────────────────────
    failures = [name for name, ok, _ in _results if not ok]
    total = len(_results)
    passed = sum(1 for _, ok, _ in _results if ok)
    print()
    if not failures:
        print(f"[hybrid-smoke] ALL PASS ({passed}/{total})")
    else:
        print(f"[hybrid-smoke] FAILURES: {len(failures)}/{total}")
        for name in failures:
            print(f"  - {name}")

    return 0 if not failures else 1


if __name__ == "__main__":
    sys.exit(main())
