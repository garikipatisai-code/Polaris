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

/** Vision inference timeout — image tokens are large and need generous room. */
const VISION_TIMEOUT_MS = 120_000;

/** Regex for validating PNG base64 data URIs. */
const DATA_URI_PNG_RE = /^data:image\/png;base64,[A-Za-z0-9+/=]+$/;

/**
 * Cross-tool screenshot cache. `tab.screenshot` writes the last data URI per
 * tabId here; `vision.ground` can read by tabId instead of requiring the model
 * to reproduce the full data URI (which is too large for small models to handle
 * reliably in tool call arguments).
 */
const screenshotCache = new Map<number, string>();

/** Store a data URI for a tabId (called by tab.screenshot). */
export function cacheScreenshot(tabId: number, dataUri: string): void {
  screenshotCache.set(tabId, dataUri);
  // Cap cache size at 5 entries to avoid unbounded memory growth
  if (screenshotCache.size > 5) {
    const first = screenshotCache.keys().next().value;
    if (first !== undefined) screenshotCache.delete(first);
  }
}

export const visionGroundArgs = z.object({
  dataUri: z.string().regex(DATA_URI_PNG_RE, 'dataUri must be a base64-encoded PNG data URI').optional(),
  tabId: z.number().int().optional(),
  question: z.string().min(1).optional(),
  widthPx: z.number().int().positive().optional(),
}).refine(
  (d) => d.dataUri !== undefined || d.tabId !== undefined,
  { message: 'must provide either dataUri (direct) or tabId (lookup from last screenshot)' },
);

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
      'Verify page content using the vision model. IMPORTANT: after taking a screenshot with ' +
      'tab.screenshot, call this with tabId (NOT the dataUri string — it is too long to repeat). ' +
      'Example: vision.ground({tabId: 42}). Images < 1200 px wide will be rejected.',
    argsSchema: visionGroundArgs,
    outputSchema: visionGroundOutput,
    parametersJSON: {
      type: 'object',
      properties: {
        dataUri: {
          type: 'string',
          description: 'DEPRECATED — do not use. Use tabId instead.',
        },
        question: {
          type: 'string',
          description: 'Optional verification question. Defaults to "Is the search bar visible?".',
        },
        tabId: {
          type: 'integer',
          description: 'Tab id from tab.screenshot. PREFERRED — the screenshot is cached internally, no need to repeat the data URI.',
        },
        widthPx: {
          type: 'integer',
          description: 'Width of the source screenshot in pixels.',
        },
      },
    },
    execute: async (args) => {
      // Resolve data URI: either from direct arg or from tabId cache
      const dataUri = args.dataUri ?? (args.tabId !== undefined ? screenshotCache.get(args.tabId) : undefined);
      if (!dataUri || !DATA_URI_PNG_RE.test(dataUri)) {
        throw new BrowserToolError(
          `vision.ground: no valid screenshot available${args.tabId !== undefined ? ` for tab ${args.tabId} — call tab.screenshot first` : ''}`,
          { fatal: false },
        );
      }

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
        'Describe the page contents in 1-2 sentences. What elements are visible?';

      const result = await client.chatOnce({
        model,
        messages: [{ role: 'user', content: question, images: [dataUri!] }],
        timeoutMs: VISION_TIMEOUT_MS,
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
