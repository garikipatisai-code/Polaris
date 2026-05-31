// Shared response type + normalization for routing agent roles to either
// OllamaClient or CloudClient. The role runners (executor.ts, evaluator.ts)
// accept `OllamaClient | CloudClient` and normalize responses to DriverResponse
// before processing, so the rest of the code sees the same shape regardless of
// which provider produced the response.

import type { OllamaClient, ChatMessage, ToolDef } from './ollama';
import { wasTimeout } from './ollama';
import { CloudClient } from './cloud_client';
import type { CloudMessage } from './cloud_client';
import { anonymize, containsPlaceholders } from '../agent/anonymize';
import { deanonymize } from '../agent/deanonymize';
import { log } from '../agent/log';

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
 * Cloud returns { choices: [{ message: { content, tool_calls? } }] };
 * we map that to { message: { content, tool_calls? }, prompt_eval_count, eval_count }
 * which matches Ollama's shape. tool_calls arguments strings are JSON.parsed
 * into Record<string, unknown>; malformed JSON yields {}.
 */
export function normalizeCloudResponse(
  response: import('./cloud_client').CloudChatResponse,
): DriverResponse {
  const msg = response.choices[0]?.message;
  const toolCalls = msg?.tool_calls?.map((tc) => ({
    function: {
      name: tc.function.name,
      arguments: safeParseArgs(tc.function.arguments),
    },
  }));
  return {
    message: {
      content: msg?.content,
      ...(toolCalls && toolCalls.length ? { tool_calls: toolCalls } : {}),
    },
    prompt_eval_count: response.usage?.prompt_tokens,
    eval_count: response.usage?.completion_tokens,
  };
}

/** Parse an OpenAI tool-call arguments string into an object; {} on failure. */
function safeParseArgs(s: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(s);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export interface DriveProvider {
  client: AnyClient;
  model: string;
  /** Per-provider timeout override (ms). 35B local roles need a big one. */
  timeoutMs?: number;
  /** num_predict for local thinking roles on the 35B (else thinking eats the budget). */
  numPredict?: number;
}

export interface DriveOptions {
  messages: ChatMessage[];
  tools?: ToolDef[];
  format?: 'json' | Record<string, unknown>;
  think?: boolean;
  signal?: AbortSignal;
}

export interface DriveResult extends DriverResponse {
  providerUsed: 'local' | 'cloud';
  fellBack: boolean;
}

/**
 * Single choke point for routing a role's chat call to a local OllamaClient
 * or a cloud CloudClient. Owns: cloud tools/response_format mapping, the
 * reversible PII sandwich (anonymize outbound / deanonymize response), and
 * auto-fallback to a local provider on cloud network/HTTP/timeout error
 * (NOT on user abort).
 */
export async function driveChatOnce(
  primary: DriveProvider,
  opts: DriveOptions,
  fallback?: DriveProvider,
): Promise<DriveResult> {
  if (!(primary.client instanceof CloudClient)) {
    // Narrowed by the instanceof CloudClient guard above; AnyClient = OllamaClient | CloudClient.
    // If a third client variant is added, update this dispatch.
    const resp = await (primary.client as OllamaClient).chatOnce({
      model: primary.model,
      messages: opts.messages,
      tools: opts.tools,
      format: opts.format,
      think: opts.think,
      signal: opts.signal,
      timeoutMs: primary.timeoutMs,
      options: primary.numPredict ? { num_predict: primary.numPredict } : undefined,
    });
    return { ...resp, providerUsed: 'local', fellBack: false };
  }

  const cloud = primary.client;
  try {
    const map: Record<string, string> = {};
    const cloudMessages: CloudMessage[] = opts.messages.map((m) => {
      const { text, map: m2 } = anonymize(m.content);
      Object.assign(map, m2);
      const role = m.role === 'system' || m.role === 'assistant' ? m.role : 'user';
      return { role, content: text };
    });

    // deanonymize in place — normalizeCloudResponse below reads from raw.choices
    const raw = await cloud.chatOnce({
      model: primary.model,
      messages: cloudMessages,
      // apiKey omitted — CloudClient uses its constructed defaultApiKey.
      tools: opts.tools,
      // cloud only maps 'json'; a schema-object format is not forwarded to cloud response_format
      responseFormatJson: opts.format === 'json',
      signal: opts.signal,
      timeoutMs: primary.timeoutMs,
    });

    const respMsg = raw.choices[0]?.message;
    if (respMsg) {
      if (respMsg.content) respMsg.content = deanonymize(respMsg.content, map);
      if (respMsg.tool_calls) {
        for (const tc of respMsg.tool_calls) {
          tc.function.arguments = deanonymize(tc.function.arguments, map);
        }
      }
      // A surviving <KIND_N> means the model emitted a placeholder not in our
      // map (hallucinated or mismatched) — it would reach the tool dispatcher
      // as a literal placeholder string. Surface it rather than fail silently.
      const leaked =
        (respMsg.content && containsPlaceholders(respMsg.content)) ||
        (respMsg.tool_calls ?? []).some((tc) => containsPlaceholders(tc.function.arguments));
      if (leaked) {
        log('warn', 'cloud', 'response still contains placeholders after deanonymize (model hallucinated a placeholder?)');
      }
    }
    const normalized = normalizeCloudResponse(raw);
    return { ...normalized, providerUsed: 'cloud', fellBack: false };
  } catch (e) {
    const err = e as Error;
    const isUserAbort = err.name === 'AbortError' && !wasTimeout(e);
    if (isUserAbort || !fallback) throw e;
    log('warn', 'cloud', 'cloud call failed — falling back to local', { error: err.message?.slice(0, 200) });
    const resp = await (fallback.client as OllamaClient).chatOnce({
      model: fallback.model,
      messages: opts.messages,
      tools: opts.tools,
      format: opts.format,
      think: opts.think,
      signal: opts.signal,
      timeoutMs: fallback.timeoutMs,
      options: fallback.numPredict ? { num_predict: fallback.numPredict } : undefined,
    });
    return { ...resp, providerUsed: 'local', fellBack: true };
  }
}
