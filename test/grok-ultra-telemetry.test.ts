import { describe, expect, it, vi } from 'vitest';
import { buildGrokUltraRunway } from '../src/core/fleet/grok-ultra-runway.js';
import { emitGrokUltraRunway } from '../src/core/fleet/grok-ultra-telemetry.js';
import type { GrokUltraRunway } from '../src/core/fleet/grok-ultra-types.js';

const NOW = Date.parse('2026-10-26T12:00:00.000Z');
const ENV = { PHANTOM_POSTHOG_PROJECT_KEY: 'phc_inert_fixture_key' };
function runway(): GrokUltraRunway {
  return buildGrokUltraRunway([
    { source: 'manual', timestamp: '2026-10-25T12:00:00.000Z', remainingPoints: 2_000, totalPoints: 10_000 },
    { source: 'manual', timestamp: '2026-10-26T12:00:00.000Z', remainingPoints: 1_000, totalPoints: 10_000 },
  ], NOW);
}
function transport(status = 200) {
  return vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status }));
}
function sentBody(request: ReturnType<typeof transport>): Record<string, unknown> {
  return JSON.parse(String(request.mock.calls[0]![1]!.body));
}

describe('Grok Ultra usage-only PostHog emission', () => {
  it('does no network work when no project key is configured', async () => {
    const request = transport();
    expect(await emitGrokUltraRunway(runway(), {}, request)).toBe('disabled');
    expect(request).not.toHaveBeenCalled();
  });

  it('sends the named event to the default public ingestion host with a bounded, redirect-free request', async () => {
    const request = transport();
    const value = runway();
    expect(await emitGrokUltraRunway(value, ENV, request)).toBe('sent');
    expect(request).toHaveBeenCalledTimes(1);
    const [url, options] = request.mock.calls[0]!;
    expect(url).toBe('https://us.i.posthog.com/i/v0/e/');
    expect(options).toMatchObject({ method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' } });
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    expect(options?.signal?.aborted).toBe(false);
    const body = sentBody(request);
    expect(Object.keys(body).sort()).toEqual(['api_key', 'event', 'properties', 'timestamp', 'uuid']);
    expect(body).toMatchObject({ api_key: ENV.PHANTOM_POSTHOG_PROJECT_KEY,
      event: 'phantom_grok_ultra_runway', timestamp: value.latest!.timestamp });
    expect(body.uuid).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-8[a-f0-9]{3}-[a-f0-9]{12}$/);
    expect(body.properties).toEqual({
      distinct_id: 'phantom-fleet-grok-ultra', $process_person_profile: false,
      source: 'manual', observed_at: value.latest!.timestamp, target_at: value.targetAt,
      remaining_points: 1_000, total_points: 10_000, state: 'current', collection_mode: 'manual',
      burn_points_per_hour_h1: value.burnPointsPerHour.h1,
      burn_points_per_hour_h6: value.burnPointsPerHour.h6,
      burn_points_per_hour_h24: value.burnPointsPerHour.h24,
      projected_remaining_points_h1: value.projectedRemainingPoints.h1,
      projected_remaining_points_h6: value.projectedRemainingPoints.h6,
      projected_remaining_points_h24: value.projectedRemainingPoints.h24,
      ideal_points_per_hour: value.idealPointsPerHour,
    });
  });

  it('supports the explicit EU public ingestion host', async () => {
    const request = transport();
    expect(await emitGrokUltraRunway(runway(), { ...ENV, PHANTOM_POSTHOG_HOST: 'https://eu.i.posthog.com' }, request)).toBe('sent');
    expect(request.mock.calls[0]![0]).toBe('https://eu.i.posthog.com/i/v0/e/');
  });

  it.each([
    { PHANTOM_POSTHOG_PROJECT_KEY: 'phx_not_a_project_token' },
    { PHANTOM_POSTHOG_PROJECT_KEY: 'Bearer inert-fixture' },
    { ...ENV, PHANTOM_POSTHOG_HOST: 'http://us.i.posthog.com' },
    { ...ENV, PHANTOM_POSTHOG_HOST: 'https://us.i.posthog.com.evil.invalid' },
    { ...ENV, PHANTOM_POSTHOG_HOST: 'https://us.i.posthog.com/private/path' },
    { ...ENV, PHANTOM_POSTHOG_HOST: 'http://127.0.0.1:9000' },
  ])('refuses private credentials and non-allowlisted destinations before fetch %#', async (env) => {
    const request = transport();
    expect(await emitGrokUltraRunway(runway(), env, request)).toBe('failed');
    expect(request).not.toHaveBeenCalled();
  });

  it('emits no event without a valid latest reading', async () => {
    const request = transport();
    expect(await emitGrokUltraRunway(buildGrokUltraRunway([], NOW), ENV, request)).toBe('failed');
    expect(await emitGrokUltraRunway({ ...runway(), latest: { ...runway().latest!, token: 'PRIVATE_FIXTURE' } } as GrokUltraRunway, ENV, request))
      .toBe('failed');
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    { checkedAt: 'invalid' },
    { checkedAt: '' },
    { state: 'PRIVATE_FIXTURE_STATE' },
    { state: 'unavailable' },
  ])('fails closed before fetch for malformed timestamps or states %#', async (patch) => {
    const request = transport();
    const value = { ...runway(), ...patch } as GrokUltraRunway;
    expect(await emitGrokUltraRunway(value, ENV, request)).toBe('failed');
    expect(request).not.toHaveBeenCalled();
  });

  it('uses a property allowlist and never copies unrelated fleet metadata or environment credentials', async () => {
    const request = transport();
    const extended = { ...runway(), token: 'PRIVATE_FIXTURE_TOKEN', account: 'fixture@example.invalid',
      claims: ['PRIVATE_FIXTURE_CLAIM'], localPath: '/private/fixture-account', targetAt: 'PRIVATE_FIXTURE_TARGET',
      collection: { mode: 'manual', reason: 'PRIVATE_FIXTURE_REASON' } } as unknown as GrokUltraRunway;
    expect(await emitGrokUltraRunway(extended, { ...ENV, GROK_TOKEN: 'PRIVATE_FIXTURE_GROK_TOKEN' }, request)).toBe('sent');
    const body = sentBody(request);
    const publicProperties = JSON.stringify(body.properties);
    expect(publicProperties).not.toMatch(/PRIVATE_FIXTURE|fixture@example|private\/fixture/);
    expect(publicProperties).not.toContain(ENV.PHANTOM_POSTHOG_PROJECT_KEY);
    expect((body.properties as Record<string, unknown>).target_at).toBe(runway().targetAt);
  });

  it('withholds non-finite telemetry values instead of serializing invalid numeric evidence', async () => {
    const request = transport();
    const value = runway();
    value.burnPointsPerHour.h1 = NaN;
    value.projectedRemainingPoints.h24 = Infinity;
    expect(await emitGrokUltraRunway(value, ENV, request)).toBe('sent');
    expect(sentBody(request).properties).toMatchObject({ burn_points_per_hour_h1: null,
      projected_remaining_points_h24: null });
  });

  it('has a stable event UUID for retries and a different UUID for a new observation', async () => {
    const request = transport();
    await emitGrokUltraRunway(runway(), ENV, request);
    const first = sentBody(request).uuid;
    request.mockClear();
    await emitGrokUltraRunway(runway(), ENV, request);
    expect(sentBody(request).uuid).toBe(first);
    request.mockClear();
    const next = runway();
    next.latest = { ...next.latest!, remainingPoints: 999 };
    await emitGrokUltraRunway(next, ENV, request);
    expect(sentBody(request).uuid).not.toBe(first);
  });

  it.each([400, 429, 500])('reports HTTP %s as failed without retrying the reading', async (status) => {
    const request = transport(status);
    expect(await emitGrokUltraRunway(runway(), ENV, request)).toBe('failed');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('reports transport failure without exposing error text or retrying', async () => {
    const request = vi.fn<typeof fetch>().mockRejectedValue(new Error('PRIVATE_FIXTURE_ERROR'));
    expect(await emitGrokUltraRunway(runway(), ENV, request)).toBe('failed');
    expect(request).toHaveBeenCalledTimes(1);
  });
});
