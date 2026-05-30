// Shared response type + normalization for routing agent roles to either
// OllamaClient or CloudClient. The role runners (executor.ts, evaluator.ts)
// accept `OllamaClient | CloudClient` and normalize responses to DriverResponse
// before processing, so the rest of the code sees the same shape regardless of
// which provider produced the response.

import type { OllamaClient } from './ollama';
import type { CloudClient } from './cloud_client';

export type AnyClient = OllamaClient | CloudClient;

/** Normalized response that role runners consume from either client type. */
export interface DriverResponse {
  message?: {
    content?: string;
    tool_calls?: { function: { name: string; arguments: Record<string, unknown> } }[];
  };
  prompt_eval_count?: number;
  eval_count?: number;
}

/**
 * Normalize a CloudClient response to DriverResponse shape.
 * Cloud returns { choices: [{ message: { content } }] };
 * we map that to { message: { content }, prompt_eval_count, eval_count }
 * which matches Ollama's shape.
 */
export function normalizeCloudResponse(
  response: import('./cloud_client').CloudChatResponse,
): DriverResponse {
  return {
    message: {
      content: response.choices[0]?.message?.content,
    },
    prompt_eval_count: response.usage?.prompt_tokens,
    eval_count: response.usage?.completion_tokens,
  };
}
