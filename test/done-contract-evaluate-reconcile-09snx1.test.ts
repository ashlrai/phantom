import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cmdFleetDoneEvaluate } from '../src/cli/fleet-done-evaluate.js';
import { planDoneContract, DONE_CONTRACT_CLOSE, DONE_CONTRACT_OPEN } from '../src/core/done-contract-plan.js';
import { attestedIds, doneContractHandoff, evaluateDoneContract, type DoneRunner } from '../src/core/done-contract-evaluate.js';

let dir: string;
let outside: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'dce-wt-')));
  outside = realpathSync(mkdtempSync(join(tmpdir(), 'dce-out-')));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const OK = ['node', '-e', 'process.exit(0)'];
const BAD = ['node', '-e', 'console.error("SECRET-OUT-9");process.exit(3)'];
const put = (name: string, body: unknown) => {
  writeFileSync(join(dir, name), typeof body === 'string' ? body : JSON.stringify(body));
};
const contract = (extra: Record<string, unknown> = {}) => ({
  schema: 'done-contract.v1',
  job: 'JOB-1',
  verify: [{ id: 'ok', cmd: OK }],
  acceptance: [{ id: 'a1', text: 'It works', evidence: 'command:ok' }],
  notesFile: null,
  ...extra,
});
const fake = (results: Record<string, ReturnType<DoneRunner>>, calls: string[][] = []): DoneRunner =>
  (argv) => { calls.push([...argv]); return results[argv[0]!] ?? { status: 0 }; };

describe('evaluateDoneContract', () => {
  it('runs real harmless processes and reports actual success and failure without output', () => {
    put('DONE_CONTRACT.json', contract({
      verify: [{ id: 'ok', cmd: OK }, { id: 'bad', cmd: BAD }, { id: 'opt-bad', cmd: BAD, required: false }],
      acceptance: [{ id: 'a1', text: 't', evidence: 'command:ok' }, { id: 'a2', text: 't', evidence: 'command:bad' }],
    }));
    const e = evaluateDoneContract(dir);
    expect(e.checks.map((c) => [c.id, c.outcome, c.exitCode])).toEqual([['ok', 'passed', 0], ['bad', 'failed', 3], ['opt-bad', 'failed', 3]]);
    expect(e.acceptance.map((a) => a.status)).toEqual(['proven', 'unproven']);
    expect(e).toMatchObject({ pass: false, verdict: 'failed', mode: 'contract', source: 'contract-file' });
    expect(JSON.stringify(e) + doneContractHandoff(e)).not.toContain('SECRET-OUT-9');
  });

  it('passes when only optional checks fail, keeping them visible', () => {
    put('DONE_CONTRACT.json', contract({ verify: [{ id: 'ok', cmd: OK }, { id: 'opt', cmd: BAD, required: false }] }));
    const e = evaluateDoneContract(dir);
    expect(e).toMatchObject({ pass: true, verdict: 'passed' });
    expect(e.checks.find((c) => c.id === 'opt')).toMatchObject({ required: false, ok: false, outcome: 'failed' });
  });

  it('maps fake runner timeout, error and throw to categories', () => {
    put('DONE_CONTRACT.json', contract({
      verify: [{ id: 't', cmd: ['to'] }, { id: 'e', cmd: ['er'] }, { id: 'x', cmd: ['boom'] }],
      acceptance: [{ id: 'a1', text: 't', evidence: 'command:t', required: false }],
    }));
    const runner: DoneRunner = (argv) => {
      if (argv[0] === 'boom') throw new Error('SECRET-THROWN');
      return argv[0] === 'to' ? { status: null, error: { code: 'ETIMEDOUT' } } : { status: null, error: { code: 'ENOENT' } };
    };
    const e = evaluateDoneContract(dir, {}, { runner });
    expect(e.checks.map((c) => c.outcome)).toEqual(['timeout', 'error', 'error']);
    expect(e.acceptance[0]).toMatchObject({ status: 'optional-unmet' });
    expect(e.pass).toBe(false);
    expect(JSON.stringify(e)).not.toContain('SECRET-THROWN');
  });

  it('treats notesFile:null as no notes needed, and defaults to requiring notes', () => {
    put('DONE_CONTRACT.json', contract());
    expect(evaluateDoneContract(dir)).toMatchObject({ pass: true, notesFile: null, notesPresent: false });
    put('DONE_CONTRACT.json', contract({ notesFile: undefined }));
    expect(evaluateDoneContract(dir)).toMatchObject({ pass: false, error: 'notes-missing-or-empty' });
    put('BRIDGE_NOTES.md', '   \n');
    expect(evaluateDoneContract(dir).pass).toBe(false);
    put('BRIDGE_NOTES.md', 'real notes');
    expect(evaluateDoneContract(dir).pass).toBe(true);
  });

  it('keeps legacy notes behavior when no contract is claimed', () => {
    const calls: string[][] = [];
    expect(evaluateDoneContract(dir, {}, { runner: fake({}, calls) })).toMatchObject({ pass: false, mode: 'legacy-notes', error: 'notes-missing-or-empty' });
    put('BRIDGE_NOTES.md', '');
    expect(evaluateDoneContract(dir).pass).toBe(false);
    put('BRIDGE_NOTES.md', 'freeform');
    expect(evaluateDoneContract(dir)).toMatchObject({ pass: true, verdict: 'passed', mode: 'legacy-notes', source: 'none' });
    expect(calls).toEqual([]);
  });

  it('fails closed on a malformed claimed contract and executes nothing', () => {
    const calls: string[][] = [];
    put('BRIDGE_NOTES.md', 'plenty of notes');
    put('DONE_CONTRACT.json', '{"schema":"done-contract.v1","verify":[{"id":"LEAK-ME","cmd":["touch","x"]}]}');
    const e = evaluateDoneContract(dir, {}, { runner: fake({}, calls) });
    expect(e).toMatchObject({ pass: false, mode: 'invalid', error: 'schema-invalid', checks: [] });
    expect(calls).toEqual([]);
    expect(JSON.stringify(e)).not.toContain('LEAK-ME');
  });

  it('fails unresolved floor checks and never runs a preview', () => {
    put('DONE_CONTRACT.json', contract({ floor: { checks: ['unit'] }, notesFile: null }));
    const calls: string[][] = [];
    const plan = planDoneContract(dir);
    expect(plan.plan?.checks[0]).toMatchObject({ id: 'unit', resolved: false });
    expect(calls).toEqual([]);
    const e = evaluateDoneContract(dir, {}, { runner: fake({}, calls) });
    expect(e.checks.find((c) => c.id === 'unit')).toMatchObject({ outcome: 'unresolved', ok: false });
    expect(e.pass).toBe(false);
  });

  it('evaluates notes, manual and file evidence honestly', () => {
    mkdirSync(join(dir, 'out'));
    put('out/result.txt', 'x');
    put('BRIDGE_NOTES.md', '- [x] n1 — done: ok\n- [x] n2 — failed: red\n');
    put('DONE_CONTRACT.json', contract({
      notesFile: undefined,
      acceptance: [
        { id: 'n1', text: 't', evidence: 'notes' },
        { id: 'n2', text: 't', evidence: 'notes', required: false },
        { id: 'f1', text: 't', evidence: 'file:out/result.txt' },
        { id: 'f2', text: 't', evidence: 'file:out/missing.txt', required: false },
        { id: 'm1', text: 't', evidence: 'manual' },
      ],
    }));
    const e = evaluateDoneContract(dir, {}, { runner: fake({}) });
    expect(e.acceptance.map((a) => [a.id, a.status])).toEqual([
      ['n1', 'attested'], ['n2', 'optional-unmet'], ['f1', 'proven'], ['f2', 'optional-unmet'], ['m1', 'manual'],
    ]);
    expect(e).toMatchObject({ pass: true, verdict: 'passed-manual-pending' });
    expect(doneContractHandoff(e)).toContain('not machine proof');
  });

  it('does not let an embedded contract region self-attest', () => {
    const json = JSON.stringify(contract({ notesFile: undefined, acceptance: [{ id: 'a1', text: 't', evidence: 'notes' }] }));
    put('BRIDGE_NOTES.md', `# n\n${DONE_CONTRACT_OPEN}\n\`\`\`json\n${json}\n\`\`\`\n- [x] a1 — done: self\n${DONE_CONTRACT_CLOSE}\n`);
    const e = evaluateDoneContract(dir, {}, { runner: fake({}) });
    expect(e).toMatchObject({ source: 'notes-embed', pass: false });
    expect(e.acceptance[0]!.status).toBe('unproven');
    expect([...attestedIds('- [x] a — done\n- [ ] a — pending')]).toEqual([]);
  });

  it('keeps notes, file evidence and cwd inside the real worktree', () => {
    const calls: string[][] = [];
    writeFileSync(join(outside, 'notes.md'), '- [x] n1 — done: escaped\n');
    writeFileSync(join(outside, 'f.txt'), 'x');
    mkdirSync(join(outside, 'cwd'));
    symlinkSync(join(outside, 'notes.md'), join(dir, 'BRIDGE_NOTES.md'));
    symlinkSync(outside, join(dir, 'link'));
    put('DONE_CONTRACT.json', contract({
      notesFile: undefined,
      verify: [{ id: 'esc', cmd: OK, cwd: 'link/cwd' }, { id: 'ok', cmd: OK }],
      acceptance: [
        { id: 'n1', text: 't', evidence: 'notes' },
        { id: 'f1', text: 't', evidence: 'file:link/f.txt' },
        { id: 'f2', text: 't', evidence: 'file:../outside' },
      ],
    }));
    // '../outside' is rejected at plan time (bad-file-evidence), so drop it to test the rest.
    expect(evaluateDoneContract(dir, {}, { runner: fake({}, calls) })).toMatchObject({ mode: 'invalid', error: 'bad-file-evidence' });
    expect(calls).toEqual([]);
    put('DONE_CONTRACT.json', contract({
      notesFile: undefined,
      verify: [{ id: 'esc', cmd: OK, cwd: 'link/cwd' }, { id: 'ok', cmd: OK }],
      acceptance: [{ id: 'n1', text: 't', evidence: 'notes' }, { id: 'f1', text: 't', evidence: 'file:link/f.txt' }],
    }));
    const e = evaluateDoneContract(dir, {}, { runner: fake({}, calls) });
    expect(e.checks.find((c) => c.id === 'esc')).toMatchObject({ outcome: 'rejected', ok: false });
    expect(calls).toHaveLength(1);
    expect(e.notesPresent).toBe(false);
    expect(e.acceptance.map((a) => a.status)).toEqual(['unproven', 'unproven']);
    expect(e.pass).toBe(false);
  });
});

describe('cmdFleetDoneEvaluate', () => {
  const run = async (args: string[]) => {
    const out: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((s: unknown) => void out.push(String(s)));
    vi.spyOn(console, 'error').mockImplementation((s: unknown) => void out.push(String(s)));
    const code = await cmdFleetDoneEvaluate(args);
    return { code, out: out.join('\n') };
  };
  it('prints help, and validates arguments before running anything', async () => {
    put('DONE_CONTRACT.json', contract({ verify: [{ id: 'ok', cmd: ['node', '-e', `require("fs").writeFileSync(${JSON.stringify(join(dir, 'RAN'))},"")`] }] }));
    expect((await run(['--help'])).code).toBe(0);
    for (const bad of [[], ['--worktree', dir], ['--worktree', dir, '--trust-worktree', '--bogus'], ['--trust-worktree', '--worktree']]) {
      expect((await run(bad)).code).toBe(2);
    }
    expect((await run(['--worktree', join(dir, 'nope'), '--trust-worktree', '--json']))).toMatchObject({ code: 2 });
    expect(() => realpathSync(join(dir, 'RAN'))).toThrow();
  });
  it('emits JSON with exit 0 on pass and 1 on failure or invalid contract', async () => {
    put('DONE_CONTRACT.json', contract());
    const pass = await run(['--worktree', dir, '--trust-worktree', '--json']);
    expect(pass.code).toBe(0);
    expect(JSON.parse(pass.out)).toMatchObject({
      schema: 'fleet.done-evaluate.v1', evaluationSchema: 'done-contract.evaluation.v1', status: 'passed', source: 'contract-file',
      checks: [{ id: 'ok', outcome: 'passed' }], acceptance: [{ id: 'a1', status: 'proven' }],
    });
    put('DONE_CONTRACT.json', contract({ verify: [{ id: 'ok', cmd: BAD }] }));
    const fail = await run(['--worktree', dir, '--trust-worktree', '--json']);
    expect(fail.code).toBe(1);
    expect(fail.out).not.toContain('SECRET-OUT-9');
    put('DONE_CONTRACT.json', '{nope');
    const bad = await run(['--worktree', dir, '--trust-worktree', '--contract', 'DONE_CONTRACT.json']);
    expect(bad.code).toBe(1);
    expect(bad.out).toContain('FAILED');
    expect(bad.out).not.toContain('nope');
  });
});
