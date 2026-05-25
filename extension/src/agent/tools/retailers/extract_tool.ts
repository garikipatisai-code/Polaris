// product.extract — bridge tool wiring the M3 ARIA extractor into the
// retailer adapter framework. The agent calls `product.extract({tabId})`,
// which:
//   1. Resolves the tab's current URL (chrome.tabs.get).
//   2. Looks up a matching retailer adapter via findAdapter(url). If none
//      matches, returns { product: null, retailer: null, reason } so the
//      model can fall back to a generic ARIA pass.
//   3. Calls aria.extract internally to get the SimplifiedNode tree.
//   4. Delegates to the adapter's extract() to produce a ProductRecord.
//
// Why a separate tool rather than calling extractProduct from aria.extract?
// Three reasons:
//   - Keeps aria.extract single-purpose (page → tree). The agent sometimes
//     wants the tree without product-level interpretation.
//   - Lets the agent decide whether the cost of a retailer parse is worth
//     it (e.g., on category pages it isn't).
//   - Makes the adapter framework a real consumer rather than dead code
//     (arch-nemesis #7 caught the framework was unwired in M3 backend).

import { z } from 'zod';
import type { ToolHandler } from '../registry';
import { BrowserToolError, withBrowserTimeout } from '../browser/lifecycle';
import { ariaExtractTool } from '../browser/aria';
import type { SimplifiedNode } from '../browser/aria_types';
import { findAdapter, extractProduct } from './index';
import type { ProductRecord } from './types';

const argsSchema = z.object({
  tabId: z.number().int().positive(),
});

const productRecordSchema: z.ZodType<ProductRecord> = z.object({
  retailer: z.string(),
  url: z.string().optional(),
  title: z.string(),
  priceCents: z.number().int().optional(),
  currency: z.string().optional(),
  inStock: z.boolean().optional(),
  shippingCents: z.number().int().optional(),
  rating: z
    .object({ score: z.number(), count: z.number().int() })
    .optional(),
  asin: z.string().optional(),
  sku: z.string().optional(),
  imageUrl: z.string().optional(),
  features: z.array(z.string()).max(10).optional(),
});

const outputSchema = z.object({
  product: productRecordSchema.nullable(),
  retailer: z.string().nullable(),
  /** Diagnostic — non-null when product is null so the model can react. */
  reason: z.string().optional(),
});

type ProductExtractArgs = z.infer<typeof argsSchema>;
type ProductExtractOutput = z.infer<typeof outputSchema>;

async function getTabUrl(tabId: number): Promise<string> {
  const chromeApi = (
    globalThis as unknown as { chrome?: { tabs?: typeof chrome.tabs } }
  ).chrome?.tabs;
  if (!chromeApi) {
    throw new BrowserToolError('chrome.tabs unavailable', { fatal: true });
  }
  const tab = await chromeApi.get(tabId);
  if (!tab.url) {
    throw new BrowserToolError('tab has no resolvable URL yet', { fatal: false });
  }
  return tab.url;
}

export const productExtractTool: ToolHandler<ProductExtractArgs, ProductExtractOutput> = {
  name: 'product.extract',
  description:
    'Extract a structured product record from a tab on a known retailer (e.g., Amazon). Returns the product fields (title, price, in-stock, rating, features) when the URL matches a registered retailer adapter, otherwise returns product:null with a diagnostic reason.',
  argsSchema,
  outputSchema,
  parametersJSON: {
    type: 'object',
    properties: {
      tabId: {
        type: 'integer',
        minimum: 1,
        description: 'Chrome tab id (positive integer).',
      },
    },
    required: ['tabId'],
  },
  execute: async (args, ctx) =>
    withBrowserTimeout(
      async () => {
        const url = await getTabUrl(args.tabId);
        const adapter = findAdapter(url);
        if (!adapter) {
          return {
            product: null,
            retailer: null,
            reason: `no retailer adapter matches ${new URL(url).host}`,
          };
        }
        // Reuse aria.extract — its retry / timeout / fatal-categorization
        // behaviour is already correct, no need to duplicate.
        const ariaResult = await ariaExtractTool.execute({ tabId: args.tabId }, ctx);
        const tree: SimplifiedNode | null = ariaResult.tree;
        if (!tree) {
          return {
            product: null,
            retailer: adapter.name,
            reason: 'aria.extract returned null tree',
          };
        }
        const product = extractProduct(tree, url);
        if (!product) {
          return {
            product: null,
            retailer: adapter.name,
            reason: `${adapter.name} adapter could not extract a product (likely not a product page)`,
          };
        }
        return { product, retailer: adapter.name };
      },
      35_000,
      'product.extract',
    ),
};
