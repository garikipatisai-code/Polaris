// Shared protocol between the side panel UI and the background service worker.

import type { AgentStateHot, AgentEventType } from './agent_types';
import type { OpSummary } from '../agent/metrics';
import type { DomainTier } from '../agent/domain_tiers';

export interface CloudProviderConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface Settings {
  ollamaBaseUrl: string;
  model: string;
  embeddingModel: string;
  /** Thinking mode for chat replies (M1 chat path). */
  enableThinking: boolean;
  /** Thinking mode for the Planner role. Default on; disable on slow hardware. */
  plannerThinking: boolean;
  /** Thinking mode for the Evaluator role (M2.5+). Default on; disable on slow hardware. */
  evaluatorThinking: boolean;
  /** Thinking mode for the Executor role. Off by default (e2b is fast enough without it). */
  executorThinking: boolean;
  /** Per-role cloud provider overrides. When set, routes that role to a cloud LLM. */
  cloud?: {
    planner?: CloudProviderConfig;
    executor?: CloudProviderConfig;
    evaluator?: CloudProviderConfig;
    compactor?: CloudProviderConfig;
  };
  /**
   * Per-role LOCAL model override (same Ollama server, different model tag).
   * Locked defaults route the reasoning roles to the capable 35B; Executor /
   * Compactor inherit `model` (the fast 4B). Cloud (above) takes precedence.
   */
  roleModels?: {
    planner?: string;
    executor?: string;
    evaluator?: string;
    compactor?: string;
  };
}

export const DEFAULT_SETTINGS: Settings = {
  ollamaBaseUrl: 'http://localhost:11434',
  model: 'gemma4:e4b',
  embeddingModel: 'mxbai-embed-large',
  enableThinking: false,
  plannerThinking: true,
  evaluatorThinking: true,
  executorThinking: true,
  // All roles -> Gemma 4 e4b (4.5B active, 128K context, vision built-in).
  // The e4b fits ~14 GPU layers on the P2200 with the rest on CPU, giving
  // ~3-5 tok/s with reliable native function calling.
  roleModels: {},
};

export interface ChatStats {
  promptTokens?: number;
  genTokens?: number;
  tokPerSec?: number;
  wallMs?: number;
}

/** Generic agent event mirrored from the orchestrator to the panel. */
export interface AgentEventPayload {
  type: AgentEventType;
  data?: unknown;
}

// Side panel → service worker
export type RequestMessage =
  | { type: 'chat.start'; userText: string; goal?: string }
  | { type: 'chat.abort' }
  | { type: 'settings.get' }
  | { type: 'settings.set'; settings: Partial<Settings> }
  | { type: 'ollama.ping' }
  | { type: 'agent.start'; goal: string }
  | { type: 'agent.abort' }
  | { type: 'agent.reset' }
  | { type: 'agent.resume' }
  | { type: 'agent.getSnapshot' }
  | { type: 'metrics.get'; taskId: string }
  | { type: 'domainTiers.list' }
  | { type: 'domainTiers.set'; host: string; tier: DomainTier | null };

// Service worker → side panel
export type ResponseMessage =
  | { type: 'chat.chunk'; content: string }
  | { type: 'chat.complete'; stats?: ChatStats }
  | { type: 'chat.error'; message: string }
  | { type: 'chat.status'; status: 'warming'; message: string }
  | { type: 'settings.value'; settings: Settings }
  | { type: 'ollama.ping.result'; ok: boolean; error?: string; models?: string[] }
  | { type: 'agent.started'; taskId: string; goal: string }
  | { type: 'agent.event'; event: AgentEventPayload }
  /**
   * Batched resume-time event replay. Used by `agent.resume` to send
   * the entire persisted event log as a single message instead of N
   * separate `agent.event` postMessages. The panel handler expands the
   * batch and processes each event identically to a singleton.
   */
  | { type: 'agent.events'; events: AgentEventPayload[] }
  | { type: 'agent.terminal'; phase: 'DONE' | 'ABORTED'; summary?: string; error?: string }
  | { type: 'agent.snapshot'; state: AgentStateHot | null }
  | { type: 'metrics.value'; taskId: string; summary: OpSummary[] }
  | { type: 'domainTiers.value'; tiers: Record<string, DomainTier> };

export const PORT_NAME = 'polaris.sidepanel';
