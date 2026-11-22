/** Host-load history: fixture ps text and a temp runs dir in, rows and plain lines out. Nothing runs ps or reads the real home. */
import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { planChangeDigest } from '../src/core/comms/change-digest.js';
import { cmdHost } from '../src/cli/host.js';
import { buildPulse, pulseText } from '../src/core/fleet/pulse.js';
import {
  answerLine, blockedHourLine, HISTORY_MAX_ROWS, LOAD_HISTORY_FILE, LOAD_HISTORY_SCHEMA, readLoadHistory, summarizeLoadHistory,
  takeLoadSnapshot, type LoadSnapshotRow,
} from '../src/core/fleet/load-history.js';

const T0 = Date.UTC(2026, 10, 19, 12, 0, 0);
const MIN = 60_000;
const ps = readFileSync(join(__dirname, 'fixtures', 'host-load', 'fleet-heavy.txt'), 'utf8');
const BLOCKED = JSON.stringify({ why: 'over_host load1=75 host_max=36 owned=0.0', settle_s: 30 });
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const dirs = (): string => { const root = mkdtempSync(join(tmpdir(), 'load-history-')); roots.push(root); return root; };
const row = (at: number, load1: number | null, contributors: [string, number][]): LoadSnapshotRow =>
  ({ at, load1, hostMax: 36, contributors: contributors.map(([name, sharePercent]) => ({ name, sharePercent })) });
const deps = (now: number, admission: string | null) => ({ now: () => now, ps: async () => ps, jobRoots: () => [{ jobId: 'RQ-ONE', pid: 400 }], owners: () => ({}), admission: () => admission });
const writeRows = (dir: string, rows: LoadSnapshotRow[]) => {
  mkdirSync(join(dir, 'queue'), { recursive: true });
  writeFileSync(join(dir, LOAD_HISTORY_FILE), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
};

describe('takeLoadSnapshot', () => {
  it('takes one snapshot when over the dispatcher limit, and at most one per 10 minutes', async () => {
    const dir = dirs();
    const first = await takeLoadSnapshot(dir, deps(T0, BLOCKED));
    expect(first).toMatchObject({ state: 'taken', row: { at: T0, load1: 75, hostMax: 36 } });
    if (first.state === 'taken') expect(first.row.contributors[0]).toMatchObject({ name: 'fleet jobs' });
    expect((await takeLoadSnapshot(dir, deps(T0 + 9 * MIN, BLOCKED))).state).toBe('too-soon');
    expect(readLoadHistory(dir)).toHaveLength(1);
    expect((await takeLoadSnapshot(dir, deps(T0 + 10 * MIN, BLOCKED))).state).toBe('taken');
    expect(readLoadHistory(dir).map(r => r.at)).toEqual([T0, T0 + 10 * MIN]);
  });
  it('does nothing and never runs ps when launches are not blocked or the state is unknown', async () => {
    const dir = dirs();
    const boom = { ...deps(T0, null), ps: async () => { throw new Error('ps must not run'); } };
    expect((await takeLoadSnapshot(dir, boom)).state).toBe('unknown');
    expect((await takeLoadSnapshot(dir, { ...boom, admission: () => JSON.stringify({ settle_s: 0 }) })).state).toBe('not-blocked');
    expect(readLoadHistory(dir)).toEqual([]);
  });
  it('keeps 7 days and 2,000 rows: old rows rotate out, the newest stay', async () => {
    const dir = dirs();
    const old = row(T0 - 8 * 86_400_000, 50, [['x', 100]]);
    const many = Array.from({ length: HISTORY_MAX_ROWS }, (_, i) => row(T0 - (HISTORY_MAX_ROWS - i) * 20_000 - 11 * MIN, 40 + i % 5, [['Docker', 100]]));
    writeRows(dir, [old, ...many]);
    expect((await takeLoadSnapshot(dir, deps(T0, BLOCKED))).state).toBe('taken');
    const kept = readLoadHistory(dir);
    expect(kept).toHaveLength(HISTORY_MAX_ROWS);
    expect(kept.at(-1)!.at).toBe(T0);
    expect(kept[0]!.at).toBe(many[1]!.at);
    expect(kept.some(r => r.at === old.at)).toBe(false);
  });
  it('skips damaged lines', () => {
    const dir = dirs();
    mkdirSync(join(dir, 'queue'), { recursive: true });
    writeFileSync(join(dir, LOAD_HISTORY_FILE), `not json\n${JSON.stringify(row(T0, 50, [['Docker', 100]]))}\n{"at":"x"}\n`);
    expect(readLoadHistory(dir)).toHaveLength(1);
  });
});

describe('summarizeLoadHistory', () => {
  const rows = [
    row(T0 - 70 * MIN, 60, [['Docker', 50], ['fleet jobs', 50]]),
    row(T0 - 60 * MIN, 80, [['Docker', 60], ['local model server', 40]]),
    row(T0 - 50 * MIN, 75, [['Docker', 60], ['local model server', 30], ['Chrome', 10]]),
    row(T0 - 5 * MIN, 90, [['local model server', 80], ['Docker', 20]]),
  ];
  it('rolls up per hour: peak load, blocked minutes and the top 3 by share', () => {
    const report = summarizeLoadHistory(rows, T0, 6);
    expect(report).toMatchObject({ schema: LOAD_HISTORY_SCHEMA, version: 1, state: 'known', snapshots: 4 });
    const last = report.hours.at(-1)!;
    expect(last).toMatchObject({ hour: '2026-11-19T11:00:00.000Z', snapshots: 3, peakLoad1: 90, blockedMinutes: 25 });
    expect(last.top.map(c => c.name)).toEqual(['Docker', 'local model server', 'Chrome']);
    expect(report.hours[0]).toMatchObject({ snapshots: 1, peakLoad1: 60, blockedMinutes: 10 });
    expect(report.hours[0]!.top).toEqual([{ name: 'Docker', sharePercent: 50 }, { name: 'fleet jobs', sharePercent: 50 }]);
  });
  it('answers in one plain line', () => {
    expect(answerLine([{ name: 'Docker', sharePercent: 41 }, { name: 'local model server', sharePercent: 22 }], 'today'))
      .toBe('Most blocked time today: Docker (41%), then local model server (22%).');
    expect(summarizeLoadHistory(rows, T0, 24).answer).toMatch(/^Most blocked time today: Docker \(\d+%\), then local model server/);
    expect(summarizeLoadHistory(rows, T0, 6).answer).toMatch(/^Most blocked time in the last 6 hours: Docker/);
  });
  it('says unknown when no snapshot exists, and has no hours', () => {
    const report = summarizeLoadHistory([], T0, 6);
    expect(report).toMatchObject({ state: 'unknown', snapshots: 0, blockedMinutes: null, hours: [], top: [] });
    expect(report.answer).toBe('Unknown: no load snapshot has been taken yet, so what blocked launches is not known.');
  });
  it('gives the digest and pulse line only when blocked over 10 minutes in the last hour', () => {
    expect(blockedHourLine([row(T0 - 5 * MIN, 90, [['Docker', 100]])], T0)).toBeNull();
    const busy = [row(T0 - 40 * MIN, 90, [['Docker', 100]]), row(T0 - 30 * MIN, 90, [['Docker', 100]])];
    expect(blockedHourLine(busy, T0)).toBe('Launches were blocked by machine load for 20 minutes in the last hour. Most blocked time in the last hour: Docker (100%).');
    expect(blockedHourLine([], T0)).toBeNull();
    const digest = planChangeDigest(null, {
      events: [{ key: 'fixture-merge', kind: 'merge', at: new Date(T0 - MIN).toISOString(), text: 'Fixture merged', work: true }],
      seats: null, autonomy: { on: true, mode: 'fixture' }, mergeCountUnavailable: false, fleet: null, loadLine: blockedHourLine(busy, T0),
    }, T0);
    expect(digest.text).toContain(blockedHourLine(busy, T0));
    const pulse = buildPulse({ jobs: null, main: null, releases: null, spend: null, loadLine: 'Blocked line.' }, T0);
    expect(pulseText(pulse)[1]).toBe('Blocked line.');
    expect(pulseText(buildPulse({ jobs: null, main: null, releases: null, spend: null }, T0))).not.toContain('Blocked line.');
  });
});

describe('phm host load --history', () => {
  const run = async (args: string[], dir: string) => {
    const out: string[] = [];
    const code = await cmdHost(['load', ...args], { runsDir: dir, now: () => T0, write: text => out.push(text) });
    return { code, text: out.join('') };
  };
  it('prints typed JSON with a schema id, and unknown with no snapshot', async () => {
    const dir = dirs();
    const empty = await run(['--history', '--json'], dir);
    expect(empty.code).toBe(0);
    expect(JSON.parse(empty.text)).toMatchObject({ schema: LOAD_HISTORY_SCHEMA, state: 'unknown', hours: [] });
    writeRows(dir, [row(T0 - 30 * MIN, 80, [['Docker', 100]])]);
    const known = JSON.parse((await run(['--history', '--since', '24h', '--json'], dir)).text);
    expect(known).toMatchObject({ state: 'known', sinceHours: 24, answer: 'Most blocked time today: Docker (100%).' });
    expect((await run(['--history'], dir)).text).toContain('Most blocked time in the last 6 hours: Docker (100%).');
  });
  it('rejects a bad window with exit 2', async () => {
    const dir = dirs();
    expect((await run(['--history', '--since', 'soon'], dir)).code).toBe(2);
    expect((await run(['--history', '--since', '30d'], dir)).code).toBe(2);
    expect((await run(['--history', '--by-tree'], dir)).code).toBe(2);
    expect((await run(['--history', '--history'], dir)).code).toBe(2);
  });
});
