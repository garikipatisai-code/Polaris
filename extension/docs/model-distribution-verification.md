# Model-distribution verification — Linux P2200 — 2026-05-30

> **Hi Claude (Linux session).** You are running this on the production box
> (ThinkStation P330, Quadro P2200 5 GB VRAM, 32 GB DDR4, i7) because the Mac
> dev sandbox can't reach Ollama under real load. This is a **measurement run**,
> not a feature build:
>
> - **Do NOT write or change extension code.** The per-role *local-model
>   routing* (`settings.roleModels`) is **not built yet** — that's exactly why
>   this guide drives Ollama's `/api/chat` **directly** instead of through the
>   extension.
> - **Every system-level change is reversible and snapshotted.** Steps 4–5
>   touch the Ollama service + create throwaway model tags. You take a snapshot
>   first and restore at the end (see **Reversibility & safety**). The base
>   `qwen3.5:4b` / `qwen3.6:35b-a3b` tags are never modified.
> - **Don't re-measure what's already settled** (see the boundary table below).
>   Spend the box's time only on the genuinely new, decision-critical numbers.
> - When done, **fill in `## Session results`**, then **commit + push** this
>   file on branch `feat/hybrid-delta-wiring` (commit as
>   `garikipatisai@gmail.com`). That results section IS the deliverable I
>   review to lock the role→model table.

This guide closes step 2 of the spec's §10 model-distribution flow
(`docs/superpowers/specs/2026-05-30-hybrid-delta-wiring-design.md`). It
empirically tests the Gemini research's predictions
(`docs/superpowers/research/2026-05-30-model-distribution-gemini.md`) against
the real hardware so the role→model *defaults* can be locked.

---

## The hypothesis under test

The starting hypothesis (spec §10, confirmed by the Gemini research with
"High" confidence on every row):

| Role | Proposed model | Why |
|---|---|---|
| **Planner** | `qwen3.6:35b-a3b` | rare, latency-tolerant; 35B reasoning builds robust long-horizon plans |
| **Executor** | `qwen3.5:4b` | hot path, must be < 20 s/turn; only the GPU-resident 4B meets it |
| **Evaluator** | `qwen3.6:35b-a3b` | wrong verdicts waste whole loops; periodic, so slowness amortizes |
| **Compactor** | `qwen3.5:4b` | high-throughput simple synthesis; must not block the Executor loop |

This run produces the numbers that confirm or refute that table.

---

## What this verifies — and what it does NOT

**Already empirically measured on this box (DO NOT redo — sources in
`CLAUDE.md`, `extension/docs/probes/m3.5-linux.md`, `docs/challenges.md`):**

| Already known | Value | Source |
|---|---|---|
| `qwen3.5:4b` sustained gen | ~38 tok/s (short "pong") | CLAUDE.md hardware table |
| `qwen3.6:35b-a3b` gen | ~11 tok/s, 85%/15% CPU/GPU split | `docs/challenges.md:43` |
| 4B long-context latency curve | 4K=14.5 s … 128K=1089 s | CLAUDE.md "Long-context latency curve" |
| 4B tool-call success | ~80% (4/5), needs retry-on-empty | CLAUDE.md hardware table |
| `format:"json"` string mode (4B) | 10/10 ✅ | probe / CLAUDE.md |
| `format:<schema-object>` | 0/3 ❌ confirmed broken | probe / CLAUDE.md |
| KV-cache reuse ratio (4B) | 0.502 (T2/T1, ~50% reduction) | `m3.5-linux.md:41` |
| Vision threshold | hallucinates < 1200 px; 1600 px works | CLAUDE.md / Convention #5 |
| Loop-breaker logic | unit-tested (distinct-action + repeat + unknown-tool) | mock suite (231+ tests) |

**What is NEW and decision-critical (this run measures it):**

1. **35B prefill latency at the Executor budget (6K)** — the single most
   important number. Confirms/refutes whether the 35B is categorically
   unusable on the hot path (Prediction 1).
2. **Per-role turn latency on the 35B at real budgets** (Planner ≤32K,
   Evaluator ≤8K) — extrapolated from the measured 35B prefill rate, with an
   optional full-budget confirmation. Decides whether Planner/Evaluator on 35B
   is *latency-acceptable* given they're rare/periodic.
3. **Parser mismatch + tool-call reliability per model** (Prediction's
   qualitative core) — does Ollama's default Hermes-JSON parser produce empty
   `tool_calls` + raw XML leakage on these tags, and does thinking-ON corrupt
   the conversation for the Planner/Evaluator JSON path? This is the
   highest-leverage *unknown* — it reframes "model weakness" as possibly a
   config bug.
4. **Model-swap cost: `MAX_LOADED_MODELS=1` vs pinned `=2`** (Predictions 2 &
   3) — the open risk in spec §10: thrashing when alternating a GPU 4B and a
   CPU 35B per task.
5. **Concurrent memory footprint** (Prediction 4) — RAM 22–25 GB / VRAM
   < 3.5 GB / no OOM with both models pinned.

---

## Hardware (capture at run start)

```bash
nvidia-smi --query-gpu=name,memory.total,memory.used --format=csv,noheader   # Expected: Quadro P2200, 5120 MiB, ...
ollama --version            # Expected: 0.22.1 or note the actual version
node --version              # Expected: v20.x
free -h                     # baseline RAM
uname -a                    # P330 host string
```

---

## Pre-flight checks

```bash
# 1) Ollama reachable + BOTH model tags present (base tags, untouched by this run)
curl -s http://localhost:11434/api/tags | python3 -c "import sys,json; t=[m['name'] for m in json.load(sys.stdin)['models']]; print('\n'.join(t))"
#   Expected: list INCLUDES both 'qwen3.5:4b' and 'qwen3.6:35b-a3b'.
#   If 'qwen3.6:35b-a3b' is missing:  ollama pull qwen3.6:35b-a3b   (23 GB — only if not present)

# 2) Current Ollama env (RECORD THIS — you restore to it in Step 5)
systemctl show ollama --property=Environment
echo "$OLLAMA_MAX_LOADED_MODELS  $OLLAMA_NUM_PARALLEL  $OLLAMA_KEEP_ALIVE  $OLLAMA_KV_CACHE_TYPE"
#   Note Gap #4 from linux-validation.md: OLLAMA_ORIGINS may be empty here — irrelevant for this run (no browser).
```

---

## Reversibility & safety (do this BEFORE Step 4)

```bash
# Snapshot the service env so Step 5 can restore exactly.
systemctl show ollama --property=Environment > /tmp/ollama_env_before.txt
cat /tmp/ollama_env_before.txt

# Snapshot loaded-model state.
ollama ps > /tmp/ollama_ps_before.txt
```

- Steps 4–5 add a **systemd drop-in** and create **throwaway model tags**
  (`*-exec`, `*-plan`). Both are removed in **Step 5 — teardown**.
- `sudo systemctl revert ollama.service` deletes the drop-in entirely; a
  restart returns Ollama to exactly `/tmp/ollama_env_before.txt`.
- The base tags `qwen3.5:4b` and `qwen3.6:35b-a3b` are **never** modified.

---

## The measurement harness (save once, reused by Steps 1–4)

Save this to `/tmp/model_dist_probe.py`. It is **stdlib-only** (mirrors
`probe.py`) and **read-only against the server** — it only POSTs to
`/api/chat`; it changes no config. Crucially it reads the timing fields
`probe.py` ignores: `load_duration`, `prompt_eval_duration` (prefill), and
`eval_duration` (decode).

```python
cat > /tmp/model_dist_probe.py <<'PY'
#!/usr/bin/env python3
"""Per-role latency + tool-call reliability for the model-distribution decision.
Stdlib only. Read-only: only POSTs to /api/chat, changes no server config.
Reads load_duration / prompt_eval_duration / eval_duration that probe.py omits.
"""
import json, time, urllib.request, urllib.error, argparse, re, sys

BASE = "http://localhost:11434"
M4B  = "qwen3.5:4b"
M35  = "qwen3.6:35b-a3b"
XML_LEAK = re.compile(r"<tool_call>|<function\s*=|</?think>", re.I)

def chat(model, messages, options=None, tools=None, fmt=None, think=None, timeout=3000):
    body = {"model": model, "messages": messages, "stream": False}
    if options is not None: body["options"] = options
    if tools   is not None: body["tools"]   = tools
    if fmt     is not None: body["format"]  = fmt
    if think   is not None: body["think"]   = think
    req = urllib.request.Request(BASE + "/api/chat",
            data=json.dumps(body).encode(),
            headers={"Content-Type": "application/json"})
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=timeout) as r:
        resp = json.load(r)
    return resp, time.time() - t0

def timing(resp, wall):
    g = lambda k: resp.get(k, 0) or 0
    pe_c, pe_d = g("prompt_eval_count"), g("prompt_eval_duration")
    e_c,  e_d  = g("eval_count"),        g("eval_duration")
    ld         = g("load_duration")
    return {
        "wall_s":        round(wall, 1),
        "load_s":        round(ld / 1e9, 2),
        "prompt_tokens": pe_c,
        "prefill_s":     round(pe_d / 1e9, 1),
        "prefill_tok_s": round(pe_c / (pe_d / 1e9), 1) if pe_d else None,
        "gen_tokens":    e_c,
        "gen_s":         round(e_d / 1e9, 1),
        "gen_tok_s":     round(e_c / (e_d / 1e9), 1) if e_d else None,
    }

def make_prompt(approx_tokens):
    """~4 chars/token filler (matches probe.py's heuristic)."""
    filler = "The quick brown fox jumps over the lazy dog. "
    reps = max(1, (approx_tokens * 4) // len(filler))
    return (filler * reps) + "\n\nReply with exactly one word: ack"

WEATHER_TOOL = [{
    "type": "function",
    "function": {
        "name": "get_current_weather",
        "description": "Get the current weather for a city.",
        "parameters": {
            "type": "object",
            "properties": {
                "city": {"type": "string", "description": "City name"},
                "unit": {"type": "string", "enum": ["c", "f"]},
            },
            "required": ["city"],
        },
    },
}]

def latency(model, approx_tokens, num_ctx, force_cpu=False, num_predict=128):
    opts = {"num_ctx": num_ctx, "num_predict": num_predict}
    if force_cpu: opts["num_gpu"] = 0     # pin 35B to CPU for an honest hot-path number
    msgs = [{"role": "user", "content": make_prompt(approx_tokens)}]
    resp, wall = chat(model, msgs, options=opts, think=False)
    t = timing(resp, wall)
    t.update(model=model, target_tokens=approx_tokens, num_ctx=num_ctx, force_cpu=force_cpu)
    return t

def toolcall_trials(model, n=5, think=False, force_cpu=False):
    """Tool-call path (Executor channel). Counts empty tool_calls + raw-XML leak."""
    opts = {"num_ctx": 8192, "num_predict": 256}
    if force_cpu: opts["num_gpu"] = 0
    rows = []
    for i in range(n):
        msgs = [{"role": "user",
                 "content": "What's the weather in Paris? Use the get_current_weather tool."}]
        resp, wall = chat(model, msgs, options=opts, tools=WEATHER_TOOL, think=think)
        m = resp.get("message", {})
        tcs = m.get("tool_calls") or []
        content = m.get("content", "") or ""
        got_city = any("city" in (tc.get("function", {}).get("arguments") or {})
                       if isinstance(tc.get("function", {}).get("arguments"), dict)
                       else "city" in str(tc.get("function", {}).get("arguments", ""))
                       for tc in tcs)
        rows.append({
            "trial": i, "tool_calls": len(tcs), "got_city": got_city,
            "xml_leak": bool(XML_LEAK.search(content)),
            "content_head": content[:160].replace("\n", " "),
            "wall_s": round(wall, 1),
        })
    return rows

def json_thinking_trials(model, n=5):
    """Planner/Evaluator channel: format:'json' WITH thinking ON.
    Detects <think> leakage into content + JSON-parse failures (the corruption bug)."""
    rows = []
    for i in range(n):
        msgs = [{"role": "user",
                 "content": ('Return ONLY a JSON object describing a 2-step plan to '
                             'find the cheapest wireless headphones. '
                             'Keys: "summary" (string), "steps" (array of strings).')}]
        resp, wall = chat(model, msgs, fmt="json", think=True,
                          options={"num_ctx": 8192, "num_predict": 512})
        m = resp.get("message", {})
        content = m.get("content", "") or ""
        thinking = m.get("thinking", "") or ""
        try:
            json.loads(content); parsed = True
        except Exception:
            parsed = False
        rows.append({
            "trial": i, "json_parsed": parsed,
            "think_field_len": len(thinking),
            "think_leak_in_content": bool(re.search(r"</?think>", content, re.I)),
            "content_head": content[:160].replace("\n", " "),
            "wall_s": round(wall, 1),
        })
    return rows

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["latency", "tools", "jsonthink"])
    ap.add_argument("--model", default=M4B)
    ap.add_argument("--tokens", type=int, default=6000)
    ap.add_argument("--num-ctx", type=int, default=8192)
    ap.add_argument("--cpu", action="store_true")
    ap.add_argument("--n", type=int, default=5)
    ap.add_argument("--think", action="store_true")
    a = ap.parse_args()
    if a.mode == "latency":
        print(json.dumps(latency(a.model, a.tokens, a.num_ctx, a.cpu), indent=2))
    elif a.mode == "tools":
        rows = toolcall_trials(a.model, a.n, a.think, a.cpu)
        empties = sum(1 for r in rows if r["tool_calls"] == 0)
        leaks   = sum(1 for r in rows if r["xml_leak"])
        ok      = sum(1 for r in rows if r["got_city"])
        print(json.dumps({"model": a.model, "n": a.n, "think": a.think,
                          "ok_with_city": ok, "empty_tool_calls": empties,
                          "xml_leak": leaks, "rows": rows}, indent=2))
    else:
        rows = json_thinking_trials(a.model, a.n)
        parsed = sum(1 for r in rows if r["json_parsed"])
        leaks  = sum(1 for r in rows if r["think_leak_in_content"])
        print(json.dumps({"model": a.model, "n": a.n,
                          "json_parsed": parsed, "think_leak_in_content": leaks,
                          "rows": rows}, indent=2))

if __name__ == "__main__":
    main()
PY
echo "saved /tmp/model_dist_probe.py"
```

---

## Step 1 — 35B prefill rate at the Executor budget (Prediction 1)

The decisive measurement. Forces the 35B to CPU (`--cpu` → `num_gpu:0`) and
processes a ~6 000-token prompt — the Executor's real budget.

```bash
# 4B at 6K, GPU-resident — the anchor / hot-path baseline.
python3 /tmp/model_dist_probe.py latency --model qwen3.5:4b --tokens 6000 --num-ctx 8192
#   Expected: prefill_s small (single-digit→~15 s), gen_tok_s ~30-38. wall well under 20 s.

# 35B at 6K, CPU-pinned — Prediction 1.
python3 /tmp/model_dist_probe.py latency --model qwen3.6:35b-a3b --tokens 6000 --num-ctx 8192 --cpu
#   Expected (Prediction 1): prefill_tok_s ≈ 10-15; prefill_s > ~400 s (~7 min) BEFORE generation.
#   This is the number that confirms the Executor cannot live on the 35B.
```

**Record:** `prefill_s`, `prefill_tok_s`, `gen_tok_s` for both. The 35B
`prefill_tok_s` is the rate you'll extrapolate Planner/Evaluator budgets from
in Step 2.

---

## Step 2 — Per-role turn latency on the 35B at real budgets

Planner ≤ 32K and Evaluator ≤ 8K are the budgets (Convention #3). A full 32K
prefill on the CPU-bound 35B is ~30–45 min for a *single* call, so the
efficient path is to **extrapolate** from Step 1's measured `prefill_tok_s`
(prefill is bandwidth-bound and ~linear in token count), then do **one
optional full-budget confirmation** if the session has time.

```bash
# Compute extrapolated per-role turn time from Step 1's 35B prefill_tok_s.
# turn_s ≈ (budget_tokens / prefill_tok_s) + (gen_tokens / gen_tok_s)
PREFILL_TPS=<35B prefill_tok_s from Step 1>
GEN_TPS=<35B gen_tok_s from Step 1>     # ~11 expected
python3 - "$PREFILL_TPS" "$GEN_TPS" <<'PY'
import sys
pf, gen = float(sys.argv[1]), float(sys.argv[2])
for role, budget, out in [("Executor", 6000, 128), ("Evaluator", 8000, 256), ("Planner", 32000, 512)]:
    s = budget/pf + out/gen
    print(f"{role:9} budget={budget:5}  ~{s:7.0f}s  (~{s/60:5.1f} min)  on 35B-CPU")
PY
#   Expected shape: Executor ~7 min (unusable on hot path), Evaluator ~9-11 min
#   (periodic — tolerable?), Planner ~45 min at FULL budget (rare — but note real
#   planner prompts are usually far below 32K).

# OPTIONAL full-budget confirmations (only if time allows — each is long):
python3 /tmp/model_dist_probe.py latency --model qwen3.6:35b-a3b --tokens 8000  --num-ctx 8192  --cpu   # Evaluator, ~10 min
# python3 /tmp/model_dist_probe.py latency --model qwen3.6:35b-a3b --tokens 32000 --num-ctx 32768 --cpu # Planner, ~45 min — skip unless idle
```

**Decision input:** Executor on 35B is settled-unusable. The real question this
answers is whether **Evaluator (periodic) and Planner (rare)** on 35B are
*latency-tolerable* in practice, or whether even those should stay on the 4B /
go to cloud. Record the extrapolated table + any full-budget confirmation.

> Cross-check against `docs/challenges.md:18` — the Evaluator already has a
> 5-min (`DEFAULT_CHAT_TIMEOUT_MS = 300000`) timeout that fires today on the 4B
> at large prompts. If 35B Evaluator turns are ~10 min, **the timeout must be
> raised for any 35B role** or those roles will abort. Flag this in results.

---

## Step 3 — Parser mismatch & tool-call reliability (highest-leverage unknown)

The Gemini research claims Ollama defaults Qwen3.x to a Hermes-style JSON tool
parser, but these models were trained on Qwen3-Coder **XML** tool format — the
mismatch yields **empty `tool_calls` + raw XML leaking into content**, and with
thinking ON, unclosed `<think>` tags **corrupt conversation history**. This
step measures whether that actually manifests on *this* box's Ollama.

### 3a — Tool-call path (Executor channel), both models, default parser

```bash
python3 /tmp/model_dist_probe.py tools --model qwen3.5:4b        --n 10
#   Expected (matches known 4B ~80%): ok_with_city ~8/10, empty_tool_calls low, xml_leak ideally 0.

python3 /tmp/model_dist_probe.py tools --model qwen3.6:35b-a3b   --n 10 --cpu
#   THE NEW DATUM: if empty_tool_calls is high AND xml_leak > 0, the parser
#   mismatch is real on this box → the client-side XML-regex fallback (research
#   §"Empty tool_calls Array") is justified. If tool_calls land cleanly, the
#   mismatch does NOT reproduce on Ollama 0.22.1 — equally important to know.
```

### 3b — JSON + thinking path (Planner/Evaluator channel), 35B

Polaris's Planner/Evaluator use `format:"json"` string mode with **thinking
ON** — not tool calls. This tests the `<think>`-corruption bug on that path.

```bash
python3 /tmp/model_dist_probe.py jsonthink --model qwen3.6:35b-a3b --n 5
#   Expected GOOD: json_parsed 5/5, think_field_len > 0 (reasoning in the
#   dedicated 'thinking' field), think_leak_in_content 0.
#   Expected BAD (bug reproduces): json_parsed < 5 OR think_leak_in_content > 0
#   (<think> tags bleeding into content) → confirms the corruption finding for
#   the 35B reasoning roles; we'd need think=false or the enhanced.jinja fix.
```

### 3c — OPTIONAL: try the `enhanced.jinja` / `qwen3_xml` fix (only if 3a/3b reproduce the bug)

Do **not** attempt this unless 3a/3b show empty `tool_calls`, XML leakage, or
`<think>` corruption. The exact override mechanism on Ollama 0.22.1 is
uncertain; the **measurement above is the deliverable**, the fix is research.

If you do attempt it: capture **full raw response bodies** for the failing
cases first (so the fix can be designed off real data) —

```bash
# Capture one raw failing response verbatim for the record.
curl -s http://localhost:11434/api/chat -d '{
  "model":"qwen3.6:35b-a3b","stream":false,
  "messages":[{"role":"user","content":"What is the weather in Paris? Use get_current_weather."}],
  "tools":[{"type":"function","function":{"name":"get_current_weather","parameters":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}}}],
  "options":{"num_gpu":0}
}' | tee /tmp/raw_35b_toolcall.json | python3 -m json.tool
```

Then a custom Modelfile with a `TEMPLATE`/parser override is the next move —
**but record it as a follow-up for the Mac session to design**, not something to
hand-tune here. Note exactly what you tried + the outcome in results.

---

## Step 4 — Model-swap cost: `MAX_LOADED_MODELS=1` vs pinned `=2` (Predictions 2 & 3)

The open risk in spec §10: thrashing when a task alternates a GPU 4B (Executor)
and a CPU 35B (Planner/Evaluator). `load_duration` is nonzero only when Ollama
had to (re)load the model — that's the swap cost.

### 4a — Baseline (current config, likely `MAX_LOADED_MODELS=1`) — Prediction 2

```bash
# Alternate models; watch load_s. With only 1 slot, each switch reloads.
for i in 1 2 3; do
  echo "--- 4B turn $i ---"
  python3 /tmp/model_dist_probe.py latency --model qwen3.5:4b      --tokens 1000 --num-ctx 8192
  echo "--- 35B turn $i ---"
  python3 /tmp/model_dist_probe.py latency --model qwen3.6:35b-a3b --tokens 1000 --num-ctx 8192 --cpu
done
#   Expected (Prediction 2): load_s ≈ 15-30 s on each switch (every call reloads).
```

### 4b — Pinned config (`=2` + custom Modelfiles) — Prediction 3

```bash
# Throwaway model tags that bake in the pinning (base tags untouched).
cat > /tmp/Modelfile.exec <<'MF'
FROM qwen3.5:4b
PARAMETER num_ctx 8192
PARAMETER num_predict 256
MF
cat > /tmp/Modelfile.plan <<'MF'
FROM qwen3.6:35b-a3b
PARAMETER num_gpu 0
PARAMETER num_ctx 32768
MF
ollama create polaris-exec -f /tmp/Modelfile.exec
ollama create polaris-plan -f /tmp/Modelfile.plan

# Add the concurrency drop-in (reversible — removed in Step 5).
sudo systemctl edit ollama.service
#   In the editor add EXACTLY:
#   [Service]
#   Environment="OLLAMA_MAX_LOADED_MODELS=2"
#   Environment="OLLAMA_NUM_PARALLEL=1"
#   Environment="OLLAMA_KEEP_ALIVE=-1"
#   Environment="OLLAMA_KV_CACHE_TYPE=q8_0"
sudo systemctl daemon-reload && sudo systemctl restart ollama
systemctl show ollama --property=Environment   # confirm the 4 vars are set

# Warm both, then alternate. With 2 slots + distinct hardware, no eviction.
python3 /tmp/model_dist_probe.py latency --model polaris-exec --tokens 1000 --num-ctx 8192
python3 /tmp/model_dist_probe.py latency --model polaris-plan --tokens 1000 --num-ctx 32768
ollama ps    # Expected: BOTH models resident simultaneously
for i in 1 2 3; do
  python3 /tmp/model_dist_probe.py latency --model polaris-exec --tokens 1000 --num-ctx 8192
  python3 /tmp/model_dist_probe.py latency --model polaris-plan --tokens 1000 --num-ctx 32768
done
#   Expected (Prediction 3): load_s ≈ 0 on every call after warm-up (no reload).
```

**Record:** `load_s` per switch under 4a vs 4b. This settles the thrashing risk
— if 4b shows ~0 reload, per-role local routing is viable; if even pinned it
thrashes (e.g. VRAM eviction), that's a blocker the spec must address.

---

## Step 5 — Concurrent memory footprint (Prediction 4) + teardown

### 5a — Footprint with both models pinned + resident

```bash
ollama ps                                                        # both loaded?
nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader   # VRAM
free -h                                                          # total RAM
ps -o rss= -C ollama | awk '{s+=$1} END {print s/1024/1024 " GB RSS (ollama procs)"}'
#   Expected (Prediction 4): total RAM 22-25 GB used, VRAM < ~3.5 GB, NO OOM / no dmesg OOM-killer.
dmesg --level=err,warn | tail -20    # sanity: no oom-killer / CUDA OOM lines
```

### 5b — Teardown (RESTORE the box)

```bash
# Remove throwaway tags (base tags were never touched).
ollama rm polaris-exec polaris-plan

# Revert the service to its pre-run state (deletes the drop-in entirely).
sudo systemctl revert ollama.service
sudo systemctl daemon-reload && sudo systemctl restart ollama

# Verify we're back to the snapshot.
systemctl show ollama --property=Environment
diff <(systemctl show ollama --property=Environment) /tmp/ollama_env_before.txt && echo "ENV RESTORED OK"
ollama ps
```

---

## Step 6 — (Optional) loop-termination sanity (Prediction 5)

Prediction 5 (empty tool result → infinite loop without dedup; SHA-256 hashing
+ error injection breaks it < 3 turns) is **already covered by the mock test
suite** (the distinct-action / action-repeat / unknown-tool breakers, 231+
tests). No real-Ollama run is needed to confirm the *mechanism*. Skip unless you
specifically want an end-to-end confirmation on real qwen3.5:4b, in which case
run the existing slow tier and read the breaker events:

```bash
cd extension
POLARIS_REAL_OLLAMA=1 OLLAMA_MODEL=qwen3.5:4b npx vitest run tests/integration.test.ts
#   (This re-runs the settled M3.5 E2E — only do it if you want fresh breaker traces.)
```

---

## What to do if X fails

- **`qwen3.6:35b-a3b` not in `ollama list`** → `ollama pull qwen3.6:35b-a3b`
  (23 GB). If disk is tight, this is the one heavy prerequisite.
- **A 35B call times out** → the harness sets `timeout=3000` s (50 min). If
  even that trips on the 32K Planner case, that itself is the finding: record
  "32K on 35B exceeds 50 min" and rely on the Step 2 extrapolation.
- **`num_gpu:0` in options seems ignored (35B still uses GPU)** → use the
  `polaris-plan` Modelfile (`PARAMETER num_gpu 0`) instead for the CPU-pinned
  runs; note that options-level `num_gpu` didn't take.
- **`systemctl edit` opens an unfamiliar editor** → it's the drop-in for
  `override.conf`; add only the `[Service]` + `Environment=` lines, save, exit.
  `sudo systemctl revert ollama.service` always undoes it.
- **OOM / CUDA out-of-memory in Step 4b/5** → that *is* a result (Prediction 4
  refuted). Capture `dmesg` + `nvidia-smi`, then run teardown (5b) immediately.
- **Anything leaves the box dirty** → `sudo systemctl revert ollama.service`,
  restart, `ollama rm polaris-exec polaris-plan`, confirm `ollama list` shows
  only the original tags.

---

## Hard rules for this session

- Do **not** modify extension source. This run is direct-to-Ollama by design.
- Do **not** modify the base `qwen3.5:4b` / `qwen3.6:35b-a3b` tags.
- Snapshot before Step 4; **run teardown (5b) before signing off** and confirm
  `ENV RESTORED OK`.
- Fill `## Session results` with concrete numbers (keep raw ns where useful,
  like `m3.5-linux.md` does), then **commit + push** this file on
  `feat/hybrid-delta-wiring` as `garikipatisai@gmail.com`.
- Be honest in the verdict: if a prediction is refuted, say so plainly with the
  data — that's more valuable than confirming the hypothesis.

---

## Session results — 2026-05-31 (Linux, P2200)

**Hardware:** Quadro P2200 / Ollama 0.22.1 / Node v20.20.1

### Step 1 — 35B prefill at 6K (Prediction 1)
| Model | prefill_s | prefill_tok_s | gen_tok_s | wall_s | verdict |
|---|---|---|---|---|---|
| qwen3.5:4b (GPU) | 15.8 | 339.3 | 31.5 | 21.0 (incl 5s first-load) | — baseline |
| qwen3.6:35b-a3b (CPU) | 205.2 | 26.1 | 7.5 | 233.8 (incl 27s first-load) | **P1 confirmed** — 3.9 min wall for one 6K turn |

Prediction: ~7 min; actual: ~3.9 min. Faster than predicted but still categorically unusable on the Executor hot path (<20 s/turn).

### Step 2 — per-role turn latency on 35B (extrapolated from Step 1 rates)
| Role | budget | extrapolated turn_s | measured turn_s | latency-tolerable? |
|---|---|---|---|---|
| Executor | 6K | ~247s (~4.1 min) | — | **no** (hot path) |
| Evaluator | 8K | ~341s (~5.7 min) | — (optional, not run) | borderline — periodic (~every 10 turns) |
| Planner | 32K | ~1294s (~21.6 min) | — (optional, not run) | very slow but rare (~on replan only) |

- **Evaluator-timeout implication:** MUST raise `DEFAULT_CHAT_TIMEOUT_MS` (currently 300000 = 5 min) to ≥ 600000 if Evaluator uses 35B. A 5.7 min turn will abort under the current timeout.
- Planner/Evaluator extrapolations assume linear prefill scaling (prefill is bandwidth-bound, documented linear). Full-budget confirmation skipped because the extrapolated numbers are already decisive for the decision.

### Step 3 — parser mismatch / tool-call reliability
| Test | model | result | mismatch reproduces? |
|---|---|---|---|
| 3a tools | qwen3.5:4b | ok **10/10**, empty **0**, xml_leak **0** | **NO** — perfect 10/10 |
| 3a tools | qwen3.6:35b-a3b | ok **10/10**, empty **0**, xml_leak **0** | **NO** — perfect 10/10 |
| 3b jsonthink | qwen3.6:35b-a3b | parsed **0/5**, think_leak **0** | **NO (different root cause)** — the "failure" is a token-budget artifact: with `think=true` + `num_predict=512`, the verbose thinking field consumes ALL generation tokens, leaving `content` empty. With `think=false`, `format:"json"` produces clean, parseable JSON. No `<think>` tag leakage into content was observed. |
- 3c fix attempted? **No** — the Jasper-Hermes/XML parser mismatch does NOT reproduce on this Ollama 0.22.1. Neither model shows empty `tool_calls` or XML leakage. The "thinking corruption" is actually a `num_predict` budget issue: the thinking field at default verbosity fills the entire generation window before any content is emitted. The fix is not a parser override but ensuring `num_predict` is large enough (≥ 2048) when `think=true` with the 35B, or using `think=false` for the JSON path.

**Key finding for Mac session:** the structured-output path (`format:"json"`) works cleanly with `think=false` on the 35B. With `think=true`, increase `num_predict` or set a shorter thinking prompt. No Hermes-JSON default-parser bug is active on this server version.

### Step 4 — swap cost (Predictions 2 & 3)
| Config | mean load_s/switch | verdict |
|---|---|---|
| 4a `MAX_LOADED_MODELS` baseline (=1, default) | ~0.18 s (warm) / 6.5-16.5 s (first cold load) | **P2 refuted** — no thrashing occurs even at default. 4B (GPU) and 35B (CPU) use different hardware; Ollama loads both simultaneously. |
| 4b pinned `=2` + Modelfiles | ~0.21 s | **P3 confirmed** — ~0 load_s after warmup, both resident "Forever" with `KEEP_ALIVE=-1`. |
- **Surprise:** The swap-cost concern was unnecessary for this hardware pair. The 4B on VRAM and 35B on RAM don't compete for the same slot. Setting `MAX_LOADED_MODELS=2` adds marginal safety but isn't required for correctness.

### Step 5 — concurrent footprint (Prediction 4)
- RAM used: **29 GiB** · VRAM used: **4449 MiB** (87%) · OOM: **no** → P4 **confirmed with caveats**: RAM higher than predicted (29 vs 22-25 GB) but within 31 GB total. VRAM higher than predicted (4.4 vs <3.5 GB) but within 5 GB. Swap used: 2.7/8.0 GiB. No OOM-killer activity observed. The system is tight but stable with both models resident.
- **Teardown:** `ENV RESTORED OK` ? **No** — 1 env-var difference: `OLLAMA_ORIGINS=chrome-extension://*` was present in the pre-run snapshot but got removed by `systemctl revert ollama.service` (was set via a prior override that the revert cleaned up). Tags `polaris-exec`/`polaris-plan` removed. Base tags untouched. User should re-add OLLAMA_ORIGINS if browser-extension CORS is needed.

### Overall verdict on the role→model table
- **Planner** → `qwen3.6:35b-a3b` — 21 min per full-budget turn is painful but acceptable for rare replan events. Or keep on 4B/cloud for responsiveness.
- **Executor** → `qwen3.5:4b` — **definitively confirmed**. Only the GPU-resident 4B meets the <20 s/turn requirement for the hot path.
- **Evaluator** → `qwen3.6:35b-a3b` — borderline at ~5.7 min per turn. Periodic (every ~10 Executor loops) amortizes it, but `DEFAULT_CHAT_TIMEOUT_MS` must be raised. An alternative is 4B/cloud for faster evaluations at the cost of evaluation quality.
- **Compactor** → `qwen3.5:4b` — no latency pressure, throughput-focused, 4B is the right fit.

**Surprises / refutations / recommendations for the Mac session:**
1. **35B prefill faster than predicted:** 26 tok/s vs predicted 10-15. The ~4 min wall at 6K is still disqualifying for Executor but more viable for periodic Evaluator than anticipated.
2. **Tool-call reliability is excellent:** 10/10 on BOTH models. The Gemini research's Hermes-JSON/XML parser mismatch does NOT reproduce on Ollama 0.22.1. The earlier ~80% 4B rate was either variance or a different server version.
3. **Swap cost is a non-issue:** The GPU 4B and CPU 35B coexist without explicit pinning because they use different hardware. `MAX_LOADED_MODELS=2` is optional. The spec's thrashing concern was overblown for this hardware pair.
4. **JSON+thinking "corruption" is a num_predict bug:** Not a parser issue. With `think=true`, the 35B's verbose reasoning fills small generation budgets entirely. Fix: ensure adequate `num_predict` for thinking roles.
5. **Memory is tight but stable:** 29/31 GB RAM + 4449/5120 MiB VRAM. Both models fit, but there's no headroom for a third model or large KV-cache growth on the Planner 32K context.
