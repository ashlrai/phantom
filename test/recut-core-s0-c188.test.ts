/**
 * RQ-PHX-RECUTCORES0C188: recut of #5196 residual coverage. #5196's routines
 * work already reached master through #5200 (Tier-1 seam routines-engines.ts
 * plus the pin in redfix-c187-test.test.ts), so this file pins the dispatcher
 * contract through the real entry point: usage, argv validation, refusal
 * paths, and one successful run through the seam. Mocks the seam, never the
 * Tier-1 engine module, to stay out of the owner lane.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Routine } from '../src/core/routines/index.js';
import { runRoutinesCli } from '../src/cli/routines.js';

const engineRun = vi.hoisted(() => vi.fn(async () => ({ state: { status: 'done', usage: { estCostUsd: 0 } } })));
vi.mock('../src/core/config.js', () => ({ loadConfig: () => ({ foundry: { engines: {} } }) }));
vi.mock('../src/cli/routines-engines.js', () => ({ runEngineSandboxed: engineRun, runApiModelSandboxed: engineRun }));

let home: string;
beforeEach(() => {
  engineRun.mockClear();
  home = mkdtempSync(join(tmpdir(), 'recut-core-s0-c188-'));
  vi.stubEnv('HOME', home);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

const routine = (): Routine => ({
  id: 'recut-check',
  goal: 'Verify the recut landed',
  sourceRepo: '/repo',
  budgetUsd: 1,
  quotaSince: '2026-01-01T00:00:00Z',
  resources: [
    { provider: 'local', model: 'local-model', costUsd: 0, latencyMs: 1000, quality: 0.9, freeQuota: 0 },
  ],
});

describe('routines dispatcher contract (recut of #5196)', () => {
  it('prints usage and exits 0 for --help and help', async () => {
    const lines: string[] = [];
    expect(await runRoutinesCli(['--help'], x => lines.push(x))).toBe(0);
    expect(await runRoutinesCli(['help'], x => lines.push(x))).toBe(0);
    expect(lines[0]).toContain('phantom routines run');
    expect(engineRun).not.toHaveBeenCalled();
  });

  it('rejects malformed argv with exit 2 and no engine call', async () => {
    for (const argv of [[], ['run'], ['run', 'a.json', 'extra'], ['bogus', 'a.json'], ['explain']]) {
      expect(await runRoutinesCli(argv, () => {})).toBe(2);
    }
    expect(engineRun).not.toHaveBeenCalled();
  });

  it('refuses an invalid routine file with exit 1 and the refusal message', async () => {
    const file = join(home, 'bad.json');
    writeFileSync(file, JSON.stringify({ ...routine(), id: 'BAD_ID!', resources: [] }));
    const lines: string[] = [];
    expect(await runRoutinesCli(['run', file], x => lines.push(x))).toBe(1);
    expect(lines).toEqual(['Routine refused or failed; inspect configuration and private ledger.']);
    expect(engineRun).not.toHaveBeenCalled();
  });

  it('refuses explain when the ledger has no rows for the routine', async () => {
    const lines: string[] = [];
    expect(await runRoutinesCli(['explain', 'never-ran'], x => lines.push(x))).toBe(1);
    expect(lines).toEqual(['Routine refused or failed; inspect configuration and private ledger.']);
  });

  it('runs a valid routine through the seam and returns its JSON receipt', async () => {
    const file = join(home, 'routine.json');
    writeFileSync(file, JSON.stringify(routine()));
    const lines: string[] = [];
    expect(await runRoutinesCli(['run', file], x => lines.push(x))).toBe(0);
    expect(engineRun).toHaveBeenCalledWith('local-coder', 'Verify the recut landed',
      expect.objectContaining({ foundry: expect.any(Object) }),
      expect.objectContaining({ sourceRepo: '/repo', model: 'local-model' }));
    const receipt = JSON.parse(lines[0]!);
    expect(receipt).toMatchObject({ routineId: 'recut-check', outcome: 'succeeded', provider: 'local' });
  });
});
