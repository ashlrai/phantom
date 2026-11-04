/**
 * RQ-PHX-RESETWATCHREALPATH04SOZ2 — the headless `fleet reset-watch` command
 * notices a freshly refreshed provider reading on a LATER poll and releases
 * only its own autobackoff hold, with the desktop closed.
 *
 * Nothing in the release chain is injected: the real cmdFleetResetWatch runs
 * the real runResetReleaseOnce -> readUsageResets -> readResourceLedger ->
 * releaseLaneHold against a temp runs dir and one plainly fake rollout under
 * `<temp home>/.codex-2` (the personal home the ledger resolves from HOME).
 * The command exposes no clock seam for the pass itself, so the pass reads the
 * real clock; every timestamp below is relative to the real "now" and the
 * poll interval is small and real. The refresh is appended to the rollout from
 * the command's own JSONL `emit` seam, i.e. between two completed passes.
 */
import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cmdFleetResetWatch } from '../src/cli/fleet-reset-watch.js';
import { listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import { readResetReleases } from '../src/core/fleet/usage-reset-release.js';

const HOUR = 3_600_000;
const POLL_MS = 40;
const OUTER_TIMEOUT_MS = 15_000; // the command's own bound; the test ends far sooner
const STOP_BUDGET_MS = 1_500;    // stop-file slices are 250 ms; this is generous slack
const AUTOBACKOFF_LANE = 'codex-personal';
const MANUAL_LANE = 'fake-manual-lane';
const MANUAL_REASON = 'manual: usage-limit review by operator (fake)';

let root: string, runsDir: string, busRoot: string, stopFile: string, rollout: string;
let sigint: number, sigterm: number;

/** One allowlisted rollout line carrying a rate-limit snapshot; fake values only. */
const snapshot = (atMs: number, usedPct: number): string => JSON.stringify({
  timestamp: new Date(atMs).toISOString(), type: 'event_msg',
  payload: {
    type: 'token_count', info: { total_token_usage: { total_tokens: 1 } },
    rate_limits: {
      limit_id: 'codex', plan_type: 'pro',
      primary: { used_percent: usedPct, window_minutes: 300, resets_at: Math.floor((atMs + 4 * HOUR) / 1000) },
      secondary: { used_percent: usedPct, window_minutes: 10_080, resets_at: Math.floor((atMs + 3 * 24 * HOUR) / 1000) },
    },
  },
}) + '\n';

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'reset-watch-live-soz2-')));
  runsDir = join(root, 'runs');
  busRoot = join(root, 'ashlr', 'fleet');
  stopFile = join(root, 'stop.sentinel');
  const personal = join(root, 'home', '.codex-2');
  const day = join(personal, 'sessions', '2026', '11', '04');
  rollout = join(day, 'rollout-2026-11-04T00-00-00-soz2fake.jsonl');
  await mkdir(join(runsDir, 'queue'), { recursive: true });
  await mkdir(day, { recursive: true });
  vi.stubEnv('HOME', join(root, 'home'));
  vi.stubEnv('ASHLR_HOME', join(root, 'ashlr'));
  vi.stubEnv('ASHLR_RUNS_DIR', runsDir);
  sigint = process.listenerCount('SIGINT');
  sigterm = process.listenerCount('SIGTERM');

  const now = Date.now();
  const heldSince = Math.floor((now - 2 * HOUR) / 1000);
  const heldUntil = new Date(now + 3 * 24 * HOUR).toISOString(); // autobackoff's guess, days out
  await writeFile(join(runsDir, 'queue/slots.json'), JSON.stringify({
    [AUTOBACKOFF_LANE]: {
      target: 1, floor: 0, ceiling: 4, held: true, held_by: 'autobackoff', held_until: heldUntil,
      held_reason: `autobackoff job=j-fake-soz2 usage-limit until=${heldUntil} src=usage`, last_change: heldSince,
    },
    [MANUAL_LANE]: {
      target: 1, floor: 0, ceiling: 4, held: true, held_by: 'Mason t0000u', held_until: heldUntil,
      held_reason: MANUAL_REASON, last_change: heldSince,
    },
  }, null, 1));
  await writeFile(join(runsDir, 'queue/status.json'), JSON.stringify({
    last_tick: new Date(now - 3 * HOUR).toISOString(),
    lanes: { [AUTOBACKOFF_LANE]: { running: 0, target: 1, held: true } },
    budget: { [AUTOBACKOFF_LANE]: { weekly_used_pct: 100, reset_at: heldUntil } },
  }));
  // Exhausted reading, newer than the hold: consistent with it, so nothing may release.
  await writeFile(rollout, [
    { timestamp: new Date(now - 3 * HOUR).toISOString(), type: 'session_meta',
      payload: { originator: 'codex_cli_rs', cli_version: '0.0.0-fake' } },
  ].map(line => JSON.stringify(line)).join('\n') + '\n' + snapshot(now - HOUR, 100), { mode: 0o600 });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

const slots = async (): Promise<Record<string, Record<string, unknown>>> =>
  JSON.parse(await readFile(join(runsDir, 'queue/slots.json'), 'utf8'));
const waitFor = async (test: () => boolean, label: string): Promise<void> => {
  const end = Date.now() + OUTER_TIMEOUT_MS;
  while (!test()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
};

it('releases only the autobackoff hold on a later poll once a fresh low reading lands, exactly once', async () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('desktop route must not be called'));
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const records: { type: string; released?: number; lanes?: string[]; outcome?: string }[] = [];
  let refreshed = false;
  let code: number | undefined;
  let stopAt = 0;
  const watch = cmdFleetResetWatch(
    ['--timeout-ms', String(OUTER_TIMEOUT_MS), '--poll-ms', String(POLL_MS), '--runs-dir', runsDir,
      '--stop-file', stopFile, '--bus-root', busRoot, '--json'],
    {
      emit: async line => {
        const record = JSON.parse(line);
        records.push(record);
        // First completed pass: still exhausted. Refresh the provider reading now,
        // between this pass and the next one.
        if (record.type === 'pass' && !refreshed) {
          refreshed = true;
          await appendFile(rollout, snapshot(Date.now() - 1_000, 3));
        }
      },
    },
  ).then(result => { code = result; return result; });
  try {
    const passes = () => records.filter(r => r.type === 'pass');
    await waitFor(() => passes().some(r => r.released === 1), 'the releasing pass');
    // Unchanged fresh evidence across several more polls must not release again.
    const base = passes().length;
    await waitFor(() => passes().length >= base + 3, 'repeat polls after the release');
    // Cancel through the command's existing stop-file sentinel and time the return.
    await writeFile(stopFile, '');
    stopAt = Date.now();
    await watch;
    expect(Date.now() - stopAt).toBeLessThan(STOP_BUDGET_MS);
    expect(code).toBe(130);

    const all = passes();
    expect(all[0]).toMatchObject({ released: 0, lanes: [] });
    expect(all.filter(r => r.released === 1)).toHaveLength(1);
    expect(all.filter(r => r.released! > 0).flatMap(r => r.lanes!)).toEqual([AUTOBACKOFF_LANE]);
    expect(records.at(-1)).toMatchObject({ type: 'end', outcome: 'cancelled', released: 1 });

    // Hold gone from slots.json; the manual lane is untouched.
    const after = await slots();
    expect(after[AUTOBACKOFF_LANE]!.held).toBeFalsy();
    expect(JSON.stringify(after[AUTOBACKOFF_LANE])).not.toMatch(/autobackoff/);
    expect(after[MANUAL_LANE]).toMatchObject({ held: true, held_by: 'Mason t0000u', held_reason: MANUAL_REASON });

    // One audit release for that lane, one narrated event, no manual-lane entries.
    const audit = await readResetReleases(runsDir);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ lane: AUTOBACKOFF_LANE, by: 'reset-detect', state: 'reset-detected', usedPct: 3 });
    expect((await readFile(join(runsDir, 'dispatch-events.log'), 'utf8')).match(/LANE_HOLD released/g)).toHaveLength(1);
    expect(await readFile(join(runsDir, 'dispatch-events.log'), 'utf8')).not.toContain(MANUAL_LANE);

    // Bus delivery landed in the isolated root: one lane-released notice, plus the watcher's own records.
    const page = listBusInboxAfter(0, 100, { root: busRoot });
    if (page.status !== 'ok') throw new Error('bus unavailable');
    const bodies = page.messages.map(message => message.envelope.body as Record<string, unknown>);
    expect(bodies.filter(body => body.kind === 'lane-released')).toHaveLength(1);
    expect(bodies.find(body => body.kind === 'lane-released')).toMatchObject({ lane: AUTOBACKOFF_LANE, by: 'reset-detect' });
    expect(bodies[0]).toMatchObject({ kind: 'reset-watch.start.v1' });
    expect(bodies.some(body => body.kind === 'reset-watch.end.v1')).toBe(true);

    // Headless: no desktop route was reached, and no stderr noise from a bus failure.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
  } finally {
    // Always stop the watch and prove it left no listeners, even if an assertion failed.
    await writeFile(stopFile, '').catch(() => undefined);
    await watch.catch(() => undefined);
    expect(process.listenerCount('SIGINT')).toBe(sigint);
    expect(process.listenerCount('SIGTERM')).toBe(sigterm);
  }
}, OUTER_TIMEOUT_MS + 5_000);
