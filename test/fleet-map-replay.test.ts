import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdMap } from '../src/cli/map.js';
import { BUS_INBOX_MAX_MESSAGES, appendBusInbox, type BusInboxReceipt } from '../src/core/fleet/bus-inbox.js';
import { formatMapReplayText, parseStep, replayMap, MAP_REPLAY_SCHEMA, type MapReplay } from '../src/core/fleet/map-replay.js';
import { buildMapReplay, readMapReplay } from '../src/core/fleet/map-replay-build.js';
import { buildFleetLiveMap } from '../src/core/fleet/live-map.js';
import type { WorklogEntry } from '../src/core/fleet/worklog.js';
import { createFleetLiveMapApi, MAP_REPLAY_PATH } from '../src/core/verse/fleet-live-map-api.js';

const T = (hh: number, mm: number) => Date.UTC(2026, 10, 18, hh, mm, 0);
const NOW = T(12, 0), SINCE = T(11, 0), STEP = 15 * 60_000;
const entry = (job: string, kind: WorklogEntry['kind'], at: number): WorklogEntry => ({ job, repo: 'phantom', lane: 'claude', model: null, kind, at: new Date(at).toISOString(),
  mergedAt: null, openToMergeSeconds: null, url: kind === 'pr' || kind === 'merged' ? 'https://github.com/ashlrai/phantom/pull/7' : null, goal: null, detail: null });
const receipt = (from: string, to: string, receivedAt: number, n = 1): BusInboxReceipt => ({ cursor: n, receivedAt,
  envelope: { id: `${from}-${to}-${receivedAt}-${n}`, from, to, priority: 'P2', ttl: 3_600_000, body: { text: 'start the work' } } });
const bus = (rows: BusInboxReceipt[], source: 'available' | 'unavailable' = 'available') => ({ source, rows, skipped: 0 });
// RQ-AAA launches at 11:20, opens a PR at 11:40 and merges at 11:50. RQ-BBB launches at 11:05 and is still running.
const ENTRIES = [entry('RQ-AAA', 'launch', T(11, 20)), entry('RQ-AAA', 'pr', T(11, 40)), entry('RQ-AAA', 'merged', T(11, 50)), entry('RQ-BBB', 'launch', T(11, 5))];
const frames = (replay: MapReplay) => replay.frames.map(frame => frame.at.slice(11, 16));
const names = (rows: { job: string }[] | null) => rows?.map(row => row.job);
afterEach(() => vi.restoreAllMocks());

describe('buildMapReplay', () => {
  const replay = buildMapReplay({ entries: ENTRIES, bus: bus([receipt('claude', 'RQ-BBB', T(11, 32))]), since: SINCE, now: NOW, stepMs: STEP });

  it('has the stable schema, one frame per step, oldest first', () => {
    expect(Object.keys(replay)).toEqual(['schema', 'version', 'generatedAt', 'since', 'until', 'stepSeconds', 'sources', 'frames', 'gaps']);
    expect(replay).toMatchObject({ schema: MAP_REPLAY_SCHEMA, version: 1, stepSeconds: 900, sources: { jobs: 'available', messages: 'available', pools: 'unknown' }, gaps: ['Pools unknown: no pool usage history has been recorded.'] });
    // New frame fields are appended, so `fleet.map-replay.v1` readers of the older keys keep working.
    expect(Object.keys(replay.frames[0]!)).toEqual(['from', 'at', 'state', 'running', 'launched', 'prsOpened', 'merged', 'messages', 'lanes', 'pools']);
    expect(frames(replay)).toEqual(['11:15', '11:30', '11:45', '12:00']);
    expect(replay.frames.every(frame => frame.state === 'known')).toBe(true);
  });

  it('launch then merge shows in the right frames', () => {
    expect(replay.frames.map(frame => names(frame.launched))).toEqual([['RQ-BBB'], ['RQ-AAA'], [], []]);
    expect(replay.frames.map(frame => names(frame.prsOpened))).toEqual([[], [], ['RQ-AAA'], []]);
    expect(replay.frames.map(frame => names(frame.merged))).toEqual([[], [], [], ['RQ-AAA']]);
    // RQ-AAA runs from its launch until its PR; RQ-BBB never ended.
    expect(replay.frames.map(frame => names(frame.running))).toEqual([['RQ-BBB'], ['RQ-AAA', 'RQ-BBB'], ['RQ-BBB'], ['RQ-BBB']]);
    expect(replay.frames[3]!.merged![0]).toEqual({ job: 'RQ-AAA', lane: 'claude', repo: 'phantom', url: 'https://github.com/ashlrai/phantom/pull/7' });
  });

  it('a message line appears only in its own frame, built by buildMapEdges', () => {
    expect(replay.frames.map(frame => frame.messages?.length)).toEqual([0, 0, 1, 0]);
    expect(replay.frames[2]!.messages![0]).toMatchObject({ id: 'claude->RQ-BBB', count: 1, from: { node: 'lane:claude' }, to: { node: 'job:RQ-BBB' } });
  });

  it('a message on a frame boundary is counted once', () => {
    const edge = buildMapReplay({ entries: [], bus: bus([receipt('claude', 'RQ-BBB', T(11, 15))]), since: SINCE, now: NOW, stepMs: STEP });
    expect(edge.frames.map(frame => frame.messages?.length)).toEqual([0, 1, 0, 0]);
  });

  it('an unreadable jobs ledger is unknown, not an empty fleet', () => {
    const none = buildMapReplay({ entries: null, bus: bus([receipt('claude', 'RQ-BBB', T(11, 32))]), since: SINCE, now: NOW, stepMs: STEP });
    expect(none.sources.jobs).toBe('unknown');
    for (const frame of none.frames) expect(frame).toMatchObject({ state: 'partly-unknown', running: null, launched: null, prsOpened: null, merged: null });
    expect(none.frames[2]!.messages).toHaveLength(1);
    expect(none.gaps[0]).toContain('Jobs unknown');
    const both = buildMapReplay({ entries: null, bus: bus([], 'unavailable'), since: SINCE, now: NOW, stepMs: STEP });
    expect(both.frames.every(frame => frame.state === 'unknown' && frame.messages === null && frame.running === null)).toBe(true);
    expect(formatMapReplayText(both)).toContain('11:15Z  history unknown');
    expect(formatMapReplayText(both)).toContain('0 of 4 frames known');
  });

  it('history older than a full bus keeps is unknown for messages only', () => {
    const rows = Array.from({ length: BUS_INBOX_MAX_MESSAGES }, (_, i) => receipt('claude', 'RQ-BBB', T(11, 30) + i, i));
    const full = buildMapReplay({ entries: ENTRIES, bus: bus(rows), since: SINCE, now: NOW, stepMs: STEP });
    expect(full.frames.map(frame => frame.state)).toEqual(['partly-unknown', 'partly-unknown', 'known', 'known']);
    expect(full.frames[0]!.messages).toBeNull();
    expect(full.frames[0]!.running).not.toBeNull();
    expect(full.gaps.join()).toContain('Messages before 2026-11-18 11:30 UTC are unknown');
  });

  it('is deterministic', () => {
    expect(JSON.stringify(buildMapReplay({ entries: [...ENTRIES].reverse(), bus: bus([receipt('claude', 'RQ-BBB', T(11, 32))]), since: SINCE, now: NOW, stepMs: STEP }))).toBe(JSON.stringify(replay));
  });
});

describe('replayMap', () => {
  const live = buildFleetLiveMap({ now: NOW });
  it('keeps the live nodes, draws the frame jobs and message lines, and names what is unknown', () => {
    const replay = buildMapReplay({ entries: ENTRIES, bus: bus([receipt('leader', 'claude', T(11, 32))]), since: SINCE, now: NOW, stepMs: STEP });
    const map = replayMap(live, replay.frames[2]!, replay.stepSeconds);
    expect(map.generatedAt).toBe('2026-11-18T11:45:00.000Z');
    expect(map.nodes.filter(node => node.kind === 'job').map(node => node.id)).toEqual(['job:RQ-BBB']);
    expect(map.nodes.find(node => node.id === 'leader')).toBeTruthy();
    expect(map.windowMinutes).toBe(15);
    expect(map.counts.jobs).toBe(1);
    const unknown = replayMap(live, buildMapReplay({ entries: null, bus: bus([], 'unavailable'), since: SINCE, now: NOW, stepMs: STEP }).frames[0]!, 900);
    expect(unknown.nodes.some(node => node.kind === 'job')).toBe(false);
    expect(unknown.sources).toMatchObject({ jobs: 'unknown', messages: 'unknown' });
    expect(unknown.counts.messages).toBeNull();
    expect(unknown.gaps).toEqual(expect.arrayContaining(['Jobs unknown: nothing recorded for this time.', 'Messages unknown: nothing recorded for this time.']));
  });
});

describe('parseStep', () => {
  it('takes whole steps of a minute or more', () => {
    expect(parseStep('5m')).toBe(300_000);
    expect(parseStep('1h')).toBe(3_600_000);
    for (const bad of ['30s', '0m', '5', 'soon', '-5m', '5.5m']) expect(parseStep(bad)).toBeNull();
  });
});

describe('readMapReplay, the CLI and the API', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
  function fleet() {
    const dir = mkdtempSync(join(tmpdir(), 'map-replay-')); dirs.push(dir);
    const runsDir = join(dir, 'runs'), root = join(dir, 'bus');
    mkdirSync(join(runsDir, 'metrics'), { recursive: true });
    const row = (event: string, job: string, at: number, extra: object = {}) => JSON.stringify({ event, job, ts: new Date(at).toISOString(), lane: 'claude', repo: 'phantom', ...extra });
    writeFileSync(join(runsDir, 'metrics', 'jobs.jsonl'), [row('launch', 'RQ-AAA', T(11, 20)), row('publish', 'RQ-AAA', T(11, 40), { url: 'https://github.com/ashlrai/phantom/pull/7' }),
      row('merged', 'RQ-AAA', T(11, 50), { url: 'https://github.com/ashlrai/phantom/pull/7' })].join('\n') + '\n');
    appendBusInbox({ id: 'm1', from: 'claude', to: 'RQ-AAA', priority: 'P2', ttl: 86_400_000, body: { text: 'go' } }, { root, now: () => T(11, 32) });
    return { runsDir, root };
  }

  it('reads the ledger and the bus into frames', async () => {
    const { runsDir, root } = fleet();
    const read = await readMapReplay('1h', '15m', { runsDir, root, now: () => NOW });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.replay.frames.map(frame => names(frame.running))).toEqual([[], ['RQ-AAA'], [], []]);
    expect(read.replay.frames[3]!.merged).toHaveLength(1);
    expect(read.replay.frames[2]!.messages).toHaveLength(1);
  });

  it('a missing ledger is unknown jobs', async () => {
    const read = await readMapReplay('1h', '15m', { runsDir: join(tmpdir(), 'map-replay-none'), root: join(tmpdir(), 'map-replay-no-bus'), now: () => NOW });
    expect(read.ok && read.replay.sources.jobs).toBe('unknown');
    expect(read.ok && read.replay.frames[0]!.running).toBeNull();
  });

  it('refuses bad ranges in plain words', async () => {
    for (const [since, step] of [['soon', '5m'], ['6h', '30s'], ['2d', '1m'], ['0s', '5m']] as const) {
      const read = await readMapReplay(since, step, { now: () => NOW });
      expect(read.ok).toBe(false);
    }
  });

  it('phm map replay prints JSON or text and refuses bad flags', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {}), err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await cmdMap(['replay', '--json', '--since', '1h', '--step', '30m']);
    const printed = JSON.parse(log.mock.calls[0]![0] as string) as MapReplay;
    expect(printed).toMatchObject({ schema: 'fleet.map-replay.v1', version: 1, stepSeconds: 1800 });
    expect(printed.frames).toHaveLength(2);
    expect(await cmdMap(['replay'])).toBeLessThanOrEqual(1);
    expect(log.mock.calls[1]![0]).toMatch(/^Fleet replay /);
    for (const bad of [['replay', '--since'], ['replay', '--step', '10s'], ['replay', '--since', '1m', '--step', '1m', '--hours', '2'], ['replay', '--json', '--json']]) expect(await cmdMap(bad)).toBe(2);
    expect(err).toHaveBeenCalledTimes(4);
    expect(await cmdMap(['--help'])).toBe(0);
    expect(log.mock.calls.at(-1)![0]).toContain('phm map replay [--json] [--since <6h|90m|1d|ISO>] [--step <5m|1h>]');
  });

  it('GET map-replay needs a read session, validates its query and serves fleet.map-replay.v1', async () => {
    const replay = buildMapReplay({ entries: ENTRIES, bus: bus([]), since: SINCE, now: NOW, stepMs: STEP });
    const read = vi.fn(async (since?: string) => since === 'bad' ? { ok: false as const, error: 'bad since' } : { ok: true as const, replay });
    const api = createFleetLiveMapApi(undefined, undefined, undefined, undefined, read);
    const send = async (url: string, session = Date.now() + 60_000) => {
      let status = 0, body = '';
      const res = { writeHead: (s: number) => { status = s; return res; }, setHeader: () => res, end: (b?: string) => { body = b ?? ''; }, statusCode: 0 } as never;
      await api({ readSession: { expiresAt: session } } as never, { url } as never, res, url.split('?')[0]!, 'GET');
      return { status, body: body ? JSON.parse(body) : null };
    };
    expect((await send(MAP_REPLAY_PATH, Date.now() - 1)).status).toBe(401);
    expect((await send(`${MAP_REPLAY_PATH}?hours=2`)).status).toBe(400);
    expect((await send(`${MAP_REPLAY_PATH}?since=bad`)).body).toEqual({ error: 'bad since' });
    const ok = await send(`${MAP_REPLAY_PATH}?since=6h&step=5m`);
    expect(ok.status).toBe(200);
    expect(ok.body.schema).toBe('fleet.map-replay.v1');
    expect(read).toHaveBeenLastCalledWith('6h', '5m');
  });
});

describe('pool and lane history in a frame', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
  const reading = (pool: string, at: number, used_pct: number) => ({ pool, used_pct, observed_at: new Date(at).toISOString(), reset_at: null, source: null });
  const build = (usage: ReturnType<typeof reading>[] | null) => buildMapReplay({ entries: ENTRIES, bus: bus([]), usage, since: SINCE, now: NOW, stepMs: STEP });

  it('takes pool used % from the nearest reading at or before the frame, not today', () => {
    const replay = build([reading('claude', T(11, 10), 40), reading('claude', T(11, 40), 55), reading('claude', T(11, 59), 70)]);
    expect(replay.frames.map(frame => frame.pools)).toEqual([
      [{ pool: 'claude', usedPct: 40 }], [{ pool: 'claude', usedPct: 40 }], [{ pool: 'claude', usedPct: 55 }], [{ pool: 'claude', usedPct: 70 }]]);
    expect(replay.sources.pools).toBe('available');
    // Lane counts come from the jobs running in that frame.
    expect(replay.frames.map(frame => frame.lanes)).toEqual([
      [{ lane: 'claude', running: 1 }], [{ lane: 'claude', running: 2 }], [{ lane: 'claude', running: 1 }], [{ lane: 'claude', running: 1 }]]);
  });

  it('shows unknown when no reading is within 30 minutes, and on the map', () => {
    const replay = build([reading('claude', T(11, 10), 40)]);
    // 11:15 is 5 min after the reading; 11:45 is 35 min after it.
    expect(replay.frames.map(frame => frame.pools![0]!.usedPct)).toEqual([40, 40, null, null]);
    expect(replay.frames[2]!.pools).toEqual([{ pool: 'claude', usedPct: null }]);
    const live = buildFleetLiveMap({ org: null, computers: null, usage: null, lanes: null, now: NOW } as never);
    live.nodes.push({ id: 'resource:claude', kind: 'resource', level: 4, label: 'claude weekly quota', provider: 'unknown', status: 'available', detail: '99% used', live: null, usedPct: 99 });
    const shown = replayMap(live, replay.frames[2]!, 900).nodes.find(node => node.id === 'resource:claude')!;
    expect(shown).toMatchObject({ usedPct: null, status: 'unknown', detail: 'usage unknown then' });
    expect(live.nodes.find(node => node.id === 'resource:claude')!.usedPct).toBe(99);
    expect(build(null).frames.every(frame => frame.pools === null)).toBe(true);
    expect(build(null).sources.pools).toBe('unknown');
  });

  function ledger(lines: string[]) {
    const dir = mkdtempSync(join(tmpdir(), 'map-replay-')); dirs.push(dir);
    mkdirSync(join(dir, 'runs', 'metrics'), { recursive: true });
    writeFileSync(join(dir, 'runs', 'metrics', 'jobs.jsonl'), lines.join('\n') + '\n');
    return { runsDir: join(dir, 'runs'), root: join(dir, 'bus') };
  }
  const launch = (job: string, at: number) => JSON.stringify({ event: 'launch', job, ts: new Date(at).toISOString(), lane: 'claude', repo: 'phantom' });

  it('shows a job launched 30 hours before the window as running', async () => {
    const files = ledger([launch('RQ-OLD', NOW - 30 * 3_600_000 - 3_600_000)]);
    const read = await readMapReplay('1h', '30m', { ...files, now: () => NOW });
    expect(read.ok && read.replay.frames.map(frame => names(frame.running))).toEqual([['RQ-OLD'], ['RQ-OLD']]);
    expect(read.ok && read.replay.frames[0]!.lanes).toEqual([{ lane: 'claude', running: 1 }]);
  });

  it('reads only the end of a big ledger and says what it could not see', async () => {
    const filler = Array.from({ length: 200 }, (_, i) => launch(`RQ-F${i}`, NOW - 3_000_000 + i * 1_000));
    const files = ledger([launch('RQ-OLD', NOW - 30 * 3_600_000), ...filler]);
    const read = await readMapReplay('1h', '30m', { ...files, now: () => NOW, ledgerMaxBytes: 4_000 });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(names(read.replay.frames[0]!.running)).not.toContain('RQ-OLD');
    expect(read.replay.gaps.some(gap => /newest part of the jobs ledger/.test(gap))).toBe(true);
    const whole = await readMapReplay('1h', '30m', { ...files, now: () => NOW });
    expect(whole.ok && names(whole.replay.frames[0]!.running)).toContain('RQ-OLD');
    expect(whole.ok && whole.replay.gaps.some(gap => /newest part/.test(gap))).toBe(false);
  });
});
