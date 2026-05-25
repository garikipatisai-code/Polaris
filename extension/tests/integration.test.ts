// Real-Ollama integration tests. These hit a live Ollama server and exercise
// the agent against actual `qwen3.5:4b` (or whatever OLLAMA_MODEL is set to)
// rather than a scripted fake. They prove the contracts that mock tests can't:
//   • the model produces JSON that matches our Zod schemas under the real prompts
//   • Ollama's tool_calls field round-trips correctly through OllamaClient
//   • the Evaluator's free-text reason / verdict shape is parseable
//   • goal text survives the entire real-model pipeline byte-equal
//
// Two tiers:
//   • Fast smoke (always runs if Ollama reachable): one Planner round-trip,
//     validates schema. ~30 s on Mac CPU, <5 s on a GPU box.
//   • Full end-to-end (opt-in via POLARIS_REAL_OLLAMA=1): the three multi-turn
//     scenarios. SLOW — each turn is 1–3 min on Mac CPU, 5–15 s on the Linux
//     P2200. Designed to run on the box that hosts Ollama, not on a sandboxed
//     dev machine. Skipped by default to keep `npm test` fast.
//
// Behavior:
//   • If Ollama is not reachable at OLLAMA_URL, every test is skipped.
//   • If POLARIS_REAL_OLLAMA is unset, only the fast smoke runs.
//   • Each test resets storage so runs are independent.
//   • Tests are tagged with realistic timeouts (5–10 min on slow hardware).
//
// Run only the fast smoke: npx vitest run tests/integration.test.ts
// Run the slow suite:      POLARIS_REAL_OLLAMA=1 npx vitest run tests/integration.test.ts
// Override URL:            OLLAMA_URL=http://192.168.1.50:11434 npm test
// Override model:          OLLAMA_MODEL=qwen3.5:4b npm test

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Orchestrator } from '../src/agent/orchestrator';
import { OllamaClient } from '../src/background/ollama';
import { runExecutor } from '../src/agent/roles/executor';
import { createDefaultRegistry } from '../src/agent/tools';
import * as store from '../src/agent/state_store';
import { resetMockedStorage } from './setup';

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const REAL_MODEL = process.env.OLLAMA_MODEL || 'qwen3.5:4b';
const RUN_SLOW = process.env.POLARIS_REAL_OLLAMA === '1';

// Probe the server once before declaring the suite. If unreachable, all
// tests below get `.skipIf(true)` — they show as skipped rather than failed,
// which is the right behavior in dev environments without Ollama.
let reachable = false;
let availableModels: string[] = [];
try {
  const probe = new OllamaClient(OLLAMA_URL);
  const r = await probe.ping();
  reachable = r.ok;
  availableModels = r.models ?? [];
} catch {
  reachable = false;
}
const modelPresent = availableModels.includes(REAL_MODEL);
const skipReason = !reachable
  ? `Ollama not reachable at ${OLLAMA_URL}`
  : !modelPresent
    ? `model "${REAL_MODEL}" not in ${OLLAMA_URL} (${availableModels.length} models available)`
    : '';

beforeAll(() => {
  if (skipReason) {
    console.log(`[integration] SKIPPED: ${skipReason}`);
  } else {
    console.log(
      `[integration] running against ${OLLAMA_URL} model=${REAL_MODEL} ` +
        `slow=${RUN_SLOW ? 'on' : 'off (set POLARIS_REAL_OLLAMA=1)'}`,
    );
  }
});

beforeEach(async () => await resetMockedStorage());
afterEach(async () => await resetMockedStorage());
afterAll(async () => await resetMockedStorage());

// ---------------------------------------------------------------------------
// Tier 1: fast smoke — runs whenever Ollama is reachable.
// One round-trip; validates the model produces JSON we can parse + Zod-validate.
// ---------------------------------------------------------------------------

const PlannerResponseSchema = z.object({
  successCriteria: z.array(z.string().max(300)).max(20).optional(),
  rootSteps: z
    .array(
      z.object({
        id: z.string().min(1).max(20),
        title: z.string().min(1).max(200),
        rationale: z.string().max(300).optional(),
        children: z
          .array(
            z.object({
              id: z.string().min(1).max(20),
              title: z.string().min(1).max(200),
              rationale: z.string().max(300).optional(),
            }),
          )
          .max(20)
          .optional(),
      }),
    )
    .min(1)
    .max(20),
  notes: z.string().max(500).optional(),
});

describe.skipIf(!reachable || !modelPresent)('real Ollama: fast smoke', () => {
  it('Planner produces JSON that matches PlannerResponseSchema', async () => {
    // Single chat call against real Ollama with format: "json" string mode.
    // Prompt is a stripped-down planner-style prompt — enough to exercise the
    // contract without dragging in the full state machine.
    const client = new OllamaClient(OLLAMA_URL);
    const sys =
      'You are the PLANNER. Given a user GOAL, output JSON with this shape: ' +
      '{"successCriteria": [string], "rootSteps": [{"id": string, "title": string}], "notes": string}. ' +
      'rootSteps must have at least 1 entry. Output JSON only — no markdown fences, no prose.';
    const user =
      'GOAL: Use the add tool to compute 2 + 3, then call finish with the result.';

    const r = await client.chatOnce({
      model: REAL_MODEL,
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: user },
      ],
      format: 'json',
      think: false,
    });

    const content = r.message?.content ?? '';
    expect(content.length).toBeGreaterThan(0);

    // Permissive parse — strip any leading/trailing junk before JSON.parse.
    const firstBrace = content.indexOf('{');
    const lastBrace = content.lastIndexOf('}');
    expect(firstBrace).toBeGreaterThanOrEqual(0);
    expect(lastBrace).toBeGreaterThan(firstBrace);
    const json = JSON.parse(content.slice(firstBrace, lastBrace + 1));

    // Zod schema is the same one runPlanner enforces.
    const validated = PlannerResponseSchema.parse(json);
    expect(validated.rootSteps.length).toBeGreaterThanOrEqual(1);
    expect(validated.rootSteps[0]!.id).toBeTruthy();
    expect(validated.rootSteps[0]!.title).toBeTruthy();
  }, 180_000); // 3 min — covers slow Mac CPU first call

  it('Executor produces a real tool_call with the new system+user-anchor prompt shape', async () => {
    // The contract under test is the M2.7.2 fix: a [system, user-anchor]
    // message shape forces Qwen3 into tool-calling mode reliably. Test 3 in
    // the slow tier observed the OLD shape repeatedly returning 0 tool_calls
    // with unicode goals; this fast smoke verifies the new shape works for
    // the simpler ASCII case (the unicode case is in the slow tier).
    // beforeEach already calls resetMockedStorage — no manual reset here.
    const client = new OllamaClient(OLLAMA_URL);
    const state = await store.startTask(
      'Use the echo tool with text "hello", then finish.',
    );
    // Give the Executor a non-empty plan so its prompt renders fully.
    await store.patchHot({
      plan: {
        rootSteps: [{ id: 's1', title: 'echo hello then finish', status: 'active' }],
        revision: 1,
        generatedAt: Date.now(),
      },
      currentStepId: 's1',
    });

    const r = await runExecutor({
      state: (await store.loadHot())!,
      registry: createDefaultRegistry(),
      client,
      model: REAL_MODEL,
    });

    // The tool call must have happened. Either echo or finish is acceptable —
    // the only failure we're trying to catch is "0 tool_calls".
    expect(r.ok).toBe(true);
    expect(r.toolCall).toBeTruthy();
    expect(['echo', 'finish']).toContain(r.toolCall?.function.name);
  }, 180_000);
});

// ---------------------------------------------------------------------------
// Tier 2: full end-to-end agent runs — opt-in via POLARIS_REAL_OLLAMA=1.
// On Mac CPU each test runs 10–25 min; on the Linux P2200 each runs 1–3 min.
// ---------------------------------------------------------------------------

describe.skipIf(!reachable || !modelPresent || !RUN_SLOW)(
  'real Ollama: full agent loop (slow, opt-in)',
  () => {
    it('end-to-end: trivial single-tool task completes with correct answer', async () => {
      const events: { type: string; data?: unknown }[] = [];
      const orch = new Orchestrator({
        client: new OllamaClient(OLLAMA_URL),
        model: REAL_MODEL,
        plannerThinking: false,
        evaluatorThinking: false,
        maxSteps: 12,
        onEvent: (e) => events.push(e),
      });

      const goal = 'Use the add tool to compute 2 + 3, then call finish with the result.';
      await orch.start(goal);
      const final = await orch.runUntilTerminal();

      expect(final.phase).toBe('DONE');
      expect(final.goal.text).toBe(goal);
      expect(final.finalAnswer).toBeTruthy();
      expect(String(final.finalAnswer)).toMatch(/\b5\b|five/i);

      const roleEnds = events.filter((e) => e.type === 'role_end');
      const planners = roleEnds.filter((e) => (e.data as { role?: string })?.role === 'planner');
      const executors = roleEnds.filter((e) => (e.data as { role?: string })?.role === 'executor');
      const evaluators = roleEnds.filter(
        (e) => (e.data as { role?: string })?.role === 'evaluator',
      );
      expect(planners.length).toBeGreaterThanOrEqual(1);
      expect(executors.length).toBeGreaterThanOrEqual(1);
      expect(evaluators.length).toBeGreaterThanOrEqual(1);
    }, 300_000);

    it('end-to-end: multi-tool task with memory + goal byte-survival', async () => {
      const goal =
        "Use memory.write to store 17 under key 'a' in namespace 'nums', " +
        "25 under key 'b', and 8 under key 'c'. Then use memory.read to verify each. " +
        'Use the sum tool to add 17, 25, 8, and finish with the total.';
      const orch = new Orchestrator({
        client: new OllamaClient(OLLAMA_URL),
        model: REAL_MODEL,
        plannerThinking: false,
        evaluatorThinking: false,
        maxSteps: 25,
      });

      await orch.start(goal);
      const final = await orch.runUntilTerminal();

      expect(final.phase).toBe('DONE');
      expect(final.goal.text).toBe(goal);
      expect(final.finalAnswer).toBeTruthy();
      expect(String(final.finalAnswer)).toMatch(/\b50\b|fifty/i);
      expect(final.budgets.executor.used).toBeGreaterThan(0);

      const a = await store.memoryRead(final.taskId, 'nums', 'a');
      const b = await store.memoryRead(final.taskId, 'nums', 'b');
      const c = await store.memoryRead(final.taskId, 'nums', 'c');
      expect(a?.value).toBe('17');
      expect(b?.value).toBe('25');
      expect(c?.value).toBe('8');
    }, 600_000);

    it('end-to-end: non-ASCII goal text survives the entire pipeline byte-equal', async () => {
      // Pathological goal text: em-dash, euro sign, ümlaut, Chinese, emoji.
      // Anything that would break naive string handling at any layer.
      const goal = "Use the echo tool with the text '★ — €299 — ümlaut — 你好' then finish.";
      const orch = new Orchestrator({
        client: new OllamaClient(OLLAMA_URL),
        model: REAL_MODEL,
        plannerThinking: false,
        evaluatorThinking: false,
        maxSteps: 8,
      });

      await orch.start(goal);
      const final = await orch.runUntilTerminal();

      expect(final.phase).toMatch(/DONE|ABORTED/);
      // The byte-survival contract: goal text is unchanged regardless of outcome.
      expect(final.goal.text).toBe(goal);
      // Char-by-char check (catches encoding regressions even if .toBe gets weird).
      for (let i = 0; i < goal.length; i++) {
        expect(final.goal.text.charCodeAt(i)).toBe(goal.charCodeAt(i));
      }
    }, 300_000);

    it('end-to-end: compaction fires when scratchpad fills, archives findings, deletes scratch', async () => {
      // Drive the agent through enough memory.write calls to cross
      // COMPACT_ENTRY_COUNT (10). Asserts the contract that distinguishes
      // "compactor ran" from "compactor actually did its job":
      //   • a 'compaction' event was emitted with discarded > 0
      //   • findings were actually persisted in IDB (compactor produced output)
      //   • scratchpad ref count went DOWN as a result (entries removed)
      //   • compactor's own tokens rolled into budgets.totalTokens (Phase 4)
      const events: { type: string; data?: unknown }[] = [];
      const goal =
        'Write the strings "alpha", "beta", "gamma", "delta", "epsilon", "zeta" to memory ' +
        'namespace "letters" using keys k1..k6 in order. Then read each back. ' +
        'Then finish with a summary listing all six values.';
      const orch = new Orchestrator({
        client: new OllamaClient(OLLAMA_URL),
        model: REAL_MODEL,
        plannerThinking: false,
        evaluatorThinking: false,
        maxSteps: 30,
        onEvent: (e) => events.push(e),
      });

      await orch.start(goal);
      const final = await orch.runUntilTerminal();

      // Compaction must have fired at least once mid-run.
      const compactions = events.filter((e) => e.type === 'compaction');
      expect(compactions.length).toBeGreaterThanOrEqual(1);

      // The event payload must show actual work was done — not just that
      // the compactor was invoked but produced an empty findings list and
      // discarded zero entries (which is the failure mode #12 calls out).
      const totalDiscarded = compactions.reduce((acc, e) => {
        const d = e.data as { discarded?: number } | undefined;
        return acc + (d?.discarded ?? 0);
      }, 0);
      expect(totalDiscarded).toBeGreaterThan(0);

      // Findings actually persisted to IDB.
      const findingsCount = await store.countFindings(final.taskId);
      expect(findingsCount).toBeGreaterThanOrEqual(1);

      // Goal byte-survival under a real multi-turn run.
      expect(final.goal.text).toBe(goal);

      // Compactor's totalTokens contribution rolled into the running total
      // (Phase 4 tracking fix). totalTokens is monotonically increasing,
      // so this only confirms it was non-zero — but a healthy compaction
      // run produces 60+ prompt tokens minimum.
      expect(final.budgets.totalTokens).toBeGreaterThan(0);
    }, 900_000); // 15 min — compaction-driven runs are the longest
  },
);

// ---------------------------------------------------------------------------
// Executor reliability stats (arch-nemesis #11): n=1 isn't proof. This test
// runs the Executor smoke 5 times consecutively against real Ollama and
// reports the first-try-success rate (tool_call returned on the first call,
// no retry needed). Per probe data the documented rate is ~80% on Linux —
// we assert ≥3/5 to flag a regression without being flaky on the 80% mark.
// Opt-in via POLARIS_REAL_OLLAMA_FLAKE_RUNS=1 because 5× ~70s = ~6 min on
// Mac (negligible on Linux).
// ---------------------------------------------------------------------------

const RUN_FLAKE = process.env.POLARIS_REAL_OLLAMA_FLAKE_RUNS === '1';

describe.skipIf(!reachable || !modelPresent || !RUN_FLAKE)(
  'real Ollama: Executor tool-call reliability stats (opt-in)',
  () => {
    it('Executor produces a tool_call on first try ≥3/5 times (regression guard)', async () => {
      const N = 5;
      let firstTryHits = 0;
      let totalSuccess = 0;
      const wallTimes: number[] = [];

      for (let i = 0; i < N; i++) {
        await resetMockedStorage();
        const client = new OllamaClient(OLLAMA_URL);
        const state = await store.startTask(
          `Use the echo tool with text "hello run ${i}", then finish.`,
        );
        await store.patchHot({
          plan: {
            rootSteps: [{ id: 's1', title: 'echo then finish', status: 'active' }],
            revision: 1,
            generatedAt: Date.now(),
          },
          currentStepId: 's1',
        });
        const t = performance.now();
        const r = await runExecutor({
          state: (await store.loadHot())!,
          registry: createDefaultRegistry(),
          client,
          model: REAL_MODEL,
        });
        wallTimes.push(performance.now() - t);
        if (r.ok) totalSuccess++;
        if (r.ok && !r.retried) firstTryHits++;
      }

      const meanMs = wallTimes.reduce((a, b) => a + b, 0) / wallTimes.length;
      console.log(
        `[reliability] firstTry=${firstTryHits}/${N}  succeeded=${totalSuccess}/${N}  meanMs=${Math.round(meanMs)}`,
      );

      // Total success rate should be 5/5 — the role's own retry covers the
      // 20% empty-tool-call rate per probe data.
      expect(totalSuccess).toBe(N);
      // First-try rate should be ≥3/5 (60%). Probe baseline is 80% on
      // Linux; threshold of 60% catches a real regression without flaking
      // on the natural variance.
      expect(firstTryHits).toBeGreaterThanOrEqual(3);
    }, 1_800_000); // 30 min — 5× worst-case Mac wall time
  },
);
