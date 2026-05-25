// Tool-related shared types. Minimal in M2.1; expanded by M2.2's registry.
//
// `ToolDef.function.parameters` is a JSON Schema fragment as Ollama expects
// it in the `tools` array of /api/chat. We construct these from Zod schemas
// at module load (see agent/tools/registry.ts in M2.2).

export interface ToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>; // JSON Schema object
  };
}

export interface ToolCall {
  id?: string;
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

export interface ToolResult {
  ok: boolean;
  /** Tool-specific result payload. Validated by the caller against the tool's output schema. */
  data?: unknown;
  /** Error message if ok=false. */
  error?: string;
  /** Marks a non-recoverable error so the breaker can abort immediately. */
  fatal?: boolean;
  /**
   * True when the model invoked a tool name not in the registry. The
   * orchestrator forwards this to the circuit breaker as a distinct
   * "model is hallucinating tool names" signal — three of these in a
   * sliding window forces replan, separately from action-repeat.
   */
  unknownTool?: boolean;
}
