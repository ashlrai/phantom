import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleet } from '../src/cli/fleet.js';
import { cmdFleetContextCheckedRun } from '../src/cli/fleet-context-checked-run.js';
import { resolveFleetSubcommand } from '../src/cli/fleet-subcommand-resolve.js';
import { CONTEXT_START, CONTEXT_END } from '../src/core/fleet/context-worker-run.js';
import type { ContextCheckedRunIO } from '../src/core/fleet/context-checked-run.js';
import type { LocalGateDeps } from '../src/core/fleet/local-gate.js';

let root: string, snapshot: string, prompt: string, out: string, err: string;
let events: string[];
const input = () => ({ node: { jobId: 'CURRENT', upstreamJobIds: ['UPSTREAM'] },
  tasks: [{ jobId: 'UPSTREAM', text: 'cited upstream task' }], outputs: [], byteBudget: 800 });
const sha = (letter: string) => letter.repeat(40);
const echoScript = 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>process.stdout.write(JSON.stringify({s})))';
const args = (extra: string[] = [], childArgs = ['-e', echoScript]) =>
  ['--snapshot', snapshot, '--prompt', prompt, ...extra, '--', process.execPath, ...childArgs];
const io = (gate?: LocalGateDeps): ContextCheckedRunIO => ({
  stdout: new Writable({ write(c, _e, done) { const s = String(c); out += s; if (!events.includes('worker:stdout')) events.push('worker:stdout'); done(); } }),
  stderr: new Writable({ write(c, _e, done) { const s = String(c); err += s; if (s.startsWith('context-checked-run:')) events.push('result'); done(); } }),
  gate,
});
const lastResult = () => JSON.parse(err.trim().split('\n').at(-1)!.replace('context-checked-run: ', '')) as { workerExit: number; gateVerdict: string };
const metricRows = async (path = join(root, 'metrics', 'local-gate.jsonl')) =>
  (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { verdict: string; steps: { name: string }[] });

function passGate(): { exec: ReturnType<typeof vi.fn>; deps: LocalGateDeps } {
  const exec = vi.fn(async (command: string, argv: string[]) => {
    events.push(`gate:${command}`);
    return { ok: true, stdout: command === 'git' ? sha(argv[0] === 'rev-parse' ? 'a' : 'b') : '', stderr: '' };
  });
  return { exec, deps: { exec, cwd: root, metricsPath: join(root, 'metrics', 'local-gate.jsonl') } };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'context-checked-run-'));
  vi.stubEnv('HOME', root); vi.stubEnv('ASHLR_RUNS_DIR', join(root, '.ashlr-runs')); vi.stubEnv('ASHLR_HOME', join(root, '.ashlr'));
  await mkdir(join(root, '.ashlr-runs'), { mode: 0o700 });
  snapshot = join(root, 'snapshot.json'); prompt = join(root, 'prompt.txt'); out = ''; err = ''; events = [];
  await writeFile(snapshot, JSON.stringify(input())); await writeFile(prompt, 'Base prompt\n');
});
afterEach(async () => { vi.unstubAllEnvs(); vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

describe('fleet context-checked-run', () => {
  it('exposes the convention export and dispatches through ashlr fleet', async () => {
    const resolved = resolveFleetSubcommand('context-checked-run');
    expect(resolved).toEqual({ module: './fleet-context-checked-run.js', exportName: 'cmdFleetContextCheckedRun' });
    const loaded = await import('../src/cli/fleet-context-checked-run.js');
    expect(typeof loaded[resolved!.exportName]).toBe('function');
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    expect(await cmdFleet(['context-checked-run', '--help'])).toBe(0);
    expect(write.mock.calls.flat().join('')).toContain('Usage: ashlr fleet context-checked-run');
  });

  it('prints usage and exits 0 on --help without running anything', async () => {
    const { exec, deps } = passGate();
    expect(await cmdFleetContextCheckedRun(['--help'], io(deps))).toBe(0);
    expect(out).toContain('Usage: ashlr fleet context-checked-run');
    expect(exec).not.toHaveBeenCalled();
  });

  it('feeds cited context to the worker, runs the gate exactly once after it, then reports', async () => {
    const { exec, deps } = passGate();
    expect(await cmdFleetContextCheckedRun(args(), io(deps))).toBe(0);
    const stdin = (JSON.parse(out) as { s: string }).s;
    expect(stdin.startsWith('Base prompt\n' + CONTEXT_START)).toBe(true);
    expect(stdin.endsWith(CONTEXT_END)).toBe(true);
    const pack = stdin.slice(('Base prompt\n' + CONTEXT_START).length, -CONTEXT_END.length);
    expect(pack.trim().split('\n').map(line => JSON.parse(line)))
      .toContainEqual({ jobId: 'UPSTREAM', kind: 'task', text: 'cited upstream task', truncated: false });
    // One gate invocation, strictly after the worker: git identity pair then the two real check commands.
    expect(events[0]).toBe('worker:stdout');
    expect(exec).toHaveBeenCalledTimes(4);
    expect(exec.mock.calls.map(call => [call[0], call[1][0]])).toEqual([
      ['git', 'rev-parse'], ['git', 'merge-base'], ['node', join(root, 'node_modules', 'typescript', 'bin', 'tsc')], ['node', 'scripts/verify-changed.mjs'],
    ]);
    expect(events.filter(e => e.startsWith('gate:'))).toEqual(['gate:git', 'gate:git', 'gate:node', 'gate:node']);
    expect(events.at(-1)).toBe('result');
    expect(err).toBe('context-checked-run: {"workerExit":0,"gateVerdict":"pass"}\n');
    const rows = await metricRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.verdict).toBe('pass');
    expect(JSON.stringify(rows[0])).not.toContain(snapshot);
    expect(JSON.stringify(rows[0])).not.toContain(prompt);
  }, 30000);

  it('skips the gate after a nonzero worker exit', async () => {
    const { exec, deps } = passGate();
    const code = await cmdFleetContextCheckedRun(
      args([], ['-e', 'process.stdin.resume();process.stdin.on("end",()=>process.exit(7))']), io(deps));
    expect(code).toBe(7);
    expect(exec).not.toHaveBeenCalled();
    expect(lastResult()).toEqual({ workerExit: 7, gateVerdict: 'skipped' });
    expect(existsSync(join(root, 'metrics', 'local-gate.jsonl'))).toBe(false);
  }, 30000);

  it('skips the gate when the context input is invalid', async () => {
    const { exec, deps } = passGate();
    await writeFile(snapshot, '{"unexpected":"shape"}');
    expect(await cmdFleetContextCheckedRun(args(), io(deps))).toBe(2);
    expect(exec).not.toHaveBeenCalled();
    expect(lastResult()).toEqual({ workerExit: 2, gateVerdict: 'skipped' });
  }, 30000);

  it('returns nonzero when the gate fails', async () => {
    const { exec, deps } = passGate();
    exec.mockImplementation(async (command: string, argv: string[]) => ({
      ok: command === 'git', stdout: command === 'git' ? sha(argv[0] === 'rev-parse' ? 'a' : 'b') : '', stderr: '',
    }));
    expect(await cmdFleetContextCheckedRun(args(), io(deps))).toBe(1);
    expect(exec).toHaveBeenCalledTimes(4);
    expect(lastResult()).toEqual({ workerExit: 0, gateVerdict: 'fail' });
    expect((await metricRows()).at(-1)!.verdict).toBe('fail');
  }, 30000);

  it('returns nonzero when the gate throws', async () => {
    const deps: LocalGateDeps = { now: () => { throw new Error('clock dead'); }, metricsPath: join(root, 'metrics', 'local-gate.jsonl') };
    expect(await cmdFleetContextCheckedRun(args(), io(deps))).toBe(1);
    expect(lastResult()).toEqual({ workerExit: 0, gateVerdict: 'error' });
  }, 30000);

  it('does not report success until the gate promise settles', async () => {
    let release = false;
    const exec = vi.fn(async (command: string, argv: string[]) => {
      while (!release) await new Promise(r => setTimeout(r, 5));
      return { ok: true, stdout: command === 'git' ? sha(argv[0] === 'rev-parse' ? 'a' : 'b') : '', stderr: '' };
    });
    let settled = false;
    const done = cmdFleetContextCheckedRun(args(), io({ exec, metricsPath: join(root, 'metrics', 'gate.jsonl') }))
      .then(code => { settled = true; return code; });
    for (let i = 0; i < 1500 && exec.mock.calls.length === 0; i++) await new Promise(r => setTimeout(r, 10));
    expect(exec).toHaveBeenCalled();
    await new Promise(r => setTimeout(r, 25));
    expect(settled).toBe(false);
    expect(events).not.toContain('result');
    release = true;
    expect(await done).toBe(0);
    expect(settled).toBe(true);
  }, 30000);

  it('passes --budget-seconds through to the gate and keeps the production default without it', async () => {
    let elapsed = 0;
    const exec = vi.fn(async (command: string, argv: string[]) => {
      elapsed += 1;
      return { ok: true, stdout: command === 'git' ? sha(argv[0] === 'rev-parse' ? 'a' : 'b') : '', stderr: '' };
    });
    const deps: LocalGateDeps = { exec, now: () => elapsed, metricsPath: join(root, 'metrics', 'local-gate.jsonl') };
    expect(await cmdFleetContextCheckedRun(args(['--budget-seconds', '2']), io(deps))).toBe(1);
    expect(lastResult()).toEqual({ workerExit: 0, gateVerdict: 'fail' });
    expect((await metricRows()).at(-1)!.steps.map(step => step.name)).toContain('budget');
    out = ''; err = ''; events = [];
    expect(await cmdFleetContextCheckedRun(args(), io(deps))).toBe(0);
    expect(lastResult()).toEqual({ workerExit: 0, gateVerdict: 'pass' });
  }, 30000);

  it('refuses invalid flags, NaN and a missing separator while spawning nothing', async () => {
    const marker = join(root, 'spawned');
    const probe = ['--', process.execPath, '-e', `require("fs").writeFileSync(${JSON.stringify(marker)},"x")`];
    const bad: [string, string[]][] = [
      ['missing separator', ['--snapshot', snapshot, '--prompt', prompt]],
      ['empty argv', ['--snapshot', snapshot, '--prompt', prompt, '--']],
      ['missing --snapshot', ['--prompt', prompt, ...probe]],
      ['missing --prompt', ['--snapshot', snapshot, ...probe]],
      ['relative --snapshot', ['--snapshot', 'snapshot.json', '--prompt', prompt, ...probe]],
      ['relative --prompt', ['--snapshot', snapshot, '--prompt', 'prompt.txt', ...probe]],
      ['unknown flag', ['--snapshot', snapshot, '--prompt', prompt, '--bogus', '1', ...probe]],
      ['duplicate flag', ['--snapshot', snapshot, '--prompt', prompt, '--snapshot', snapshot, ...probe]],
      ['dangling flag value', ['--snapshot', snapshot, '--prompt', ...probe]],
      ['NaN budget', ['--snapshot', snapshot, '--prompt', prompt, '--budget-seconds', 'NaN', ...probe]],
      ['zero budget', ['--snapshot', snapshot, '--prompt', prompt, '--budget-seconds', '0', ...probe]],
      ['negative budget', ['--snapshot', snapshot, '--prompt', prompt, '--budget-seconds', '-1', ...probe]],
      ['infinite budget', ['--snapshot', snapshot, '--prompt', prompt, '--budget-seconds', 'Infinity', ...probe]],
    ];
    for (const [name, argv] of bad) {
      const { exec, deps } = passGate();
      out = ''; err = ''; events = [];
      expect(await cmdFleetContextCheckedRun(argv, io(deps)), name).toBe(2);
      expect(err, name).toContain('Usage: ashlr fleet context-checked-run');
      expect(out, name).toBe('');
      expect(existsSync(marker), name).toBe(false);
      expect(exec, name).not.toHaveBeenCalled();
    }
  });
});
