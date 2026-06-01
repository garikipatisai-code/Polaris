// Pure settings -> per-role provider resolution for the Orchestrator.
//
// Precedence per reasoning role: cloud[role] -> CloudClient; else
// roleModels[role] (a local Ollama model override) -> the local client +
// that model; else undefined (the orchestrator uses defaultProvider).
//
// 35B reasoning roles (planner/evaluator local override) get a raised timeout
// and a num_predict floor — the Linux verification proved a 35B turn at the
// Evaluator/Planner budgets exceeds the 5-min default, and that think:true
// with a small num_predict returns empty content.

import type { Settings } from '../shared/messages';
import type { OllamaClient } from './ollama';
import { CloudClient } from './cloud_client';
import type { ProviderConfig } from '../agent/orchestrator';

export interface ResolvedProviders {
  defaultProvider: ProviderConfig;
  plannerProvider?: ProviderConfig;
  executorProvider?: ProviderConfig;
  evaluatorProvider?: ProviderConfig;
  compactorProvider?: ProviderConfig;
}

/** Big timeouts for the CPU-bound 35B (from the Linux verification). */
const PLANNER_35B_TIMEOUT_MS = 25 * 60 * 1000;
const EVALUATOR_35B_TIMEOUT_MS = 12 * 60 * 1000;
/** Generation budget so think:true doesn't swallow the whole output. */
const THINKING_NUM_PREDICT = 2048;
/** Cloud calls are fast; matches CloudClient's default. */
const CLOUD_TIMEOUT_MS = 60_000;

/** Context window per role — matches BUDGETS in budget.ts. Without this, Ollama
 *  defaults to 2048/4096 and silently truncates prompts. */
const ROLE_CTX: Record<string, number> = {
  planner: 65536,
  executor: 16384,
  evaluator: 32768,
  compactor: 16384,
};

type ReasoningRole = 'planner' | 'executor' | 'evaluator' | 'compactor';

export function buildProviders(settings: Settings, defaultClient: OllamaClient): ResolvedProviders {
  // Default provider (4B, used when no per-role override is set). 16K context fits
  // in GPU with q8_0 KV cache.
  const defaultProvider: ProviderConfig = { client: defaultClient, model: settings.model, numCtx: 16384 };

  const resolve = (role: ReasoningRole): ProviderConfig | undefined => {
    // Compactor stays LOCAL always (spec non-goal: no compactor-on-cloud). The
    // orchestrator casts the compactor client to OllamaClient, so never hand it
    // a CloudClient even if settings.cloud.compactor was hand-edited.
    const cloud = role !== 'compactor' ? settings.cloud?.[role] : undefined;
    if (cloud && cloud.apiKey && cloud.model) {
      return {
        client: new CloudClient(cloud.baseUrl || 'https://api.deepseek.com/v1', cloud.apiKey),
        model: cloud.model,
        timeoutMs: CLOUD_TIMEOUT_MS,
        numCtx: ROLE_CTX[role],
      };
    }
    const localModel = settings.roleModels?.[role];
    if (localModel && localModel !== settings.model) {
      // 35B runs CPU-only (num_gpu:0) to keep VRAM free for KV cache — 5 GPU layers
      // saved = ~2.5 GB VRAM, enough for 64K context without OOM on the P2200.
      const is35b = localModel.includes('35b');
      return {
        client: defaultClient,
        model: localModel,
        timeoutMs:
          role === 'planner' ? PLANNER_35B_TIMEOUT_MS
          : role === 'evaluator' ? EVALUATOR_35B_TIMEOUT_MS
          : undefined,
        numPredict:
          role === 'planner' || role === 'evaluator' || role === 'executor' ? THINKING_NUM_PREDICT : undefined,
        numCtx: ROLE_CTX[role],
        options: is35b ? { num_gpu: 0 } : undefined,
      };
    }
    return undefined;
  };

  return {
    defaultProvider,
    plannerProvider: resolve('planner'),
    executorProvider: resolve('executor'),
    evaluatorProvider: resolve('evaluator'),
    compactorProvider: resolve('compactor'),
  };
}

/**
 * All distinct LOCAL models the resolved config will request (for pre-flight
 * validation against `ollama list`). Excludes cloud-routed roles.
 */
export function localModelsInUse(settings: Settings): string[] {
  const models = new Set<string>([settings.model]);
  const roles: ReasoningRole[] = ['planner', 'executor', 'evaluator', 'compactor'];
  for (const role of roles) {
    if (role !== 'compactor' && settings.cloud?.[role]?.apiKey) continue; // cloud role — not a local model (compactor is always local)
    const m = settings.roleModels?.[role];
    if (m) models.add(m);
  }
  return [...models];
}
