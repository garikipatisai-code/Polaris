import { describe, it, expect } from 'vitest';
import { buildProviders } from '../src/background/providers';
import { DEFAULT_SETTINGS } from '../src/shared/messages';
import { OllamaClient } from '../src/background/ollama';
import { CloudClient } from '../src/background/cloud_client';

const local = new OllamaClient('http://localhost:11434');

describe('buildProviders', () => {
  it('locked defaults route reasoning roles to the 35B local override', () => {
    const p = buildProviders(DEFAULT_SETTINGS, local);
    expect(p.defaultProvider.model).toBe('qwen3.5:4b');
    expect(p.plannerProvider?.model).toBe('qwen3.6:35b-a3b');
    expect(p.evaluatorProvider?.model).toBe('qwen3.6:35b-a3b');
    expect(p.executorProvider).toBeUndefined();
    expect(p.compactorProvider).toBeUndefined();
    expect(p.plannerProvider?.client).toBe(local);
  });

  it('35B reasoning roles get a raised timeout + num_predict', () => {
    const p = buildProviders(DEFAULT_SETTINGS, local);
    expect(p.plannerProvider?.timeoutMs).toBeGreaterThanOrEqual(25 * 60 * 1000);
    expect(p.evaluatorProvider?.timeoutMs).toBeGreaterThanOrEqual(12 * 60 * 1000);
    expect(p.plannerProvider?.numPredict).toBeGreaterThanOrEqual(2048);
    expect(p.evaluatorProvider?.numPredict).toBeGreaterThanOrEqual(2048);
  });

  it('cloud config takes precedence over a local override', () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      cloud: { planner: { baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk', model: 'deepseek-chat' } },
    };
    const p = buildProviders(settings, local);
    expect(p.plannerProvider?.client).toBeInstanceOf(CloudClient);
    expect(p.plannerProvider?.model).toBe('deepseek-chat');
    expect(p.plannerProvider?.timeoutMs).toBeLessThanOrEqual(120000);
  });

  it('an override equal to the default model is treated as no override', () => {
    const settings = { ...DEFAULT_SETTINGS, roleModels: { executor: 'qwen3.5:4b' } };
    const p = buildProviders(settings, local);
    expect(p.executorProvider).toBeUndefined();
  });

  it('zero cloud config => fully local, no CloudClient anywhere', () => {
    const p = buildProviders(DEFAULT_SETTINGS, local);
    for (const prov of [p.defaultProvider, p.plannerProvider, p.evaluatorProvider]) {
      expect(prov?.client).not.toBeInstanceOf(CloudClient);
    }
  });
});
