// Tool registry for the agent loop.
//
// Each tool carries:
//   - name + description (for Ollama tool defs and the Planner's compact index)
//   - argsSchema (Zod) for runtime arg validation
//   - outputSchema (Zod) for sanity-checking the handler's return value
//   - parametersJSON (hand-written JSON Schema) shipped to Ollama in `tools`
//   - execute(args, ctx) — the actual implementation
//
// We hand-write the JSON Schema rather than pulling in `zod-to-json-schema`
// (~50 KB) because we only have a small fixed set of tools and the Zod and
// JSON Schema definitions would be kept in sync by review anyway.

import { z } from 'zod';
import type { ToolDef, ToolCall, ToolResult } from '../../shared/tool_types';

export interface ToolContext {
  taskId: string;
  stepId: string | null;
}

export interface ToolHandler<I = unknown, O = unknown> {
  name: string;
  description: string;
  argsSchema: z.ZodType<I>;
  outputSchema: z.ZodType<O>;
  parametersJSON: Record<string, unknown>;
  execute: (args: I, ctx: ToolContext) => Promise<O>;
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolHandler<unknown, unknown>>();

  register<I, O>(handler: ToolHandler<I, O>): void {
    if (this.tools.has(handler.name)) {
      throw new Error(`tool already registered: ${handler.name}`);
    }
    this.tools.set(handler.name, handler as ToolHandler<unknown, unknown>);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  /** Full JSON-Schema definitions for Ollama's `tools` array. */
  toToolDefs(): ToolDef[] {
    return [...this.tools.values()].map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parametersJSON,
      },
    }));
  }

  /** Compact (name + description) index for the Planner. ~1 line per tool. */
  toIndex(): { name: string; description: string }[] {
    return [...this.tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
    }));
  }

  /**
   * Dispatch a tool call. Validates args via Zod; runs the handler; sanity-
   * checks the output. Never throws — returns {ok:false, error} on failure.
   * `fatal` is set when the failure is non-recoverable (the circuit breaker
   * will abort the task rather than retry).
   */
  async dispatch(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
    const handler = this.tools.get(call.function.name);
    if (!handler) {
      return {
        ok: false,
        error: `unknown tool: ${call.function.name}`,
        // Mark explicitly so the breaker can distinguish "model invented
        // a tool" from "registered tool returned an error" — different
        // recovery paths.
        unknownTool: true,
      };
    }
    let parsed: unknown;
    try {
      parsed = handler.argsSchema.parse(call.function.arguments);
    } catch (e) {
      return {
        ok: false,
        error: `arg validation failed for ${call.function.name}: ${truncate((e as Error).message, 200)}`,
      };
    }
    try {
      const result = await handler.execute(parsed, ctx);
      // Output validation is advisory; log but don't fail dispatch.
      try {
        handler.outputSchema.parse(result);
      } catch (e) {
        console.warn(`[polaris] tool ${call.function.name} output failed validation`, e);
      }
      return { ok: true, data: result };
    } catch (e) {
      // Browser tools throw BrowserToolError to mark fatal vs recoverable.
      // The `fatal` flag is plumbed through to the circuit breaker.
      const err = e as Error & { fatal?: boolean };
      const out: ToolResult = {
        ok: false,
        error: `${call.function.name} threw: ${truncate(err.message, 200)}`,
      };
      if (typeof err.fatal === 'boolean') out.fatal = err.fatal;
      return out;
    }
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}
