// Memory tools — agent-controlled persistent key-value cells, IDB-backed.
//
// These are the MemGPT-style virtual-memory primitives the *model itself*
// can call. The Executor uses memory.write to durably store something
// between context windows; memory.read gets it back after the scratchpad
// has been compacted away; memory.list discovers what's there.
//
// All cells are scoped to the current taskId (via ToolContext).

import { z } from 'zod';
import type { ToolHandler } from './registry';
import * as store from '../state_store';

export const memoryWriteTool: ToolHandler<
  { namespace: string; key: string; value: string },
  { ok: true }
> = {
  name: 'memory.write',
  description:
    'Persistently store a key-value cell in a namespace. Survives compaction; scoped to the current task. Value ≤ 4000 chars.',
  argsSchema: z.object({
    namespace: z.string().min(1).max(80),
    key: z.string().min(1).max(120),
    value: z.string().max(4000),
  }),
  outputSchema: z.object({ ok: z.literal(true) }),
  parametersJSON: {
    type: 'object',
    properties: {
      namespace: {
        type: 'string',
        maxLength: 80,
        description: 'Bucket name (e.g., "candidates", "prices").',
      },
      key: {
        type: 'string',
        maxLength: 120,
        description: 'Cell key within the namespace.',
      },
      value: {
        type: 'string',
        maxLength: 4000,
        description: 'Value to store (≤4000 chars).',
      },
    },
    required: ['namespace', 'key', 'value'],
  },
  execute: async (args, ctx) => {
    await store.memoryWrite(ctx.taskId, args.namespace, args.key, args.value);
    return { ok: true as const };
  },
};

export const memoryReadTool: ToolHandler<
  { namespace: string; key: string },
  { value: string | null }
> = {
  name: 'memory.read',
  description: 'Read a single key-value cell from a namespace. Returns null if absent.',
  argsSchema: z.object({
    namespace: z.string().min(1).max(80),
    key: z.string().min(1).max(120),
  }),
  outputSchema: z.object({ value: z.string().nullable() }),
  parametersJSON: {
    type: 'object',
    properties: {
      namespace: { type: 'string', maxLength: 80 },
      key: { type: 'string', maxLength: 120 },
    },
    required: ['namespace', 'key'],
  },
  execute: async (args, ctx) => {
    const cell = await store.memoryRead(ctx.taskId, args.namespace, args.key);
    return { value: cell?.value ?? null };
  },
};

export const memoryListTool: ToolHandler<
  { namespace: string; prefix?: string; limit?: number },
  { entries: { key: string; value: string }[] }
> = {
  name: 'memory.list',
  description:
    'List key-value cells in a namespace, optionally filtered by key prefix. Limit ≤ 50.',
  argsSchema: z.object({
    namespace: z.string().min(1).max(80),
    prefix: z.string().max(120).optional(),
    limit: z.number().int().min(1).max(50).optional(),
  }),
  outputSchema: z.object({
    entries: z.array(z.object({ key: z.string(), value: z.string() })),
  }),
  parametersJSON: {
    type: 'object',
    properties: {
      namespace: { type: 'string', maxLength: 80 },
      prefix: { type: 'string', maxLength: 120, description: 'Optional key prefix filter.' },
      limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Max entries to return (default 50).' },
    },
    required: ['namespace'],
  },
  execute: async (args, ctx) => {
    const cells = await store.memoryList(ctx.taskId, args.namespace, {
      prefix: args.prefix,
      limit: args.limit,
    });
    return {
      entries: cells.map((c) => ({ key: c.key, value: c.value })),
    };
  },
};
