import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const routerDocs = join(process.cwd(), 'docs/router');

describe('coding pools PostHog dashboard artifact', () => {
  it('covers station activity, per-pool rho, and time-to-green', () => {
    const contract = JSON.parse(readFileSync(join(routerDocs, 'posthog-coding-pools.json'), 'utf8')) as {
      events: Record<string, { event: string }>;
    };
    const dashboard = JSON.parse(readFileSync(join(routerDocs, 'posthog-coding-pools-dashboard.json'), 'utf8')) as {
      tiles: Array<{ title: string; query: { source: { event: string; select: string[]; properties: Array<{ key: string; value: string }> } } }>;
    };
    const events = new Set(Object.values(contract.events).map(({ event }) => event));

    expect(dashboard.tiles.map(({ title }) => title)).toEqual([
      'Station dispatches', 'Per-pool rho', 'Time-to-green (median seconds)',
    ]);
    for (const tile of dashboard.tiles) expect(events.has(tile.query.source.event)).toBe(true);
    expect(dashboard.tiles[0]?.query.source.select).toContain('properties.station_id');
    expect(dashboard.tiles[1]?.query.source.select).toContain('properties.pool_id');
    expect(dashboard.tiles[2]?.query.source.properties).toContainEqual({ key: 'status', value: 'green', operator: 'exact' });
  });
});
