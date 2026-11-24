import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/core/run/engines.js', () => ({
  engineInstalled: vi.fn(() => true),
  engineTierOf: () => 'frontier',
}));
vi.mock('../src/core/run/sandboxed-engine.js', () => ({ engineTierOf: () => 'frontier' }));
vi.mock('../src/core/fleet/quota.js', () => ({ withinLimit: () => true, evalQuota: () => 'ok', recordUse: vi.fn() }));
vi.mock('../src/core/fleet/subscription-usage.js', () => ({
  subscriptionAllows: () => ({ allowed: true, reason: 'test' }),
  isSubscriptionEngine: () => true,
  subscriptionUsage: () => null,
}));

import type { AshlrConfig, WorkItem } from '../src/core/types.js';
import { claude5ExcludeIds } from '../src/core/run/model-catalog.js';
import { routeTask } from '../src/core/run/router.js';

const item = { id: 'cap-test', repo: '/tmp', title: 'test', detail: 'test', source: 'issue',
  value: 3, effort: 3, score: 6, tags: [], ts: '2026-01-01T00:00:00Z' } as WorkItem;
const config = { version: 1, roots: ['/tmp'], editor: { name: 'vscode' },
  models: { providerChain: ['ollama'], routing: [] },
  foundry: { allowedBackends: ['claude', 'builtin'], routingPolicy: 'quality' } } as unknown as AshlrConfig;
const context = { availableEngines: ['claude', 'builtin'] } as Parameters<typeof routeTask>[2];

describe('observed model cap routing', () => {
  it('excludes Fable and selects an existing Claude fallback', () => {
    expect(claude5ExcludeIds(config, ['fable']).has('claude:claude-fable-5-1')).toBe(true);
    const result = routeTask(item, config, { ...context, cappedModels: ['fable'] });
    expect(result.engine).toBe('claude');
    expect(result.model).toBe('claude-opus-5-5');
    expect(result.reason).toContain('Fable skipped: observed model cap');
  });
  it('preserves Fable without a cap or with an unrelated cap', () => {
    expect(routeTask(item, config, context).model).toBe('claude-fable-5-1');
    expect(routeTask(item, config, { ...context, cappedModels: ['other'] }).model).toBe('claude-fable-5-1');
  });
  it('respects the Fable opt-out', () => {
    const disabled = { ...config, foundry: { ...config.foundry, claude5: { fable: false } } } as AshlrConfig;
    expect(routeTask(item, disabled, { ...context, cappedModels: ['fable'] }).model).toBe('claude-opus-5-5');
  });
  it('does not enable an unavailable or disallowed engine', () => {
    const disabled = { ...config, foundry: { ...config.foundry, allowedBackends: ['builtin'] } } as AshlrConfig;
    expect(routeTask(item, disabled, { availableEngines: ['builtin'], cappedModels: ['fable'] }).engine).not.toBe('claude');
    expect(routeTask(item, config, { availableEngines: [], cappedModels: ['fable'] }).engine).toBe('builtin');
  });
});
