import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetPlannerCycle } from '../src/cli/fleet-planner-cycle.js';
import { runPlannerCycle, type PlannerCycleDeps } from '../src/core/fleet/planner-cycle.js';
import type { executePlannerPass } from '../src/core/fleet/planner-pass.js';
import type { PlannerPassOutput } from '../src/core/fleet/planner-pass-output.js';
import type { PlannerRunResult } from '../src/core/fleet/planner-run.js';

type PassReturn = Awaited<ReturnType<typeof executePlannerPass>>;
const ROOT = '/fake/runs', PROMPT = '/fake/prompt.txt';

function runResult(over: Partial<PlannerRunResult> = {}): PlannerRunResult {
  return {
    v: 1, provider: 'fake-live', outcome: 'ran', exitCode: 0, logPath: null,
    startedAt: '2026-11-01T00:08:00.500Z', finishedAt: '2026-11-01T00:08:30.250Z',
    nextResetAt: null, planError: null, ...over,
  };
}
function view(over: Partial<PlannerPassOutput> = {}): PlannerPassOutput {
  return {
    v: 1, window: { since: 's', until: 'u' }, ingested: [], pending: [], rejected: [],
    counts: { ingested: 0, pending: 0, rejected: 0 },
    sources: { ledger: 'ok', drops: [{ dir: 'a', state: 'ok' }, { dir: 'b', state: 'ok' }, { dir: 'c', state: 'ok' }], skipped: 0 },
    ...over,
  };
}
function deps(pass: PassReturn, output?: PlannerPassOutput): PlannerCycleDeps {
  return {
    executePass: vi.fn<typeof executePlannerPass>().mockResolvedValue(pass),
    readOutput: vi.fn<PlannerCycleDeps['readOutput']>().mockResolvedValue(output ?? view()),
  };
}
const pad = (n: number): string => String(n).padStart(2, '0');
const localStamp = (d: Date): string =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe('planner cycle', () => {
  it('previews through executePlannerPass without spawning or reading evidence', async () => {
    const d = deps({ ok: true, provider: 'fake-live', reason: 'healthy slate' } as PassReturn);
    const { report, exitCode } = await runPlannerCycle({ runsRoot: ROOT, promptPath: PROMPT }, d);
    expect(d.executePass).toHaveBeenCalledExactlyOnceWith({ runsRoot: ROOT, promptPath: PROMPT, run: false });
    expect(d.readOutput).not.toHaveBeenCalled();
    expect(exitCode).toBe(0);
    expect(report).toMatchObject({ mode: 'preview', verdict: 'planned', execution: { outcome: 'planned', provider: 'fake-live' }, evidence: { state: 'not-collected' } });
  });
  it('fails a preview that cannot select a runner', async () => {
    const d = deps({ ok: false, provider: null, reason: 'planner candidates missing', nextResetAt: null } as PassReturn);
    const { report, exitCode } = await runPlannerCycle({ runsRoot: ROOT, promptPath: PROMPT }, d);
    expect(exitCode).toBe(1);
    expect(report.verdict).toBe('failed');
  });
  it('treats zero exit with no produced jobs as unproductive', async () => {
    const d = deps({ ok: true, provider: 'fake-live', reason: 'ran', result: runResult() } as PassReturn);
    const { report, exitCode } = await runPlannerCycle({ runsRoot: ROOT, promptPath: PROMPT, apply: true }, d);
    expect(d.executePass).toHaveBeenCalledExactlyOnceWith({ runsRoot: ROOT, promptPath: PROMPT, run: true });
    // Real run bounds, widened only to whole-second ledger granularity.
    expect(d.readOutput).toHaveBeenCalledExactlyOnceWith({
      runsRoot: ROOT, home: undefined, now: undefined,
      sinceMs: Date.parse('2026-11-01T00:08:00.000Z'), untilMs: Date.parse('2026-11-01T00:08:31.000Z'),
    });
    expect(exitCode).toBe(1);
    expect(report).toMatchObject({ verdict: 'unproductive', execution: { outcome: 'ran', exitCode: 0 }, evidence: { state: 'unproductive' } });
  });
  it('fails when the pass produced only rejected jobs', async () => {
    const out = view({ rejected: [{ id: 'RQ-PHX-DEN01', reason: 'denied-path', at: 'a' }], counts: { ingested: 0, pending: 0, rejected: 1 } });
    const d = deps({ ok: true, provider: 'fake-live', reason: 'ran', result: runResult() } as PassReturn, out);
    const { report, exitCode } = await runPlannerCycle({ runsRoot: ROOT, promptPath: PROMPT, apply: true }, d);
    expect(exitCode).toBe(1);
    expect(report).toMatchObject({ verdict: 'unproductive', evidence: { state: 'unproductive', rejected: [{ id: 'RQ-PHX-DEN01', reason: 'denied-path' }] } });
  });
  it.each([
    ['pending', view({ pending: [{ id: 'RQ-PHX-NEW01', dropDir: 'a', ageSeconds: 3 }], counts: { ingested: 0, pending: 1, rejected: 0 } })],
    ['ingested', view({ ingested: [{ id: 'RQ-PHX-ING01', who: 'claude', lane: 'claude', tier: 'work', at: 'a' }], counts: { ingested: 1, pending: 0, rejected: 0 } })],
  ] as const)('is productive on %s output', async (_kind, out) => {
    const d = deps({ ok: true, provider: 'fake-live', reason: 'ran', result: runResult() } as PassReturn, out);
    const { report, exitCode } = await runPlannerCycle({ runsRoot: ROOT, promptPath: PROMPT, apply: true }, d);
    expect(exitCode).toBe(0);
    expect(report).toMatchObject({ verdict: 'productive', execution: { outcome: 'ran', exitCode: 0 }, evidence: { state: 'productive', attribution: 'observational' } });
  });
  it.each([
    ['nonzero exit', runResult({ exitCode: 7 })],
    ['spawn-failed', runResult({ outcome: 'spawn-failed', exitCode: null })],
    ['no-runner', runResult({ outcome: 'no-runner', exitCode: null, provider: null })],
    ['plan-failed', runResult({ outcome: 'plan-failed', exitCode: null, provider: null, planError: 'dup' })],
  ] as const)('fails on runner outcome: %s', async (_kind, result) => {
    const d = deps({ ok: false, provider: result.provider, reason: 'ran', result } as PassReturn);
    const { report, exitCode } = await runPlannerCycle({ runsRoot: ROOT, promptPath: PROMPT, apply: true }, d);
    expect(exitCode).toBe(1);
    expect(report.verdict).toBe('failed');
    expect(report.execution.outcome).toBe(result.outcome);
  });
  it('never calls ORCH_OFF productive, even when drops appear in the window', async () => {
    const out = view({ pending: [{ id: 'RQ-PHX-OTHER1', dropDir: 'a', ageSeconds: 1 }], counts: { ingested: 0, pending: 1, rejected: 0 } });
    const result = runResult({ outcome: 'skipped-orch-off', provider: null, exitCode: null, startedAt: '2026-11-01T00:08:00.500Z', finishedAt: '2026-11-01T00:08:00.500Z' });
    const d = deps({ ok: true, provider: null, reason: 'ran', result } as PassReturn, out);
    const { report, exitCode } = await runPlannerCycle({ runsRoot: ROOT, promptPath: PROMPT, apply: true }, d);
    expect(exitCode).toBe(3);
    expect(report.verdict).toBe('skipped');
    // Evidence is still reported, but attributed only to the observed window.
    expect(report.evidence.counts?.pending).toBe(1);
  });
  it('fails when no run result is produced', async () => {
    const d = deps({ ok: false, provider: null, reason: 'all candidates are usage-limited', nextResetAt: '2099-01-01T00:00:00Z' } as PassReturn);
    const { report, exitCode } = await runPlannerCycle({ runsRoot: ROOT, promptPath: PROMPT, apply: true }, d);
    expect(d.readOutput).not.toHaveBeenCalled();
    expect(exitCode).toBe(1);
    expect(report).toMatchObject({ verdict: 'failed', execution: { outcome: 'not-run', nextResetAt: '2099-01-01T00:00:00Z' }, evidence: { state: 'not-collected' } });
  });
  it.each([
    ['invalid ledger', view({ sources: { ledger: 'invalid', drops: [{ dir: 'a', state: 'ok' }, { dir: 'b', state: 'ok' }, { dir: 'c', state: 'ok' }], skipped: 0 } })],
    ['invalid drop', view({ sources: { ledger: 'ok', drops: [{ dir: 'a', state: 'invalid' }, { dir: 'b', state: 'ok' }, { dir: 'c', state: 'ok' }], skipped: 0 } })],
    ['skipped entries', view({ sources: { ledger: 'ok', drops: [{ dir: 'a', state: 'ok' }, { dir: 'b', state: 'ok' }, { dir: 'c', state: 'ok' }], skipped: 1 } })],
    ['all sources missing', view({ sources: { ledger: 'missing', drops: [{ dir: 'a', state: 'missing' }, { dir: 'b', state: 'missing' }, { dir: 'c', state: 'missing' }], skipped: 0 } })],
  ] as const)('reports unknown on degraded evidence: %s', async (_kind, out) => {
    const d = deps({ ok: true, provider: 'fake-live', reason: 'ran', result: runResult() } as PassReturn, out);
    const { report, exitCode } = await runPlannerCycle({ runsRoot: ROOT, promptPath: PROMPT, apply: true }, d);
    expect(exitCode).toBe(4);
    expect(report).toMatchObject({ verdict: 'unknown', evidence: { state: 'unknown' } });
  });
  it('reports unknown when the run bounds cannot bound an evidence window', async () => {
    const d = deps({ ok: true, provider: 'fake-live', reason: 'ran', result: runResult({ startedAt: 'not-a-date' }) } as PassReturn);
    const { report, exitCode } = await runPlannerCycle({ runsRoot: ROOT, promptPath: PROMPT, apply: true }, d);
    expect(d.readOutput).not.toHaveBeenCalled();
    expect(exitCode).toBe(4);
    expect(report).toMatchObject({ verdict: 'unknown', evidence: { state: 'unknown' } });
  });
  it('reads a real on-disk ledger and drop window through the real output reader', async () => {
    const root = await mkdtemp(join(tmpdir(), 'planner-cycle-')); roots.push(root);
    const runsRoot = join(root, 'runs'), home = join(root, 'home');
    const claude = join(runsRoot, 'leader', 'drop', 'claude'), done = join(runsRoot, 'leader', 'drop', 'done');
    await Promise.all([claude, done, join(home, 'Projects', 'ashlrai', '.orch-drop', 'sol')].map((dir) => mkdir(dir, { recursive: true })));
    const t = new Date(2026, 10, 1, 0, 8, 10).getTime();
    await writeFile(join(runsRoot, 'leader', 'drop', 'ingested.tsv'), `${localStamp(new Date(t))}\tRQ-PHX-ING01\tclaude\tclaude\twork\tfixture\n`);
    const inside = join(claude, 'RQ-PHX-NEW01.md'), outside = join(done, 'RQ-PHX-OLD01.md.denied-path');
    await writeFile(inside, 'fixture'); await writeFile(outside, 'fixture');
    await Promise.all([utimes(inside, new Date(t), new Date(t)), utimes(outside, new Date(t - 120_000), new Date(t - 120_000))]);
    const result = runResult({ startedAt: new Date(t - 30_000).toISOString(), finishedAt: new Date(t + 30_000).toISOString() });
    const d = deps({ ok: true, provider: 'fake-live', reason: 'ran', result } as PassReturn);
    d.readOutput = (await import('../src/core/fleet/planner-pass-output.js')).readPlannerPassOutput;
    const { report, exitCode } = await runPlannerCycle({ runsRoot, promptPath: PROMPT, apply: true, home, now: () => t + 40_000 }, d);
    expect(exitCode).toBe(0);
    expect(report).toMatchObject({ verdict: 'productive', evidence: { state: 'productive', counts: { ingested: 1, pending: 1, rejected: 0 } } });
    expect(report.evidence.pending).toEqual(['RQ-PHX-NEW01']);
    expect(report.evidence.ingested).toEqual(['RQ-PHX-ING01']);
    expect(report.evidence.sources?.ledger).toBe('ok');
  });
});

describe('planner-cycle command', () => {
  const run = (args: string[], io: Parameters<typeof cmdFleetPlannerCycle>[1] = {}) => {
    let out = '', err = '';
    return cmdFleetPlannerCycle(args, { stdout: { write: (t) => { out += t; } }, stderr: { write: (t) => { err += t; } }, ...io })
      .then((code) => ({ code, out, err }));
  };
  it.each([
    ['no args', []],
    ['missing prompt value', ['--prompt-file']],
    ['relative prompt', ['--prompt-file', 'rel/p.md']],
    ['relative runs-root', ['--prompt-file', '/p.md', '--runs-root', 'rel']],
    ['unknown flag', ['--prompt-file', '/p.md', '--bogus']],
    ['duplicate flag', ['--prompt-file', '/p.md', '--prompt-file', '/p2.md']],
    ['value that looks like a flag', ['--prompt-file', '--apply']],
  ] as const)('rejects %s', async (_kind, args) => {
    const { code, err } = await run([...args]);
    expect(code).toBe(2);
    expect(err).toContain('Usage: ashlr fleet planner-cycle');
  });
  it('prints usage on --help', async () => {
    const { code, out } = await run(['--help']);
    expect(code).toBe(0);
    expect(out).toContain('--apply');
  });
  it('emits sanitized JSON and human output for a preview', async () => {
    const io = { deps: { executePass: vi.fn<typeof executePlannerPass>().mockResolvedValue({ ok: true, provider: 'fake-live', reason: 'healthy slate' } as PassReturn) } };
    const json = await run(['--prompt-file', '/p.md', '--json'], io);
    expect(json.code).toBe(0);
    const parsed = JSON.parse(json.out) as { v: number; verdict: string; mode: string };
    expect(parsed).toMatchObject({ v: 1, mode: 'preview', verdict: 'planned' });
    expect(json.out).not.toContain('/p.md');
    const human = await run(['--prompt-file', '/p.md'], io);
    expect(human.code).toBe(0);
    expect(human.out).toContain('verdict: planned');
  });
});
