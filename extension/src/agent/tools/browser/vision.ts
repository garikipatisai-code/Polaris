// Vision ground-truth verification tool.
//
// Factory function: createVisionGroundTool(client, model) returns a ToolHandler
// that takes a screenshot data URI (and optional question) and sends it to the
// local Ollama vision model for verification.
//
// This implements the "vision is verification-only, not primary extraction"
// design from Polaris CLAUDE.md (§5). Primary page data should be extracted
// via the ARIA tree; vision.ground is used to *confirm* that extracted data
// matches the visible page state.
//
// Width check: images < MIN_VISION_WIDTH_PX (1200) are rejected because smaller
// images cause the model to hallucinate instead of refusing — documented in the
// Linux probe results.

import { z } from 'zod';
import type { ToolHandler } from '../registry';
import { BrowserToolError } from './lifecycle';
import type { OllamaClient } from '../../../background/ollama';

/** Minimum screenshot width required for reliable vision model output. */
const MIN_VISION_WIDTH_PX = 1200;

const visionGroundArgs = z.object({
  dataUri: z.string().min(20, 'dataUri too short — not a valid screenshot'),
  question: z.string().min(1).optional(),
  widthPx: z.number().int().positive().optional(),
});

const visionGroundOutput = z.object({
  assessment: z.string(),
  confirmed: z.boolean(),
});

/**
 * Create a ToolHandler that verifies page state via a vision model.
 *
 * The tool sends a screenshot (as a data URI) to the local Ollama model with
 * an optional verification question. It rejects images below the minimum width
 * threshold (1200 px) with a non-fatal error, since smaller images cause
 * reliable hallucination rather than refusal.
 *
 * @param client - OllamaClient reference used to make the chat request.
 * @param model - The Ollama model name to use for vision inference.
 */
export function createVisionGroundTool(
  client: OllamaClient,
  model: string,
): ToolHandler<z.infer<typeof visionGroundArgs>, z.infer<typeof visionGroundOutput>> {
  return {
    name: 'vision.ground',
    description:
      'Send a screenshot to the local vision model and return a verification assessment. ' +
      'Use this to verify that extracted ARIA data matches the actual visible page state. ' +
      'Always provide widthPx when available; images < 1200 px wide will be rejected.',
    argsSchema: visionGroundArgs,
    outputSchema: visionGroundOutput,
    parametersJSON: {
      type: 'object',
      properties: {
        dataUri: {
          type: 'string',
          description: 'Data URI of a PNG screenshot from tab.screenshot.',
        },
        question: {
          type: 'string',
          description: 'Optional verification question. Defaults to general description.',
        },
        widthPx: {
          type: 'integer',
          description: 'Width of the source screenshot in pixels.',
        },
      },
      required: ['dataUri'],
    },
    execute: async (args) => {
      // Reject images below the minimum width — the model hallucinates
      // instead of refusing on small images.
      if (args.widthPx !== undefined && args.widthPx < MIN_VISION_WIDTH_PX) {
        throw new BrowserToolError(
          `vision.ground: image width ${args.widthPx}px < minimum ${MIN_VISION_WIDTH_PX}px`,
          { fatal: false },
        );
      }

      const question =
        args.question ??
        'Describe the page contents briefly. What elements are visible and what are their states?';

      const result = await client.chatOnce({
        model,
        messages: [{ role: 'user', content: question, images: [args.dataUri] }],
        timeoutMs: 120_000,
        think: false,
      });

      const assessment = result.message?.content ?? '';
      // Treat a meaningful response length as "confirmed"; empty or trivial
      // one-word responses mean the model couldn't extract anything useful.
      const confirmed = assessment.length > 20;

      return { assessment, confirmed };
    },
  };
}
