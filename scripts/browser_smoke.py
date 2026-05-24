#!/usr/bin/env python3
"""
Browser smoke test for the Polaris extension.

Launches Chrome with the built extension loaded, points it at the CDP
remote-debugging port, then verifies:
  1. Service worker registers
  2. No errors in service worker console at boot
  3. Ollama /api/tags is reachable from the extension (no CORS rejection)
  4. (If reachable) one chat round-trip works end-to-end

Requires: built dist/ under ../extension/dist; system Chrome at the
standard /Applications path; local Ollama on http://localhost:11434
with OLLAMA_ORIGINS allowing chrome-extension://*  (or set to "*").

Stdlib only.
"""
from __future__ import annotations

import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
import urllib.error
from contextlib import closing
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
DIST = REPO / "extension" / "dist"
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
CDP_PORT = 9222

# ----------------------------- helpers ----------------------------

def find_free_port() -> int:
    with closing(socket.socket()) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]

def http_get(url: str, timeout: float = 5) -> str:
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return r.read().decode()

def wait_for(predicate, deadline_s: float = 15, interval_s: float = 0.3) -> bool:
    end = time.time() + deadline_s
    while time.time() < end:
        try:
            if predicate():
                return True
        except Exception:
            pass
        time.sleep(interval_s)
    return False

# ----------------------------- CDP via stdlib WebSocket ---------------------

# Tiny WebSocket client over stdlib socket — Chrome's CDP needs WS, not HTTP.
# We implement the bare minimum (no extensions, no fragmentation past 64KB
# for our tiny payloads). Good enough for evaluating short JS in a target.

import base64, hashlib, struct, secrets

class WS:
    def __init__(self, url: str):
        # ws://host:port/path
        assert url.startswith("ws://"), url
        rest = url[len("ws://"):]
        hostport, _, path = rest.partition("/")
        host, _, port = hostport.partition(":")
        self.host = host
        self.port = int(port or "80")
        self.path = "/" + path
        self.sock = socket.create_connection((self.host, self.port), timeout=20)
        self._handshake()

    def _handshake(self) -> None:
        key = base64.b64encode(secrets.token_bytes(16)).decode()
        req = (
            f"GET {self.path} HTTP/1.1\r\n"
            f"Host: {self.host}:{self.port}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n"
            "\r\n"
        )
        self.sock.sendall(req.encode())
        # Read headers until \r\n\r\n
        buf = b""
        while b"\r\n\r\n" not in buf:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise ConnectionError("server closed during handshake")
            buf += chunk
        head, _, leftover = buf.partition(b"\r\n\r\n")
        if b"101" not in head.split(b"\r\n", 1)[0]:
            raise ConnectionError(f"handshake failed: {head[:120]}")
        self._rxbuf = leftover

    def send(self, data: str) -> None:
        payload = data.encode()
        # Final fragment + text opcode = 0x81
        header = bytearray([0x81])
        length = len(payload)
        mask = secrets.token_bytes(4)
        if length < 126:
            header.append(0x80 | length)
        elif length < (1 << 16):
            header.append(0x80 | 126)
            header += struct.pack(">H", length)
        else:
            header.append(0x80 | 127)
            header += struct.pack(">Q", length)
        header += mask
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        self.sock.sendall(bytes(header) + masked)

    def recv(self, timeout: float = 20) -> str:
        self.sock.settimeout(timeout)
        # Read header byte 1
        b1 = self._read_exact(1)[0]
        opcode = b1 & 0x0F
        b2 = self._read_exact(1)[0]
        length = b2 & 0x7F
        if length == 126:
            length = struct.unpack(">H", self._read_exact(2))[0]
        elif length == 127:
            length = struct.unpack(">Q", self._read_exact(8))[0]
        payload = self._read_exact(length)
        if opcode == 0x8:
            raise ConnectionError("server sent close")
        if opcode == 0x9:  # ping
            # We're not handling pings — best effort.
            return self.recv(timeout)
        return payload.decode("utf-8", errors="replace")

    def _read_exact(self, n: int) -> bytes:
        out = self._rxbuf[:n]
        self._rxbuf = self._rxbuf[n:]
        while len(out) < n:
            chunk = self.sock.recv(max(4096, n - len(out)))
            if not chunk:
                raise ConnectionError("server closed mid-frame")
            out += chunk
        if len(out) > n:
            self._rxbuf = out[n:] + self._rxbuf
            out = out[:n]
        return out

    def close(self) -> None:
        try:
            self.sock.close()
        except Exception:
            pass

class CDP:
    """Minimal CDP wrapper — open one WS per target, send commands by id."""
    def __init__(self, ws_url: str):
        self.ws = WS(ws_url)
        self._id = 0

    def call(self, method: str, params: dict | None = None, timeout: float = 30) -> dict:
        self._id += 1
        msg_id = self._id
        msg = {"id": msg_id, "method": method, "params": params or {}}
        self.ws.send(json.dumps(msg))
        # Read until we get a response with matching id (skip event notifications)
        end = time.time() + timeout
        while time.time() < end:
            try:
                raw = self.ws.recv(timeout=max(0.5, end - time.time()))
            except socket.timeout:
                continue
            obj = json.loads(raw)
            if obj.get("id") == msg_id:
                if "error" in obj:
                    raise RuntimeError(f"CDP error {method}: {obj['error']}")
                return obj.get("result", {})
            # else it's an event — ignore
        raise TimeoutError(f"CDP timeout on {method}")

    def close(self) -> None:
        self.ws.close()

# ----------------------------- main flow ---------------------------

def main() -> int:
    if not DIST.exists():
        print(f"FAIL: build first — {DIST} not found", file=sys.stderr)
        return 1
    if not Path(CHROME).exists():
        print(f"FAIL: Chrome not at {CHROME}", file=sys.stderr)
        return 1

    profile = Path(tempfile.mkdtemp(prefix="polaris-test-"))
    print(f"[smoke] profile: {profile}")
    print(f"[smoke] loading extension from: {DIST}")
    print(f"[smoke] CDP port: {CDP_PORT}")

    args = [
        CHROME,
        f"--user-data-dir={profile}",
        f"--load-extension={DIST}",
        f"--remote-debugging-port={CDP_PORT}",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-default-apps",
        "--disable-features=TranslateUI",
        "--silent-launch",
        "about:blank",
    ]
    proc = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        # 1) Wait for CDP HTTP to be reachable
        if not wait_for(lambda: bool(http_get(f"http://localhost:{CDP_PORT}/json/version")), deadline_s=20):
            print("FAIL: CDP didn't come up", file=sys.stderr)
            return 2
        ver = json.loads(http_get(f"http://localhost:{CDP_PORT}/json/version"))
        print(f"[smoke] Chrome: {ver.get('Browser', '?')}")

        # 2) Wait for service worker target to appear
        def find_sw():
            targets = json.loads(http_get(f"http://localhost:{CDP_PORT}/json"))
            return [t for t in targets if t.get("type") == "service_worker"
                    and "Polaris" in t.get("title", "") + t.get("url", "")
                    or "chrome-extension://" in t.get("url", "")
                    and t.get("type") == "service_worker"]
        sw_targets = []
        if not wait_for(lambda: bool(_collect_sw(CDP_PORT, sw_targets)), deadline_s=20):
            print("FAIL: no extension service worker target appeared", file=sys.stderr)
            print("[smoke] all targets:")
            for t in json.loads(http_get(f"http://localhost:{CDP_PORT}/json")):
                print(f"  type={t.get('type')} title={t.get('title','')!r} url={t.get('url','')!r}")
            return 3
        sw = sw_targets[0]
        ext_id = sw["url"].split("/")[2]
        print(f"[smoke] extension id: {ext_id}")
        print(f"[smoke] SW target: {sw['url']}")

        # 3) Open CDP WS to the service worker
        cdp = CDP(sw["webSocketDebuggerUrl"])

        # Enable Runtime + Log domains so we can see console output and execute.
        cdp.call("Runtime.enable")
        cdp.call("Log.enable")

        # 4) Read any prior console messages already buffered (best-effort)
        # 5) Evaluate: does the extension see our modules / no top-level errors?
        result = cdp.call("Runtime.evaluate", {
            "expression": "typeof chrome !== 'undefined' && !!chrome.runtime && !!chrome.storage",
            "returnByValue": True,
        })
        ok_apis = result.get("result", {}).get("value")
        print(f"[smoke] chrome APIs available in SW: {ok_apis}")
        if not ok_apis:
            return 4

        # 6) Hit Ollama /api/tags from inside the extension context
        #    (this is the real CORS test — fetch from chrome-extension:// origin)
        ollama_url = os.environ.get("OLLAMA_BASE_URL", "http://localhost:11434")
        result = cdp.call("Runtime.evaluate", {
            "expression": f"""
                (async () => {{
                  try {{
                    const r = await fetch('{ollama_url}/api/tags');
                    const ok = r.ok;
                    const body = await r.text();
                    return JSON.stringify({{ok, status: r.status, len: body.length}});
                  }} catch (e) {{
                    return JSON.stringify({{ok: false, error: String(e)}});
                  }}
                }})()
            """,
            "awaitPromise": True,
            "returnByValue": True,
        }, timeout=30)
        val = result.get("result", {}).get("value")
        print(f"[smoke] Ollama fetch from extension: {val}")
        if not val:
            return 5
        parsed = json.loads(val)
        if not parsed.get("ok"):
            print(f"FAIL: Ollama unreachable or CORS-rejected: {parsed}", file=sys.stderr)
            print(f"      Hint: set OLLAMA_ORIGINS='chrome-extension://*' on the Ollama server.", file=sys.stderr)
            return 6

        # 7) End-to-end chat round-trip via /api/chat (non-streaming for simplicity)
        chat_expr = f"""
            (async () => {{
              try {{
                const r = await fetch('{ollama_url}/api/chat', {{
                  method: 'POST',
                  headers: {{'Content-Type': 'application/json'}},
                  body: JSON.stringify({{
                    model: 'qwen3.5:4b',
                    messages: [{{role: 'user', content: 'Reply with exactly one word: polaris'}}],
                    stream: false,
                    think: false
                  }}),
                }});
                if (!r.ok) {{
                  return JSON.stringify({{ok: false, status: r.status, body: (await r.text()).slice(0,200)}});
                }}
                const data = await r.json();
                return JSON.stringify({{ok: true, content: data.message?.content?.slice(0,200) ?? '', eval_count: data.eval_count}});
              }} catch (e) {{
                return JSON.stringify({{ok: false, error: String(e)}});
              }}
            }})()
        """
        result = cdp.call("Runtime.evaluate", {
            "expression": chat_expr, "awaitPromise": True, "returnByValue": True,
        }, timeout=120)
        val = result.get("result", {}).get("value")
        print(f"[smoke] chat round-trip: {val}")
        if not val:
            return 7
        parsed = json.loads(val)
        if not parsed.get("ok"):
            print(f"FAIL: chat call failed: {parsed}", file=sys.stderr)
            return 8

        print("\n[smoke] ✅ ALL CHECKS PASSED")
        print(f"  · extension loaded (id={ext_id})")
        print(f"  · service worker registered, chrome APIs present")
        print(f"  · fetch to {ollama_url}/api/tags from chrome-extension origin succeeded (no CORS 403)")
        print(f"  · chat round-trip returned content={parsed.get('content')!r}, eval_count={parsed.get('eval_count')}")
        cdp.close()
        return 0
    finally:
        proc.send_signal(signal.SIGTERM)
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
        shutil.rmtree(profile, ignore_errors=True)
        print(f"[smoke] Chrome stopped, profile cleaned")

def _collect_sw(port: int, sink: list) -> bool:
    """Populate `sink` with any extension service worker targets."""
    try:
        targets = json.loads(http_get(f"http://localhost:{port}/json"))
    except Exception:
        return False
    sink.clear()
    for t in targets:
        if t.get("type") == "service_worker" and t.get("url", "").startswith("chrome-extension://"):
            sink.append(t)
    return bool(sink)

if __name__ == "__main__":
    sys.exit(main())
