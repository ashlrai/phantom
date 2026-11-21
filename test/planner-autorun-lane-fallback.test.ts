/**
 * RQ-PLANNERLANEN22IQ8 — a planner login that hit its usage limit no longer
 * stops the fleet's self-supply while another login's pool still has usage.
 */
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetPlannerTick } from '../src/cli/fleet-planner-tick.js';
import {
  decidePlannerAutorun, type PlannerAutorunInput, type PlannerSlateLane,
} from '../src/core/fleet/planner-autorun.js';
import type { PlannerHealth } from '../src/core/fleet/planner-failover.js';
import type { SpawnedPlannerProcess, SpawnLike } from '../src/core/fleet/planner-run.js';

const NOW = new Date(2026, 10, 20, 12, 0, 0).getTime();
const hoursFrom = (h: number): string => new Date(NOW + h * 3_600_000).toISOString();
const failing = (resetAt: string | null, reason = 'usage-limit'): PlannerHealth =>
  ({ status: 'failing', failingSince: hoursFrom(-10), lastGoodPassAt: null, resetAt, reason });
const lane = (provider: string, out: boolean, resetAt: string | null = null): PlannerSlateLane => ({ provider, out, resetAt });

const input = (over: Partial<PlannerAutorunInput> = {}): PlannerAutorunInput => ({
  phxReady: 3,
  lanes: [{ lane: 'claude', running: 0, target: 4, held: false }],
  health: failing(hoursFrom(27)),
  orchOff: false,
  nowMs: NOW,
  slate: [lane('codex-personal', true, hoursFrom(27)), lane('claude', false, hoursFrom(160))],
  failedLane: 'codex-personal',
  ...over,
});

describe('planner lane fallback decision', () => {
  it('runs on the lane with usage left and names it', () => {
    const d = decidePlannerAutorun(input());
    expect(d).toMatchObject({ run: true, reason: 'low-supply', lane: 'claude', fallbackFrom: 'codex-personal' });
  });

  it('never falls back onto the login that just died', () => {
    const d = decidePlannerAutorun(input({ slate: [lane('codex-personal', false), lane('claude', true, hoursFrom(5))] }));
    expect(d).toMatchObject({ run: false, reason: 'planner-failing' });
    expect(d.lane).toBeUndefined();
  });

  it('skips with every pool named and the earliest reset when all are out', () => {
    const d = decidePlannerAutorun(input({ slate: [lane('codex-personal', true, hoursFrom(27)), lane('claude', true, hoursFrom(5))] }));
    expect(d).toMatchObject({ run: false, reason: 'planner-failing', nextResetAt: hoursFrom(5) });
    expect(d.poolsOut?.map((p) => p.lane)).toEqual(['codex-personal', 'claude']);
    expect(d.detail).toContain('codex-personal');
    expect(d.detail).toContain('claude');
    expect(d.detail).toContain('first resets');
  });

  it('still skips when the failing login has no slate to fall back on', () => {
    const d = decidePlannerAutorun(input({ slate: undefined, failedLane: undefined }));
    expect(d).toMatchObject({ run: false, reason: 'planner-failing', nextResetAt: hoursFrom(27) });
  });

  it('is no longer failing once the reset time has passed', () => {
    const d = decidePlannerAutorun(input({ health: failing(hoursFrom(-1)) }));
    expect(d).toMatchObject({ run: true, reason: 'low-supply' });
    expect(d.lane).toBeUndefined();
  });

  it('does not treat other failures as a usage limit', () => {
    const d = decidePlannerAutorun(input({ health: failing(null, 'executor-fail') }));
    expect(d).toMatchObject({ run: false, reason: 'planner-failing' });
    expect(d.lane).toBeUndefined();
  });

  it('a healthy planner runs as before, with no lane', () => {
    const d = decidePlannerAutorun(input({
      health: { status: 'ok', failingSince: null, lastGoodPassAt: hoursFrom(-3), resetAt: null, reason: null },
    }));
    expect(d.run).toBe(true);
    expect(d.lane).toBeUndefined();
  });
});

describe('planner-tick fallback report', () => {
  const roots: string[] = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('runs one pass on the fallback lane only and reports lane and fallbackFrom', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tick-lane-')); roots.push(root);
    await mkdir(join(root, 'queue'), { recursive: true });
    const promptPath = join(root, 'prompt.md');
    await writeFile(promptPath, 'plain prompt');
    await writeFile(join(root, 'queue', 'planner-candidates.json'), JSON.stringify({
      v: 1, promptPath, lastProvider: 'codex-personal',
      candidates: [
        { provider: 'codex-personal', argv: ['fake-codex'] },
        { provider: 'claude', argv: ['fake-claude'] },
      ],
    }));
    const spawn = vi.fn<SpawnLike>(() => {
      const child = new EventEmitter() as EventEmitter & SpawnedPlannerProcess;
      child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.kill = () => true;
      setImmediate(() => child.emit('close', 0, null));
      return child;
    });
    const lines: string[] = [];
    await cmdFleetPlannerTick(['--runs-dir', root, '--json', '--apply'], {
      now: NOW, readInput: async () => input(), spawn, output: (l) => lines.push(l),
    });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0]![0]).toBe('fake-claude');
    expect(JSON.parse(lines[0]!)).toMatchObject({ provider: 'claude', lane: 'claude', fallbackFrom: 'codex-personal' });
  });
});
