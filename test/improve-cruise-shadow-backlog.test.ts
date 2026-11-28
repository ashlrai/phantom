import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  classifyCruiseReason,
  CRUISE_SHADOW_MAX_ITEMS,
  CRUISE_SHADOW_MIN_DAYS,
  CRUISE_SHADOW_MIN_SAMPLES,
  cruiseShadowBacklogItems,
  foldCruiseShadowCells,
  parseCruiseShadowSamples,
  type CruiseShadowSample,
} from '../src/core/improve/cruise-shadow-backlog.js';
import { discoverBacklog } from '../src/core/improve/discover.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';

const SCHEMA = 'ashlr.cruise.shadow.v1';
const NOW = Date.parse('2026-11-23T12:00:00.000Z');
const CUTOFF = NOW - 7 * 24 * 60 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;

type SampleSpec = {
  zone?: string;
  action?: string;
  stress?: number | null;
  reasons?: string[];
  badEvent?: boolean;
  dispatchd?: Record<string, unknown> | null;
};
const row = (ts: string, spec: SampleSpec = {}, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({
    ts,
    schema: SCHEMA,
    mode: 'shadow',
    kill: false,
    pause: null,
    bad_event: spec.badEvent === true,
    profile: 'mac-large',
    sample: { pressure_level: 'normal', pressure_score: 45.0, free_pct: 55.0, load1: 54.05, load_per_core: 3.0, thermal: 'nominal' },
    cruise: {
      zone: spec.zone ?? 'danger',
      stress: spec.stress === undefined ? 26.5 : spec.stress,
      top: 'pressure_score',
      reasons: spec.reasons ?? ['pressure_score z=26.5', 'foreign_pressure fleet_mem_share=0.02'],
      action: spec.action ?? 'hold_foreign',
      target: 1,
      prev_target: 1,
      ceiling: 5,
      knee: 6.09,
      shed: null,
      warmup: true,
      params: {},
    },
    memguard_measured: null,
    dispatchd: spec.dispatchd === undefined
      ? { last_tick: ts, paused: null, running_total: 8, target_total: 16, queued_total: 101 }
      : spec.dispatchd,
    ...extra,
  });
const sample = (atMs: number, zone: 'warn' | 'danger' = 'danger', action = 'hold_foreign', extra: Partial<CruiseShadowSample> = {}): CruiseShadowSample => ({
  atMs,
  zone,
  action,
  stress: 26.5,
  badEvent: false,
  runningTotal: 8,
  targetTotal: 16,
  queuedTotal: 101,
  reasonClasses: ['pressure_score', 'foreign_pressure'],
  ...extra,
});

describe('classifyCruiseReason', () => {
  it('maps the generated reason vocabulary to its leading class', () => {
    expect(classifyCruiseReason('pressure_score z=26.5')).toBe('pressure_score');
    expect(classifyCruiseReason('foreign_pressure fleet_mem_share=0.02')).toBe('foreign_pressure');
    expect(classifyCruiseReason('os_pressure_critical')).toBe('os_pressure');
    expect(classifyCruiseReason('os_pressure_warn')).toBe('os_pressure');
    expect(classifyCruiseReason('thermal_serious')).toBe('thermal');
    expect(classifyCruiseReason('thermal_critical')).toBe('thermal');
    expect(classifyCruiseReason('cold_start')).toBe('cold_start');
    expect(classifyCruiseReason('load1 z=12.3')).toBe('load');
    expect(classifyCruiseReason('load_per_core z=4.1')).toBe('load');
    expect(classifyCruiseReason('mem_free_pct z=2.0')).toBe('memory');
    expect(classifyCruiseReason('compressed_bytes z=9.9')).toBe('memory');
    expect(classifyCruiseReason('swap_used_bytes z=1.1')).toBe('swap');
    expect(classifyCruiseReason('fleet_mem_share=0.02')).toBe('fleet_share');
  });

  it('classifies unknown, empty and oversized reasons as other', () => {
    expect(classifyCruiseReason('something_new z=1')).toBe('other');
    expect(classifyCruiseReason('')).toBe('other');
    expect(classifyCruiseReason('x'.repeat(2000))).toBe('other');
  });
});

describe('parseCruiseShadowSamples', () => {
  it('keeps valid adverse rows and validates the producer contract', () => {
    const rows = [
      row('2026-11-23T10:00:00.000Z', { zone: 'danger', action: 'hold_foreign' }),
      row('2026-11-23T05:05:00-0500', { zone: 'warn', action: 'decrease', badEvent: true, stress: null }),
      // non-adverse zones never count
      row('2026-11-23T10:10:00.000Z', { zone: 'ok', action: 'raise' }),
      row('2026-11-23T10:15:00.000Z', { zone: 'unknown', action: 'hold' }),
      // foreign schema / mode
      row('2026-11-23T10:20:00.000Z', {}, { schema: 'ashlr.cruise.live.v1' }),
      row('2026-11-23T10:25:00.000Z', {}, { mode: 'live' }),
      // zone outside the controller vocabulary
      row('2026-11-23T10:30:00.000Z', { zone: 'critical' }),
      // missing/oversized action
      row('2026-11-23T10:35:00.000Z', { action: 'x'.repeat(100) }),
      // outside window / future / missing ts
      row('2026-11-10T10:00:00.000Z'),
      row('2026-11-24T10:00:00.000Z'),
      JSON.stringify({ schema: SCHEMA, mode: 'shadow', cruise: { zone: 'danger', action: 'hold_foreign' } }),
      // malformed cruise block
      JSON.stringify({ ts: '2026-11-23T10:40:00.000Z', schema: SCHEMA, mode: 'shadow', cruise: 'danger' }),
      'not json at all',
      '',
    ].join('\n');
    const samples = parseCruiseShadowSamples(rows, CUTOFF, NOW);
    expect(samples).toHaveLength(2);
    expect(samples[0]).toMatchObject({
      zone: 'danger',
      action: 'hold_foreign',
      stress: 26.5,
      badEvent: false,
      runningTotal: 8,
      targetTotal: 16,
      queuedTotal: 101,
    });
    expect(samples[1]).toMatchObject({ zone: 'warn', action: 'decrease', stress: null, badEvent: true });
    // Offset timestamps parse to the same instant the producer meant (05:05-0500 = 10:05Z).
    expect(samples[1]!.atMs).toBe(Date.parse('2026-11-23T10:05:00.000Z'));
    expect(samples[0]!.reasonClasses).toEqual(['pressure_score', 'foreign_pressure']);
  });

  it('tolerates a five-minute future skew and rejects beyond it', () => {
    const rows = [
      row('2026-11-23T12:03:00.000Z'),
      row('2026-11-23T12:06:00.000Z'),
    ].join('\n');
    const samples = parseCruiseShadowSamples(rows, CUTOFF, NOW);
    expect(samples).toHaveLength(1);
    expect(samples[0]!.atMs).toBe(Date.parse('2026-11-23T12:03:00.000Z'));
  });

  it('handles absent or malformed dispatchd and reasons honestly', () => {
    const rows = [
      row('2026-11-23T10:00:00.000Z', { dispatchd: null }),
      row('2026-11-23T10:05:00.000Z', { dispatchd: { running_total: 'eight', target_total: 16, queued_total: 101 } }),
      JSON.stringify({
        ts: '2026-11-23T10:10:00.000Z', schema: SCHEMA, mode: 'shadow', bad_event: false,
        cruise: { zone: 'danger', action: 'shed', stress: 30, reasons: 'not-an-array' },
      }),
    ].join('\n');
    const samples = parseCruiseShadowSamples(rows, CUTOFF, NOW);
    expect(samples).toHaveLength(3);
    expect(samples[0]).toMatchObject({ runningTotal: null, targetTotal: null, queuedTotal: null, reasonClasses: ['pressure_score', 'foreign_pressure'] });
    expect(samples[1]).toMatchObject({ runningTotal: null, targetTotal: 16, queuedTotal: 101 });
    expect(samples[2]).toMatchObject({ action: 'shed', reasonClasses: [] });
  });
});

describe('foldCruiseShadowCells', () => {
  it('groups by zone and action and aggregates the fleet context', () => {
    const T0 = Date.parse('2026-11-23T08:00:00.000Z');
    const cells = foldCruiseShadowCells([
      sample(T0, 'danger', 'hold_foreign', { badEvent: true, stress: 40 }),
      sample(T0 + 60_000, 'danger', 'hold_foreign', { runningTotal: 4, targetTotal: 16, queuedTotal: 200, stress: 30 }),
      sample(T0 - DAY, 'warn', 'decrease', { runningTotal: 16, targetTotal: 16, queuedTotal: 0, stress: 8, reasonClasses: ['load'] }),
    ]);
    expect(cells.map((c) => [c.zone, c.action, c.samples, c.days, c.badEvents])).toEqual([
      ['danger', 'hold_foreign', 2, 1, 1],
      ['warn', 'decrease', 1, 1, 0],
    ]);
    const danger = cells[0]!;
    expect(danger.maxStress).toBe(40);
    expect(danger.maxQueued).toBe(200);
    // Sample 1: running 8 < target 16 → idle capacity; sample 2: running 4 < 16 → idle capacity.
    expect(danger.idleCapacitySamples).toBe(2);
    expect(danger.dispatchdSamples).toBe(2);
    expect(danger.maxRunning).toBe(8);
    expect(danger.maxTarget).toBe(16);
    expect(danger.reasonClasses).toEqual([
      { cls: 'foreign_pressure', count: 2 },
      { cls: 'pressure_score', count: 2 },
    ]);
    expect(danger.firstSeen).toBe(new Date(T0).toISOString());
    expect(danger.lastSeen).toBe(new Date(T0 + 60_000).toISOString());
    expect(danger.lowerBound).toBe(false);
    const warn = cells[1]!;
    // running == target → at ceiling, not idle.
    expect(warn.idleCapacitySamples).toBe(0);
    expect(warn.maxQueued).toBe(0);
  });

  it('marks folded cells as lower bounds when the tail was truncated', () => {
    const cells = foldCruiseShadowCells([sample(Date.now())], true);
    expect(cells[0]!.lowerBound).toBe(true);
  });
});

describe('cruiseShadowBacklogItems', () => {
  let home: string;
  let saved: { HOME?: string; ASHLR_HOME?: string; ASHLR_RUNS_DIR?: string };
  const NOW_MS = Date.now();
  const iso = (minAgo: number): string => new Date(NOW_MS - minAgo * 60_000).toISOString();

  beforeEach(async () => {
    saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME, ASHLR_RUNS_DIR: process.env.ASHLR_RUNS_DIR };
    delete process.env.ASHLR_HOME;
    delete process.env.ASHLR_RUNS_DIR;
    home = await mkdtemp(join(tmpdir(), 'cruise-shadow-backlog-'));
    process.env.HOME = home;
  });
  afterEach(async () => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    vi.restoreAllMocks();
    await rm(home, { recursive: true, force: true });
  });

  /** A scratch journal at an explicit path. */
  async function journal(name: string, rows: string[]): Promise<string> {
    const dir = join(home, name);
    await mkdir(dir, { recursive: true });
    const path = join(dir, 'cruise-shadow.jsonl');
    await writeFile(path, rows.join('\n') + '\n');
    return path;
  }
  /** Three samples on two UTC days: 60 and 120 min ago share a day; 2000 min ago guarantees a second. */
  const recurring = (spec: SampleSpec = {}): string[] => [
    row(iso(60), spec), row(iso(120), spec), row(iso(2000), spec),
  ];

  it('emits an item for a recurring adverse cell', async () => {
    const path = await journal('j1', recurring({ zone: 'danger', action: 'hold_foreign' }));
    const items = await cruiseShadowBacklogItems({ repo: 'ashlrai/phantom', journalPath: path, now: new Date(NOW_MS) });
    expect(items).toHaveLength(1);
    const [item] = items;
    expect(item).toMatchObject({ priority: 3, repo: 'ashlrai/phantom', area: 'cruise-shadow' });
    expect(item!.id).toMatch(/^fleet-cruise-shadow-[0-9a-f]{16}$/);
    expect(item!.title).toContain('danger');
    expect(item!.title).toContain('hold_foreign');
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item!.prompt).toContain('ashlr.cruise.shadow.v1');
    expect(item!.prompt).toContain('cruise-shadow.jsonl');
    expect(item!.prompt).toContain('hold_foreign');
    expect(item!.prompt).toContain('foreign_pressure');
    expect(item!.prompt).toContain('no-change');
    expect(item!.prompt).toContain('queued_total');
    // Generated reason strings are never quoted into prompts.
    expect(item!.prompt).not.toContain('fleet_mem_share=0.02');
    expect(item!.prompt).not.toContain('z=26.5');
  });

  it('keeps zones and actions in separate cells', async () => {
    const path = await journal('j2', [
      ...recurring({ zone: 'danger', action: 'hold_foreign' }),
      ...recurring({ zone: 'danger', action: 'decrease' }),
      ...recurring({ zone: 'warn', action: 'hold_warn' }),
    ]);
    const items = await cruiseShadowBacklogItems({ repo: 'ashlrai/phantom', journalPath: path, now: new Date(NOW_MS) });
    expect(items).toHaveLength(3);
    expect(new Set(items.map((i) => i.id)).size).toBe(3);
    const titles = items.map((i) => i.title);
    expect(titles.some((t) => t.includes('hold_foreign'))).toBe(true);
    expect(titles.some((t) => t.includes('decrease'))).toBe(true);
    expect(titles.some((t) => t.includes('hold_warn'))).toBe(true);
  });

  it('emits nothing below the recurring bars of samples and days', async () => {
    // Two samples only — under the sample bar even across two days.
    const thin = await journal('j3a', [row(iso(60)), row(iso(2000))]);
    expect(await cruiseShadowBacklogItems({ repo: 'ashlrai/phantom', journalPath: thin, now: new Date(NOW_MS) })).toEqual([]);
    // Three samples all inside one UTC day — under the day bar. Fixed timestamps guarantee one day.
    const sameDay = await journal('j3b', [
      row('2026-11-23T01:00:00.000Z'), row('2026-11-23T05:00:00.000Z'), row('2026-11-23T09:00:00.000Z'),
    ]);
    expect(await cruiseShadowBacklogItems({ repo: 'ashlrai/phantom', journalPath: sameDay, now: new Date('2026-11-23T12:00:00.000Z') })).toEqual([]);
    // Healthy and cold-start zones only — never evidence.
    const healthy = await journal('j3c', recurring({ zone: 'ok', action: 'raise' }));
    expect(await cruiseShadowBacklogItems({ repo: 'ashlrai/phantom', journalPath: healthy, now: new Date(NOW_MS) })).toEqual([]);
    const cold = await journal('j3d', recurring({ zone: 'unknown', action: 'hold' }));
    expect(await cruiseShadowBacklogItems({ repo: 'ashlrai/phantom', journalPath: cold, now: new Date(NOW_MS) })).toEqual([]);
    expect(CRUISE_SHADOW_MIN_SAMPLES).toBe(3);
    expect(CRUISE_SHADOW_MIN_DAYS).toBe(2);
  });

  it('emits nothing for a missing journal or another repository', async () => {
    expect(await cruiseShadowBacklogItems({ repo: 'ashlrai/phantom', journalPath: join(home, 'no-such.jsonl'), now: new Date(NOW_MS) })).toEqual([]);
    const path = await journal('j4', recurring());
    expect(await cruiseShadowBacklogItems({ repo: 'ashlrai/other', journalPath: path, now: new Date(NOW_MS) })).toEqual([]);
    expect(await cruiseShadowBacklogItems({ repo: 'AshlrAI/Phantom', journalPath: path, now: new Date(NOW_MS) })).toHaveLength(1);
  });

  it('reads the default journal under ~/.ashlr-runs/metrics when no override is given', async () => {
    const dir = join(home, '.ashlr-runs', 'metrics');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'cruise-shadow.jsonl'), recurring().join('\n') + '\n');
    const items = await cruiseShadowBacklogItems({ repo: 'ashlrai/phantom', now: new Date(NOW_MS) });
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toContain('danger');
  });

  it('honours ASHLR_RUNS_DIR and an empty env value falls back to the home runs dir', async () => {
    const custom = join(home, 'custom-runs');
    await mkdir(join(custom, 'metrics'), { recursive: true });
    await writeFile(join(custom, 'metrics', 'cruise-shadow.jsonl'), recurring({ action: 'decrease' }).join('\n') + '\n');
    process.env.ASHLR_RUNS_DIR = custom;
    expect(await cruiseShadowBacklogItems({ repo: 'ashlrai/phantom', now: new Date(NOW_MS) })).toHaveLength(1);
    // Explicit runsDir wins over the env.
    const other = join(home, 'other-runs');
    await mkdir(join(other, 'metrics'), { recursive: true });
    await writeFile(join(other, 'metrics', 'cruise-shadow.jsonl'), recurring({ zone: 'warn', action: 'hold_warn' }).join('\n') + '\n');
    const viaOpt = await cruiseShadowBacklogItems({ repo: 'ashlrai/phantom', runsDir: other, now: new Date(NOW_MS) });
    expect(viaOpt).toHaveLength(1);
    expect(viaOpt[0]!.title).toContain('hold_warn');
    // Empty env is no dir at all — falls back to ~/.ashlr-runs, not cwd.
    process.env.ASHLR_RUNS_DIR = '';
    const fallback = join(home, '.ashlr-runs', 'metrics');
    await mkdir(fallback, { recursive: true });
    await writeFile(join(fallback, 'cruise-shadow.jsonl'), recurring({ action: 'shed' }).join('\n') + '\n');
    const items = await cruiseShadowBacklogItems({ repo: 'ashlrai/phantom', now: new Date(NOW_MS) });
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toContain('shed');
  });

  it('states truncation as a lower bound in the prompt', async () => {
    const path = await journal('j5', recurring());
    const pad = 'x'.repeat(8_600 * 1024);
    await writeFile(path, pad + '\n' + recurring().join('\n') + '\n');
    const items = await cruiseShadowBacklogItems({ repo: 'ashlrai/phantom', journalPath: path, now: new Date(NOW_MS) });
    expect(items).toHaveLength(1);
    expect(items[0]!.prompt).toContain('lower bound');
  });

  it('derives stable ids so a refresh re-adds nothing and honours the limit', async () => {
    const path = await journal('j6', [
      ...recurring({ action: 'hold_foreign' }),
      ...recurring({ action: 'decrease' }),
      ...recurring({ zone: 'warn', action: 'hold_warn' }),
    ]);
    const opts = { repo: 'ashlrai/phantom', journalPath: path, now: new Date(NOW_MS) };
    const first = await cruiseShadowBacklogItems(opts);
    const second = await cruiseShadowBacklogItems(opts);
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
    expect(first.length).toBeLessThanOrEqual(CRUISE_SHADOW_MAX_ITEMS);
    expect(first.length).toBe(3);
    expect(await cruiseShadowBacklogItems({ ...opts, limit: 1 })).toHaveLength(1);
  });

  it('appends cruise-shadow items through discovery and dedupes on refresh', async () => {
    const dir = join(home, '.ashlr-runs', 'metrics');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'cruise-shadow.jsonl'), recurring().join('\n') + '\n');
    const greenGh = async (args: string[]) => {
      const p = args[4] ?? '';
      if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
    };
    const first = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    const cruiseItems = first.items.filter((i) => i.id.startsWith('fleet-cruise-shadow-'));
    expect(cruiseItems).toHaveLength(1);
    expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    expect(appendUserBacklogItems(cruiseItems)).toBe(1);
    const second = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('fleet-cruise-shadow-')))).toBe(0);
    expect(readUserBacklogItems().filter((i) => i.id.startsWith('fleet-cruise-shadow-'))).toHaveLength(1);
  });
});
