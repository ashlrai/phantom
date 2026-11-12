/**
 * RQ-PHX-CLAUDERESETRECOVER196S — recovery of the held-Claude quota refresh
 * preserved from PR #5214 (head 0b797022f1ed3d214404d1af8bd3121ac6018801),
 * itself the port of test/fleet-reset-release-claude-probe-04.test.ts.
 * `fleet reset-release --apply` refreshes a stale usage-exhaustion-held Claude
 * reading once before reading the reset snapshot, so an agent can reconsider
 * an exhaustion hold without a manual `fleet claude-quota --write`. Dry-run,
 * --help and invalid arguments never probe or write; a missing command, a
 * failed probe or unhealthy evidence cannot release a lane; a manual hold
 * stays held through the existing guarded release path. Every probe here is
 * a fake — no real claude process is spawned.
 */
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cmdFleetResetRelease } from '../src/cli/fleet-reset-release.js';
import {
  refreshHeldClaudeQuota, type ClaudeProbeOutcome, type Probe,
} from '../src/core/fleet/claude-quota-refresh.js';
import { writeClaudeQuotaReading } from '../src/core/fleet/claude-quota-reading.js';
import { readLaneTargets } from '../src/core/fleet/runs-lane-targets.js';
import type { ClaudeAccountUsageResult } from '../src/core/resources/claude-account-usage.js';
import type { ClaudeAccountStatusOptions } from '../src/core/resources/claude-account-status.js';

const NOW_MS = Date.parse('2026-11-12T12:00:00Z');
const NOW_ISO = new Date(NOW_MS).toISOString();
const HELD_SINCE = '2026-11-11T12:00:00Z';
const HELD_UNTIL = '2026-11-17T00:00:00Z';

let runsDir: string;
const slot = (held: boolean, reason: string | null, heldBy = 'autobackoff') => ({
  target: 1, floor: 0, ceiling: 2, held,
  ...(held ? { held_reason: reason, held_until: HELD_UNTIL, held_by: heldBy } : {}),
  last_change: Date.parse(HELD_SINCE) / 1000,
});
const seed = async (slots: Record<string, unknown>) => {
  await mkdir(join(runsDir, 'queue'), { recursive: true });
  await writeFile(join(runsDir, 'queue/slots.json'), JSON.stringify(slots));
  await writeFile(join(runsDir, 'queue/status.json'), JSON.stringify({ last_tick: NOW_ISO, lanes: {} }));
};
const AUTOBACKOFF = `autobackoff claude job=j-1 until=${HELD_UNTIL} src=fake`;
const MANUAL = 'manual: operator hold';
const usage = (usedPercent: number): ClaudeAccountUsageResult => ({
  schemaVersion: 1, scope: 'claude-native-auth-status', status: 'observed', reason: 'observed',
  loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max',
  accountHint: 'operator@example.com', startedAt: NOW_ISO, finishedAt: NOW_ISO,
  quotaFresh: true,
  windows: [{ id: 'seven_day', usedPercent, resetsAt: '2026-11-12T10:00:00Z' }],
} as unknown as ClaudeAccountUsageResult);
const quotaFile = () => join(runsDir, 'metrics/claude-quota.json');
const claudeLane = async () => (await readLaneTargets({ runsDir })).lanes.find(l => l.lane === 'claude');

interface Payload {
  mode?: string; claudeProbe?: string; sourceState?: string; checked?: number;
  planned?: { lane: string; state?: string; usedPct?: number | null; readingAsOf?: string | null; heldUntil?: string | null }[];
  released?: { lane: string; state?: string }[];
  errors?: { lane: string; message: string }[];
}
type RefreshFn = (opts: { runsDir: string; now: () => number }) => Promise<ClaudeProbeOutcome>;
const run = async (args: string[], o: { probe?: Probe; findCommand?: () => string | null; refresh?: RefreshFn } = {}) => {
  const out: string[] = [];
  const err: string[] = [];
  const probe = o.probe ?? (vi.fn(async (_opts: ClaudeAccountStatusOptions) => usage(2)) as unknown as Probe);
  const findCommand = o.findCommand ?? (() => '/fake/claude');
  const refreshClaude: RefreshFn = o.refresh
    ?? (opts => refreshHeldClaudeQuota({ ...opts, probe, findCommand }));
  const code = await cmdFleetResetRelease(args, {
    now: () => NOW_MS, output: t => out.push(t), error: t => err.push(t), refreshClaude,
  });
  return {
    code, out, err,
    json: out[0]?.startsWith('{') ? JSON.parse(out[0]) as Payload : null,
  };
};

beforeEach(async () => { runsDir = await mkdtemp(join(tmpdir(), 'claude-reset-recovery-')); });
afterEach(async () => { await rm(runsDir, { recursive: true, force: true }); });

it('dry-run, --help and invalid arguments never probe, refresh or write', async () => {
  await seed({ claude: slot(true, AUTOBACKOFF) });
  const refresh = vi.fn() as unknown as RefreshFn;
  const probe = vi.fn(async (_opts: ClaudeAccountStatusOptions) => usage(2)) as unknown as Probe;

  const help = await run(['--help'], { refresh, probe });
  expect(help.code).toBe(0);
  expect(help.out[0]).toContain('Usage: ashlr fleet reset-release');

  for (const args of [['--bogus'], ['positional'], ['--json', '--json'], ['--apply', '--apply'],
    ['--runs-dir'], ['--runs-dir', 'relative/dir'], ['--runs-dir', runsDir, '--runs-dir', runsDir]]) {
    expect((await run(args, { refresh, probe })).code).toBe(2);
  }
  const dry = await run(['--json', '--runs-dir', runsDir], { refresh, probe });
  expect(dry.code).toBe(0);
  expect(dry.json).toMatchObject({ mode: 'dry-run', claudeProbe: 'skipped-dry-run' });

  expect(refresh).not.toHaveBeenCalled();
  expect(probe).not.toHaveBeenCalled();
  expect(existsSync(quotaFile())).toBe(false);
  expect(await claudeLane()).toMatchObject({ held: true });
  const human = await run(['--runs-dir', runsDir]);
  expect(human.out.join('\n')).toContain('claude probe: skipped-dry-run');
});

it('--apply with claude not held (or only claude-api held) probes nothing', async () => {
  await seed({ claude: slot(false, null), 'claude-api': slot(true, AUTOBACKOFF) });
  const probe = vi.fn(async (_opts: ClaudeAccountStatusOptions) => usage(2));
  const { json } = await run(['--json', '--apply', '--runs-dir', runsDir], { probe });
  expect(probe).not.toHaveBeenCalled();
  expect(json).toMatchObject({ claudeProbe: 'not-held', released: [] });
});

it('--apply refreshes a stale exhaustion-held Claude reading once, before the snapshot, and releases through the guarded path', async () => {
  await seed({ claude: slot(true, AUTOBACKOFF) });
  const probe = vi.fn(async (_opts: ClaudeAccountStatusOptions) => usage(2));
  const { code, json } = await run(['--json', '--apply', '--runs-dir', runsDir], { probe });
  expect(probe).toHaveBeenCalledTimes(1);
  expect(probe.mock.calls[0]![0]).toMatchObject({ command: ['/fake/claude'], cwd: runsDir, timeoutMs: 20_000 });
  expect(json).toMatchObject({ claudeProbe: 'probed', sourceState: 'healthy' });
  // Only sanitized window fields persist — never account identifiers or native text.
  const raw = await readFile(quotaFile(), 'utf8');
  expect(raw).not.toContain('operator@example.com');
  const saved = JSON.parse(raw) as Record<string, unknown>;
  expect(saved).toMatchObject({ v: 1, fresh: true, observedAt: NOW_ISO,
    windows: [{ id: 'seven_day', usedPct: 2, resetAt: '2026-11-12T10:00:00Z' }] });
  expect(Object.keys(saved).sort()).toEqual(['fresh', 'observedAt', 'reason', 'v', 'windows']);
  // The fresh reading is what the same snapshot plans and releases from.
  expect(json!.planned).toEqual([expect.objectContaining({ lane: 'claude', usedPct: 2, readingAsOf: NOW_ISO })]);
  expect(json!.released!.map(r => r.lane)).toEqual(['claude']);
  expect(await claudeLane()).toMatchObject({ held: false });
  expect(code).toBe(0);
});

it('a fresh reading skips the subprocess; a still-high reading keeps the hold', async () => {
  await seed({ claude: slot(true, AUTOBACKOFF) });
  await writeClaudeQuotaReading(runsDir, { v: 1, observedAt: new Date(NOW_MS - 10 * 60_000).toISOString(),
    reason: 'observed', fresh: true, windows: [{ id: 'seven_day', usedPct: 90, resetAt: null }] });
  const probe = vi.fn(async (_opts: ClaudeAccountStatusOptions) => usage(2));
  const { json } = await run(['--json', '--apply', '--runs-dir', runsDir], { probe });
  expect(probe).not.toHaveBeenCalled();
  expect(json).toMatchObject({ claudeProbe: 'fresh', released: [] });
  expect(await claudeLane()).toMatchObject({ held: true });
});

it('a future-dated or stale reading is probed again', async () => {
  await seed({ claude: slot(true, AUTOBACKOFF) });
  const probe = vi.fn(async (_opts: ClaudeAccountStatusOptions) => usage(1));
  for (const at of [NOW_MS + 60_000, NOW_MS - 31 * 60_000]) {
    probe.mockClear();
    await writeClaudeQuotaReading(runsDir, { v: 1, observedAt: new Date(at).toISOString(),
      reason: 'observed', fresh: true, windows: [] });
    expect(await refreshHeldClaudeQuota({ runsDir, now: () => NOW_MS, probe, findCommand: () => '/fake/claude' })).toBe('probed');
    expect(probe).toHaveBeenCalledTimes(1);
  }
});

it('a missing command or a throwing probe is unavailable: nothing written, lane stays held', async () => {
  await seed({ claude: slot(true, AUTOBACKOFF) });
  const boom = vi.fn(async (_opts: ClaudeAccountStatusOptions): Promise<ClaudeAccountUsageResult> => { throw new Error('boom'); });
  const thrown = await run(['--json', '--apply', '--runs-dir', runsDir], { probe: boom });
  expect(thrown.json).toMatchObject({ claudeProbe: 'unavailable', released: [] });
  expect(thrown.code).toBe(0);
  expect(existsSync(quotaFile())).toBe(false);
  expect(await claudeLane()).toMatchObject({ held: true });

  const probe = vi.fn(async (_opts: ClaudeAccountStatusOptions) => usage(2));
  const missing = await run(['--json', '--apply', '--runs-dir', runsDir], { probe, findCommand: () => null });
  expect(missing.json).toMatchObject({ claudeProbe: 'unavailable', released: [] });
  expect(probe).not.toHaveBeenCalled();
  expect(existsSync(quotaFile())).toBe(false);
  expect(await claudeLane()).toMatchObject({ held: true });
});

it('unhealthy evidence cannot release the lane even after a successful refresh', async () => {
  await seed({ claude: slot(true, AUTOBACKOFF) });
  await writeFile(join(runsDir, 'queue/status.json'), '{');
  const probe = vi.fn(async (_opts: ClaudeAccountStatusOptions) => usage(1));
  const { code, json } = await run(['--json', '--apply', '--runs-dir', runsDir], { probe });
  expect(probe).toHaveBeenCalledTimes(1);
  expect(json).toMatchObject({ claudeProbe: 'probed', sourceState: 'degraded', released: [] });
  expect(code).toBe(1);
  expect(await claudeLane()).toMatchObject({ held: true });
});

it('a manual hold is never released even when the refresh succeeds', async () => {
  await seed({ claude: slot(true, MANUAL, 'Mason t1221u') });
  const probe = vi.fn(async (_opts: ClaudeAccountStatusOptions) => usage(1));
  const { code, json } = await run(['--json', '--apply', '--runs-dir', runsDir], { probe });
  expect(json).toMatchObject({ claudeProbe: 'probed', released: [], planned: [] });
  expect(code).toBe(0);
  expect(await claudeLane()).toMatchObject({ held: true, heldReason: MANUAL, changedBy: expect.stringContaining('Mason') });
});
