// Default tool registry assembly.
//
// `createDefaultRegistry()` is the single entry point the orchestrator uses.
// New tools should be added here (and to the right category file).

import { ToolRegistry } from './registry';
import { echoTool, addTool, sumTool, delayTool, finishTool, nextStepTool } from './core';
import { memoryReadTool, memoryWriteTool, memoryListTool } from './memory';

export function createDefaultRegistry(): ToolRegistry {
  const reg = new ToolRegistry();
  // Core
  reg.register(echoTool);
  reg.register(addTool);
  reg.register(sumTool);
  reg.register(delayTool);
  reg.register(nextStepTool);
  reg.register(finishTool);
  // Memory (IDB-backed, per-task)
  reg.register(memoryWriteTool);
  reg.register(memoryReadTool);
  reg.register(memoryListTool);
  return reg;
}

export { ToolRegistry } from './registry';
export type { ToolHandler, ToolContext } from './registry';
export { echoTool, addTool, sumTool, delayTool, finishTool, nextStepTool } from './core';
export { memoryWriteTool, memoryReadTool, memoryListTool } from './memory';

/** Names of tools the orchestrator special-cases (phase transitions, plan advancement, etc.). */
export const SPECIAL_TOOLS = {
  /** `finish` calls route the state machine to EVALUATING. */
  FINISH: 'finish',
  /** `next_step` calls advance currentStepId and update plan step status. */
  NEXT_STEP: 'next_step',
} as const;
