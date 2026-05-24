// Core mock tools for M2 validation: echo, add, delay, finish.
//
// These exist to exercise the agent loop end-to-end without any browser-
// side complexity. M3 adds real browser tools (tab control, ARIA extract,
// screenshot vision).
//
// `finish` is special: the orchestrator detects calls to it and transitions
// the state machine to EVALUATING regardless of plan progress. The tool
// itself just acks — the routing decision lives in orchestrator.ts.

import { z } from 'zod';
import type { ToolHandler } from './registry';

export const echoTool: ToolHandler<{ text: string }, { text: string }> = {
  name: 'echo',
  description: 'Echoes the input text back unchanged. Smoke test only.',
  argsSchema: z.object({ text: z.string() }),
  outputSchema: z.object({ text: z.string() }),
  parametersJSON: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'Text to echo back.' },
    },
    required: ['text'],
  },
  execute: async (args) => ({ text: args.text }),
};

export const addTool: ToolHandler<{ a: number; b: number }, { sum: number }> = {
  name: 'add',
  description: 'Add two numbers and return the sum. For 3+ numbers prefer the `sum` tool.',
  argsSchema: z.object({ a: z.number(), b: z.number() }),
  outputSchema: z.object({ sum: z.number() }),
  parametersJSON: {
    type: 'object',
    properties: {
      a: { type: 'number', description: 'First addend.' },
      b: { type: 'number', description: 'Second addend.' },
    },
    required: ['a', 'b'],
  },
  execute: async (args) => ({ sum: args.a + args.b }),
};

export const sumTool: ToolHandler<{ numbers: number[] }, { sum: number }> = {
  name: 'sum',
  description:
    'Add an array of numbers and return the total. Use this when summing 3 or more values — preferred over chaining multiple `add` calls.',
  argsSchema: z.object({
    numbers: z.array(z.number()).min(1).max(100),
  }),
  outputSchema: z.object({ sum: z.number() }),
  parametersJSON: {
    type: 'object',
    properties: {
      numbers: {
        type: 'array',
        items: { type: 'number' },
        minItems: 1,
        maxItems: 100,
        description: 'List of numbers to sum.',
      },
    },
    required: ['numbers'],
  },
  execute: async (args) => ({ sum: args.numbers.reduce((acc, n) => acc + n, 0) }),
};

export const delayTool: ToolHandler<{ ms: number }, { waitedMs: number }> = {
  name: 'delay',
  description: 'Waits N milliseconds (max 5000). Exercises async tool paths.',
  argsSchema: z.object({ ms: z.number().int().min(0).max(5000) }),
  outputSchema: z.object({ waitedMs: z.number() }),
  parametersJSON: {
    type: 'object',
    properties: {
      ms: {
        type: 'integer',
        minimum: 0,
        maximum: 5000,
        description: 'Milliseconds to wait (0–5000).',
      },
    },
    required: ['ms'],
  },
  execute: async (args) => {
    await new Promise((resolve) => setTimeout(resolve, args.ms));
    return { waitedMs: args.ms };
  },
};

export const finishTool: ToolHandler<
  { summary: string; findingKeys?: string[] },
  { ack: true }
> = {
  name: 'finish',
  description:
    'Signal that the user\'s goal is complete. Provide a final summary and (optionally) the finding keys that back the summary. The orchestrator routes this to EVALUATING.',
  argsSchema: z.object({
    summary: z.string().min(1).max(2000),
    findingKeys: z.array(z.string()).max(20).optional(),
  }),
  outputSchema: z.object({ ack: z.literal(true) }),
  parametersJSON: {
    type: 'object',
    properties: {
      summary: {
        type: 'string',
        maxLength: 2000,
        description: 'Final answer or summary for the user.',
      },
      findingKeys: {
        type: 'array',
        items: { type: 'string' },
        maxItems: 20,
        description: 'Optional: finding keys that back the summary.',
      },
    },
    required: ['summary'],
  },
  execute: async () => ({ ack: true as const }),
};

export const nextStepTool: ToolHandler<
  { reason?: string },
  { ack: true }
> = {
  name: 'next_step',
  description:
    'Mark the current plan step as DONE and advance to the next pending step. ' +
    'Call this when the actions required by the current step have been completed. ' +
    'Do NOT call this on the last step — call `finish` instead.',
  argsSchema: z.object({
    reason: z.string().max(200).optional(),
  }),
  outputSchema: z.object({ ack: z.literal(true) }),
  parametersJSON: {
    type: 'object',
    properties: {
      reason: {
        type: 'string',
        maxLength: 200,
        description: 'Optional: one-line note on what was accomplished in this step.',
      },
    },
  },
  execute: async () => ({ ack: true as const }),
};
