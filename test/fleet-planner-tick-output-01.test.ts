import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetPlannerTick } from '../src/cli/fleet-planner-tick.js';
import type { PlannerAutorunInput } from '../src/core/fleet/planner-autorun.js';
import * as runner from '../src/core/fleet/planner-run.js';
import type { SpawnedPlannerProcess, SpawnLike } from '../src/core/fleet/planner-run.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const now = Date.now();
const input: PlannerAutorunInput = {
  phxReady: 0, lanes: [{ lane: 'test', running: 0, target: 1, held: false }],
  health: { status: 'unknown', failingSince: null, lastGoodPassAt: null, resetAt: null, reason: null },
  orchOff: false, nowMs: now,
};
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'tick-output-')); roots.push(root);
  const queue = join(root, 'queue'), drop = join(root, 'leader', 'drop');
  await mkdir(queue, { recursive: true });
  await mkdir(join(drop, 'claude'), { recursive: true });
  await mkdir(join(drop, 'done'), { recursive: true });
  await writeFile(join(drop, 'ingested.tsv'), '');
  const promptPath = join(root, 'prompt.md');
  await writeFile(promptPath, 'fixture prompt');
  await writeFile(join(queue, 'planner-candidates.json'), JSON.stringify({
    v: 1, candidates: [{ provider: 'test', argv: ['fake-planner'] }], promptPath,
  }));
  return { root, drop };
}
function fakeSpawn(action: () => Promise<void> = async () => {}, code = 0) {
  const spawn = vi.fn<SpawnLike>(() => {
    const child = new EventEmitter() as EventEmitter & SpawnedPlannerProcess;
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => true;
    void action().then(() => child.emit('close', code, null), (err: Error) => child.emit('error', err));
    return child;
  });
  return spawn;
}
async function run(root: string, spawn: SpawnLike, extra: Partial<Parameters<typeof cmdFleetPlannerTick>[1]> = {}, args = ['--apply']) {
  const lines: string[] = [];
  const code = await cmdFleetPlannerTick(['--runs-dir', root, '--json', ...args], {
    now, readInput: async () => input, spawn, output: (line) => lines.push(line), ...extra,
  });
  return { code, report: JSON.parse(lines[0]!) };
}
async function touch(path: string) {
  await writeFile(path, 'fixture');
  await utimes(path, new Date(now), new Date(now));
}

describe('planner tick output evidence', () => {
  it('observes a pending drop created by its single execution', async () => {
    const { root, drop } = await fixture();
    const spawn = fakeSpawn(() => touch(join(drop, 'claude', 'RQ-PHX-NEW.md')));
    const { code, report } = await run(root, spawn);
    expect(code).toBe(0);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(report).toMatchObject({ outcome: 'ran', exitCode: 0, verdict: 'productive', evidence: { state: 'productive', attribution: 'observational', counts: { pending: 1, ingested: 0, rejected: 0 } } });
    expect(report.evidence.window).toEqual({ since: new Date(Math.floor(now / 1000) * 1000).toISOString(), until: new Date(Math.ceil(now / 1000) * 1000).toISOString() });
  });

  it('counts an ingested ledger row as productive', async () => {
    const { root, drop } = await fixture();
    const d = new Date(now), pad = (n: number) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    const spawn = fakeSpawn(() => writeFile(join(drop, 'ingested.tsv'), `${stamp}\tRQ-PHX-NEW\tclaude\twork\twork\tfixture\n`));
    const { code, report } = await run(root, spawn);
    expect(code).toBe(0);
    expect(report.evidence.counts.ingested).toBe(1);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it.each(['empty', 'rejected'] as const)('reports healthy %s output as unproductive', async (kind) => {
    const { root, drop } = await fixture();
    const spawn = fakeSpawn(kind === 'rejected' ? () => touch(join(drop, 'done', 'RQ-PHX-NEW.md.denied')) : undefined);
    const { code, report } = await run(root, spawn);
    expect(code).toBe(1);
    expect(report).toMatchObject({ verdict: 'unproductive', evidence: { state: 'unproductive', counts: { pending: 0, ingested: 0, rejected: kind === 'rejected' ? 1 : 0 } } });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('treats missing, degraded, and failed reads as unknown', async () => {
    for (const kind of ['missing', 'degraded', 'throw'] as const) {
      const { root, drop } = await fixture();
      if (kind === 'missing') await rm(drop, { recursive: true });
      if (kind === 'degraded') await writeFile(join(drop, 'ingested.tsv'), 'invalid row\n');
      const spawn = fakeSpawn();
      const readOutput = kind === 'throw' ? vi.fn().mockRejectedValue(new Error('unavailable')) : undefined;
      const { code, report } = await run(root, spawn, { readOutput });
      expect(code, kind).toBe(1);
      expect(report.verdict, kind).toBe('unknown');
      expect(spawn).toHaveBeenCalledTimes(1);
      if (readOutput) expect(readOutput).toHaveBeenCalledTimes(1);
    }
  });

  it('rejects invalid returned bounds without reading evidence', async () => {
    const { root } = await fixture();
    vi.spyOn(runner, 'runPlannerPass').mockResolvedValueOnce({
      v: 1, outcome: 'ran', provider: 'test', exitCode: 0, logPath: null,
      startedAt: 'invalid', finishedAt: new Date(now).toISOString(), nextResetAt: null, planError: null,
    });
    const readOutput = vi.fn();
    const { code, report } = await run(root, fakeSpawn(), { readOutput });
    expect(code).toBe(1);
    expect(report.verdict).toBe('unknown');
    expect(readOutput).not.toHaveBeenCalled();
  });

  it('keeps a failed execution failed even when work is observed', async () => {
    const { root, drop } = await fixture();
    const spawn = fakeSpawn(() => touch(join(drop, 'claude', 'RQ-PHX-NEW.md')), 7);
    const { code, report } = await run(root, spawn);
    expect(code).toBe(1);
    expect(report).toMatchObject({ exitCode: 7, verdict: 'failed', evidence: { state: 'productive' } });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('does not access evidence or spawn on preview and SKIP', async () => {
    const { root } = await fixture();
    const readOutput = vi.fn(), spawn = fakeSpawn();
    expect((await run(root, spawn, { readOutput }, [])).code).toBe(0);
    expect((await run(root, spawn, { readOutput, readInput: async () => ({ ...input, orchOff: true }) })).code).toBe(0);
    expect(readOutput).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });
});
