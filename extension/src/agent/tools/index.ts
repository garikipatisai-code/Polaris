// Default tool registry assembly.
//
// `createDefaultRegistry()` is the single entry point the orchestrator uses.
// New tools should be added here (and to the right category file).

import { ToolRegistry } from './registry';
import { echoTool, addTool, sumTool, delayTool, finishTool, nextStepTool } from './core';
import { memoryReadTool, memoryWriteTool, memoryListTool } from './memory';
import { searchTool } from './browser/search';
import { ariaExtractTool } from './browser/aria';
import {
  tabOpenTool,
  tabCloseTool,
  tabListTool,
  tabScreenshotTool,
  tabWaitLoadedTool,
} from './browser/tab';
import { productExtractTool } from './retailers/extract_tool';
import { tabClickTool } from './browser/actions';

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
  // M3 browser tools — only functional in the actual extension context (need
  // chrome.tabs / chrome.debugger). They throw BrowserToolError({fatal:true})
  // if invoked outside the extension, so the orchestrator can react cleanly.
  reg.register(searchTool);
  reg.register(ariaExtractTool);
  reg.register(tabOpenTool);
  reg.register(tabCloseTool);
  reg.register(tabListTool);
  reg.register(tabScreenshotTool);
  reg.register(tabWaitLoadedTool);
  // Retailer integration: bridge ARIA extraction to the adapter framework.
  reg.register(productExtractTool);
  // Page-action tools: CDP-based DOM interaction (click, type, select).
  reg.register(tabClickTool);
  return reg;
}

export { ToolRegistry } from './registry';
export type { ToolHandler, ToolContext } from './registry';
export { echoTool, addTool, sumTool, delayTool, finishTool, nextStepTool } from './core';
export { memoryWriteTool, memoryReadTool, memoryListTool } from './memory';
export { searchTool, parseDuckDuckGoResults } from './browser/search';
export { ariaExtractTool, simplifyAxTree } from './browser/aria';
export {
  tabOpenTool,
  tabCloseTool,
  tabListTool,
  tabScreenshotTool,
  tabWaitLoadedTool,
  getOwnedTabs,
  closeOwnedTabs,
} from './browser/tab';
export { findAdapter, extractProduct } from './retailers';
export { productExtractTool } from './retailers/extract_tool';
export { tabClickTool } from './browser/actions';
export { createVisionGroundTool } from './browser/vision';
export { BrowserToolError, withBrowserTimeout } from './browser/lifecycle';

/** Names of tools the orchestrator special-cases (phase transitions, plan advancement, etc.). */
export const SPECIAL_TOOLS = {
  /** `finish` calls route the state machine to EVALUATING. */
  FINISH: 'finish',
  /** `next_step` calls advance currentStepId and update plan step status. */
  NEXT_STEP: 'next_step',
} as const;
