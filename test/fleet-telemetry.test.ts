import { describe, expect, it, vi } from 'vitest';
import { buildCodingFleetSnapshot } from '../src/core/fleet/coding-snapshot.js';
import { emitFleetTelemetry, fleetTelemetryEvents } from '../src/core/fleet/coding-telemetry.js';

describe('opt-in fleet measurements', () => {
  it('emits no events unless explicitly enabled and carries no private text or invented dollar value', async () => {
    const snapshot = await buildCodingFleetSnapshot({ fetchGithub: false, path: '/missing-fleet-telemetry-fixture.json', home: '/missing-fleet-telemetry-home', nowMs: Date.parse('2026-10-26T12:00:00Z') });
    snapshot.agents = [{ agent: 'private-agent', repo: 'private-repo', task: 'private-task-canary', claim_id: null, expires_at: null }];
    const sink = vi.fn();
    expect(emitFleetTelemetry(snapshot, { enabled: false, host: null, apiKey: null }, sink)).toBe(0);
    expect(sink).not.toHaveBeenCalled();
    expect(emitFleetTelemetry(snapshot, { enabled: true, host: null, apiKey: null })).toBe(0);
    expect(emitFleetTelemetry(snapshot, { enabled: true, host: 'http://example.com', apiKey: 'private-api-canary' })).toBe(0);
    expect(emitFleetTelemetry(snapshot, { enabled: true, host: null, apiKey: null }, sink)).toBeGreaterThan(0);
    const events = fleetTelemetryEvents(snapshot);
    expect(new Set(events.map(event => event.event))).toEqual(new Set(['phantom_pool_burndown', 'phantom_grok_ultra_runway', 'phantom_pool_value_per_dollar']));
    expect(JSON.stringify(events)).not.toContain('private-');
    const unknown = events.find(event => event.event === 'phantom_pool_burndown' && event.properties.pool_id === 'codex-cmp');
    expect(unknown?.properties.used_fraction).toBeNull();
    expect(events.filter(event => event.event === 'phantom_pool_value_per_dollar').every(event => event.properties.value_per_dollar === null)).toBe(true);
  });
});
