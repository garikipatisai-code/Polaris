// walkPlan is exported from orchestrator.ts (post-arch-nemesis #4). Earlier
// rounds duplicated the function here to avoid pulling chrome-API-heavy
// imports — that pattern was a false-confidence trap (the test passed even
// when the source drifted) and has been removed.

import { describe, expect, it } from 'vitest';
import type { Plan, PlanStep } from '../src/shared/agent_types';
import { walkPlan } from '../src/agent/orchestrator';

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
