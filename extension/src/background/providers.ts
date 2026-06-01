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

/** Big timeouts for the CPU-bound 26B (from the Gemma 4 research). */
const PLANNER_26B_TIMEOUT_MS = 25 * 60 * 1000;
const EVALUATOR_26B_TIMEOUT_MS = 12 * 60 * 1000;
/** Generation budget so think:true doesn't swallow the whole output. */
const THINKING_NUM_PREDICT = 2048;
/** Cloud calls are fast; matches CloudClient's default. */
const CLOUD_TIMEOUT_MS = 60_000;

/** Context window per role — set to model-native maximums. Gemma 4's GQA and
 *  cross-layer KV sharing make these fit easily (e2b 128K KV cache ~960 MB at
 *  q8_0; 26B 256K KV cache ~640 MB at q8_0). */
const ROLE_CTX: Record<string, number> = {
  planner: 262144,
  executor: 131072,
  evaluator: 262144,
  compactor: 131072,
};

type ReasoningRole = 'planner' | 'executor' | 'evaluator' | 'compactor';

export function buildProviders(settings: Settings, defaultClient: OllamaClient): ResolvedProviders {
  // Default provider (e4b/e2b, used when no per-role override). 128K context
  // fits in GPU with q8_0 KV cache. Ollama dynamically splits layers.
  const defaultProvider: ProviderConfig = { client: defaultClient, model: settings.model, numCtx: 131072 };

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
      return {
        client: defaultClient,
        model: localModel,
        timeoutMs:
          role === 'planner' ? PLANNER_26B_TIMEOUT_MS
          : role === 'evaluator' ? EVALUATOR_26B_TIMEOUT_MS
          : undefined,
        numPredict:
          role === 'planner' || role === 'evaluator' ? THINKING_NUM_PREDICT : undefined,
        numCtx: ROLE_CTX[role],
        // No num_gpu override — Ollama dynamically splits layers across
        // VRAM/CPU based on available resources and model size.
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
