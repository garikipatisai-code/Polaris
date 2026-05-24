// IndexedDB schema and connection for Polaris agent state.
//
// Schema version 1. Stores:
//   scratchpad  — FIFO ring per task; primary key [taskId, seq]
//   findings    — structured atomic facts; primary key id (ULID)
//   memory      — agent-controlled namespaced cells; key [taskId, namespace, key]
//   events      — audit log for UI replay; primary key [taskId, seq]

import { openDB } from 'idb';
import type { IDBPDatabase, DBSchema } from 'idb';
import type {
  ScratchEntry,
  Finding,
  MemoryCell,
  AgentEvent,
} from '../shared/agent_types';

const DB_NAME = 'polaris';
const DB_VERSION = 1;

export interface PolarisDB extends DBSchema {
  scratchpad: {
    key: [string, number];
    value: ScratchEntry;
    indexes: { 'by-task': string };
  };
  findings: {
    key: string;
    value: Finding;
    indexes: {
      'by-task-ts': [string, number];
      'by-task-key': [string, string];
    };
  };
  memory: {
    key: [string, string, string];
    value: MemoryCell;
    indexes: { 'by-task-ns': [string, string] };
  };
  events: {
    key: [string, number];
    value: AgentEvent;
    indexes: { 'by-task': string };
  };
}

let dbPromise: Promise<IDBPDatabase<PolarisDB>> | null = null;

export function getDB(): Promise<IDBPDatabase<PolarisDB>> {
  if (!dbPromise) {
    dbPromise = openDB<PolarisDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('scratchpad')) {
          const s = db.createObjectStore('scratchpad', { keyPath: ['taskId', 'seq'] });
          s.createIndex('by-task', 'taskId');
        }
        if (!db.objectStoreNames.contains('findings')) {
          const f = db.createObjectStore('findings', { keyPath: 'id' });
          f.createIndex('by-task-ts', ['taskId', 'ts']);
          f.createIndex('by-task-key', ['taskId', 'key']);
        }
        if (!db.objectStoreNames.contains('memory')) {
          db.createObjectStore('memory', { keyPath: ['taskId', 'namespace', 'key'] })
            .createIndex('by-task-ns', ['taskId', 'namespace']);
        }
        if (!db.objectStoreNames.contains('events')) {
          db.createObjectStore('events', { keyPath: ['taskId', 'seq'] })
            .createIndex('by-task', 'taskId');
        }
      },
    });
  }
  return dbPromise;
}

/** Wipe the entire database. Test / reset utility only. */
export async function dropDB(): Promise<void> {
  if (dbPromise) {
    (await dbPromise).close();
    dbPromise = null;
  }
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve(); // best effort
  });
}
