import { describe, it, expect } from 'vitest';
import { buildProviders } from '../src/background/providers';
import { DEFAULT_SETTINGS } from '../src/shared/messages';
import { OllamaClient } from '../src/background/ollama';
import { CloudClient } from '../src/background/cloud_client';

const local = new OllamaClient('http://localhost:11434');

describe('buildProviders', () => {
  it('defaults to e4b for all roles with no per-role overrides', () => {
    const p = buildProviders(DEFAULT_SETTINGS, local);
    expect(p.defaultProvider.model).toBe('gemma4:e4b');
    expect(p.plannerProvider).toBeUndefined();
    expect(p.evaluatorProvider).toBeUndefined();
    expect(p.executorProvider).toBeUndefined();
    expect(p.compactorProvider).toBeUndefined();
  });

  it('explicit 26B override gets a raised timeout + num_predict', () => {
    const settings = { ...DEFAULT_SETTINGS, roleModels: { planner: 'gemma4:26b', evaluator: 'gemma4:26b' } };
    const p = buildProviders(settings, local);
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
    const settings = { ...DEFAULT_SETTINGS, roleModels: { executor: 'gemma4:e4b' } };
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
