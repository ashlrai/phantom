/**
 * Reconciliation coverage for original PR #1736 (RQ-ROUTINELOCALQ8, head
 * 6814fb9bb978233673af06d585bd592b37e61f50): the receipt-driven routine CLI
 * (`routines run <routine.json>` then `routines explain <id>`) must still work
 * through the real runRoutinesCli entry point alongside today's scheduler and
 * portable-registry verbs. Only the executor/config transport seams are mocked;
 * placement, ledger and CLI dispatch run for real against temporary state.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runRoutinesCli } from '../src/cli/routines.js';
import { readRoutineLedger, type Routine } from '../src/core/routines/index.js';
import { routinesDir } from '../src/core/routines/scheduler.js';

const engineRun = vi.hoisted(() => vi.fn(async () => ({ state: { status: 'done', usage: { estCostUsd: 0 } } })));
vi.mock('../src/core/config.js', () => ({ loadConfig: () => ({ foundry: { engines: {} } }) }));
vi.mock('../src/cli/routines-engines.js', () => ({ runEngineSandboxed: engineRun, runApiModelSandboxed: engineRun }));

let home: string;
beforeEach(() => { engineRun.mockClear(); engineRun.mockResolvedValue({ state: { status: 'done', usage: { estCostUsd: 0 } } }); home = mkdtempSync(join(tmpdir(), 'routine-cli-1736-')); vi.stubEnv('HOME', home); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); rmSync(home, { recursive: true, force: true }); });

const placementRoutine = (): Routine => ({ id: 'watchdog', goal: 'Check stalled jobs', sourceRepo: '/repo', budgetUsd: 3,
  quotaSince: '2026-01-01T00:00:00Z', resources: [
    { provider: 'local', model: 'local-model', costUsd: 0, latencyMs: 1000, quality: 0.9, freeQuota: 0 },
    { provider: 'codex', model: 'frontier-model', costUsd: 1, latencyMs: 2000, quality: 0.98, freeQuota: 0 },
  ] });

const runJson = async (routine: Routine): Promise<{ code: number; receipt: Record<string, unknown> | null; lines: string[] }> => {
  const file = join(home, `routine-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify(routine));
  const lines: string[] = [];
  const code = await runRoutinesCli(['run', file], x => lines.push(x));
  let receipt: Record<string, unknown> | null = null;
  try { receipt = JSON.parse(lines.join('\n')) as Record<string, unknown>; } catch { /* refused runs print prose */ }
  return { code, receipt, lines };
};

describe('original #1736 receipt-driven routine CLI on current master', () => {
  it('runs a JSON routine through local-first placement and explains the recorded receipt', async () => {
    const { code, receipt } = await runJson(placementRoutine());
    expect(code).toBe(0);
    expect(receipt).toMatchObject({ routineId: 'watchdog', provider: 'local', model: 'local-model', outcome: 'succeeded', metric: 'operational' });
    expect((receipt!.decision as Record<string, unknown>).selected).toMatchObject({ provider: 'local' });
    expect(engineRun).toHaveBeenCalledWith('local-coder', 'Check stalled jobs', expect.anything(), expect.objectContaining({ sourceRepo: '/repo', model: 'local-model' }));

    const lines: string[] = [];
    expect(await runRoutinesCli(['explain', 'watchdog'], x => lines.push(x))).toBe(0);
    const rows = JSON.parse(lines[0]!) as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ routineId: 'watchdog', provider: 'local', outcome: 'succeeded' });
    expect(readRoutineLedger()).toHaveLength(1);
  });

  it('escalates to Codex after repeated local failures and explain shows the decision trail', async () => {
    const providers: string[] = [];
    for (let i = 0; i < 4; i++) {
      engineRun.mockResolvedValueOnce({ state: { status: i < 3 ? 'failed' : 'done', usage: { estCostUsd: 0 } } });
      const { code, receipt } = await runJson(placementRoutine());
      expect(code).toBe(i < 3 ? 1 : 0);
      providers.push((receipt!.decision as { selected: { provider: string } }).selected.provider);
      expect(receipt).toMatchObject({ outcome: i < 3 ? 'failed' : 'succeeded' });
    }
    expect(providers).toEqual(['local', 'local', 'local', 'codex']);
    expect(engineRun.mock.calls.map(call => call[0])).toEqual(['local-coder', 'local-coder', 'local-coder', 'codex']);

    const lines: string[] = [];
    expect(await runRoutinesCli(['explain', 'watchdog'], x => lines.push(x))).toBe(0);
    const rows = JSON.parse(lines[0]!) as { outcome: string; decision: Record<string, unknown> }[];
    expect(rows).toHaveLength(4);
    expect(rows[3]!.decision).toMatchObject({ localFailureRate: 1, selected: { provider: 'codex' } });
    expect((rows[3]!.decision.candidates as { reason: string }[])[0]!.reason).toBe('repeated local failures');
  });

  it('still dispatches the newer scheduler verbs from the same runRoutinesCli entry point', async () => {
    const yaml = join(home, 'routines.yaml');
    writeFileSync(yaml, [
      'routines:',
      '  - id: tick-smoke',
      '    schedule: "* * * * *"',
      '    prompt: "Report fleet health"',
      '    capabilities: [research]',
      '    tier: local',
      '    output: tick.md',
      'executors:',
      '  - id: omlx-local',
      '    kind: omlx',
      '    capabilities: [research]',
      '    tier: local',
      '    cost: 0',
      '    dailyLimit: 5',
      '    model: local-model',
      '',
    ].join('\n'));

    const listLines: string[] = [];
    expect(await runRoutinesCli(['list', '--file', yaml], x => listLines.push(x))).toBe(0);
    expect(listLines.join('\n')).toContain('tick-smoke');

    const statusLines: string[] = [];
    expect(await runRoutinesCli(['status', '--file', yaml], x => statusLines.push(x))).toBe(0);
    expect(statusLines.join('\n')).toContain('| tick-smoke |');
    expect(existsSync(join(routinesDir(), 'STATUS.md'))).toBe(true);
    // Scheduler state stays in its own files; the placement ledger is untouched.
    expect(readRoutineLedger()).toHaveLength(0);
  });
});
