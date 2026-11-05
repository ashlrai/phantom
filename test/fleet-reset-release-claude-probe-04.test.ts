/**
 * RQ-PHX-RESETCLAUDEPROBE04 — `fleet reset-release --apply` refreshes Claude's
 * native weekly reading itself when the `claude` lane is held. Dry-run never
 * probes. Every probe here is a fake; no real claude process is spawned.
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cmdFleetResetRelease } from '../src/cli/fleet-reset-release.js';
import { refreshHeldClaudeQuota } from '../src/core/fleet/claude-quota-refresh.js';
import { writeClaudeQuotaReading } from '../src/core/fleet/claude-quota-reading.js';
import type { ClaudeAccountUsageResult } from '../src/core/resources/claude-account-usage.js';

const NOW_MS = Date.parse('2026-11-04T12:00:00Z');
const HELD_SINCE = '2026-11-03T12:00:00Z';
const HELD_UNTIL = '2026-11-08T00:00:00Z';

let runsDir: string;
const slot = (held: boolean, reason: string | null) => ({
  target: 1, floor: 0, ceiling: 2, held, ...(held ? { held_reason: reason, held_until: HELD_UNTIL, held_by: 'autobackoff' } : {}),
  last_change: Date.parse(HELD_SINCE) / 1000,
});
const seed = async (slots: Record<string, unknown>) => {
  await mkdir(join(runsDir, 'queue'), { recursive: true });
  await writeFile(join(runsDir, 'queue/slots.json'), JSON.stringify(slots));
  await writeFile(join(runsDir, 'queue/status.json'), JSON.stringify({ last_tick: '2026-11-04T11:59:00Z', lanes: {} }));
};
const AUTOBACKOFF = `autobackoff claude job=j-1 until=${HELD_UNTIL} src=fake`;
const usage = (usedPercent: number): ClaudeAccountUsageResult => ({
  schemaVersion: 1, scope: 'claude-native-auth-status', status: 'observed', reason: 'observed', loggedIn: true,
  authMethod: 'claude.ai', subscriptionType: null, accountHint: null, startedAt: '2026-11-04T12:00:00Z',
  finishedAt: '2026-11-04T12:00:01Z', quotaFresh: true,
  windows: [{ id: 'seven_day', usedPercent, resetsAt: '2026-11-04T10:00:00Z' }],
} as unknown as ClaudeAccountUsageResult);
const quotaFile = () => join(runsDir, 'metrics/claude-quota.json');

const run = async (args: string[], probe: ReturnType<typeof vi.fn>, findCommand: () => string | null = () => '/fake/claude') => {
  const out: string[] = [];
  const code = await cmdFleetResetRelease(args, {
    now: () => NOW_MS, output: t => out.push(t), error: () => undefined,
    refreshClaude: o => refreshHeldClaudeQuota({ ...o, probe, findCommand }),
  });
  return { code, out, json: out[0]?.startsWith('{') ? JSON.parse(out[0]) : null };
};

beforeEach(async () => { runsDir = await mkdtemp(join(tmpdir(), 'reset-claude-probe-')); });
afterEach(async () => { await rm(runsDir, { recursive: true, force: true }); });

it('dry-run never probes and reports skipped-dry-run', async () => {
  await seed({ claude: slot(true, AUTOBACKOFF) });
  const probe = vi.fn();
  const { code, json, out } = await run(['--json', '--runs-dir', runsDir], probe);
  expect(probe).not.toHaveBeenCalled();
  expect(json.claudeProbe).toBe('skipped-dry-run');
  expect(code).toBe(0);
  expect(existsSync(quotaFile())).toBe(false);
  const human = await run(['--runs-dir', runsDir], probe);
  expect(human.out[0]).toContain('claude probe: skipped-dry-run');
  expect(out).toHaveLength(1);
});

it('--apply with claude not held (or only claude-api held) probes nothing', async () => {
  await seed({ claude: slot(false, null), 'claude-api': slot(true, AUTOBACKOFF) });
  const probe = vi.fn();
  const { json } = await run(['--json', '--apply', '--runs-dir', runsDir], probe);
  expect(probe).not.toHaveBeenCalled();
  expect(json.claudeProbe).toBe('not-held');
});

it('--apply with claude held and no reading probes once, writes it and plans from it', async () => {
  await seed({ claude: slot(true, AUTOBACKOFF) });
  const probe = vi.fn(async () => usage(2));
  const { code, json } = await run(['--json', '--apply', '--runs-dir', runsDir], probe);
  expect(probe).toHaveBeenCalledTimes(1);
  expect(probe.mock.calls[0]![0]).toMatchObject({ command: ['/fake/claude'], cwd: runsDir, timeoutMs: 20_000 });
  expect(json.claudeProbe).toBe('probed');
  const saved = JSON.parse(await readFile(quotaFile(), 'utf8'));
  expect(saved).toMatchObject({ v: 1, fresh: true, observedAt: new Date(NOW_MS).toISOString(),
    windows: [{ id: 'seven_day', usedPct: 2, resetAt: '2026-11-04T10:00:00Z' }] });
  expect(json.planned).toEqual([expect.objectContaining({ lane: 'claude', usedPct: 2, readingAsOf: new Date(NOW_MS).toISOString() })]);
  expect(json.released.map((r: { lane: string }) => r.lane)).toEqual(['claude']);
  expect(code).toBe(0);
});

it('a reading younger than 30 minutes is fresh and not probed again', async () => {
  await seed({ claude: slot(true, AUTOBACKOFF) });
  await writeClaudeQuotaReading(runsDir, { v: 1, observedAt: new Date(NOW_MS - 10 * 60_000).toISOString(), reason: 'observed', fresh: true,
    windows: [{ id: 'seven_day', usedPct: 90, resetAt: null }] });
  const probe = vi.fn();
  const { json } = await run(['--json', '--apply', '--runs-dir', runsDir], probe);
  expect(probe).not.toHaveBeenCalled();
  expect(json.claudeProbe).toBe('fresh');
});

it('a future-dated or old reading is probed again', async () => {
  await seed({ claude: slot(true, AUTOBACKOFF) });
  const probe = vi.fn(async () => usage(1));
  for (const at of [NOW_MS + 60_000, NOW_MS - 31 * 60_000]) {
    probe.mockClear();
    await writeClaudeQuotaReading(runsDir, { v: 1, observedAt: new Date(at).toISOString(), reason: 'observed', fresh: true, windows: [] });
    expect(await refreshHeldClaudeQuota({ runsDir, now: () => NOW_MS, probe, findCommand: () => '/fake/claude' })).toBe('probed');
    expect(probe).toHaveBeenCalledTimes(1);
  }
});

it('a throwing probe or a missing binary is unavailable, writes nothing and keeps exit rules', async () => {
  await seed({ claude: slot(true, AUTOBACKOFF) });
  const boom = vi.fn(async () => { throw new Error('boom'); });
  const thrown = await run(['--json', '--apply', '--runs-dir', runsDir], boom);
  expect(thrown.json.claudeProbe).toBe('unavailable');
  expect(thrown.code).toBe(0);
  expect(existsSync(quotaFile())).toBe(false);
  const probe = vi.fn();
  const missing = await run(['--json', '--apply', '--runs-dir', runsDir], probe, () => null);
  expect(missing.json.claudeProbe).toBe('unavailable');
  expect(probe).not.toHaveBeenCalled();
  expect(existsSync(quotaFile())).toBe(false);
  expect(missing.json.released).toEqual([]);
});
