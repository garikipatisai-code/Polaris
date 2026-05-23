import { DEFAULT_SETTINGS, Settings } from '../shared/messages';

const KEY = 'polaris.settings';

export async function getSettings(): Promise<Settings> {
  const result = await chrome.storage.local.get(KEY);
  const stored = (result[KEY] ?? {}) as Partial<Settings>;
  return { ...DEFAULT_SETTINGS, ...stored };
}

export async function setSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await getSettings();
  const next: Settings = { ...current, ...patch };
  await chrome.storage.local.set({ [KEY]: next });
  return next;
}
