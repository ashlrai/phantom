import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { claudeWindowReport, runClaudeWindowCheck } from '../examples/agents/claude-window-check.js';
import { readResourceLedger, type ResourceLedgerV1 } from '../src/core/fleet/runs-resource-ledger.js';
import { readFleetRunsDirState } from '../src/core/fleet/runs-dir-state.js';

const at = '2026-10-31T12:00:00Z';
const now = () => Date.parse(at);
const roots: string[] = [];
async function fixture(budget: object, lanes: object) {
  const root = await mkdtemp(join(tmpdir(), 'claude-window-'));
  roots.push(root);
  await mkdir(join(root, 'queue'));
  await writeFile(join(root, 'queue/status.json'), JSON.stringify({
    last_tick: at, paused: false, mem_free_pct: 50, lanes, budget,
  }));
  return root;
}
const lane = (held = false, held_reason?: string) => ({ running: 0, target: 1, queued: 0, held, held_reason });
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function invoke(args: string[], overrides: Parameters<typeof runClaudeWindowCheck>[1] = {}) {
  const lines: string[] = [];
  const code = await runClaudeWindowCheck(args, { now, ...overrides, write: text => lines.push(text) });
  return { code, output: lines.map(line => JSON.parse(line)) };
}
function isolated(root: string) {
  return {
    ledger: (opts: Parameters<typeof readResourceLedger>[0]) => readResourceLedger({ ...opts, personalCodexHome: join(root, 'empty-personal') }),
    runs: readFleetRunsDirState,
  };
}

describe('Claude window workflow', () => {
  it('upgrades legacy five-hour-only status without projecting an active five-hour quota', async () => {
    const root = await fixture({ claude: { five_hour_used_pct: 99, fiveHourPct: 98, messages_5h: 80, five_hour_reset_at: '2026-10-31T14:00:00Z' } }, { claude: lane() });
    const result = await invoke(['--runs-dir', root], isolated(root));
    expect(result.code).toBe(0);
    expect(result.output[0]).toMatchObject({ violationCount: 0, lanes: [
      { lane: 'claude', window: 'weekly', usedPct: null, resetAt: null, held: false, violation: false },
      { lane: 'claude-api', window: null, usedPct: null, held: null, join: 'unknown' },
    ] });
  });

  it('preserves weekly data, credits and authentication holds as separate observations', async () => {
    const root = await fixture({
      claude: { weekly_used_pct: 42, reset_at: '2026-11-02T00:00:00Z', source: 'fixture' },
      'claude-api': { credits_remaining: 12 },
      'claude-extra': {},
    }, { claude: lane(true, 'authentication required'), 'claude-api': lane() });
    const result = await invoke(['--runs-dir', root], isolated(root));
    expect(result.code).toBe(0);
    expect(result.output[0]).toMatchObject({ observation: { ledger: { sources: { status: 'healthy', jobs: 'missing' } } }, lanes: [
      { lane: 'claude', window: 'weekly', usedPct: 42, resetAt: '2026-11-02T00:00:00Z', held: true, heldReason: 'authentication required', holdKind: 'authentication', join: 'matched' },
      { lane: 'claude-api', window: 'credits', creditsRemaining: 12, held: false },
      { lane: 'claude-extra', window: 'none', held: null, heldReason: null, join: 'unknown' },
    ] });
  });

  it('does not attribute a reason across mismatched or missing observations', async () => {
    const root = await fixture({ claude: { weekly_used_pct: 9 } }, { claude: lane(true, 'authentication required') });
    const ledger = await readResourceLedger({ runsDir: root, now, personalCodexHome: join(root, 'empty-personal') });
    const runs = await readFleetRunsDirState({ runsDir: root, now });
    runs.lastTick = '2026-10-31T12:01:00Z';
    expect(claudeWindowReport(ledger, runs).lanes[0]).toMatchObject({ join: 'mismatched', held: true, heldReason: null, holdKind: 'unknown' });
    ledger.lanes = [];
    expect(claudeWindowReport(ledger, runs).lanes[0]).toMatchObject({ join: 'unknown', window: null, held: null, heldReason: null });
  });

  it('detects explicit five-hour projections including those beyond the output cap', async () => {
    const root = await fixture({}, {});
    const ledger = await readResourceLedger({ runsDir: root, now, personalCodexHome: join(root, 'empty-personal') });
    const runs = await readFleetRunsDirState({ runsDir: root, now });
    const row = { lane: '', running: null, target: null, held: null, window: 'none', usedPct: null, creditsRemaining: null, resetAt: null, burnPctPerHour: null, tokensPerHour6h: null, projectedExhaustion: null, source: null, deadSignal: null } as const;
    ledger.lanes = Array.from({ length: 101 }, (_, i) => ({ ...row, lane: 'claude-' + String(i).padStart(3, '0') }));
    ledger.lanes.push({ ...row, lane: 'claude-z', window: 'five_hour' as ResourceLedgerV1['lanes'][number]['window'] });
    const result = await invoke([], { ledger: async () => ledger, runs: async () => runs });
    expect(result.code).toBe(1);
    expect(result.output[0]).toMatchObject({ violationCount: 1, lanesOmitted: 4 });
    expect(result.output[0].lanes).toHaveLength(100);
    ledger.lanes = [{ ...row, lane: 'claude', window: '5h' as ResourceLedgerV1['lanes'][number]['window'] }];
    expect(claudeWindowReport(ledger, runs).lanes[0]).toMatchObject({ violation: true, window: null });
  });

  it('bounds options, reports JSON errors, and never reads on invalid input', async () => {
    const ledger = vi.fn<typeof readResourceLedger>();
    for (const args of [['--samples', '11'], ['--interval-ms', '1000'], ['--samples', '2', '--interval-ms', '999'], ['--runs-dir'], ['--help', '--bad']]) {
      expect(await invoke(args, { ledger })).toMatchObject({ code: 2, output: [{ error: 'invalid_arguments' }] });
    }
    expect(ledger).not.toHaveBeenCalled();
    expect(await invoke(['--help'])).toMatchObject({ code: 0, output: [{ usage: expect.stringContaining('npx tsx') }] });
    expect(await invoke([], { ledger: async () => { throw new Error('private fixture text'); } })).toEqual({ code: 1, output: [{ v: 1, error: 'read_failed' }] });
  });

  it('samples sequentially with injected waits and removes signal handlers on interruption', async () => {
    const root = await fixture({}, {});
    const deps = isolated(root);
    const controller = new AbortController();
    const wait = vi.fn(async (_ms: number, _signal: AbortSignal) => { controller.abort(); });
    const before = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
    const result = await invoke(['--runs-dir', root, '--samples', '3', '--interval-ms', '1000'], { ...deps, wait, signal: controller.signal });
    expect(result.code).toBe(130);
    expect(result.output).toHaveLength(1);
    expect(wait).toHaveBeenCalledTimes(1);
    expect(wait.mock.calls[0]?.[0]).toBe(1000);
    expect([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]).toEqual(before);
  });

  it('emits a safe JSON error if waiting fails', async () => {
    const root = await fixture({}, {});
    const result = await invoke(['--runs-dir', root, '--samples', '2'], {
      ...isolated(root), wait: async () => { throw new Error('private fixture text'); },
    });
    expect(result.code).toBe(1);
    expect(result.output).toHaveLength(2);
    expect(result.output[1]).toEqual({ v: 1, error: 'wait_failed' });
  });
});
