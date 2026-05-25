// Domain tier system — per-host trust hierarchy gating page actions.
//
// Three tiers in increasing trust:
//   read-only    — agent can navigate, extract ARIA, screenshot, etc.
//                   but CANNOT click, type, or otherwise mutate the page.
//                   Default for any unknown host. Safest baseline.
//   click-only   — agent can additionally click (navigate, scroll-into-view,
//                   submit forms with no inputs). NO typing.
//   full-action  — agent can click + type + select. Effectively "the user
//                   has explicitly trusted this domain to handle their
//                   keystrokes." Highest trust; opt-in only.
//
// Storage: `chrome.storage.local` under `polaris.domain_tiers`, a flat map
// from `host` (e.g., "amazon.com") to tier. The hostname normalization
// strips `www.` so user-friendly settings work; subdomains are NOT
// inherited (`shop.amazon.com` is distinct from `amazon.com` unless the
// user adds it). This is intentional — different subdomains may be run by
// different teams with different trust profiles.
//
// `assertCanAct` is the gate point M4 page-action tools call before
// dispatching. Insufficient tier throws `BrowserToolError(fatal: false)`
// so the model can react (e.g., explain to the user why it stopped).

import { BrowserToolError } from './tools/browser/lifecycle';

export type DomainTier = 'read-only' | 'click-only' | 'full-action';

const TIER_RANK: Record<DomainTier, number> = {
  'read-only': 0,
  'click-only': 1,
  'full-action': 2,
};

const STORAGE_KEY = 'polaris.domain_tiers';
const DEFAULT_TIER: DomainTier = 'read-only';

/**
 * Extract the canonical host from a URL. Strips `www.` prefix so users see
 * "amazon.com" not "www.amazon.com" in their tier settings. Throws if the
 * URL doesn't parse — caller should treat that as fatal (the tools that
 * call this already validate URLs at their argsSchema layer).
 */
export function canonicalHost(url: string): string {
  const u = new URL(url);
  return u.host.replace(/^www\./i, '');
}

/** Return the tier configured for the given URL, or the default. */
export async function getDomainTier(url: string): Promise<DomainTier> {
  let host: string;
  try {
    host = canonicalHost(url);
  } catch {
    return DEFAULT_TIER;
  }
  const out = await chrome.storage.local.get(STORAGE_KEY);
  const map = (out[STORAGE_KEY] ?? {}) as Record<string, DomainTier>;
  return map[host] ?? DEFAULT_TIER;
}

/**
 * Set the tier for a host. Pass the host directly (not a URL) — settings
 * UI knows the host. Removing a host's entry (revert to default) is done
 * by passing `null` as the tier.
 */
export async function setDomainTier(
  host: string,
  tier: DomainTier | null,
): Promise<void> {
  const normalized = host.replace(/^www\./i, '');
  const out = await chrome.storage.local.get(STORAGE_KEY);
  const map = (out[STORAGE_KEY] ?? {}) as Record<string, DomainTier>;
  if (tier === null) {
    delete map[normalized];
  } else {
    map[normalized] = tier;
  }
  await chrome.storage.local.set({ [STORAGE_KEY]: map });
}

/** Read all configured tiers (for the settings UI). */
export async function listDomainTiers(): Promise<Record<string, DomainTier>> {
  const out = await chrome.storage.local.get(STORAGE_KEY);
  return (out[STORAGE_KEY] ?? {}) as Record<string, DomainTier>;
}

/**
 * Test/debug only — wipe the tier map.
 * Production callers go through setDomainTier individually.
 */
export async function _resetDomainTiers(): Promise<void> {
  await chrome.storage.local.remove(STORAGE_KEY);
}

/**
 * Gate point for M4 page-action tools. Throws a non-fatal BrowserToolError
 * if the URL's domain is below the required tier. Tools call this before
 * dispatching any DOM-mutating CDP command.
 *
 * Non-fatal so the model can react: it'll see "domain X is read-only,
 * cannot click" and either ask the user to upgrade or pick a different
 * approach. Fatal would abort the task, which is too aggressive for a
 * normal capability negotiation.
 */
export async function assertCanAct(
  url: string,
  required: 'click-only' | 'full-action',
): Promise<void> {
  const tier = await getDomainTier(url);
  if (TIER_RANK[tier] < TIER_RANK[required]) {
    let host: string;
    try {
      host = canonicalHost(url);
    } catch {
      host = url;
    }
    throw new BrowserToolError(
      `domain "${host}" is set to "${tier}" tier; this action requires "${required}". ` +
        `User must upgrade the tier in Polaris settings before the agent can ${
          required === 'full-action' ? 'type' : 'click'
        } here.`,
      { fatal: false },
    );
  }
}
