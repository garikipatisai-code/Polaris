// Synthetic stress test for the goal-survival contract.
//
// Polaris's central architectural claim is "the agent stays locked on the
// user's original goal even when its working context fills up". For five
// milestones this was a marketing assertion. This module is the test that
// turns it into a measurable property.
//
// Run from the SW DevTools console:
//
//   await polaris.stressTest()
//
// The harness:
//   1. Wipes any existing state.
//   2. Pre-populates memory.* with answer-bearing data + ~8 KB of distractor
//      text (forcing the scratchpad past compaction threshold).
//   3. Starts an agent task whose only solvable path is to read the data
//      from memory (which compaction will have moved out of scratchpad and
//      into the findings store).
//   4. Polls until terminal phase.
//   5. Asserts:
//        a. final phase === 'DONE'
//        b. goal.text byte-equal to the original goal string
//        c. finalAnswer contains "50" (or whatever the expected value is)
//        d. at least one compaction event fired
//        e. budgets.executor.used > 0 (the loop actually ran)

import * as store from './state_store';
import { Orchestrator } from './orchestrator';
import { OllamaClient } from '../background/ollama';
import type { AgentStateHot } from '../shared/agent_types';
import { log, getLogs } from './log';

interface StressResult {
  passed: boolean;
  failures: string[];
  observations: Record<string, unknown>;
}

const STRESS_GOAL =
  "From memory namespace 'stress', read the values stored under keys " +
  "n1, n2, n3, n4, n5 (each is a number). Sum all five and finish with " +
  'the total as your final answer.';

// Five values whose sum is intentionally non-trivial to spot-check.
const STRESS_VALUES = { n1: 13, n2: 27, n3: 8, n4: 91, n5: 41 } as const;
const EXPECTED_SUM = Object.values(STRESS_VALUES).reduce((a, b) => a + b, 0); // 180

const DISTRACTOR_LINE =
  'Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor ' +
  'incididunt ut labore et dolore magna aliqua. ';

export interface StressOptions {
  ollamaBaseUrl?: string;
  model?: string;
  /** Roughly how many tokens of distractor scratchpad to inject before the run. */
  injectTokens?: number;
  /** Hard cap on poll duration. */
  maxDurationMs?: number;
}

export async function stressTest(opts: StressOptions = {}): Promise<StressResult> {
  const baseUrl = opts.ollamaBaseUrl ?? 'http://localhost:11434';
  const model = opts.model ?? 'qwen3.5:4b';
  const injectTokens = opts.injectTokens ?? 8000;
  const maxDurationMs = opts.maxDurationMs ?? 15 * 60 * 1000; // 15 min

  log('info', 'agent', 'stress test starting', { baseUrl, model, injectTokens });
  const failures: string[] = [];
  const observations: Record<string, unknown> = {};

  // 1. Clean slate.
  const existing = await store.loadHot();
  if (existing) await store.resetTask(existing.taskId);
  await store.clearHot();

  // 2. Start the task so we have a taskId for memory writes.
  const client = new OllamaClient(baseUrl);
  const initial = await store.startTask(STRESS_GOAL);
  const taskId = initial.taskId;
  log('info', 'agent', 'stress: task started', { taskId, goal: STRESS_GOAL });

  // 3. Pre-populate memory cells the agent must read to solve the goal.
  for (const [k, v] of Object.entries(STRESS_VALUES)) {
    await store.memoryWrite(taskId, 'stress', k, String(v));
  }

  // 4. Inject distractor scratchpad. Each entry is a synthetic role_msg
  // containing repeating filler. We do this BEFORE the orchestrator starts
  // so its very first Executor turn sees a heavy scratchpad → compaction
  // fires immediately on the pre-flight check.
  const tokensPerEntry = Math.ceil(DISTRACTOR_LINE.length / 4);
  const targetEntries = Math.max(15, Math.ceil(injectTokens / tokensPerEntry));
  for (let i = 0; i < targetEntries; i++) {
    await store.appendScratch(taskId, 'role_msg', {
      role: 'system',
      content: DISTRACTOR_LINE.repeat(2 + (i % 3)),
    });
  }
  observations.injectedEntries = targetEntries;
  log('info', 'agent', 'stress: distractor injected', {
    targetEntries,
    approxTokens: targetEntries * tokensPerEntry,
  });

  // 5. Wipe hot state so startTask can be re-called by the orchestrator on
  //    its proper initialization. We *keep* the IDB contents (memory cells
  //    and scratchpad we just injected). Clean approach: skip the wipe and
  //    let the orchestrator resume against the pre-existing task.
  const orchestrator = new Orchestrator({
    client,
    model,
    plannerThinking: false, // for speed during the stress test
    evaluatorThinking: true,
    onEvent: (e) => log('debug', 'agent', `stress event: ${e.type}`, e.data),
  });

  // Run from the existing initial state via resume() rather than start() —
  // start() would overwrite the hot state we just initialised.
  // Bump phase from PLANNING to ensure resume() picks up correctly.
  // (startTask already set phase to PLANNING.)
  const startTime = Date.now();
  const finalPromise = (async () => {
    await orchestrator.resume();
    return orchestrator.runUntilTerminal();
  })();

  // Poll for terminal with a hard deadline.
  let final: AgentStateHot;
  try {
    final = await Promise.race([
      finalPromise,
      new Promise<AgentStateHot>((_, reject) =>
        setTimeout(() => reject(new Error('stress test timeout')), maxDurationMs),
      ),
    ]);
  } catch (e) {
    failures.push(`run did not terminate: ${(e as Error).message}`);
    final = (await store.loadHot()) as AgentStateHot;
  }

  observations.durationMs = Date.now() - startTime;
  observations.finalPhase = final?.phase;
  observations.finalAnswer = final?.finalAnswer;
  observations.planRevision = final?.plan.revision;
  observations.executorTokensUsed = final?.budgets.executor.used;
  observations.totalTokens = final?.budgets.totalTokens;
  observations.totalReplans = final?.breaker.totalReplans;

  // 6. Assert.
  if (!final) {
    failures.push('no final state retrievable from store');
  } else {
    if (final.phase !== 'DONE') {
      failures.push(`final phase is ${final.phase}, expected DONE`);
    }
    if (final.goal.text !== STRESS_GOAL) {
      failures.push(
        `goal.text mutated! expected "${STRESS_GOAL.slice(0, 40)}…", got "${final.goal.text.slice(0, 40)}…"`,
      );
    }
    const answerStr = String(final.finalAnswer ?? '');
    if (!answerStr.includes(String(EXPECTED_SUM))) {
      failures.push(
        `finalAnswer missing expected sum ${EXPECTED_SUM}: "${answerStr.slice(0, 200)}"`,
      );
    }
    if ((final.budgets.executor.used ?? 0) === 0) {
      failures.push('executor budget unused — loop never actually ran');
    }
    // At least one compaction event in the audit log.
    const events = await store.eventsSince(final.taskId, 0);
    const compactions = events.filter((e) => e.type === 'compaction').length;
    observations.compactionEvents = compactions;
    if (compactions === 0) {
      failures.push(
        `compactor never fired — the architecture's external-memory premise didn't activate`,
      );
    }
  }

  const result: StressResult = {
    passed: failures.length === 0,
    failures,
    observations,
  };
  log(result.passed ? 'info' : 'error', 'agent', `stress test ${result.passed ? 'PASSED' : 'FAILED'}`, result);

  // Final summary in console for easy reading.
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  Polaris stress test: ${result.passed ? '✅ PASSED' : '❌ FAILED'}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.table(result.observations);
  if (failures.length > 0) {
    console.log('Failures:');
    for (const f of failures) console.log('  ✗', f);
  }
  console.log(`\nFor details: polaris.dumpLogs() | polaris.logs({since: Date.now()-${result.observations.durationMs}})`);
  return result;
}

/** Convenience: wipe state without running the test. */
export async function stressReset(): Promise<void> {
  const existing = await store.loadHot();
  if (existing) await store.resetTask(existing.taskId);
  await store.clearHot();
  console.log('[polaris] state cleared');
}

// Used by getLogs from caller.
export { getLogs };
