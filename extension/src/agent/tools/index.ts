// Default tool registry assembly.
//
// `createDefaultRegistry()` is the single entry point the orchestrator uses.
// New tools should be added here (and to the right category file).

import { ToolRegistry } from './registry';
import { echoTool, addTool, delayTool, finishTool } from './core';
import { memoryReadTool, memoryWriteTool, memoryListTool } from './memory';

export function createDefaultRegistry(): ToolRegistry {
  const reg = new ToolRegistry();
  // Core
  reg.register(echoTool);
  reg.register(addTool);
  reg.register(delayTool);
  reg.register(finishTool);
  // Memory (IDB-backed, per-task)
  reg.register(memoryWriteTool);
  reg.register(memoryReadTool);
  reg.register(memoryListTool);
  return reg;
}

export { ToolRegistry } from './registry';
export type { ToolHandler, ToolContext } from './registry';
export { echoTool, addTool, delayTool, finishTool } from './core';
export { memoryWriteTool, memoryReadTool, memoryListTool } from './memory';

/** Names of tools the orchestrator special-cases (phase transitions, etc.). */
export const SPECIAL_TOOLS = {
  /** `finish` calls route the state machine to EVALUATING. */
  FINISH: 'finish',
} as const;
