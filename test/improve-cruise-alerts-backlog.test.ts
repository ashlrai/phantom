import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CRUISE_ALERTS_MAX_ITEMS,
  CRUISE_ALERTS_MIN_ALERTS,
  CRUISE_ALERTS_MIN_DAYS,
  cruiseAlertsBacklogItems,
  foldCruiseAlerts,
  parseCruiseAlerts,
  type CruiseAlertSample,
} from '../src/core/improve/cruise-alerts-backlog.js';
import { discoverBacklog } from '../src/core/improve/discover.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';

const NOW = Date.parse('2026-11-27T12:00:00.000Z');
const CUTOFF = NOW - 7 * 24 * 60 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;

type AlertSpec = {
  name?: string;
  system?: boolean;
  action?: string;
  pid?: number;
  rssShare?: number | null;
  cpuPct?: number | null;
  z?: number | null;
};
/** The watchdog's record shape: epoch-seconds float ts, kind runaway_daemon, action alert_only. */
const row = (tsSec: number, spec: AlertSpec = {}, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({
    kind: 'runaway_daemon',
    name: spec.name ?? 'node',
    pid: spec.pid ?? 4242,
    uid: 501,
    rss_bytes: 329449472,
    rss_share: spec.rssShare === undefined ? 0.18 : spec.rssShare,
    cpu_pct: spec.cpuPct === undefined ? 150.8 : spec.cpuPct,
    z: spec.z === undefined ? 89.6 : spec.z,
    z_rss: 10.7,
    z_cpu: 89.6,
    slope_bps: -1354083,
    baseline_bytes: 58755389,
    system: spec.system ?? false,
    action: spec.action ?? 'alert_only',
    ts: tsSec,
    ...extra,
  });
const sample = (atMs: number, name = 'node', extra: Partial<CruiseAlertSample> = {}): CruiseAlertSample => ({
  atMs,
  name,
  system: false,
  action: 'alert_only',
  pid: 4242,
  rssShare: 0.18,
  cpuPct: 150.8,
  z: 89.6,
  ...extra,
});

describe('parseCruiseAlerts', () => {
  it('keeps valid rows and validates the producer contract', () => {
    const sec = (ms: number): number => ms / 1000;
    const rows = [
      row(sec(NOW - 60 * 60 * 1000), { name: 'node', pid: 11 }),
      row(sec(NOW - 2 * 60 * 60 * 1000), { name: 'git', system: true, pid: 22, rssShare: null, cpuPct: null, z: null }),
      // other kinds never count
      row(sec(NOW - 3 * 60 * 60 * 1000), {}, { kind: 'zombie_report' }),
      // foreign name shapes: empty, oversized, control characters
      row(sec(NOW - 4 * 60 * 60 * 1000), { name: '' }),
      row(sec(NOW - 5 * 60 * 60 * 1000), { name: 'x'.repeat(200) }),
      row(sec(NOW - 6 * 60 * 60 * 1000), { name: 'evil\nname' }),
      // timestamp dialects that are not epoch seconds
      JSON.stringify({ kind: 'runaway_daemon', name: 'node', ts: '2026-11-27T10:00:00.000Z' }),
      JSON.stringify({ kind: 'runaway_daemon', name: 'node', ts: -5 }),
      JSON.stringify({ kind: 'runaway_daemon', name: 'node', ts: 'not-a-number' }),
      // outside window / beyond future skew
      row(sec(NOW - 8 * 24 * 60 * 60 * 1000)),
      row(sec(NOW + 10 * 60 * 1000)),
      // missing name entirely
      JSON.stringify({ kind: 'runaway_daemon', ts: sec(NOW - 60 * 1000) }),
      'not json at all',
      '',
    ].join('\n');
    const samples = parseCruiseAlerts(rows, CUTOFF, NOW);
    expect(samples).toHaveLength(2);
    expect(samples[0]).toMatchObject({ name: 'node', system: false, action: 'alert_only', pid: 11, rssShare: 0.18, cpuPct: 150.8, z: 89.6 });
    expect(samples[1]).toMatchObject({ name: 'git', system: true, pid: 22, rssShare: null, cpuPct: null, z: null });
    expect(samples[0]!.atMs).toBe(NOW - 60 * 60 * 1000);
  });

  it('tolerates a five-minute future skew and rejects beyond it', () => {
    const sec = (ms: number): number => ms / 1000;
    const rows = [row(sec(NOW + 3 * 60 * 1000)), row(sec(NOW + 6 * 60 * 1000))].join('\n');
    const samples = parseCruiseAlerts(rows, CUTOFF, NOW);
    expect(samples).toHaveLength(1);
    expect(samples[0]!.atMs).toBe(NOW + 3 * 60 * 1000);
  });

  it('degrades malformed evidence fields and the uid flag honestly', () => {
    const sec = (ms: number): number => ms / 1000;
    const rows = [
      // pid absent/non-integer, system absent, numeric fields as strings
      JSON.stringify({ kind: 'runaway_daemon', name: 'python3', ts: sec(NOW - 60 * 1000), pid: 'x', rss_share: 'high', cpu_pct: 42.5, z: 7.25 }),
      JSON.stringify({ kind: 'runaway_daemon', name: 'node', ts: sec(NOW - 120 * 1000), pid: 5.5, system: 'yes', rss_share: 0.5, cpu_pct: null, z: null }),
      // oversized action is foreign → action null but the alert still counts
      row(sec(NOW - 180 * 1000), { action: 'x'.repeat(100) }),
    ].join('\n');
    const samples = parseCruiseAlerts(rows, CUTOFF, NOW);
    expect(samples).toHaveLength(3);
    expect(samples[0]).toMatchObject({ name: 'python3', system: null, action: null, pid: null, rssShare: null, cpuPct: 42.5, z: 7.25 });
    expect(samples[1]).toMatchObject({ name: 'node', system: null, pid: null, rssShare: 0.5, cpuPct: null });
    expect(samples[2]).toMatchObject({ name: 'node', action: null });
  });
});

describe('foldCruiseAlerts', () => {
  it('groups by name, uid flag and action and aggregates the measured peaks', () => {
    const T0 = Date.parse('2026-11-27T08:00:00.000Z');
    const cells = foldCruiseAlerts([
      sample(T0, 'node', { pid: 1, rssShare: 0.10, cpuPct: 90, z: 40 }),
      sample(T0 + 60_000, 'node', { pid: 2, rssShare: 0.25, cpuPct: 200, z: 120 }),
      sample(T0 - DAY, 'git', { system: true, pid: 9, rssShare: null, cpuPct: null, z: null }),
      sample(T0 - DAY, 'git', { system: false, pid: 10 }),
    ]);
    expect(cells.map((c) => [c.name, c.system, c.alerts, c.days, c.pids])).toEqual([
      ['node', false, 2, 1, 2],
      ['git', false, 1, 1, 1],
      ['git', true, 1, 1, 1],
    ]);
    const node = cells[0]!;
    expect(node.maxZ).toBe(120);
    expect(node.peakRssShare).toBe(0.25);
    expect(node.peakCpuPct).toBe(200);
    expect(node.firstSeen).toBe(new Date(T0).toISOString());
    expect(node.lastSeen).toBe(new Date(T0 + 60_000).toISOString());
    expect(node.lowerBound).toBe(false);
    // The same name under different uid flags and actions stays in separate cells.
    expect(new Set(cells.map((c) => `${c.name}:${c.system}`)).size).toBe(3);
  });

  it('marks folded cells as lower bounds when the tail was truncated', () => {
    const cells = foldCruiseAlerts([sample(Date.now())], true);
    expect(cells[0]!.lowerBound).toBe(true);
  });
});

describe('cruiseAlertsBacklogItems', () => {
  let home: string;
  let saved: { HOME?: string; ASHLR_HOME?: string; ASHLR_RUNS_DIR?: string };
  const NOW_MS = Date.now();
  const sec = (msAgo: number): number => (NOW_MS - msAgo * 60_000) / 1000;

  beforeEach(async () => {
    saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME, ASHLR_RUNS_DIR: process.env.ASHLR_RUNS_DIR };
    delete process.env.ASHLR_HOME;
    delete process.env.ASHLR_RUNS_DIR;
    home = await mkdtemp(join(tmpdir(), 'cruise-alerts-backlog-'));
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
    const path = join(dir, 'cruise-alerts.jsonl');
    await writeFile(path, rows.join('\n') + '\n');
    return path;
  }
  /** Three alerts on two UTC days: 60 and 120 min ago share a day; 2000 min ago guarantees a second. */
  const recurring = (spec: AlertSpec = {}): string[] => [
    row(sec(60), spec), row(sec(120), { ...spec, pid: (spec.pid ?? 4242) + 1 }), row(sec(2000), { ...spec, pid: (spec.pid ?? 4242) + 2 }),
  ];

  it('emits an item for a recurring alert cell', async () => {
    const path = await journal('j1', recurring({ name: 'node', rssShare: 0.22, cpuPct: 180, z: 95 }));
    const items = await cruiseAlertsBacklogItems({ repo: 'ashlrai/phantom', journalPath: path, now: new Date(NOW_MS) });
    expect(items).toHaveLength(1);
    const [item] = items;
    expect(item).toMatchObject({ priority: 3, repo: 'ashlrai/phantom', area: 'cruise-alerts' });
    expect(item!.id).toMatch(/^fleet-cruise-alerts-[0-9a-f]{16}$/);
    expect(item!.title).toContain('node');
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item!.prompt).toContain('cruise-alerts.jsonl');
    expect(item!.prompt).toContain('runaway_daemon');
    expect(item!.prompt).toContain('alert_only');
    expect(item!.prompt).toContain('no-change');
    expect(item!.prompt).toContain('3 alert');
    expect(item!.prompt).toContain('2 distinct UTC day');
    // Measured peaks are quoted rounded; pids are counted, never listed.
    expect(item!.prompt).toContain('22% of host RAM');
    expect(item!.prompt).toContain('3 distinct process id');
    expect(item!.prompt).not.toContain('pid 4242');
  });

  it('keeps names, uid flags and actions in separate cells', async () => {
    const path = await journal('j2', [
      ...recurring({ name: 'node' }),
      ...recurring({ name: 'git', system: true }),
      ...recurring({ name: 'node', system: true }),
    ]);
    const items = await cruiseAlertsBacklogItems({ repo: 'ashlrai/phantom', journalPath: path, now: new Date(NOW_MS) });
    expect(items).toHaveLength(3);
    expect(new Set(items.map((i) => i.id)).size).toBe(3);
    const nodeOwn = items.find((i) => i.title.includes("'node'") && !i.prompt.includes('system:true'));
    const nodeSys = items.find((i) => i.title.includes("'node'") && i.prompt.includes('system:true'));
    const gitSys = items.find((i) => i.title.includes("'git'"));
    expect(nodeOwn).toBeDefined();
    expect(nodeSys).toBeDefined();
    expect(gitSys).toBeDefined();
    // system:true cells carry the foreign-ownership framing.
    expect(nodeSys!.prompt).toContain('outside the cruise user');
    expect(gitSys!.prompt).toContain('Fleet-side changes cannot relieve it');
  });

  it('emits nothing below the recurring bars of alerts and days', async () => {
    // Two alerts only — under the alert bar even across two days.
    const thin = await journal('j3a', [row(sec(60)), row(sec(2000))]);
    expect(await cruiseAlertsBacklogItems({ repo: 'ashlrai/phantom', journalPath: thin, now: new Date(NOW_MS) })).toEqual([]);
    // Three alerts all inside one UTC day — under the day bar. Fixed timestamps guarantee one day.
    const fixedNow = Date.parse('2026-11-23T12:00:00.000Z');
    const sameDay = await journal('j3b', [
      row((fixedNow - 3 * 60 * 60 * 1000) / 1000), row((fixedNow - 5 * 60 * 60 * 1000) / 1000), row((fixedNow - 7 * 60 * 60 * 1000) / 1000),
    ]);
    expect(await cruiseAlertsBacklogItems({ repo: 'ashlrai/phantom', journalPath: sameDay, now: new Date(fixedNow) })).toEqual([]);
    // Foreign kinds only — never evidence.
    const other = await journal('j3c', recurring().map((r) => r.replace('runaway_daemon', 'other_kind')));
    expect(await cruiseAlertsBacklogItems({ repo: 'ashlrai/phantom', journalPath: other, now: new Date(NOW_MS) })).toEqual([]);
    expect(CRUISE_ALERTS_MIN_ALERTS).toBe(3);
    expect(CRUISE_ALERTS_MIN_DAYS).toBe(2);
  });

  it('emits nothing for a missing journal or another repository', async () => {
    expect(await cruiseAlertsBacklogItems({ repo: 'ashlrai/phantom', journalPath: join(home, 'no-such.jsonl'), now: new Date(NOW_MS) })).toEqual([]);
    const path = await journal('j4', recurring());
    expect(await cruiseAlertsBacklogItems({ repo: 'ashlrai/other', journalPath: path, now: new Date(NOW_MS) })).toEqual([]);
    expect(await cruiseAlertsBacklogItems({ repo: 'AshlrAI/Phantom', journalPath: path, now: new Date(NOW_MS) })).toHaveLength(1);
  });

  it('reads the default journal under ~/.ashlr-runs/metrics when no override is given', async () => {
    const dir = join(home, '.ashlr-runs', 'metrics');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'cruise-alerts.jsonl'), recurring().join('\n') + '\n');
    const items = await cruiseAlertsBacklogItems({ repo: 'ashlrai/phantom', now: new Date(NOW_MS) });
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toContain('node');
  });

  it('honours ASHLR_RUNS_DIR and an empty env value falls back to the home runs dir', async () => {
    const custom = join(home, 'custom-runs');
    await mkdir(join(custom, 'metrics'), { recursive: true });
    await writeFile(join(custom, 'metrics', 'cruise-alerts.jsonl'), recurring({ name: 'git' }).join('\n') + '\n');
    process.env.ASHLR_RUNS_DIR = custom;
    expect(await cruiseAlertsBacklogItems({ repo: 'ashlrai/phantom', now: new Date(NOW_MS) })).toHaveLength(1);
    // Explicit runsDir wins over the env.
    const other = join(home, 'other-runs');
    await mkdir(join(other, 'metrics'), { recursive: true });
    await writeFile(join(other, 'metrics', 'cruise-alerts.jsonl'), recurring({ name: 'bash' }).join('\n') + '\n');
    const viaOpt = await cruiseAlertsBacklogItems({ repo: 'ashlrai/phantom', runsDir: other, now: new Date(NOW_MS) });
    expect(viaOpt).toHaveLength(1);
    expect(viaOpt[0]!.title).toContain('bash');
    // Empty env is no dir at all — falls back to ~/.ashlr-runs, not cwd.
    process.env.ASHLR_RUNS_DIR = '';
    const fallback = join(home, '.ashlr-runs', 'metrics');
    await mkdir(fallback, { recursive: true });
    await writeFile(join(fallback, 'cruise-alerts.jsonl'), recurring({ name: 'zsh' }).join('\n') + '\n');
    const items = await cruiseAlertsBacklogItems({ repo: 'ashlrai/phantom', now: new Date(NOW_MS) });
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toContain('zsh');
  });

  it('states truncation as a lower bound in the prompt', async () => {
    const path = await journal('j5', recurring());
    const pad = 'x'.repeat(8_600 * 1024);
    await writeFile(path, pad + '\n' + recurring().join('\n') + '\n');
    const items = await cruiseAlertsBacklogItems({ repo: 'ashlrai/phantom', journalPath: path, now: new Date(NOW_MS) });
    expect(items).toHaveLength(1);
    expect(items[0]!.prompt).toContain('lower bound');
  });

  it('derives stable ids so a refresh re-adds nothing and honours the limit', async () => {
    const path = await journal('j6', [
      ...recurring({ name: 'node' }),
      ...recurring({ name: 'git' }),
      ...recurring({ name: 'bash' }),
      ...recurring({ name: 'zsh' }),
      ...recurring({ name: 'python3' }),
      ...recurring({ name: 'mds_stores', system: true }),
      ...recurring({ name: 'codex' }),
      ...recurring({ name: 'ashlr' }),
      ...recurring({ name: 'spindump', system: true }),
      ...recurring({ name: 'grep' }),
    ]);
    const opts = { repo: 'ashlrai/phantom', journalPath: path, now: new Date(NOW_MS) };
    const first = await cruiseAlertsBacklogItems(opts);
    const second = await cruiseAlertsBacklogItems(opts);
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
    expect(first.length).toBeLessThanOrEqual(CRUISE_ALERTS_MAX_ITEMS);
    expect(first.length).toBe(CRUISE_ALERTS_MAX_ITEMS);
    expect(await cruiseAlertsBacklogItems({ ...opts, limit: 1 })).toHaveLength(1);
  });

  it('appends cruise-alerts items through discovery and dedupes on refresh', async () => {
    const dir = join(home, '.ashlr-runs', 'metrics');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'cruise-alerts.jsonl'), recurring().join('\n') + '\n');
    const greenGh = async (args: string[]) => {
      const p = args[4] ?? '';
      if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
    };
    const first = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    const alertItems = first.items.filter((i) => i.id.startsWith('fleet-cruise-alerts-'));
    expect(alertItems).toHaveLength(1);
    expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    expect(appendUserBacklogItems(alertItems)).toBe(1);
    const second = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('fleet-cruise-alerts-')))).toBe(0);
    expect(readUserBacklogItems().filter((i) => i.id.startsWith('fleet-cruise-alerts-'))).toHaveLength(1);
  });
});
