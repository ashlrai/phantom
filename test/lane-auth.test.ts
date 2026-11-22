/** Fixture tests for lanes.auth.v1 (`phm fleet lane-auth`): synthetic jobs and presence, no real home, no credential values. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetLaneAuth } from '../src/cli/fleet-lane-auth.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
import { asksText, listAsks } from '../src/core/fleet/asks.js';
import {
  buildLaneAuth, formatLaneAuthText, laneAuthDigestLine, probePresence, raiseLaneAuthAsks, readLaneAuth, LANE_AUTH_SCHEMA,
  type LaneFinish, type Presence,
} from '../src/core/fleet/lane-auth.js';
import { buildStatusDigest } from '../src/core/leader/status-digest.js';
import { gatherStatusDigestInput } from '../src/core/leader/status-digest-sources.js';
import { readFleetRunsDirState } from '../src/core/fleet/runs-dir-state.js';

const NOW = Date.parse('2026-11-19T22:00:00.000Z');
const ago = (hours: number) => NOW - hours * 3_600_000;
const finish = (lane: string, hours: number, empty: boolean, authFailed = false): LaneFinish => ({ lane, at: ago(hours), empty, authFailed });
const build = (presence: Record<string, Presence>, finishes: LaneFinish[] = [], unused: Record<string, number | null> = {}, held: Record<string, string> = {}) =>
  buildLaneAuth({ nowMs: NOW, lanes: Object.keys(presence).map(lane => ({ lane, heldReason: held[lane] ?? null })), presence, finishes, unusedPct: unused });
const row = (data: ReturnType<typeof build>, lane: string) => data.lanes.find(r => r.lane === lane)!;

describe('lane sign-in state', () => {
  it('missing_signin when the presence check finds nothing, with the plain fix', () => {
    const r = row(build({ gemini: 'absent' }, [], { gemini: 85 }), 'gemini');
    expect(r).toMatchObject({ state: 'missing_signin', fix: 'Run `gemini` once in a terminal to sign in', needs_mason: true });
  });
  it('expired when a sign-in exists but a recent job was refused and none worked since', () => {
    const r = row(build({ claude: 'present' }, [finish('claude', 3, true, true), finish('claude', 5, false)]), 'claude');
    expect(r).toMatchObject({ state: 'expired', auth_failures: 1, needs_mason: false });
    expect(r.fix).toContain('phm authority claude-signin');
  });
  it('a job that worked after the refusal clears it; one older than 24 h is ignored', () => {
    expect(row(build({ claude: 'present' }, [finish('claude', 5, true, true), finish('claude', 2, false)]), 'claude').state).toBe('ok');
    expect(row(build({ claude: 'present' }, [finish('claude', 30, true, true)]), 'claude').state).toBe('ok');
  });
  it('ok when the sign-in exists and nothing was refused', () => {
    const r = row(build({ devin: 'present' }), 'devin');
    expect(r).toMatchObject({ state: 'ok', fix: null, needs_mason: false });
  });
  it('unknown with no presence check and no job evidence; ok when a job worked; expired when refused', () => {
    expect(row(build({ codex: 'unknown' }), 'codex')).toMatchObject({ state: 'unknown', fix: null });
    expect(row(build({ codex: 'unknown' }, [finish('codex', 1, false)]), 'codex').state).toBe('ok');
    expect(row(build({ codex: 'unknown' }, [finish('codex', 1, true, true)]), 'codex').state).toBe('expired');
  });
  it('a sign-in hold reason counts as a refusal', () => {
    expect(row(build({ zai: 'unknown' }, [], {}, { zai: 'needs sign-in' }), 'zai')).toMatchObject({ state: 'expired', fix: expect.stringContaining('Sign in to Zai') });
  });
  it('no Asks card when the unused plan is small or unknown', () => {
    expect(row(build({ gemini: 'absent' }, [], { gemini: 10 }), 'gemini').needs_mason).toBe(false);
    expect(row(build({ gemini: 'absent' }), 'gemini').needs_mason).toBe(false);
  });
  it('orders blocked lanes first and carries the schema id', () => {
    const data = build({ claude: 'present', gemini: 'absent', codex: 'unknown' });
    expect(data.schema).toBe(LANE_AUTH_SCHEMA);
    expect(data.lanes.map(r => r.lane)).toEqual(['gemini', 'codex', 'claude']);
    expect(JSON.stringify(data)).not.toMatch(/token|secret|password|cookie/i);
  });
  it('prints plain text and a digest line', () => {
    const data = build({ gemini: 'absent', devin: 'absent', claude: 'present' }, [], { gemini: 85, devin: 40 });
    expect(formatLaneAuthText(data)).toContain('gemini: missing_signin (85% of its plan would go unused)\n  Run `gemini` once in a terminal to sign in.');
    expect(laneAuthDigestLine(data)).toBe('Sign-in: Gemini is not signed in, 85% of its plan unused. Run `gemini` once in a terminal to sign in. (+1 more: phm fleet lane-auth)');
    expect(laneAuthDigestLine(build({ claude: 'present' }))).toBeNull();
  });
  it('puts the line in the hourly digest', () => {
    const lines = buildStatusDigest({
      installedVersion: { ok: true, value: '1' }, publishedVersion: { ok: true, value: '1' }, updatePending: false,
      mergesLastHour: { ok: true, value: 1 }, mergesLast24h: { ok: true, value: 2 }, lanes: { ok: true, value: [] },
      needsMason: { ok: true, value: 0 }, topP0: { ok: true, value: null }, authLine: 'Sign-in: Gemini is not signed in.',
    });
    expect(lines).toContain('Sign-in: Gemini is not signed in.');
  });
});

describe('presence checks', () => {
  it('reads only existence, and never looks under ~/.codex*', async () => {
    const seen: string[] = [];
    const out = await probePresence(['gemini', 'devin', 'devin-flash', 'claude', 'codex', 'codex-local'], {
      home: '/home/x', exists: p => { seen.push(p); return p.endsWith('oauth_creds.json'); }, hasEnv: () => false, hasDevinKey: async () => false,
    });
    expect(out).toEqual({ gemini: 'present', devin: 'absent', 'devin-flash': 'absent', claude: 'unknown', codex: 'unknown', 'codex-local': 'unknown' });
    expect(seen.some(p => p.includes('.codex'))).toBe(false);
    expect((await probePresence(['gemini'], { home: '/h', exists: () => false, hasEnv: n => n === 'GEMINI_API_KEY' })).gemini).toBe('present');
  });
});

describe('Asks card and reader', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'laneauth-')); mkdirSync(join(dir, 'metrics'), { recursive: true }); writeFileSync(join(dir, 'NEEDS-MASON.md'), ''); });
  afterEach(() => { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });

  it('raises one open ask per blocked lane, once, and the Asks list renders it', async () => {
    const data = build({ gemini: 'absent', devin: 'absent' }, [], { gemini: 85, devin: 5 });
    const ids = await raiseLaneAuthAsks(data, { runsDir: dir, now: () => NOW });
    expect(ids).toHaveLength(1);
    expect(await raiseLaneAuthAsks(data, { runsDir: dir, now: () => NOW })).toEqual(ids);
    const list = listAsks({ runsDir: dir, now: () => NOW });
    expect(list.asks).toHaveLength(1);
    expect(list.asks[0]).toMatchObject({ kind: 'signin', type: 'password', subject: 'gemini' });
    const text = asksText(list).join('\n');
    expect(text).toContain('Run `gemini` once in a terminal to sign in. Gemini will waste about 85% of its included usage');
    expect(text).toContain('Gemini usage that would otherwise expire');
  });
  it('does not add a second card when the lane already has an open ask', async () => {
    writeFileSync(join(dir, 'NEEDS-MASON.md'), 'ask:password@gemini Sign in to Gemini once: run gemini in a terminal. (asked 2026-11-19T21:00:00.000Z)\n');
    await raiseLaneAuthAsks(build({ gemini: 'absent' }, [], { gemini: 85 }), { runsDir: dir, now: () => NOW });
    expect(listAsks({ runsDir: dir, now: () => NOW }).asks).toHaveLength(1);
  });
  it('reads the job ledger and log tails: auth_failed text makes a lane expired', async () => {
    const rows = [
      { event: 'launch', job: 'RQ-A1', lane: 'zai', ts: new Date(ago(2)).toISOString() },
      { event: 'finish', job: 'RQ-A1', lane: 'zai', empty: true, exit_code: 1, ts: new Date(ago(2)).toISOString() },
    ];
    writeFileSync(join(dir, 'metrics', 'jobs.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
    writeFileSync(join(dir, 'RQ-A1.log'), 'starting\nError: not logged in. Please log in again.\n');
    const data = await readLaneAuth({ runsDir: dir, now: () => NOW, probes: { home: dir, exists: () => false, hasEnv: () => false, hasDevinKey: async () => true } });
    expect(row(data, 'zai')).toMatchObject({ state: 'expired', auth_failures: 1 });
    expect(data.lanes.map(r => r.lane)).toEqual(['zai']);
  });
  it('reuses a current signin card even when its request wording differs', async () => {
    const { raiseAsk } = await import('../src/core/fleet/asks.js');
    const existing = raiseAsk('password', 'Sign in to Gemini.', { runsDir: dir, now: () => NOW }, { subject: 'gemini', unblocks: 'Gemini usage that would otherwise expire' });
    expect(existing.ok).toBe(true);
    expect(listAsks({ runsDir: dir, now: () => NOW }).asks[0]?.kind).toBe('signin');
    const ids = await raiseLaneAuthAsks(build({ gemini: 'absent' }, [], { gemini: 85 }), { runsDir: dir, now: () => NOW });
    expect(ids).toEqual([existing.ok ? existing.id : 'unreachable']);
    expect(listAsks({ runsDir: dir, now: () => NOW }).asks).toHaveLength(1);
  });
  it('ignores job ids outside the runs directory', async () => {
    writeFileSync(join(dir, 'metrics', 'jobs.jsonl'), JSON.stringify({ event: 'finish', job: '../outside', lane: 'zai', empty: true, ts: new Date(ago(1)).toISOString() }));
    const data = await readLaneAuth({ runsDir: dir, now: () => NOW });
    expect(data.lanes).toEqual([]);
    expect(data.gaps).toContain('The dispatcher status could not be read, so lane targets and holds are unknown.');
  });
  it('gathers sign-in evidence with the digest clock and raises its card', async () => {
    const authModule = await import('../src/core/fleet/lane-auth.js');
    const data = build({ gemini: 'absent' }, [], { gemini: 85 });
    const read = vi.spyOn(authModule, 'readLaneAuth').mockResolvedValue(data);
    const input = await gatherStatusDigestInput(dir, new Date(NOW), {
      installedVersion: () => '1', publishedVersion: async () => '1',
      mergeFacts: async () => ({ shipped: [], mergeCountUnavailable: false }),
      runsState: () => readFleetRunsDirState({ runsDir: dir, now: () => NOW }),
      needs: () => ({ status: 'missing', items: [] }), inbox: async () => ({ sourceState: 'missing', entries: [] }),
      mergeLatency: undefined, workClaims: undefined, peers: undefined, nodeRuns: undefined,
      gapLine: undefined, diskLine: undefined, supplyLine: undefined, wasteLine: undefined,
      yieldLine: undefined, notLiveLine: undefined, blocker: undefined,
    });
    expect(read.mock.calls[0]?.[0]?.runsDir).toBe(dir);
    expect(read.mock.calls[0]?.[0]?.now?.()).toBe(NOW);
    expect(buildStatusDigest(input)).toContain(laneAuthDigestLine(data));
    expect(listAsks({ runsDir: dir, now: () => NOW }).asks).toHaveLength(1);
  });
});

describe('fleet lane-auth command', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
  it('is reachable through the generated registry and renders JSON and text', async () => {
    expect((await FLEET_SUBCOMMAND_LOADERS['lane-auth']!()).cmdFleetLaneAuth).toBe(cmdFleetLaneAuth);
    const report = build({ gemini: 'absent' }, [], { gemini: 85 });
    const read = vi.fn<typeof readLaneAuth>(async () => report), raise = vi.fn<typeof raiseLaneAuthAsks>(async () => []);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleetLaneAuth(['--json'], { read, raise })).toBe(0);
    expect(JSON.parse(log.mock.calls[0]![0])).toEqual(report);
    expect(raise).toHaveBeenCalledWith(report, { runsDir: read.mock.calls[0]?.[0]?.runsDir });
    expect(await cmdFleetLaneAuth([], { read, raise })).toBe(0);
    expect(log.mock.calls[1]![0]).toContain('gemini: missing_signin');
  });
  it('uses the selected runs directory for both the report and Asks cards', async () => {
    vi.stubEnv('ASHLR_RUNS_DIR', ' /fixture/lane-auth-runs ');
    const report = build({ gemini: 'absent' }, [], { gemini: 85 });
    const auth = await import('../src/core/fleet/lane-auth.js');
    const read = vi.spyOn(auth, 'readLaneAuth').mockResolvedValue(report);
    const raise = vi.spyOn(auth, 'raiseLaneAuthAsks').mockResolvedValue([]);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const command = await FLEET_SUBCOMMAND_LOADERS['lane-auth']!();
    expect(await (command.cmdFleetLaneAuth as typeof cmdFleetLaneAuth)(['--json'])).toBe(0);
    expect(read).toHaveBeenCalledWith({ runsDir: '/fixture/lane-auth-runs' });
    expect(raise).toHaveBeenCalledWith(report, { runsDir: '/fixture/lane-auth-runs' });
    expect(JSON.parse(log.mock.calls[0]![0] as string)).toEqual(report);
  });
  it.each(['', '   ', undefined])('uses the home default when ASHLR_RUNS_DIR is %j', async runsDir => {
    vi.stubEnv('ASHLR_RUNS_DIR', runsDir);
    const report = build({});
    const read = vi.fn<typeof readLaneAuth>(async () => report), raise = vi.fn<typeof raiseLaneAuthAsks>(async () => []);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleetLaneAuth([], { read, raise })).toBe(0);
    const expected = join(homedir(), '.ashlr-runs');
    expect(read).toHaveBeenCalledWith({ runsDir: expected });
    expect(raise).toHaveBeenCalledWith(report, { runsDir: expected });
  });
  it('handles help and rejects invalid or duplicate flags before reading', async () => {
    const read = vi.fn(async () => build({}));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdFleetLaneAuth(['--help'], { read })).toBe(0);
    expect(await cmdFleetLaneAuth(['--json', '--json'], { read })).toBe(2);
    expect(await cmdFleetLaneAuth(['--apply'], { read })).toBe(2);
    expect(await cmdFleetLaneAuth(['--bad'], { read })).toBe(2);
    expect(read).not.toHaveBeenCalled();
  });
});
