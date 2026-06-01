// page.extract — LLM-based page content extraction.
//
// Unlike product.extract (which uses retailer-specific adapters for known
// page formats), page.extract sends the current ARIA tree + a free-form
// question to the model and returns structured data. This works on any
// page — search results, listings, landing pages — without adapters.

import { z } from 'zod';
import type { ToolHandler } from '../registry';
import type { OllamaClient } from '../../../background/ollama';

const extractArgs = z.object({
  tabId: z.number().int(),
  question: z.string().min(1).max(500),
});

const extractOutput = z.object({
  answer: z.string(),
});

export interface ExtractToolOptions {
  client: OllamaClient;
  model: string;
}

export function createExtractTool(opts: ExtractToolOptions): ToolHandler<
  z.infer<typeof extractArgs>,
  z.infer<typeof extractOutput>
> {
  return {
    name: 'page.extract',
    description:
      'Extract information from the current page by asking a question about its content. ' +
      'Works on any page (search results, listings, articles) without adapters. ' +
      'Example: page.extract({tabId: 42, question: "List all products with prices"}). ' +
      'Returns an LLM-generated answer based on the page structure.',
    argsSchema: extractArgs,
    outputSchema: extractOutput,
    parametersJSON: {
      type: 'object',
      properties: {
        tabId: { type: 'integer', description: 'Tab id from tab.open or tab.list.' },
        question: { type: 'string', minLength: 1, maxLength: 500, description: 'Question about the page content.' },
      },
      required: ['tabId', 'question'],
    },
    execute: async (args) => {
      const { getCachedElements } = await import('./aria_types');
      const cached = getCachedElements(args.tabId);

      let pageDescription: string;
      if (cached && cached.length > 0) {
        pageDescription = JSON.stringify(cached.slice(0, 50));
      } else {
        const { ariaExtractTool } = await import('./aria');
        const result = await ariaExtractTool.execute({ tabId: args.tabId }, { taskId: '', stepId: '' });
        pageDescription = JSON.stringify(result.tree ?? '');
      }

      const response = await opts.client.chatOnce({
        model: opts.model,
        messages: [
          { role: 'system', content: 'You extract structured information from web page data. Answer the user\'s question based ONLY on the page content provided. If the information is not visible, say so.' },
          { role: 'user', content: `Page content:\n${pageDescription.slice(0, 8000)}\n\nQuestion: ${args.question}` },
        ],
        timeoutMs: 30_000,
        think: false,
      });

      return {
        answer: response.message?.content ?? 'Could not extract page content.',
      };
    },
  };
}
