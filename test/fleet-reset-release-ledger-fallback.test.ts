/**
 * The self-tick reset-release step does not fail just because the live Claude
 * probe is unavailable: it falls back to the ledger reading `phm pools` shows
 * (source "ledger"), a tick with nothing to release exits 0 with a plain note,
 * and an unreadable slots file fails with that reason named.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { cmdFleetSelfTick } from '../src/cli/fleet-self-tick.js';
import { cmdFleetResetRelease } from '../src/cli/fleet-reset-release.js';
import { SELF_TICK_STEP_ORDER, type SelfTickSteps } from '../src/core/fleet/self-tick.js';
import type { ClaudeAccountUsageResult } from '../src/core/resources/claude-account-usage.js';

const NOW = Date.parse('2026-11-21T12:00:00Z');
let home: string;
let root: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'reset-ledger-home-'));
  root = join(home, 'runs');
  await mkdir(join(root, 'queue'), { recursive: true });
  await writeFile(join(root, 'queue/slots.json'), JSON.stringify({
    claude: { target: 1, floor: 0, ceiling: 2, held: false },
    codex: { target: 1, floor: 0, ceiling: 2, held: false },
  }));
  await writeFile(join(root, 'queue/status.json'), JSON.stringify({
    last_tick: '2026-11-21T11:59:00Z', lanes: { claude: { held: false }, codex: { held: false } },
    budget: { claude: { weekly_used_pct: 32, reset_at: '2026-11-27T23:00:00Z', observed_at: '2026-11-21T11:30:00Z', source: 'fleet sensor' } },
  }));
});
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

const failedProbe = async (): Promise<ClaudeAccountUsageResult> => ({
  schemaVersion: 1, scope: 'claude-native-auth-status', status: 'unavailable', reason: 'timeout', loggedIn: false,
  quotaFresh: false, windows: [],
} as unknown as ClaudeAccountUsageResult);

async function tick() {
  const steps = Object.fromEntries(SELF_TICK_STEP_ORDER.filter(n => n !== 'reset-release')
    .map(name => [name, async () => ({ exitCode: 0, output: '{}' })])) as Partial<SelfTickSteps>;
  const out: string[] = [];
  const code = await cmdFleetSelfTick(['--json', '--apply', '--runs-dir', root], {
    home, now: () => NOW, steps, output: t => out.push(t), error: () => undefined,
    claudeProbe: failedProbe, claudeFindCommand: () => '/fake/claude',
  });
  const report = JSON.parse(out[0]!) as { steps: { step: string; state: string; report: Record<string, unknown> | null }[] };
  return { code, release: report.steps.find(s => s.step === 'reset-release')! };
}

it('probe fails + ledger reading present -> ok with source "ledger"', async () => {
  const { code, release } = await tick();
  expect(release.state).not.toBe('failed');
  expect(release.report?.claudeQuota).toMatchObject({ state: 'ledger', source: 'ledger', weeklyPct: 32 });
  expect(code).toBe(0);
});

it('nothing to release -> exit 0 with a plain note', async () => {
  const out: string[] = [];
  const code = await cmdFleetResetRelease(['--apply', '--runs-dir', root], {
    now: () => NOW, refreshClaude: async () => 'unavailable', output: t => out.push(t), error: () => undefined,
  });
  expect(code).toBe(0);
  expect(out.join('\n')).toContain('checked 2 lane(s), none held past a reset');
});

it('a malformed jobs log does not fail the step', async () => {
  await mkdir(join(root, 'metrics'), { recursive: true });
  await writeFile(join(root, 'metrics/jobs.jsonl'), 'this is not json\n');
  const code = await cmdFleetResetRelease(['--apply', '--runs-dir', root], {
    now: () => NOW, refreshClaude: async () => 'unavailable', output: () => undefined, error: () => undefined,
  });
  expect(code).toBe(0);
});

it('unreadable slots file -> failed with the named reason', async () => {
  await writeFile(join(root, 'queue/slots.json'), '{ not valid');
  const out: string[] = [];
  const code = await cmdFleetResetRelease(['--apply', '--runs-dir', root], {
    now: () => NOW, refreshClaude: async () => 'unavailable', output: t => out.push(t), error: () => undefined,
  });
  expect(code).toBe(1);
  expect(out.join('\n')).toContain('failed: the lane slots file is unreadable');
});
