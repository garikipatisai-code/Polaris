// Property-based tests for walkPlan (orchestrator's plan-step advancer).
//
// walkPlan is now exported directly from src/agent/orchestrator.ts (post-
// arch-nemesis #4). Earlier rounds duplicated the function here, which gave
// false confidence — the test passed even when the source drifted.
//
// Properties verified:
//  - non-mutation of the input plan
//  - current step is always marked 'done' when found
//  - nextStepId always corresponds to a real step in the new plan (or null)
//  - walking with currentStepId === null is a no-op
//  - status of children fields is unchanged (M2.6.3 only walks root steps)
//  - walking from the last pending step yields nextStepId === null

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { Plan, PlanStep, StepStatus } from '../../src/shared/agent_types';
import { walkPlan } from '../../src/agent/orchestrator';

const NUM_RUNS = 60;
const STATUSES: readonly StepStatus[] = ['pending', 'active', 'done', 'skipped', 'failed'] as const;

interface StepSpec {
  id: string;
  status: StepStatus;
  hasChildren: boolean;
}

/**
 * Build a valid plan from generated step specs. IDs are forced unique by
 * suffixing the index — fast-check's plain string generator may emit dupes,
 * which would break walkPlan's "find by id" contract.
 */
function buildPlan(specs: StepSpec[]): Plan {
  const seen = new Set<string>();
  const rootSteps: PlanStep[] = [];
  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i]!;
    let id = `${spec.id}-${i}`;
    while (seen.has(id)) id = `${id}_dup`;
    seen.add(id);
    const step: PlanStep = {
      id,
      title: `step-${i}`,
      status: spec.status,
    };
    if (spec.hasChildren) {
      step.children = [
        { id: `${id}.c1`, title: 'child1', status: 'pending' },
        { id: `${id}.c2`, title: 'child2', status: 'done' },
      ];
    }
    rootSteps.push(step);
  }
  return { rootSteps, revision: 1, generatedAt: 0 };
}

const stepSpec = fc.record({
  id: fc.string({ minLength: 1, maxLength: 6 }),
  status: fc.constantFrom(...STATUSES),
  hasChildren: fc.boolean(),
});

const planArb = fc
  .array(stepSpec, { minLength: 1, maxLength: 8 })
  .map((specs) => buildPlan(specs));

/** Pick an arbitrary id from the plan, OR a non-existent sentinel id. */
function planAndCurrentId(): fc.Arbitrary<{ plan: Plan; currentStepId: string }> {
  return planArb.chain((plan) =>
    fc.integer({ min: 0, max: plan.rootSteps.length - 1 }).map((i) => ({
      plan,
      currentStepId: plan.rootSteps[i]!.id,
    })),
  );
}

/** Deep-clone helper for non-mutation checks. */
function deepClone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

describe('walkPlan — property tests', () => {
  it('does not mutate the input plan', () => {
    fc.assert(
      fc.property(planAndCurrentId(), ({ plan, currentStepId }) => {
        const snapshot = deepClone(plan);
        walkPlan(plan, currentStepId);
        expect(plan).toEqual(snapshot);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('marks the current step as done when found in rootSteps', () => {
    fc.assert(
      fc.property(planAndCurrentId(), ({ plan, currentStepId }) => {
        const out = walkPlan(plan, currentStepId);
        const cur = out.plan.rootSteps.find((s) => s.id === currentStepId);
        expect(cur).toBeDefined();
        expect(cur!.status).toBe('done');
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('returns a nextStepId that always corresponds to a real step in the new plan, or null', () => {
    fc.assert(
      fc.property(planAndCurrentId(), ({ plan, currentStepId }) => {
        const out = walkPlan(plan, currentStepId);
        if (out.nextStepId === null) return true;
        const ids = out.plan.rootSteps.map((s) => s.id);
        return ids.includes(out.nextStepId);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('returns nextStepId === null when walking from the last pending/active step', () => {
    // Construct plans where the chosen step has no pending/active step after it.
    fc.assert(
      fc.property(
        fc.array(stepSpec, { minLength: 1, maxLength: 6 }),
        (specs) => {
          // Force the LAST step to be 'active' and ensure no later pending — by
          // construction it's last, so there is no 'after'. Walk from it.
          const plan = buildPlan([...specs.slice(0, -1), { id: 'last', status: 'active', hasChildren: false }]);
          const lastId = plan.rootSteps[plan.rootSteps.length - 1]!.id;
          const out = walkPlan(plan, lastId);
          return out.nextStepId === null;
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('returns nextStepId === null and an unchanged plan when currentStepId is null', () => {
    fc.assert(
      fc.property(planArb, (plan) => {
        const out = walkPlan(plan, null);
        // Reference equality: the source returns the same plan object.
        expect(out.plan).toBe(plan);
        expect(out.nextStepId).toBe(null);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('returns nextStepId === null and an unchanged plan when currentStepId is not in plan', () => {
    fc.assert(
      fc.property(planArb, (plan) => {
        // Use a sentinel ID guaranteed not to collide with any generated id.
        const out = walkPlan(plan, '__not_a_real_step_id__');
        expect(out.plan).toBe(plan);
        expect(out.nextStepId).toBe(null);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('current step transitions to "done" and the next pending/active becomes "active" — at most one of each', () => {
    // Compares input vs output transitions across all root step ids.
    fc.assert(
      fc.property(planAndCurrentId(), ({ plan, currentStepId }) => {
        const out = walkPlan(plan, currentStepId);
        const beforeById = new Map(plan.rootSteps.map((s) => [s.id, s.status]));
        const afterById = new Map(out.plan.rootSteps.map((s) => [s.id, s.status]));

        let toDoneCount = 0;
        let toActiveCount = 0;
        for (const [id, beforeStatus] of beforeById.entries()) {
          const afterStatus = afterById.get(id)!;
          if (beforeStatus !== afterStatus) {
            // Allowed transitions only: → 'done' (the current) or → 'active' (the next).
            if (afterStatus === 'done') toDoneCount++;
            else if (afterStatus === 'active') toActiveCount++;
            else {
              // Disallowed transition discovered — fail loudly with context.
              throw new Error(
                `unexpected transition ${beforeStatus} → ${afterStatus} on step ${id}`,
              );
            }
          }
        }
        // At most one transition into 'done' (the current step) — fewer if it
        // was already 'done'. At most one into 'active' (the next pending/active).
        expect(toDoneCount).toBeLessThanOrEqual(1);
        expect(toActiveCount).toBeLessThanOrEqual(1);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('children of root steps are unchanged (M2.6.3 only walks root steps)', () => {
    fc.assert(
      fc.property(planAndCurrentId(), ({ plan, currentStepId }) => {
        const out = walkPlan(plan, currentStepId);
        for (let i = 0; i < plan.rootSteps.length; i++) {
          const before = plan.rootSteps[i]!.children;
          const after = out.plan.rootSteps[i]!.children;
          expect(after).toEqual(before);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('idempotent-ish: walking from an already-done step still returns a deep-equal plan when no later pending exists', () => {
    // NOTE: a strict "idempotent on already-done" property is not what the
    // source actually does — if a later pending step exists, walkPlan WILL
    // advance to it even though the current step is already 'done'. We
    // therefore test the scoped form: when current is already done AND no
    // later pending/active exists, the resulting plan is deep-equal to input
    // and nextStepId is null.
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom<StepStatus>('done', 'skipped', 'failed'), {
          minLength: 1,
          maxLength: 6,
        }),
        (laterStatuses) => {
          // Build [done-current, ...non-pending-laters].
          const specs: StepSpec[] = [
            { id: 'cur', status: 'done', hasChildren: false },
            ...laterStatuses.map((s, i) => ({ id: `l${i}`, status: s, hasChildren: false })),
          ];
          const plan = buildPlan(specs);
          const currentId = plan.rootSteps[0]!.id;
          const out = walkPlan(plan, currentId);
          expect(out.nextStepId).toBe(null);
          // Deep-equal: the rootSteps array is rebuilt with shallow copies but
          // statuses match since no transitions happened.
          expect(out.plan.rootSteps).toEqual(plan.rootSteps);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
