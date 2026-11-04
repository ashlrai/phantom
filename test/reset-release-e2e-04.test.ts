/**
 * RQ-PHX-RESETRELEASEE2E04 — end-to-end proof that Phantom itself releases a
 * usage-limit autobackoff hold on codex-personal once the personal Codex
 * session logs show the window reset (Mason's inbox lesson: the fleet detects
 * resets and available usage itself; the Oct 31 19:28 zero-waste order:
 * personal Codex sat at 100% left while its lane stayed held).
 *
 * Unlike the unit and command suites, nothing here injects the ledger or the
 * reset rows: the fixture is one fake rollout file under a fake
 * `$HOME/.codex-2` (the home `runs-resource-ledger.ts` resolves when no
 * `personalCodexHome` option is given — never the real ~/.codex or
 * ~/.codex-2), plus real runs-dir state. The command then walks the real
 * chain: collectCodexSessionUsages -> buildCodexResourceReport ->
 * readResourceLedger (observation { source: 'codex-personal-sessions' }) ->
 * readUsageResets -> runResetReleaseOnce -> releaseLaneHold -> bus notice.
 *
 * Timeline (UTC): the dispatcher's last tick at 18:00 still read 100% used;
 * autobackoff placed the hold at 19:00 (T0); the rollout's newest rate-limit
 * snapshot is at T0+30m reading 3% (reset); the verb runs at T0+45m.
 */
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cmdFleetResetRelease } from '../src/cli/fleet-reset-release.js';
import { listBusInboxAfter, type BusInboxReceipt } from '../src/core/fleet/bus-inbox.js';
import { readLaneTargets } from '../src/core/fleet/runs-lane-targets.js';
import { readResourceLedger } from '../src/core/fleet/runs-resource-ledger.js';
import { readUsageResets } from '../src/core/fleet/usage-reset-detect.js';
import { readResetReleases } from '../src/core/fleet/usage-reset-release.js';

const T0_MS = Date.parse('2026-10-31T19:00:00Z');
const TICK_ISO = '2026-10-31T18:00:00Z';
const FRESH_READING_MS = T0_MS + 30 * 60_000;
const STALE_READING_MS = T0_MS - 10 * 60_000;
const FRESH_READING_ISO = new Date(FRESH_READING_MS).toISOString();
const STALE_READING_ISO = new Date(STALE_READING_MS).toISOString();
const NOW_MS = T0_MS + 45 * 60_000;
const NOW_ISO = new Date(NOW_MS).toISOString();
const HELD_UNTIL = '2026-11-04T00:00:00Z'; // autobackoff's guess, still days out
const WEEKLY_RESET_S = Math.floor(Date.parse('2026-11-05T00:00:00Z') / 1000);
const SESSION_RESET_S = Math.floor((FRESH_READING_MS + 4 * 3_600_000) / 1000); // 4h out: session window
const AUTOBACKOFF_REASON = `autobackoff job=j-fake-e2e04 usage-limit until=${HELD_UNTIL} src=usage`;
const MANUAL_REASON = 'manual: usage-limit review by operator';

let root: string;
let runsDir: string;
let fakeHome: string;
let personalCodexHome: string;
let busRoot: string;

/** The minimal allowlisted rollout a codex CLI writes; plainly fake values only. */
function rolloutLines(observedIso: string, usedPct: number): unknown[] {
  const base = Date.parse(observedIso);
  const meta = new Date(base - 60_000).toISOString();
  const ctx = new Date(base - 30_000).toISOString();
  return [
    { timestamp: meta, type: 'session_meta',
      payload: { timestamp: meta, originator: 'codex_cli_rs', cli_version: '0.99.0' } },
    { timestamp: ctx, type: 'turn_context', payload: { model: 'gpt-5.4-codex' } },
    { timestamp: observedIso, type: 'event_msg', payload: {
      type: 'token_count', info: { total_token_usage: { total_tokens: 12345 } },
      rate_limits: {
        limit_id: 'codex', plan_type: 'pro',
        primary: { used_percent: usedPct, window_minutes: 300, resets_at: SESSION_RESET_S },
        secondary: { used_percent: usedPct, window_minutes: 10_080, resets_at: WEEKLY_RESET_S },
      },
    } },
  ];
}

/** Real on-disk state: a held lane in slots.json, a stale dispatchd tick, one rollout. */
async function seed(opts: { readingMs: number; heldBy: string; heldReason: string }): Promise<void> {
  await writeFile(join(runsDir, 'queue/slots.json'), JSON.stringify({
    'codex-personal': {
      target: 1, floor: 0, ceiling: 4, held: true,
      held_reason: opts.heldReason, held_until: HELD_UNTIL,
      held_by: opts.heldBy, last_change: T0_MS / 1000,
    },
  }, null, 1));
  await writeFile(join(runsDir, 'queue/status.json'), JSON.stringify({
    last_tick: TICK_ISO,
    lanes: { 'codex-personal': { running: 0, target: 1, held: true } },
    budget: { 'codex-personal': { weekly_used_pct: 100, reset_at: HELD_UNTIL } },
  }));
  const observedIso = new Date(opts.readingMs).toISOString();
  const day = join(personalCodexHome, 'sessions', '2026', '10', '31');
  await mkdir(day, { recursive: true });
  await writeFile(
    join(day, 'rollout-2026-10-31T00-00-00-e2e04aaa.jsonl'),
    `${rolloutLines(observedIso, 3).map((line) => JSON.stringify(line)).join('\n')}\n`,
    { mode: 0o600 },
  );
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'reset-release-e2e04-')));
  runsDir = join(root, 'runs');
  fakeHome = join(root, 'home');
  personalCodexHome = join(fakeHome, '.codex-2');
  busRoot = join(root, 'ashlr', 'fleet');
  await mkdir(join(runsDir, 'queue'), { recursive: true });
  await mkdir(personalCodexHome, { recursive: true });
  // HOME drives homedir() (test/setup/home.ts), which is where
  // readResourceLedger resolves `<home>/.codex-2`; ASHLR_HOME is where the
  // default bus inbox lands. Both stay inside this mkdtemp — never real state.
  vi.stubEnv('HOME', fakeHome);
  vi.stubEnv('ASHLR_HOME', join(root, 'ashlr'));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

interface CommandReport {
  v: number; mode: string; at: string; sourceState: string; checked: number;
  planned: { lane: string; state: string }[];
  released: { lane: string; state: string; usedPct: number | null; readingAsOf: string | null; heldUntil: string | null }[];
  errors: { lane: string; message: string }[];
}

/** The real verb entry: real readUsageResets, real release path, real bus. */
async function runApply(): Promise<{ code: number; stderr: string; json: CommandReport | null }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await cmdFleetResetRelease(['--apply', '--json', '--runs-dir', runsDir], {
    now: () => NOW_MS,
    output: (text) => out.push(text),
    error: (text) => err.push(text),
  });
  return {
    code, stderr: err.join('\n'),
    json: out[0]?.startsWith('{') ? JSON.parse(out[0]) as CommandReport : null,
  };
}

const laneRow = async () =>
  (await readLaneTargets({ runsDir })).lanes.find((l) => l.lane === 'codex-personal');
const resetRow = async () =>
  (await readUsageResets({ runsDir, now: () => NOW_MS })).rows.find((r) => r.lane === 'codex-personal');
const ledgerRow = async () =>
  (await readResourceLedger({ runsDir, now: () => NOW_MS })).lanes.find((r) => r.lane === 'codex-personal');
const busMessages = (): BusInboxReceipt[] => {
  const page = listBusInboxAfter(0, 50, { root: busRoot, now: () => NOW_MS });
  return page.status === 'ok' ? page.messages : [];
};
const auditLines = async () => (await readFile(join(runsDir, 'queue/reset-releases.jsonl'), 'utf8'))
  .trim().split('\n').filter(Boolean);

it('releases the autobackoff usage hold when the personal session log proves the window reset', async () => {
  await seed({ readingMs: FRESH_READING_MS, heldBy: 'autobackoff', heldReason: AUTOBACKOFF_REASON });
  // Step 2 link: the raw rollout became a codex-personal ledger row carrying
  // the session observation (usedPct 3, asOf = the rollout timestamp).
  expect(await ledgerRow()).toMatchObject({
    usedPct: 3,
    observation: { source: 'codex-personal-sessions', asOf: FRESH_READING_ISO },
  });
  // Step 3 link: reading newer than the hold + used <= 25 => releasable.
  expect(await resetRow()).toMatchObject({
    state: 'reset-detected', releasable: true, heldBy: 'autobackoff',
    usedPct: 3, readingAsOf: FRESH_READING_ISO,
  });
  const { code, stderr, json } = await runApply();
  expect(stderr).toBe('');
  expect(code).toBe(0);
  expect(json).toMatchObject({
    v: 1, mode: 'apply', at: NOW_ISO, sourceState: 'healthy', checked: 1, errors: [],
    planned: [{ lane: 'codex-personal', state: 'reset-detected' }],
  });
  expect(json!.released).toEqual([{
    lane: 'codex-personal', state: 'reset-detected', usedPct: 3,
    readingAsOf: FRESH_READING_ISO, heldUntil: HELD_UNTIL,
  }]);
  // Step 4 link: the hold is gone from the real runs-dir file.
  expect(await laneRow()).toMatchObject({ held: false, changedBy: expect.stringContaining('reset-detect') });
  expect(await readResetReleases(runsDir)).toEqual([{
    v: 1, at: NOW_ISO, by: 'reset-detect', lane: 'codex-personal', state: 'reset-detected',
    usedPct: 3, readingAsOf: FRESH_READING_ISO, heldUntil: HELD_UNTIL,
    reason: `window reset: reads 3% at ${FRESH_READING_ISO}`,
  }]);
  expect(await readFile(join(runsDir, 'dispatch-events.log'), 'utf8'))
    .toContain(`LANE_HOLD released codex-personal by reset-detect: window reset: reads 3% at ${FRESH_READING_ISO}`);
  // Exactly one bus notice reached the default inbox.
  const notices = busMessages();
  expect(notices).toHaveLength(1);
  expect(notices[0]!.envelope.body).toMatchObject({
    kind: 'lane-released', lane: 'codex-personal', at: NOW_ISO, by: 'reset-detect', usedPct: 3,
  });
});

it('releases nothing when the rollout reading is older than the hold (stale-reading)', async () => {
  await seed({ readingMs: STALE_READING_MS, heldBy: 'autobackoff', heldReason: AUTOBACKOFF_REASON });
  // The stale reading still reaches the ledger (it is newer than the 18:00
  // tick); detection alone must refuse it because it predates the hold.
  expect(await ledgerRow()).toMatchObject({
    usedPct: 3,
    observation: { source: 'codex-personal-sessions', asOf: STALE_READING_ISO },
  });
  expect(await resetRow()).toMatchObject({
    state: 'stale-reading', releasable: false, usedPct: 3, readingAsOf: STALE_READING_ISO,
  });
  const { code, json } = await runApply();
  expect(code).toBe(0);
  expect(json).toMatchObject({ sourceState: 'healthy', released: [], errors: [], planned: [] });
  expect(await laneRow()).toMatchObject({ held: true, heldReason: AUTOBACKOFF_REASON });
  expect(existsSync(join(runsDir, 'queue/reset-releases.jsonl'))).toBe(false);
  expect(existsSync(join(runsDir, 'dispatch-events.log'))).toBe(false);
  expect(busMessages()).toEqual([]);
});

it('never releases a manual hold even with a fresh reset-looking reading', async () => {
  await seed({ readingMs: FRESH_READING_MS, heldBy: 'Mason t0000u', heldReason: MANUAL_REASON });
  expect(await resetRow()).toMatchObject({ state: 'manual-hold', releasable: false, heldBy: 'manual' });
  const { code, json } = await runApply();
  expect(code).toBe(0);
  expect(json).toMatchObject({ sourceState: 'healthy', released: [], errors: [], planned: [] });
  expect(await laneRow()).toMatchObject({ held: true, heldReason: MANUAL_REASON });
  expect(existsSync(join(runsDir, 'queue/reset-releases.jsonl'))).toBe(false);
  expect(busMessages()).toEqual([]);
});

it('a second --apply releases nothing and writes no second notice', async () => {
  await seed({ readingMs: FRESH_READING_MS, heldBy: 'autobackoff', heldReason: AUTOBACKOFF_REASON });
  const first = await runApply();
  expect(first.json!.released).toHaveLength(1);
  const second = await runApply();
  expect(second.code).toBe(0);
  expect(second.json).toMatchObject({ released: [], errors: [] });
  expect(await laneRow()).toMatchObject({ held: false });
  expect(await auditLines()).toHaveLength(1);
  const events = await readFile(join(runsDir, 'dispatch-events.log'), 'utf8');
  expect(events.match(/LANE_HOLD released/g)).toHaveLength(1);
  expect(busMessages()).toHaveLength(1);
});
