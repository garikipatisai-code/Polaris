#!/usr/bin/env python3
"""
Comprehensive capability probe for qwen3.5:4b via Ollama.
Stdlib only. Works on Python 3.9+.

USAGE:
    python3 probe.py                              # run all tests, localhost Ollama
    OLLAMA_BASE_URL=http://192.168.1.50:11434 python3 probe.py
    python3 probe.py --only chat,tool,think      # run a subset
    python3 probe.py --skip needle               # skip a test
    python3 probe.py --needle-depths 4,16,32,64  # custom needle depths in K
    python3 probe.py --model qwen3.5:4b          # override model
    python3 probe.py --out ./my_results.json     # custom output path

OUTPUT:
    - Live progress to stdout
    - Structured JSON results to ./probe_results.json (or --out)
    - Last 3 KB of log mirrored to ./probe_log.txt
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import subprocess
import sys
import time
import urllib.request
import urllib.error
from pathlib import Path
from typing import Any, Optional

# ----------------------------- config -----------------------------

DEFAULT_OLLAMA = os.environ.get("OLLAMA_BASE_URL", "http://localhost:11434")
DEFAULT_MODEL = os.environ.get("OLLAMA_MODEL", "qwen3.5:4b")

# ----------------------------- helpers ----------------------------

class Probe:
    def __init__(self, base_url: str, model: str, out_path: Path):
        self.base = base_url.rstrip("/")
        self.model = model
        self.out_path = out_path
        self.log_path = out_path.with_suffix(".log")
        self.results: dict[str, Any] = {
            "model": model,
            "base_url": base_url,
            "started_at": time.time(),
            "host": _uname(),
            "tests": {},
        }
        self._log: list[str] = []

    def log(self, msg: str = "") -> None:
        print(msg, flush=True)
        self._log.append(msg)

    def save(self) -> None:
        self.out_path.write_text(json.dumps(self.results, indent=2, default=str))
        self.log_path.write_text("\n".join(self._log[-500:]))

    def post(self, path: str, payload: dict, timeout: float = 1800) -> dict:
        req = urllib.request.Request(
            self.base + path,
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read().decode())
        except urllib.error.HTTPError as e:
            return {"_http_error": e.code, "_body": e.read().decode(errors="replace")[:500]}
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            return {"_net_error": str(e)[:300]}

    def chat(
        self,
        messages: list,
        options: Optional[dict] = None,
        tools: Optional[list] = None,
        format: Any = None,
        think: Optional[bool] = None,
        timeout: float = 1800,
    ) -> dict:
        payload: dict = {"model": self.model, "messages": messages, "stream": False}
        if options:
            payload["options"] = options
        if tools:
            payload["tools"] = tools
        if format is not None:
            payload["format"] = format
        if think is not None:
            payload["think"] = think
        return self.post("/api/chat", payload, timeout=timeout)

# ----------------------------- utilities --------------------------

def _uname() -> str:
    try:
        return subprocess.check_output(["uname", "-a"], text=True).strip()
    except Exception:
        return sys.platform

def _record(p: Probe, name: str, value: Any) -> None:
    p.results["tests"][name] = value
    p.save()

# ----------------------------- tests ------------------------------

def t_preflight(p: Probe) -> None:
    p.log("\n=== preflight: Ollama up + model present ===")
    tags = p.post("/api/tags", {}, timeout=10)  # GET works as POST with empty body? Actually need GET.
    # Fall back to a real GET:
    try:
        with urllib.request.urlopen(p.base + "/api/tags", timeout=10) as r:
            tags = json.loads(r.read().decode())
    except Exception as e:
        p.log(f"  Ollama unreachable at {p.base}: {e}")
        _record(p, "preflight", {"ok": False, "err": str(e)})
        return
    models = [m["name"] for m in tags.get("models", [])]
    present = p.model in models
    p.log(f"  Ollama reachable, {len(models)} models loaded")
    p.log(f"  Target {p.model}: {'PRESENT' if present else 'MISSING'}")
    if not present:
        p.log(f"  Available: {models}")

    show = p.post("/api/show", {"name": p.model}, timeout=20)
    details = show.get("details") or {}
    model_info = show.get("model_info") or {}
    arch = model_info.get("general.architecture") or details.get("family")
    ctx = model_info.get(f"{arch}.context_length") if arch else None
    p.log(f"  arch={arch}, advertised context_length={ctx}")
    _record(p, "preflight", {
        "ok": present,
        "models_available": models,
        "details": details,
        "arch": arch,
        "context_length": ctx,
    })

def t_chat_latency(p: Probe) -> None:
    p.log("\n=== chat + latency (5 calls) ===")
    samples = []
    for i in range(5):
        start = time.time()
        r = p.chat(
            [{"role": "user", "content": "Reply with exactly one word: pong"}],
            think=False,
        )
        wall = time.time() - start
        if "_http_error" in r or "_net_error" in r:
            p.log(f"  {i+1}: ERROR {r}")
            samples.append({"ok": False, "err": r})
            continue
        m = r.get("message") or {}
        eval_dur = r.get("eval_duration", 0) / 1e9
        tps = (r.get("eval_count", 0) / eval_dur) if eval_dur else 0
        samples.append({
            "ok": True, "wall": round(wall, 2),
            "prompt_tokens": r.get("prompt_eval_count"),
            "gen_tokens": r.get("eval_count"),
            "tok_per_sec": round(tps, 2),
            "content": (m.get("content") or "")[:80],
        })
        p.log(f"  {i+1}: wall={wall:.2f}s  tps={tps:.1f}  gen={r.get('eval_count')}  "
              f"reply={(m.get('content') or '')[:60]!r}")
    good = [s for s in samples if s.get("ok")]
    avg_tps = sum(s["tok_per_sec"] for s in good) / len(good) if good else 0
    p.log(f"  AVG tok/sec (excl first): "
          f"{sum(s['tok_per_sec'] for s in good[1:])/max(len(good)-1,1):.1f}")
    _record(p, "chat_latency", {"samples": samples, "avg_tps": round(avg_tps, 2)})

def t_tool_call(p: Probe) -> None:
    p.log("\n=== native tool calling ===")
    tools = [{
        "type": "function",
        "function": {
            "name": "get_current_weather",
            "description": "Get current weather for a city.",
            "parameters": {
                "type": "object",
                "properties": {
                    "city": {"type": "string"},
                    "unit": {"type": "string", "enum": ["celsius", "fahrenheit"]},
                },
                "required": ["city", "unit"],
            },
        },
    }]
    r = p.chat(
        [{"role": "user", "content": "Weather in Tokyo in celsius. Use the tool."}],
        tools=tools, think=False,
    )
    msg = r.get("message") or {}
    tcs = msg.get("tool_calls") or []
    ok = bool(tcs) and "city" in (tcs[0].get("function", {}).get("arguments") or {})
    p.log(f"  tool_calls returned: {len(tcs)}  ok={ok}")
    if tcs:
        p.log(f"  first call: {json.dumps(tcs[0])[:300]}")
    _record(p, "tool_call", {"ok": ok, "n_calls": len(tcs), "first": tcs[0] if tcs else None})

def t_thinking_toggle(p: Probe) -> None:
    p.log("\n=== thinking-mode toggle ===")
    q = "What is 17 * 23? Reply with just the number."
    on = p.chat([{"role": "user", "content": q}], think=True)
    off = p.chat([{"role": "user", "content": q}], think=False)
    def pick(r):
        if "_http_error" in r or "_net_error" in r:
            return {"err": r}
        m = r.get("message") or {}
        return {
            "thinking_len": len(m.get("thinking") or ""),
            "content": m.get("content", "")[:80],
            "gen_tokens": r.get("eval_count", 0),
        }
    on_p, off_p = pick(on), pick(off)
    p.log(f"  think=True : thinking_len={on_p.get('thinking_len')}, gen={on_p.get('gen_tokens')}, content={on_p.get('content')!r}")
    p.log(f"  think=False: thinking_len={off_p.get('thinking_len')}, gen={off_p.get('gen_tokens')}, content={off_p.get('content')!r}")
    _record(p, "thinking_toggle", {
        "on": on_p, "off": off_p,
        "supported": (on_p.get("thinking_len") or 0) > (off_p.get("thinking_len") or 0),
    })

def t_json_string_mode(p: Probe, n: int = 10) -> None:
    p.log(f"\n=== format:'json' string mode ({n} calls) ===")
    successes = 0
    parses = []
    for i in range(n):
        r = p.chat(
            [{"role": "user", "content":
              "Output ONE fake product as JSON with keys product (str), price_usd (number), in_stock (bool), rating (0-5 number). JSON only, no prose."}],
            format="json", think=False,
        )
        if "_http_error" in r or "_net_error" in r:
            parses.append({"ok": False, "err": str(r)[:200]})
            continue
        content = (r.get("message") or {}).get("content", "")
        try:
            obj = json.loads(content)
            ok = all(k in obj for k in ["product", "price_usd", "in_stock", "rating"])
            successes += ok
            parses.append({"ok": ok, "obj": obj})
        except Exception as e:
            parses.append({"ok": False, "err": str(e), "raw": content[:200]})
    p.log(f"  {successes}/{n} valid")
    _record(p, "json_string_mode", {"n": n, "successes": successes, "rate": successes / n, "parses": parses})

def t_json_schema_mode(p: Probe, n: int = 3) -> None:
    """Documents whether the model honors a JSON-Schema object as format constraint."""
    p.log(f"\n=== format:<schema> object mode ({n} calls — known to be flaky) ===")
    schema = {
        "type": "object",
        "properties": {
            "product": {"type": "string"},
            "price_usd": {"type": "number"},
            "in_stock": {"type": "boolean"},
            "rating": {"type": "number"},
        },
        "required": ["product", "price_usd", "in_stock", "rating"],
    }
    successes = 0
    parses = []
    for i in range(n):
        r = p.chat(
            [{"role": "user", "content": "Output one fake product listing matching the schema."}],
            format=schema, think=False,
        )
        if "_http_error" in r or "_net_error" in r:
            parses.append({"ok": False, "err": str(r)[:200]})
            continue
        content = (r.get("message") or {}).get("content", "")
        try:
            obj = json.loads(content)
            ok = all(k in obj for k in ["product", "price_usd", "in_stock", "rating"])
            successes += ok
            parses.append({"ok": ok, "obj": obj})
        except Exception as e:
            parses.append({"ok": False, "err": str(e), "raw": content[:200]})
    p.log(f"  {successes}/{n} valid (if 0, schema-object mode confirmed broken — use json string mode or tool calls)")
    _record(p, "json_schema_mode", {"n": n, "successes": successes, "parses": parses})

def t_tool_call_structured(p: Probe, n: int = 5) -> None:
    p.log(f"\n=== tool-call as structured-output channel ({n} calls) ===")
    tools = [{"type": "function", "function": {
        "name": "report_product",
        "description": "Report a product listing.",
        "parameters": {
            "type": "object",
            "properties": {
                "product": {"type": "string"},
                "price_usd": {"type": "number"},
                "in_stock": {"type": "boolean"},
                "rating": {"type": "number"},
            },
            "required": ["product", "price_usd", "in_stock", "rating"],
        }}}]
    successes = 0
    parses = []
    for i in range(n):
        r = p.chat(
            [{"role": "user", "content": "Invent one fake product and report via report_product tool."}],
            tools=tools, think=False,
        )
        tcs = (r.get("message") or {}).get("tool_calls") or []
        ok = bool(tcs) and all(k in (tcs[0].get("function", {}).get("arguments") or {})
                                for k in ["product", "price_usd", "in_stock", "rating"])
        successes += ok
        parses.append({"ok": ok, "call": tcs[0] if tcs else None})
    p.log(f"  {successes}/{n} valid")
    _record(p, "tool_call_structured", {"n": n, "successes": successes, "rate": successes / n, "parses": parses})

def t_vision_sizes(p: Probe) -> None:
    p.log("\n=== vision: scaling image size ===")
    # Find a reference image: prefer one shipped in the repo, then common locations
    script_dir = Path(__file__).resolve().parent
    src_candidates = [
        script_dir / "docs" / "ollama-qwen35-page.png",
        Path.cwd() / "docs" / "ollama-qwen35-page.png",
        Path.cwd() / "ollama-qwen35-page.png",
        Path("/Users/saikrishna/Documents/Spike/Personal/Browser/_slices/slice_07.png"),
        Path("/Users/saikrishna/Documents/Spike/Personal/Browser/qwen3.5:4b.png"),
        Path(os.path.expanduser("~/Downloads/qwen3.5:4b.png")),
        Path(os.path.expanduser("~/Desktop/qwen3.5:4b.png")),
    ]
    src = next((str(c) for c in src_candidates if c.exists()), None)
    if src is None:
        p.log("  no test image found; skipping vision tests")
        _record(p, "vision_sizes", {"skipped": True, "reason": "no source image"})
        return
    p.log(f"  source image: {src}")

    # Pick whichever image resizer is on PATH; if none, just use the original
    resize_tool = None
    for cand in ["sips", "convert", "magick"]:
        try:
            subprocess.run(
                [cand, "--help" if cand == "sips" else "-version"],
                capture_output=True, timeout=5,
            )
            resize_tool = cand
            break
        except (FileNotFoundError, subprocess.TimeoutExpired):
            continue
    p.log(f"  resizer: {resize_tool or 'none (using original image at full size)'}")

    out_dir = p.out_path.parent / "_vision_temp"
    out_dir.mkdir(exist_ok=True)
    sizes_px = [400, 800, 1600] if resize_tool else [None]
    results = []
    for px in sizes_px:
        if px is None:
            tmp = Path(src)
            label = "original"
        else:
            tmp = out_dir / f"v_{px}.png"
            if resize_tool == "sips":
                subprocess.run(["sips", "-Z", str(px), src, "--out", str(tmp)],
                               capture_output=True, check=False)
            elif resize_tool == "convert":
                subprocess.run(["convert", src, "-resize", f"{px}x{px}>", str(tmp)],
                               capture_output=True, check=False)
            elif resize_tool == "magick":
                subprocess.run(["magick", src, "-resize", f"{px}x{px}>", str(tmp)],
                               capture_output=True, check=False)
            if not tmp.exists():
                results.append({"size": f"{px}px", "skipped": True, "reason": "resize failed"})
                continue
            label = f"{px}px"
        kb = tmp.stat().st_size / 1024
        b64 = base64.b64encode(tmp.read_bytes()).decode()
        start = time.time()
        r = p.chat(
            [{"role": "user",
              "content": "Read this screenshot. What model name is at the top of the page? Reply with just the name.",
              "images": [b64]}],
            think=False, timeout=600,
        )
        wall = time.time() - start
        if "_http_error" in r or "_net_error" in r:
            results.append({"size": label, "kb": round(kb, 1), "wall_s": round(wall, 1),
                            "ok": False, "err": r})
            p.log(f"  {label} ({kb:.0f} KB) wall={wall:.1f}s ERROR: {str(r)[:120]}")
            continue
        content = (r.get("message") or {}).get("content", "")
        ok = "qwen3.5" in content.lower() or "qwen 3.5" in content.lower()
        results.append({"size": label, "kb": round(kb, 1), "wall_s": round(wall, 1),
                        "ok": ok, "reply": content[:200]})
        p.log(f"  {label} ({kb:.0f} KB) wall={wall:.1f}s ok={ok} reply={content[:80]!r}")
    _record(p, "vision_sizes", {"src": src, "resize_tool": resize_tool, "results": results})

def t_streaming(p: Probe) -> None:
    p.log("\n=== streaming SSE ===")
    payload = {
        "model": p.model, "messages": [{"role": "user", "content": "Count slowly from 1 to 5."}],
        "stream": True, "think": False,
    }
    req = urllib.request.Request(
        p.base + "/api/chat",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
    )
    chunks = []
    start = time.time()
    ttft = None
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            for line in r:
                if ttft is None:
                    ttft = time.time() - start
                line = line.decode().strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                    chunks.append(obj.get("message", {}).get("content", ""))
                    if obj.get("done"):
                        break
                except Exception:
                    pass
        total = time.time() - start
        full = "".join(chunks)
        p.log(f"  ttft={ttft:.2f}s  total={total:.2f}s  chunks={len(chunks)}  text={full[:80]!r}")
        _record(p, "streaming", {"ok": True, "ttft_s": round(ttft or 0, 2),
                                  "total_s": round(total, 2), "chunks": len(chunks),
                                  "text": full})
    except Exception as e:
        p.log(f"  ERROR: {e}")
        _record(p, "streaming", {"ok": False, "err": str(e)[:200]})

def t_multiturn(p: Probe) -> None:
    p.log("\n=== multi-turn continuity ===")
    history = [
        {"role": "user", "content": "Remember: my favorite color is teal."},
    ]
    r1 = p.chat(history, think=False)
    history.append({"role": "assistant", "content": (r1.get("message") or {}).get("content", "")})
    history.append({"role": "user", "content": "Remember: my dog's name is Mochi."})
    r2 = p.chat(history, think=False)
    history.append({"role": "assistant", "content": (r2.get("message") or {}).get("content", "")})
    history.append({"role": "user", "content": "What's my favorite color AND my dog's name? Reply tersely."})
    r3 = p.chat(history, think=False)
    final = (r3.get("message") or {}).get("content", "")
    p.log(f"  turn3 reply: {final[:200]!r}")
    ok = "teal" in final.lower() and "mochi" in final.lower()
    _record(p, "multiturn", {"ok": ok, "final": final})

def t_needle(p: Probe, depths_k: list) -> None:
    p.log(f"\n=== needle-in-haystack (depths in K: {depths_k}) ===")
    needle = "The secret pass-phrase for the agent loop is BLUE-DOLPHIN-42."
    filler_word = "The quick brown fox jumps over the lazy dog. " * 5
    out = {}
    for k in depths_k:
        target_tokens = k * 1024
        target_chars = target_tokens * 4
        n_rep = max(1, target_chars // len(filler_word))
        filler = filler_word * n_rep
        cut = int(len(filler) * 0.7)  # 70% depth
        haystack = filler[:cut] + "\n\n" + needle + "\n\n" + filler[cut:]
        prompt = (
            haystack
            + "\n\nIgnore the filler text. What is the secret pass-phrase? Reply with just the pass-phrase, nothing else."
        )
        num_ctx = max(target_tokens + 4096, 8192)
        p.log(f"  -> {k}K  prompt_chars={len(prompt)}  num_ctx={num_ctx}")
        start = time.time()
        r = p.chat(
            [{"role": "user", "content": prompt}],
            options={"num_ctx": num_ctx}, think=False, timeout=3600,
        )
        wall = time.time() - start
        if "_http_error" in r or "_net_error" in r:
            p.log(f"     ERROR after {wall:.1f}s: {str(r)[:200]}")
            out[f"{k}k"] = {"ok": False, "wall_s": round(wall, 1), "err": r}
            _record(p, "needle", out)
            # Don't try larger if a smaller one already failed catastrophically
            if "_net_error" in r and "timed out" in str(r).lower():
                p.log(f"     timeout at {k}K — skipping larger depths")
                break
            continue
        content = (r.get("message") or {}).get("content", "")
        ok = "BLUE-DOLPHIN-42" in content
        out[f"{k}k"] = {
            "ok": ok, "wall_s": round(wall, 1),
            "prompt_tokens": r.get("prompt_eval_count"),
            "gen_tokens": r.get("eval_count"),
            "reply": content[:200],
        }
        p.log(f"     prompt_tokens={r.get('prompt_eval_count')}  wall={wall:.1f}s  found={ok}")
        p.log(f"     reply: {content[:100]!r}")
        _record(p, "needle", out)

def t_embedding(p: Probe) -> None:
    p.log("\n=== embeddings (mxbai-embed-large) ===")
    candidates = ["mxbai-embed-large:335m", "mxbai-embed-large", "mxbai-embed-large:latest", "nomic-embed-text"]
    chosen = None
    try:
        with urllib.request.urlopen(p.base + "/api/tags", timeout=10) as r:
            models = [m["name"] for m in json.loads(r.read().decode()).get("models", [])]
        for c in candidates:
            if c in models:
                chosen = c
                break
    except Exception as e:
        p.log(f"  cannot list models: {e}")
        _record(p, "embedding", {"ok": False, "err": str(e)})
        return
    if chosen is None:
        p.log(f"  no embedding model present (looked for {candidates})")
        _record(p, "embedding", {"ok": False, "reason": "no embedding model"})
        return
    start = time.time()
    r = p.post("/api/embed", {"model": chosen, "input": ["best price on Sony WH-1000XM5",
                                                          "weather forecast tomorrow"]}, timeout=120)
    wall = time.time() - start
    if "_http_error" in r or "_net_error" in r:
        p.log(f"  ERROR: {r}")
        _record(p, "embedding", {"ok": False, "err": r})
        return
    embs = r.get("embeddings") or []
    dims = len(embs[0]) if embs else 0
    p.log(f"  model={chosen} dims={dims} wall={wall:.2f}s")
    _record(p, "embedding", {"ok": True, "model": chosen, "dims": dims, "wall_s": round(wall, 2)})

# ----------------------------- runner -----------------------------

TESTS = [
    ("preflight",      t_preflight),
    ("chat",           t_chat_latency),
    ("tool",           t_tool_call),
    ("think",          t_thinking_toggle),
    ("json_string",    t_json_string_mode),
    ("json_schema",    t_json_schema_mode),
    ("tool_structured", t_tool_call_structured),
    ("streaming",      t_streaming),
    ("multiturn",      t_multiturn),
    ("vision",         t_vision_sizes),
    ("embedding",      t_embedding),
    ("needle",         lambda p: t_needle(p, p._needle_depths)),
]

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default=DEFAULT_OLLAMA, help="Ollama base URL")
    ap.add_argument("--model", default=DEFAULT_MODEL, help="model tag")
    ap.add_argument("--out", default="./probe_results.json", help="results JSON path")
    ap.add_argument("--only", help="comma-separated test names to run")
    ap.add_argument("--skip", help="comma-separated test names to skip")
    ap.add_argument("--needle-depths", default="4,16,32,64,128",
                    help="comma-separated needle depths in K (default 4,16,32,64,128)")
    args = ap.parse_args()

    p = Probe(args.base, args.model, Path(args.out))
    p._needle_depths = [int(x) for x in args.needle_depths.split(",") if x.strip()]
    only = set(args.only.split(",")) if args.only else None
    skip = set(args.skip.split(",")) if args.skip else set()

    p.log(f"probe.py  model={p.model}  base={p.base}")
    p.log(f"out={p.out_path}  log={p.log_path}")
    p.log(f"host: {p.results['host']}")

    for name, fn in TESTS:
        if only and name not in only:
            continue
        if name in skip:
            continue
        try:
            fn(p)
        except KeyboardInterrupt:
            p.log("\n[interrupted by user]")
            break
        except Exception as e:
            p.log(f"  !! {name} raised: {e}")
            _record(p, name, {"ok": False, "exception": str(e)})

    p.results["finished_at"] = time.time()
    p.results["wall_total_s"] = round(p.results["finished_at"] - p.results["started_at"], 1)
    p.save()
    p.log("\n=== summary ===")
    for name, _ in TESTS:
        t = p.results["tests"].get(name)
        if t is None:
            continue
        ok = t.get("ok")
        succ = t.get("successes")
        rate = t.get("rate")
        rate_s = f"  ({succ}/{t.get('n')}, {rate:.0%})" if rate is not None else ""
        flag = "✓" if ok else ("?" if ok is None else "✗")
        p.log(f"  [{flag}] {name}{rate_s}")
    p.log(f"\nresults: {p.out_path}")
    p.log(f"log:     {p.log_path}")
    return 0

if __name__ == "__main__":
    sys.exit(main())
