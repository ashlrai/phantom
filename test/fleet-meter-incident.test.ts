import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateBusEnvelope, type BusEnvelope } from '../src/core/fleet/bus-envelope.js';
import { CHANNEL_BUS_TTL_MS } from '../src/core/fleet/channel-bus-publish.js';
import {
  METER_INCIDENT_BUS_KIND, buildMeterIncidentEnvelope, planMeterIncidents, postMeterIncidents,
} from '../src/core/fleet/meter-incident.js';
import { cmdFleetMeterIncident } from '../src/cli/fleet-meter-incident.js';
import { readMeterDrop, type MeterDropProvider, type MeterDropReport } from '../src/cli/fleet-meter-drop.js';
import type { LaneState, LaneTruthReaders, MeterSample } from '../src/cli/fleet-lane-truth.js';

const base = Date.parse('2026-10-31T12:37:00Z'); // inside the 12:00 clock hour
const HOUR_MS = 60 * 60 * 1000;

const lane = (name: string, running: number | null): LaneState =>
  ({ lane: name, target: 2, running, queued: 0, held: false });
const sample = (provider: string, usedPercent: number, sampledMs: number, window = 'secondary:10080'): MeterSample =>
  ({ provider, window, usedPercent, resetAt: '2026-11-06T12:00:00Z', sampledAt: new Date(sampledMs).toISOString() });
/** A meter pinned at 61 % for `minutes` before `nowMs` while `running` jobs run. */
const flatReaders = (nowMs: number, opts: { provider?: string; running?: number | null; minutes?: number; lastPercent?: number } = {}): LaneTruthReaders => {
  const provider = opts.provider ?? 'codex-personal';
  return {
    lanes: async () => [lane(provider, opts.running === undefined ? 12 : opts.running)],
    meters: async () => [
      sample(provider, 61, nowMs - (opts.minutes ?? 74) * 60_000),
      sample(provider, opts.lastPercent ?? 61, nowMs),
    ],
  };
};
const flatProvider = async (nowMs = base): Promise<MeterDropProvider> =>
  (await readMeterDrop(flatReaders(nowMs), nowMs)).providers[0]!;

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('buildMeterIncidentEnvelope', () => {
  it('builds a valid P1 broadcast carrying the widest window', async () => {
    const provider = await flatProvider();
    const envelope = buildMeterIncidentEnvelope(provider, base);
    expect(validateBusEnvelope(envelope).ok).toBe(true);
    expect(envelope).toMatchObject({
      from: 'fleet', to: 'all', priority: 'P1', ttl: CHANNEL_BUS_TTL_MS,
    });
    expect(envelope.id).toMatch(/^fleet-meter-flat-[0-9a-f]{16}$/);
    expect(envelope.body).toEqual({
      kind: METER_INCIDENT_BUS_KIND, provider: 'codex-personal', running: 12,
      observedMinutes: 74, firstUsedPercent: 61, lastUsedPercent: 61,
      text: 'codex-personal meter flat 74 min at 61% while 12 jobs run',
    });
  });

  it('keys the id on the floored clock hour so same-hour reruns dedupe', async () => {
    const provider = await flatProvider();
    const sameHour = buildMeterIncidentEnvelope(provider, base).id;
    expect(buildMeterIncidentEnvelope(provider, base + 20 * 60_000).id).toBe(sameHour);
    expect(buildMeterIncidentEnvelope(provider, base + HOUR_MS).id).not.toBe(sameHour);
    const other = await readMeterDrop(flatReaders(base, { provider: 'grok-ultra' }), base);
    expect(buildMeterIncidentEnvelope(other.providers[0]!, base).id).not.toBe(sameHour);
  });
});

describe('planMeterIncidents', () => {
  it('plans only flat_with_work providers', async () => {
    const report: MeterDropReport = await readMeterDrop({
      lanes: async () => [
        lane('codex-personal', 3), lane('claude-max', 0), lane('grok-ultra', 4), lane('terra', 5),
      ],
      meters: async () => [
        sample('codex-personal', 61, base - 74 * 60_000), sample('codex-personal', 61, base),
        sample('claude-max', 30, base - 74 * 60_000), sample('claude-max', 30, base),
        sample('grok-ultra', 40, base - 74 * 60_000), sample('grok-ultra', 44, base),
        sample('terra', 9, base - 74 * 60_000),
      ],
    }, base);
    expect(report.providers.map(row => [row.provider, row.verdict])).toEqual([
      ['codex-personal', 'flat_with_work'], ['terra', 'unknown'], ['claude-max', 'flat_idle'], ['grok-ultra', 'moving'],
    ]);
    expect(planMeterIncidents(report).map(row => row.provider)).toEqual(['codex-personal']);
  });
});

describe('postMeterIncidents', () => {
  it('passes failure statuses through and a throwing post is unavailable', async () => {
    const report = await readMeterDrop(flatReaders(base), base);
    expect(postMeterIncidents(report, base, () => ({ status: 'full' })))
      .toEqual([{ provider: 'codex-personal', status: 'full' }]);
    expect(postMeterIncidents(report, base, () => { throw new Error('offline'); }))
      .toEqual([{ provider: 'codex-personal', status: 'unavailable' }]);
  });
});

describe('cmdFleetMeterIncident', () => {
  const logSpy = () => vi.spyOn(console, 'log').mockImplementation(() => {});
  const lastLog = (): string => String(vi.mocked(console.log).mock.calls.at(-1)![0]);

  it('posts exactly one meter-flat P1 envelope for a flat_with_work provider', async () => {
    const post = vi.fn((_envelope: unknown) => ({ status: 'posted' as const, id: 'x', cursor: 1 }));
    const code = await cmdFleetMeterIncident(['--apply'], { readers: flatReaders(base), now: () => base, post });
    expect(code).toBe(0);
    expect(post).toHaveBeenCalledTimes(1);
    const envelope = post.mock.calls[0]![0] as BusEnvelope;
    expect(validateBusEnvelope(envelope).ok).toBe(true);
    expect(envelope.priority).toBe('P1');
    expect((envelope.body as Record<string, unknown>)['kind']).toBe('meter-flat');
  });

  it('posts nothing for moving, flat_idle or unknown verdicts', async () => {
    for (const readers of [
      flatReaders(base, { lastPercent: 70 }),
      flatReaders(base, { running: 0 }),
      { lanes: async () => [lane('codex-personal', 3)], meters: async () => [] as MeterSample[] },
    ]) {
      const post = vi.fn();
      expect(await cmdFleetMeterIncident(['--apply'], { readers, now: () => base, post })).toBe(0);
      expect(post).not.toHaveBeenCalled();
    }
  });

  it('dedupes a second --apply inside the hour and posts again in the next', async () => {
    const log = logSpy();
    const root = await mkdtemp(join(tmpdir(), 'meter-incident-'));
    dirs.push(root);
    const at = (offset: number) => base + offset;
    const run = (offset: number) => cmdFleetMeterIncident(
      ['--apply', '--runs-dir', root, '--json'],
      { readers: flatReaders(at(offset)), now: () => at(offset) });
    expect(await run(0)).toBe(0);
    const first = JSON.parse(lastLog());
    expect(first.posted).toEqual([{ provider: 'codex-personal', status: 'posted' }]);
    expect(await run(20 * 60_000)).toBe(0);
    const second = JSON.parse(lastLog());
    expect(second.posted).toEqual([{ provider: 'codex-personal', status: 'duplicate' }]);
    expect(second.planned[0]!.id).toBe(first.planned[0]!.id);
    expect(await run(HOUR_MS)).toBe(0);
    const third = JSON.parse(lastLog());
    expect(third.planned[0]!.id).not.toBe(first.planned[0]!.id);
    expect(third.posted).toEqual([{ provider: 'codex-personal', status: 'posted' }]);
    expect(log).toHaveBeenCalled();
  });

  it('reports an unavailable post and still exits 0', async () => {
    logSpy();
    const post = vi.fn(() => { throw new Error('offline'); });
    expect(await cmdFleetMeterIncident(['--apply', '--json'], { readers: flatReaders(base), now: () => base, post }))
      .toBe(0);
    expect(JSON.parse(lastLog()).posted).toEqual([{ provider: 'codex-personal', status: 'unavailable' }]);
  });

  it('never calls post on a dry run and reports planned incidents as JSON', async () => {
    logSpy();
    const post = vi.fn();
    expect(await cmdFleetMeterIncident(['--json'], { readers: flatReaders(base), now: () => base, post })).toBe(0);
    expect(post).not.toHaveBeenCalled();
    const out = JSON.parse(lastLog());
    expect(out.schema).toBe('fleet.meter-incident.v1');
    expect(out.posted).toBeNull();
    expect(out.planned).toEqual([expect.objectContaining({
      kind: 'meter-flat', provider: 'codex-personal', running: 12,
      observedMinutes: 74, firstUsedPercent: 61, lastUsedPercent: 61,
      text: 'codex-personal meter flat 74 min at 61% while 12 jobs run',
    })]);
  });

  it('exits 2 on a bad flag or value and reads nothing', async () => {
    const lanes = vi.fn(async () => [lane('codex-personal', 3)]);
    const readers = { lanes, meters: async () => [] as MeterSample[] };
    for (const args of [['--bogus'], ['--runs-dir', 'relative/path'], ['--runs-dir'],
      ['--json', '--json'], ['--apply', '--apply'], ['--apply', '--runs-dir', 'x']]) {
      expect(await cmdFleetMeterIncident(args, { readers, now: () => base })).toBe(2);
    }
    expect(lanes).not.toHaveBeenCalled();
    expect(await cmdFleetMeterIncident(['--help'], { readers, now: () => base })).toBe(0);
    expect(lanes).not.toHaveBeenCalled();
  });
});
