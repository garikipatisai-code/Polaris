// Test setup: install browser-shaped globals (chrome.storage.local in-memory,
// IndexedDB via fake-indexeddb) so backend modules that touch persistence
// can be exercised in Node. Loaded by vitest before each test file.

import 'fake-indexeddb/auto';
import { dropDB } from '../src/agent/idb';

// In-memory chrome.storage.local mock. Only the surface state_store uses.
const memoryStore = new Map<string, unknown>();

interface StorageGetResult {
  [key: string]: unknown;
}

const localStorage = {
  async get(keys?: string | string[] | null): Promise<StorageGetResult> {
    if (keys == null) {
      const out: StorageGetResult = {};
      for (const [k, v] of memoryStore) out[k] = v;
      return out;
    }
    if (typeof keys === 'string') {
      return memoryStore.has(keys) ? { [keys]: memoryStore.get(keys) } : {};
    }
    const out: StorageGetResult = {};
    for (const k of keys) if (memoryStore.has(k)) out[k] = memoryStore.get(k);
    return out;
  },
  async set(items: Record<string, unknown>): Promise<void> {
    for (const [k, v] of Object.entries(items)) memoryStore.set(k, v);
  },
  async remove(keys: string | string[]): Promise<void> {
    const ks = typeof keys === 'string' ? [keys] : keys;
    for (const k of ks) memoryStore.delete(k);
  },
  async clear(): Promise<void> {
    memoryStore.clear();
  },
};

(globalThis as unknown as { chrome: unknown }).chrome = {
  storage: { local: localStorage },
  runtime: {
    lastError: null,
  },
};

/**
 * Reset all mocked persistent state between tests.
 *
 * `dropDB()` from idb.ts both closes the cached connection AND deletes the
 * database, so the next test starts with a fresh `getDB()` open. Without
 * the cache reset, subsequent tests would reuse a connection to a deleted
 * database and hang.
 */
export async function resetMockedStorage(): Promise<void> {
  memoryStore.clear();
  await dropDB();
}

// crypto.getRandomValues is required by ulid; Node 19+ exposes globalThis.crypto.
if (typeof globalThis.crypto?.getRandomValues !== 'function') {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { webcrypto } = require('node:crypto');
  Object.defineProperty(globalThis, 'crypto', {
    value: webcrypto,
    configurable: true,
  });
}

// performance.now polyfill (already global in modern Node).
if (typeof globalThis.performance?.now !== 'function') {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { performance: nodePerf } = require('node:perf_hooks');
  Object.defineProperty(globalThis, 'performance', {
    value: nodePerf,
    configurable: true,
  });
}
