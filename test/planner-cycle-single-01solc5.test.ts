import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runPlannerCycle, type PlannerCycleDeps } from '../src/core/fleet/planner-cycle.js';

const roots: string[] = [];
function root(): string { const path = mkdtempSync(join(tmpdir(), 'planner-single-')); roots.push(path); return path; }
const opts = (runsRoot: string, apply = true) => ({ runsRoot, promptPath: '/fixture/prompt', apply });
const pass = { ok: true, provider: 'fixture', reason: 'ran', result: {
  v: 1 as const, provider: 'fixture', outcome: 'ran' as const, exitCode: 0, logPath: null,
  startedAt: '2026-11-01T00:00:00Z', finishedAt: '2026-11-01T00:00:01Z', nextResetAt: null, planError: null,
} };
const output = { v: 1 as const, window: { since: 's', until: 'u' }, ingested: [], pending: [], rejected: [],
  counts: { ingested: 0, pending: 0, rejected: 0 }, sources: { ledger: 'ok' as const, drops: [], skipped: 0 } };
function deps(): PlannerCycleDeps {
  return { executePass: vi.fn<PlannerCycleDeps['executePass']>().mockResolvedValue(pass),
    readOutput: vi.fn<PlannerCycleDeps['readOutput']>().mockResolvedValue(output) };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe('planner cycle filesystem single flight', () => {
  it('excludes overlapping calls through execution and evidence, while other roots proceed', async () => {
    const path = root(), other = root(), waiting = deferred<typeof pass>(), evidence = deferred<typeof output>();
    const first = deps(), contender = deps(), independent = deps();
    vi.mocked(first.executePass).mockReturnValue(waiting.promise);
    vi.mocked(first.readOutput).mockReturnValue(evidence.promise);
    const running = runPlannerCycle(opts(path), first);
    const busy = await runPlannerCycle(opts(path), contender);
    expect(busy).toMatchObject({ exitCode: 3, report: { verdict: 'skipped', execution: { outcome: 'not-run', reason: expect.stringContaining('busy') } } });
    expect(contender.executePass).not.toHaveBeenCalled(); expect(contender.readOutput).not.toHaveBeenCalled();
    expect((await runPlannerCycle(opts(other), independent)).report.verdict).toBe('unproductive');
    waiting.resolve(pass);
    await vi.waitFor(() => expect(first.readOutput).toHaveBeenCalledOnce());
    expect((await runPlannerCycle(opts(path), contender)).report.verdict).toBe('skipped');
    evidence.resolve(output);
    expect((await running).report.verdict).toBe('unproductive');
    expect(first.executePass).toHaveBeenCalledOnce();
    expect((await runPlannerCycle(opts(path), contender)).report.verdict).toBe('unproductive');
  });

  it('excludes a separately imported process', async () => {
    const path = root(), waiting = deferred<typeof pass>(), first = deps();
    vi.mocked(first.executePass).mockReturnValue(waiting.promise);
    const running = runPlannerCycle(opts(path), first);
    const moduleUrl = pathToFileURL(resolve('src/core/fleet/planner-cycle.ts')).href;
    const script = `import { runPlannerCycle } from ${JSON.stringify(moduleUrl)}; const r = await runPlannerCycle({runsRoot: process.argv[1], promptPath: '/p', apply: true}, {executePass: async () => { throw Error('executed'); }, readOutput: async () => { throw Error('read'); }}); console.log(JSON.stringify({verdict:r.report.verdict, exitCode:r.exitCode}));`;
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, path], { encoding: 'utf8', timeout: 15000 });
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual({ verdict: 'skipped', exitCode: 3 });
    waiting.resolve(pass); await running;
  });

  it('does not create storage in preview', async () => {
    const path = join(root(), 'missing'), d = deps();
    expect((await runPlannerCycle(opts(path, false), d)).report.verdict).toBe('planned');
    expect(existsSync(path)).toBe(false); expect(d.readOutput).not.toHaveBeenCalled();
  });

  it('releases after executor throws and evidence fails', async () => {
    const path = root(), d = deps();
    vi.mocked(d.executePass).mockRejectedValueOnce(new Error('fixture'));
    expect((await runPlannerCycle(opts(path), d)).report.verdict).toBe('failed');
    vi.mocked(d.readOutput).mockRejectedValueOnce(new Error('fixture'));
    expect((await runPlannerCycle(opts(path), d)).report.verdict).toBe('unknown');
    expect((await runPlannerCycle(opts(path), d)).report.verdict).toBe('unproductive');
  });

  it.each(['file', 'symlink'] as const)('refuses unexpected lock %s without removing it', async (kind) => {
    const path = root(), directory = join(path, '.planner-cycle'), lock = join(directory, 'apply.lock');
    mkdirSync(directory, { mode: 0o700 });
    const target = join(path, 'foreign'); writeFileSync(target, 'foreign', { mode: 0o600 });
    if (kind === 'file') writeFileSync(lock, 'foreign', { mode: 0o600 }); else symlinkSync(target, lock);
    const d = deps();
    expect((await runPlannerCycle(opts(path), d)).report.verdict).toBe('failed');
    expect(d.executePass).not.toHaveBeenCalled(); expect(d.readOutput).not.toHaveBeenCalled();
    expect(readFileSync(lock, 'utf8')).toBe('foreign');
  });

  it('reports an abandoned valid lock as busy without taking it over', async () => {
    const path = root(), directory = join(path, '.planner-cycle'), lock = join(directory, 'apply.lock');
    mkdirSync(directory, { mode: 0o700 });
    const marker = `planner-cycle-lock-v1 ${'a'.repeat(32)}\n`;
    writeFileSync(lock, marker, { mode: 0o600 });
    const d = deps(), result = await runPlannerCycle(opts(path), d);
    expect(result).toMatchObject({ exitCode: 3, report: { verdict: 'skipped', execution: { reason: expect.stringContaining('abandoned') } } });
    expect(d.executePass).not.toHaveBeenCalled(); expect(d.readOutput).not.toHaveBeenCalled();
    expect(readFileSync(lock, 'utf8')).toBe(marker);
  });

  it('preserves productive and skipped result classifications', async () => {
    const path = root(), d = deps();
    vi.mocked(d.readOutput).mockResolvedValueOnce({ ...output, counts: { ingested: 1, pending: 0, rejected: 0 } });
    const productive = await runPlannerCycle(opts(path), d);
    expect(productive).toMatchObject({ exitCode: 0, report: { verdict: 'productive', evidence: { attribution: 'observational' } } });
    vi.mocked(d.executePass).mockResolvedValueOnce({ ...pass, result: { ...pass.result, outcome: 'skipped-orch-off', exitCode: null } });
    expect((await runPlannerCycle(opts(path), d))).toMatchObject({ exitCode: 3, report: { verdict: 'skipped' } });
  });

  it('never removes a replacement lock', async () => {
    const path = root(), waiting = deferred<typeof pass>(), d = deps();
    vi.mocked(d.executePass).mockReturnValue(waiting.promise);
    const running = runPlannerCycle(opts(path), d), lock = join(path, '.planner-cycle', 'apply.lock');
    renameSync(lock, `${lock}.original`); writeFileSync(lock, 'foreign', { mode: 0o600 });
    waiting.resolve(pass);
    expect((await running).report.verdict).toBe('failed');
    expect(readFileSync(lock, 'utf8')).toBe('foreign');
  });

  it('fails closed for missing, relative, symlinked and writable roots', async () => {
    const path = root(), alias = join(root(), 'alias'); symlinkSync(path, alias);
    const writable = root(); chmodSync(writable, 0o777);
    for (const bad of [join(path, 'missing'), 'relative', alias, writable]) {
      const d = deps();
      expect((await runPlannerCycle(opts(bad), d)).report.verdict).toBe('failed');
      expect(d.executePass).not.toHaveBeenCalled(); expect(d.readOutput).not.toHaveBeenCalled();
    }
  });
});
