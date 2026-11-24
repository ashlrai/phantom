import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetPulse } from '../src/cli/fleet-pulse.js';
import { createFleetRunsApi } from '../src/core/verse/fleet-runs-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import {
  buildPulseAlerts, notifyPulseAlerts, pulseAlertsText, readPulseAlerts, PULSE_ALERTS_SCHEMA, PULSE_NOTIFY_STATE,
  type PulseAlertInputs,
} from '../src/core/fleet/pulse-alerts.js';
import { throughputMarks } from '../src/core/fleet/throughput.js';
import type { SpendRow, SpendSnapshot } from '../src/core/usage/spend.js';
import type { StarvedRead } from '../src/core/fleet/lane-starved.js';

const NOW = Date.parse('2026-11-19T12:00:00Z');
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();
const row = (event: string, minutesAgo: number, extra: Record<string, unknown>) => JSON.stringify({ event, ts: at(minutesAgo), ...extra });
const launch = (n: number, lane: string, minutesAgo: number) => row('launch', minutesAgo, { job: `RQ-FAKE-${n}`, lane, repo: 'phantom' });
const finish = (n: number, lane: string, minutesAgo: number, empty: boolean) => row('finish', minutesAgo, { job: `RQ-FAKE-${n}`, lane, empty });
const marksOf = (...lines: string[]) => throughputMarks(lines.join('\n'), NOW - 72 * 3_600_000, NOW).marks;
const calm: StarvedRead = { lanes: { claude: { free_slots: 0, ready_rows: 2, starved: false, starved_since: null, line: null } }, waiting_elsewhere: 0, open_rows: 0 };
const pool = (extra: Partial<SpendRow>): SpendRow => ({ pool: 'claude', unit: 'percent', reason: null, usedPercent: 50, resetAt: null, hoursLeft: 10, burnPerHour: 4, projectedUnusedPercent: 5,
  projectedUsedPercent: 95, remainingUsd: null, projectedUnusedUsd: null, verdict: 'on-pace', status: 'on-pace', summary: 'on pace', resetsIn: '10h 0m', ...extra });
const spend = (...pools: SpendRow[]): SpendSnapshot => ({ schema: 'usage.spend.v1', v: 1, asOf: at(1), headline: 'x', pools });
/** A busy, healthy fleet: a launch two minutes ago, a calm lane snapshot, every pool on pace. */
const quiet = (): PulseAlertInputs => ({ marks: marksOf(launch(1, 'claude', 2), finish(1, 'claude', 1, false)), starved: calm, spend: spend(pool({})) });

describe('buildPulseAlerts', () => {
  it('a quiet fleet has no alerts and reads "All lanes busy."', () => {
    const pulse = buildPulseAlerts(quiet(), NOW);
    expect(pulse).toEqual({ schema: PULSE_ALERTS_SCHEMA, v: 1, as_of: at(0), alerts: [], unknown: [] });
    expect(pulseAlertsText(pulse)).toEqual(['All lanes busy.']);
  });

  it('stalled: no launch and no merge for 30 minutes is an incident; 29 is not', () => {
    const merged = row('outcome', 40, { job: 'RQ-FAKE-9', url: 'https://github.com/ashlrai/phantom/pull/9', state: 'MERGED', mergedAt: at(40) });
    const stalled = buildPulseAlerts({ ...quiet(), marks: marksOf(launch(1, 'claude', 50), merged) }, NOW);
    expect(stalled.alerts).toEqual([{ kind: 'stalled', lane: 'fleet', since: at(40), detail: 'No job has started and no PR has merged for 40 minutes.',
      fix_hint: expect.stringContaining('dispatcher') }]);
    expect(buildPulseAlerts({ ...quiet(), marks: marksOf(launch(1, 'claude', 29)) }, NOW).alerts).toEqual([]);
    expect(buildPulseAlerts({ ...quiet(), marks: marksOf(launch(1, 'claude', 30)) }, NOW).alerts[0]).toMatchObject({ kind: 'stalled', since: at(30) });
    expect(buildPulseAlerts({ ...quiet(), marks: [] }, NOW).alerts[0]!.detail).toBe('No job has started and no PR has merged in the last 72 hours.');
  });

  it('starved: free slots with nothing queued for 30 minutes; younger or unrecorded ones are not alerts', () => {
    const starved = (since: string | null): StarvedRead => ({ ...calm, lanes: { zai: { free_slots: 2, ready_rows: 0, starved: true, starved_since: since, line: 'x' } } });
    expect(buildPulseAlerts({ ...quiet(), starved: starved(at(45)) }, NOW).alerts).toEqual([{ kind: 'starved', lane: 'zai', since: at(45),
      detail: 'zai has 2 free slots and nothing queued for 45 minutes.', fix_hint: 'Add jobs for zai: phm fleet idle-lanes.' }]);
    expect(buildPulseAlerts({ ...quiet(), starved: starved(at(10)) }, NOW).alerts).toEqual([]);
    const unrecorded = buildPulseAlerts({ ...quiet(), starved: starved(null) }, NOW);
    expect(unrecorded.alerts).toEqual([]);
    expect(unrecorded.unknown).toEqual(['Starved: zai has free slots and nothing queued, but how long is not recorded yet.']);
  });

  it('wasting: EMPTY above 40% over a lane\'s last 20 jobs; exactly 40% and thin evidence stay quiet', () => {
    const jobs = (lane: string, empties: number, total: number, base: number) => Array.from({ length: total }, (_, i) => finish(base + i, lane, 100 + i, i < empties));
    // grok: 9 of 20 = 45%. claude: 8 of 20 = 40%, not above. zai: 3 of 3 EMPTY, too few jobs to say.
    const marks = marksOf(launch(1, 'claude', 1), ...jobs('grok', 9, 20, 100), ...jobs('claude', 8, 20, 200), ...jobs('zai', 3, 3, 300));
    const wasting = buildPulseAlerts({ ...quiet(), marks }, NOW).alerts;
    expect(wasting).toEqual([{ kind: 'wasting', lane: 'grok', since: at(119), detail: 'grok: 9 of its last 20 jobs finished EMPTY (45%).', fix_hint: expect.stringContaining('empty-causes') }]);
    // Only the last 20 count: 10 old EMPTY jobs followed by 20 clean ones is a clean lane.
    const recovered = marksOf(launch(1, 'claude', 1), ...Array.from({ length: 30 }, (_, i) => finish(400 + i, 'grok', 100 + i, i >= 20)));
    expect(buildPulseAlerts({ ...quiet(), marks: recovered }, NOW).alerts).toEqual([]);
  });

  it('pool_waste: a plan projected to end its window more than 10% unused; 10% and on-pace pools are quiet', () => {
    const behind = (name: string, unused: number | null) => pool({ pool: name, status: 'behind', verdict: 'behind', projectedUnusedPercent: unused });
    const pulse = buildPulseAlerts({ ...quiet(), spend: spend(behind('codex-cmp', 35.4), behind('zai', 10), pool({ pool: 'claude' }), behind('devin', null)) }, NOW);
    expect(pulse.alerts).toEqual([{ kind: 'pool_waste', lane: 'codex-cmp', since: null, detail: 'codex-cmp is on track to leave 35% unused when it resets in 10h 0m.',
      fix_hint: 'Queue more jobs for codex-cmp before it resets.' }]);
    expect(pulse.unknown).toEqual(['Pool waste: devin is behind pace, but the unused share is not known.']);
  });

  it('unreadable inputs are listed as unknown, never as fine', () => {
    const pulse = buildPulseAlerts({ marks: null, starved: null, spend: null }, NOW);
    expect(pulse.alerts).toEqual([]);
    expect(pulse.unknown).toEqual(['Stalled, wasting: the job metrics file could not be read.', 'Starved: the lane snapshot could not be read.', 'Pool waste: the spend snapshot could not be read.']);
    expect(pulseAlertsText(pulse)[0]).toBe('No alerts.');
  });

  it('orders alerts stalled, starved, wasting, pool_waste', () => {
    const starved: StarvedRead = { ...calm, lanes: { zai: { free_slots: 1, ready_rows: 0, starved: true, starved_since: at(60), line: 'x' } } };
    const marks = marksOf(...Array.from({ length: 6 }, (_, i) => finish(i, 'grok', 200 + i, true)));
    const sp = spend(pool({ pool: 'claude', status: 'behind', verdict: 'behind', projectedUnusedPercent: 50 }));
    expect(buildPulseAlerts({ marks, starved, spend: sp }, NOW).alerts.map(a => a.kind)).toEqual(['stalled', 'starved', 'wasting', 'pool_waste']);
  });
});

describe('notifyPulseAlerts and readPulseAlerts', () => {
  let runs: string;
  beforeEach(async () => { runs = await mkdtemp(join(tmpdir(), 'pulse-alerts-')); });
  afterEach(async () => { await rm(runs, { recursive: true, force: true }); });
  const stalled = (): PulseAlertInputs => ({ ...quiet(), marks: [] });

  it('dedupe: the second call within the hour sends nothing; an hour later it sends again', async () => {
    const email = vi.fn(async () => undefined), telegram = vi.fn(async () => ({ ok: true }));
    const call = (now: number) => readPulseAlerts({ runsDir: runs, now, notify: true, read: async () => stalled(), senders: { email, telegram } });
    await call(NOW);
    expect(email).toHaveBeenCalledTimes(1);
    expect(telegram).toHaveBeenCalledTimes(1);
    expect(email.mock.calls[0]![0]).toMatch(/^Phantom alert: No job has started and no PR has merged .* Check that the dispatcher is running/);
    await call(NOW + 59 * 60_000);
    expect(email).toHaveBeenCalledTimes(1);
    await call(NOW + 61 * 60_000);
    expect(email).toHaveBeenCalledTimes(2);
  });

  it('a different alert still sends, and a failed send is retried on the next call', async () => {
    const send = vi.fn(async () => ({ ok: false }));
    const pulse = buildPulseAlerts(stalled(), NOW);
    expect(await notifyPulseAlerts(pulse, { runsDir: runs, now: NOW, senders: { telegram: send } })).toEqual([]);
    expect(await notifyPulseAlerts(pulse, { runsDir: runs, now: NOW + 1000, senders: { telegram: send } })).toEqual([]);
    expect(send).toHaveBeenCalledTimes(2);
    const ok = vi.fn(async () => undefined);
    const two = buildPulseAlerts({ ...stalled(), spend: spend(pool({ status: 'behind', verdict: 'behind', projectedUnusedPercent: 40 })) }, NOW);
    expect((await notifyPulseAlerts(two, { runsDir: runs, now: NOW + 2000, senders: { email: ok } })).map(a => a.kind)).toEqual(['stalled', 'pool_waste']);
    expect((await notifyPulseAlerts(two, { runsDir: runs, now: NOW + 3000, senders: { email: ok } }))).toEqual([]);
    expect(Object.keys(JSON.parse(await readFile(join(runs, PULSE_NOTIFY_STATE), 'utf8')))).toEqual(['stalled:fleet', 'pool_waste:claude']);
  });

  it('a plain read sends nothing', async () => {
    const email = vi.fn(async () => undefined);
    await readPulseAlerts({ runsDir: runs, now: NOW, read: async () => stalled(), senders: { email } });
    expect(email).not.toHaveBeenCalled();
  });
});

describe('phm fleet pulse --alerts', () => {
  afterEach(() => vi.restoreAllMocks());
  const pulse = buildPulseAlerts({ ...quiet(), marks: [] }, NOW);
  const run = async (args: string[], alerts = pulse) => {
    const out: string[] = [], err: string[] = [], notify: boolean[] = [];
    vi.spyOn(console, 'log').mockImplementation((text: string) => { out.push(text); });
    vi.spyOn(console, 'error').mockImplementation((text: string) => { err.push(text); });
    const fail = async () => { throw new Error('wrong reader'); };
    const code = await cmdFleetPulse(args, fail, fail, async n => { notify.push(n); return alerts; });
    return { code, out: out.join('\n'), err: err.join('\n'), notify };
  };
  it('prints typed JSON with a schema id, plain words, sends by default and only looks with --no-notify', async () => {
    const json = await run(['--alerts', '--json']);
    expect(json.code).toBe(0);
    expect(JSON.parse(json.out)).toMatchObject({ schema: 'fleet.pulse.alerts.v1', v: 1, as_of: at(0), alerts: [{ kind: 'stalled', lane: 'fleet', since: expect.any(String), detail: expect.any(String), fix_hint: expect.any(String) }], unknown: [] });
    expect(json.notify).toEqual([true]);
    expect((await run(['--json', '--alerts'])).out).toBe(json.out);
    expect((await run(['--alerts', '--no-notify'])).notify).toEqual([false]);
    expect((await run(['--alerts'])).out).toMatch(/^1 alert:\n {2}fleet: No job has started/);
    expect((await run(['--alerts'], buildPulseAlerts(quiet(), NOW))).out).toBe('All lanes busy.');
    expect((await run(['--help'])).out).toContain('fleet.pulse.alerts.v1');
  });
  it('rejects combinations that mean nothing', async () => {
    for (const args of [['--alerts', '--lanes'], ['--no-notify'], ['--alerts', '--alerts'], ['--alerts', '--by']]) expect((await run(args)).code).toBe(2);
  });
});

describe('the desktop and phone API', () => {
  it('serves fleet.pulse.alerts.v1 and asks to notify; non-GET is refused', async () => {
    const read = vi.fn(async () => buildPulseAlerts(quiet(), NOW));
    const api = createFleetRunsApi({ runsDir: '/nowhere', now: () => NOW, readPulseAlerts: read }), path = '/api/verse/fleet/runs/pulse/alerts';
    const send = async (method: string) => {
      const req = Object.assign(Readable.from([]), { url: path, method, headers: {} }) as unknown as IncomingMessage;
      let status = 0, body = '';
      const res = { headersSent: false, writeHead(code: number) { status = code; }, end(text: string) { body = text; } } as unknown as ServerResponse;
      expect(await api({ cfg: {}, token: 'fake', allowDispatch: false } as VerseApiContext, req, res, path, method)).toBe(true);
      return { status, body };
    };
    const ok = await send('GET');
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body)).toMatchObject({ schema: 'fleet.pulse.alerts.v1', alerts: [] });
    expect(read).toHaveBeenCalledWith({ runsDir: '/nowhere', now: NOW, notify: true });
    expect((await send('POST')).status).toBe(405);
  });
});
