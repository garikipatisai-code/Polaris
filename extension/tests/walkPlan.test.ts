// walkPlan is a private helper inside orchestrator.ts. To test it without
// pulling in the orchestrator's heavy imports (chrome APIs etc.), the
// function is duplicated here from the source.  If the orchestrator's copy
// drifts, this test will fail to mirror reality — that's an acceptable
// signal that we should extract walkPlan into its own file.

import { describe, expect, it } from 'vitest';
import type { Plan, PlanStep } from '../src/shared/agent_types';

// ---- copy of orchestrator.ts walkPlan (keep in sync) ----
function walkPlan(plan: Plan, currentStepId: string | null): { plan: Plan; nextStepId: string | null } {
  if (currentStepId === null) {
    return { plan, nextStepId: null };
  }
  const newRootSteps: PlanStep[] = plan.rootSteps.map((s) => ({ ...s }));
  let nextStepId: string | null = null;
  let foundCurrent = false;
  for (let i = 0; i < newRootSteps.length; i++) {
    if (newRootSteps[i]!.id === currentStepId) {
      foundCurrent = true;
      newRootSteps[i] = { ...newRootSteps[i]!, status: 'done' };
      for (let j = i + 1; j < newRootSteps.length; j++) {
        if (newRootSteps[j]!.status === 'pending' || newRootSteps[j]!.status === 'active') {
          newRootSteps[j] = { ...newRootSteps[j]!, status: 'active' };
          nextStepId = newRootSteps[j]!.id;
          break;
        }
      }
      break;
    }
  }
  if (!foundCurrent) {
    return { plan, nextStepId: null };
  }
  return {
    plan: { ...plan, rootSteps: newRootSteps },
    nextStepId,
  };
}
// ---- end copy ----

function makePlan(specs: { id: string; status: PlanStep['status']; children?: PlanStep[] }[]): Plan {
  return {
    rootSteps: specs.map((s) => ({
      id: s.id,
      title: s.id,
      status: s.status,
      children: s.children,
    })),
    revision: 1,
    generatedAt: 0,
  };
}

describe('walkPlan', () => {
  it('advances from s1 to s2 when s2 is pending', () => {
    const plan = makePlan([
      { id: 's1', status: 'active' },
      { id: 's2', status: 'pending' },
      { id: 's3', status: 'pending' },
    ]);
    const out = walkPlan(plan, 's1');
    expect(out.nextStepId).toBe('s2');
    expect(out.plan.rootSteps[0]!.status).toBe('done');
    expect(out.plan.rootSteps[1]!.status).toBe('active');
    expect(out.plan.rootSteps[2]!.status).toBe('pending');
  });

  it('returns null nextStepId when advancing from the last step', () => {
    const plan = makePlan([
      { id: 's1', status: 'done' },
      { id: 's2', status: 'active' },
    ]);
    const out = walkPlan(plan, 's2');
    expect(out.nextStepId).toBe(null);
    expect(out.plan.rootSteps[1]!.status).toBe('done');
  });

  it('skips already-done intermediate steps', () => {
    const plan = makePlan([
      { id: 's1', status: 'active' },
      { id: 's2', status: 'done' },
      { id: 's3', status: 'pending' },
    ]);
    const out = walkPlan(plan, 's1');
    expect(out.nextStepId).toBe('s3');
  });

  it('returns null nextStepId when currentStepId is null', () => {
    const plan = makePlan([{ id: 's1', status: 'pending' }]);
    const out = walkPlan(plan, null);
    expect(out.nextStepId).toBe(null);
    // Plan unchanged (returned as-is).
    expect(out.plan).toBe(plan);
  });

  it('returns null nextStepId when currentStepId is not in the plan', () => {
    const plan = makePlan([
      { id: 's1', status: 'pending' },
      { id: 's2', status: 'pending' },
    ]);
    const out = walkPlan(plan, 'sX');
    expect(out.nextStepId).toBe(null);
    // Plan unchanged because we couldn't find current.
    expect(out.plan).toBe(plan);
  });

  it('does NOT mutate the original plan', () => {
    const plan = makePlan([
      { id: 's1', status: 'active' },
      { id: 's2', status: 'pending' },
    ]);
    const before = JSON.stringify(plan);
    walkPlan(plan, 's1');
    expect(JSON.stringify(plan)).toBe(before);
  });

  it('preserves children fields on advanced steps', () => {
    const child: PlanStep = { id: 's1.1', title: 'child', status: 'pending' };
    const plan = makePlan([
      { id: 's1', status: 'active', children: [child] },
      { id: 's2', status: 'pending' },
    ]);
    const out = walkPlan(plan, 's1');
    expect(out.plan.rootSteps[0]!.children).toEqual([child]);
  });
});
