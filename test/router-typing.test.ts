import { describe, expect, it, vi } from 'vitest';
import type { AshlrConfig, WorkItem } from '../src/core/types.js';
import { defaultConfig } from '../src/core/config.js';
import { isSubstantiveItem, routeTask, routeTaskCascade } from '../src/core/run/router.js';

vi.mock('../src/core/fleet/quota.js', () => ({ withinLimit: () => true }));
vi.mock('../src/core/fleet/subscription-usage.js', () => ({
  subscriptionAllows: () => ({ allowed: true }),
}));

const item: WorkItem = {
  id: 'scope-boundary', repo: '/mock/repo', source: 'todo', title: 'Small task',
  detail: '', value: 2, effort: 1, score: 2, tags: [], ts: '2026-10-26T00:00:00Z',
};
const ctx = { availableEngines: ['builtin'] } satisfies Parameters<typeof routeTask>[2];

describe('optional router enrichments', () => {
  it.each([
    [undefined, false],
    [{}, false],
    [{ fileCount: 5, symbolCount: 20 }, false],
    [{ fileCount: 6 }, true],
    [{ symbolCount: 21 }, true],
  ] as const)('preserves scope thresholds for %j', (localizedScope, substantive) => {
    const enriched = { ...item, localizedScope };
    const foundry = { ...defaultConfig().foundry, cascade: true };
    const cfg: AshlrConfig = { ...defaultConfig(), foundry };
    expect(isSubstantiveItem(enriched)).toBe(substantive);
    expect(routeTaskCascade(enriched, cfg, ctx).cheapFirst).toBe(!substantive);
  });

  it.each([undefined, false] as const)('preserves base routing with cascade %s', cascade => {
    const foundry = { ...defaultConfig().foundry, cascade, routingPolicy: 'cost' as const };
    const cfg: AshlrConfig = { ...defaultConfig(), foundry };
    expect(routeTaskCascade(item, cfg, ctx)).toEqual({
      ...routeTask(item, cfg, ctx), attempt: 1, cheapFirst: false, tierLabel: 'local',
    });
  });
});
