import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateBusEnvelope } from '../src/core/fleet/bus-envelope.js';
import {
  WASTE_INCIDENT_BUS_KIND, buildWasteIncidentEnvelope, planWasteIncidents, postWasteIncidents,
} from '../src/core/fleet/waste-incident.js';
import { cmdFleetWasteIncident } from '../src/cli/fleet-waste-incident.js';
import type { WasteRiskInput, WasteRiskProjection } from '../src/core/resources/waste-risk.js';

const base = Date.parse('2026-10-31T12:37:00Z');
const HOUR_MS = 60 * 60 * 1000;

const row = (lane: string, over: Partial<WasteRiskProjection> = {}): WasteRiskProjection => ({
  lane, reset_at: '2026-10-31T22:07:00Z', hours_to_reset: 9.54, window_remaining_fraction: 0.2,
  projected_used_at_reset: 58, projected_unused_at_reset: 42, waste_risk: 'high', recommended_target: 3, ...over,
});

/** Raw input that projects to 'high': 10 of 100 used, slow burn, 20 % of window left. */
const highInput = (lane: string): WasteRiskInput => ({
  lane, used: 10, limit: 100, window_start: '2026-10-31T00:00:00Z', reset_at: '2026-10-31T15:00:00Z',
  now: new Date(base).toISOString(), burn_per_hour: 1, running: 1, per_job_cost: 1, ceiling: 4,
});
const lowInput = (lane: string): WasteRiskInput => ({ ...highInput(lane), used: 99 });

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('planWasteIncidents', () => {
  it('plans only high rows with finite evidence', () => {
    const rows = [
      row('hot'), row('unk', { waste_risk: 'unknown' }), row('med', { waste_risk: 'medium' }),
      row('low', { waste_risk: 'low' }), row('nullproj', { projected_unused_at_reset: null }),
      row('nohours', { hours_to_reset: null }), row('past', { hours_to_reset: 0 }),
      row('nan', { projected_unused_at_reset: Number.NaN }),
    ];
    expect(planWasteIncidents(rows).map(r => r.lane)).toEqual(['hot']);
  });
});

describe('buildWasteIncidentEnvelope', () => {
  it('builds a valid P1 fleet envelope with rounded numbers', () => {
    const envelope = buildWasteIncidentEnvelope(row('codex-personal'), base);
    expect(validateBusEnvelope(envelope).ok).toBe(true);
    expect([envelope.from, envelope.to, envelope.priority]).toEqual(['fleet', 'all', 'P1']);
    expect(envelope.body).toMatchObject({
      kind: WASTE_INCIDENT_BUS_KIND, lane: 'codex-personal', projectedUnusedPct: 42, hoursToReset: 9.5,
      resetAt: '2026-10-31T22:07:00Z', recommendedTarget: 3,
      text: 'codex-personal: 42% projected unused at reset in 9.5 h',
    });
  });

  it('keeps the id stable inside an hour and changes it in the next', () => {
    const a = buildWasteIncidentEnvelope(row('x'), base).id;
    expect(buildWasteIncidentEnvelope(row('x'), base + 10 * 60_000).id).toBe(a);
    expect(buildWasteIncidentEnvelope(row('x'), base + HOUR_MS).id).not.toBe(a);
    expect(buildWasteIncidentEnvelope(row('y'), base).id).not.toBe(a);
  });

  it('clips the text to 200 characters', () => {
    const envelope = buildWasteIncidentEnvelope(row('l'.repeat(400)), base);
    expect((envelope.body as { text: string }).text).toHaveLength(200);
  });
});

describe('postWasteIncidents', () => {
  it('reports statuses and turns a throwing post into unavailable', () => {
    expect(postWasteIncidents([row('a'), row('b', { waste_risk: 'low' })], base, () => ({ status: 'full' })))
      .toEqual([{ lane: 'a', status: 'full' }]);
    expect(postWasteIncidents([row('a')], base, () => { throw new Error('offline'); }))
      .toEqual([{ lane: 'a', status: 'unavailable' }]);
  });
});

describe('cmdFleetWasteIncident', () => {
  const logSpy = () => vi.spyOn(console, 'log').mockImplementation(() => {});
  const lastLog = (): string => String(vi.mocked(console.log).mock.calls.at(-1)![0]);
  const read = async () => [highInput('fake-a'), lowInput('fake-b'), highInput('fake-c')];
  const okPost = () => vi.fn((_envelope: unknown, _options?: unknown) => ({ status: 'posted' as const, id: 'x', cursor: 1 }));

  it('dry run with --json lists planned lanes, posted is null, and posts nothing', async () => {
    logSpy();
    const post = okPost();
    expect(await cmdFleetWasteIncident(['--json'], { read, now: () => base, post })).toBe(0);
    const out = JSON.parse(lastLog());
    expect(out.schema).toBe('fleet.waste-incident.v1');
    expect(out.posted).toBeNull();
    expect(out.planned.map((p: { lane: string }) => p.lane)).toEqual(['fake-a', 'fake-c']);
    expect(post).not.toHaveBeenCalled();
  });

  it('--apply posts once per high lane into the given runs dir', async () => {
    logSpy();
    const dir = await mkdtemp(join(tmpdir(), 'waste-incident-'));
    dirs.push(dir);
    const post = okPost();
    expect(await cmdFleetWasteIncident(['--apply', '--json', '--runs-dir', dir], { read, now: () => base, post })).toBe(0);
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[0]![1]).toMatchObject({ root: dir });
    expect(JSON.parse(lastLog()).posted).toEqual([
      { lane: 'fake-a', status: 'posted' }, { lane: 'fake-c', status: 'posted' },
    ]);
  });

  it('prints usage on --help and -h with exit 0', async () => {
    const log = logSpy();
    expect(await cmdFleetWasteIncident(['--help'])).toBe(0);
    expect(await cmdFleetWasteIncident(['-h'])).toBe(0);
    expect(log).toHaveBeenCalledTimes(2);
  });

  it('exits 2 on an unknown flag or a relative --runs-dir', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdFleetWasteIncident(['--bogus'], { read })).toBe(2);
    expect(await cmdFleetWasteIncident(['--runs-dir', 'rel/dir'], { read })).toBe(2);
    expect(await cmdFleetWasteIncident(['--runs-dir'], { read })).toBe(2);
  });

  it('exits 1 with one stderr line when evidence is unavailable', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const post = okPost();
    const code = await cmdFleetWasteIncident(['--apply'], { read: async () => { throw new Error('nope'); }, post });
    expect(code).toBe(1);
    expect(err).toHaveBeenCalledTimes(1);
    expect(post).not.toHaveBeenCalled();
  });
});
