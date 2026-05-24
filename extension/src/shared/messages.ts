// Shared protocol between the side panel UI and the background service worker.

export interface Settings {
  ollamaBaseUrl: string;
  model: string;
  embeddingModel: string;
  enableThinking: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  ollamaBaseUrl: 'http://localhost:11434',
  model: 'qwen3.5:4b',
  embeddingModel: 'mxbai-embed-large',
  enableThinking: false,
};

export interface ChatStats {
  promptTokens?: number;
  genTokens?: number;
  tokPerSec?: number;
  wallMs?: number;
}

// Side panel → service worker
export type RequestMessage =
  | { type: 'chat.start'; userText: string; goal?: string }
  | { type: 'chat.abort' }
  | { type: 'settings.get' }
  | { type: 'settings.set'; settings: Partial<Settings> }
  | { type: 'ollama.ping' };

// Service worker → side panel
export type ResponseMessage =
  | { type: 'chat.chunk'; content: string }
  | { type: 'chat.complete'; stats?: ChatStats }
  | { type: 'chat.error'; message: string }
  | { type: 'chat.status'; status: 'warming'; message: string }
  | { type: 'settings.value'; settings: Settings }
  | { type: 'ollama.ping.result'; ok: boolean; error?: string; models?: string[] };

export const PORT_NAME = 'polaris.sidepanel';
