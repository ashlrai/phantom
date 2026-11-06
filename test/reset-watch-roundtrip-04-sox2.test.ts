import { appendFile, mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cmdFleetResetWatch } from '../src/cli/fleet-reset-watch.js';
import { listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import { readLaneTargets } from '../src/core/fleet/runs-lane-targets.js';
import { readUsageResets } from '../src/core/fleet/usage-reset-detect.js';
import { readResetReleases } from '../src/core/fleet/usage-reset-release.js';

const heldAt = Date.parse('2026-10-31T19:00:00Z');
const exhaustedAt = new Date(heldAt + 10 * 60_000).toISOString();
const recoveredAt = new Date(heldAt + 30 * 60_000).toISOString();
const now = heldAt + 45 * 60_000;
const heldUntil = '2026-11-04T00:00:00Z';
const resetSeconds = Math.floor(Date.parse('2026-11-05T00:00:00Z') / 1000);
const manualReason = 'manual: usage-limit review by operator';
let root: string;
let runsDir: string;
let rollout: string;
let busRoot: string;

function reading(timestamp: string, usedPct: number): string {
  return JSON.stringify({ timestamp, type: 'event_msg', payload: {
    type: 'token_count', info: { total_token_usage: { total_tokens: 12345 } },
    rate_limits: { limit_id: 'codex', plan_type: 'pro',
      primary: { used_percent: usedPct, window_minutes: 300, resets_at: Math.floor((heldAt + 4 * 3_600_000) / 1000) },
      secondary: { used_percent: usedPct, window_minutes: 10_080, resets_at: resetSeconds } },
  } });
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'reset-watch-roundtrip-')));
  runsDir = join(root, 'runs');
  const home = join(root, 'home');
  const sessions = join(home, '.codex-2', 'sessions', '2026', '10', '31');
  rollout = join(sessions, 'rollout-2026-10-31T00-00-00-e2e04aaa.jsonl');
  busRoot = join(root, 'ashlr', 'fleet');
  await mkdir(join(runsDir, 'queue'), { recursive: true });
  await mkdir(sessions, { recursive: true });
  vi.stubEnv('HOME', home);
  vi.stubEnv('ASHLR_HOME', join(root, 'ashlr'));
  vi.spyOn(Date, 'now').mockReturnValue(now);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

async function seed(manual: boolean): Promise<void> {
  await writeFile(join(runsDir, 'queue/slots.json'), JSON.stringify({
    'codex-personal': { target: 1, floor: 0, ceiling: 4, held: true,
      held_reason: manual ? manualReason : `autobackoff job=j-fake usage-limit until=${heldUntil} src=usage`,
      held_until: heldUntil, held_by: manual ? 'Mason t0000u' : 'autobackoff', last_change: heldAt / 1000 },
  }));
  await writeFile(join(runsDir, 'queue/status.json'), JSON.stringify({
    last_tick: '2026-10-31T18:00:00Z',
    lanes: { 'codex-personal': { running: 0, target: 1, held: true } },
    budget: { 'codex-personal': { weekly_used_pct: 100, reset_at: heldUntil } },
  }));
  await writeFile(rollout, [
    JSON.stringify({ timestamp: '2026-10-31T19:01:00Z', type: 'session_meta',
      payload: { timestamp: '2026-10-31T19:01:00Z', originator: 'codex_cli_rs', cli_version: '0.99.0' } }),
    JSON.stringify({ timestamp: '2026-10-31T19:02:00Z', type: 'turn_context', payload: { model: 'gpt-5.4-codex' } }),
    reading(exhaustedAt, 100), '',
  ].join('\n'), { mode: 0o600 });
}

async function watch(): Promise<{ records: Array<Record<string, unknown>>; code: number }> {
  const records: Array<Record<string, unknown>> = [];
  const observations: Array<{ usedPct: number | null; readingAsOf: string | null; state: string } | undefined> = [];
  const stopFile = join(root, 'stop');
  let sleeps = 0;
  const beforeInt = process.listeners('SIGINT');
  const beforeTerm = process.listeners('SIGTERM');
  try {
    const code = await cmdFleetResetWatch([
      '--timeout-ms', '10000', '--poll-ms', '1', '--runs-dir', runsDir, '--stop-file', stopFile, '--json',
    ], {
      now: () => 0,
      emit: async (line) => {
        const record = JSON.parse(line) as Record<string, unknown>;
        records.push(record);
        if (record.type === 'pass') observations.push(
          (await readUsageResets({ runsDir })).rows.find((row) => row.lane === 'codex-personal'),
        );
      },
      sleep: async () => {
        sleeps += 1;
        if (sleeps === 1) {
          await appendFile(rollout, `${reading(recoveredAt, 3)}\n`);
        }
        if (sleeps === 3) await writeFile(stopFile, '');
      },
    });
    expect(observations[0]).toMatchObject({ usedPct: 100, readingAsOf: exhaustedAt });
    expect(observations[1]).toMatchObject({ usedPct: 3, readingAsOf: recoveredAt });
    return { records, code };
  } finally {
    expect(process.listeners('SIGINT')).toEqual(beforeInt);
    expect(process.listeners('SIGTERM')).toEqual(beforeTerm);
  }
}

it.each([false, true])('observes recovery across passes and respects manual hold=%s', async (manual) => {
  await seed(manual);
  const { code, records } = await watch();
  expect(code).toBe(130);
  expect(records.map((record) => record.type)).toEqual(['pass', 'pass', 'pass', 'end']);
  expect(records.slice(0, 3).map((record) => record.released)).toEqual(manual ? [0, 0, 0] : [0, 1, 0]);
  expect(records[3]).toMatchObject({ outcome: 'cancelled', passes: 3, released: manual ? 0 : 1, errors: 0 });
  const lane = (await readLaneTargets({ runsDir })).lanes.find((row) => row.lane === 'codex-personal');
  expect(lane).toMatchObject(manual
    ? { held: true, heldReason: manualReason }
    : { held: false, changedBy: expect.stringContaining('reset-detect') });
  const audit = await readResetReleases(runsDir);
  expect(audit).toHaveLength(manual ? 0 : 1);
  if (!manual) expect(audit[0]).toMatchObject({ lane: 'codex-personal', by: 'reset-detect',
    state: 'reset-detected', usedPct: 3, readingAsOf: recoveredAt });
  const inbox = listBusInboxAfter(0, 50, { root: busRoot, now: () => now });
  expect(inbox.status).toBe('ok');
  if (inbox.status === 'ok') {
    expect(inbox.messages).toHaveLength(manual ? 0 : 1);
    if (!manual) expect(inbox.messages[0]!.envelope.body).toMatchObject({
      kind: 'lane-released', lane: 'codex-personal', by: 'reset-detect', usedPct: 3,
    });
  }
});
