import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cmdFleetDonePlan } from '../src/cli/fleet-done-plan.js';
import {
  DONE_CONTRACT_CLOSE, DONE_CONTRACT_OPEN, MAX_CONTRACT_BYTES, loadDoneContract, parseDoneContract, planDoneContract,
} from '../src/core/done-contract-plan.js';

const spawnSpy = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (orig) => ({ ...(await orig<typeof import('node:child_process')>()), spawnSync: spawnSpy, spawn: spawnSpy, execFileSync: spawnSpy }));

let dir: string;
let outside: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dcp-wt-'));
  outside = mkdtempSync(join(tmpdir(), 'dcp-out-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const contract = (extra: Record<string, unknown> = {}) => ({
  schema: 'done-contract.v1',
  job: 'JOB-1',
  verify: [{ id: 'unit-a', cmd: ['node', '--version'] }],
  acceptance: [{ id: 'a1', text: 'It works', evidence: 'command:unit-a' }],
  ...extra,
});
const put = (name: string, body: unknown) => writeFileSync(join(dir, name), typeof body === 'string' ? body : JSON.stringify(body));
const embed = (json: string) => `# notes\n${DONE_CONTRACT_OPEN}\n\`\`\`json\n${json}\n\`\`\`\n- [ ] a1 — pending\n${DONE_CONTRACT_CLOSE}\n`;

describe('parseDoneContract', () => {
  it('accepts the optional-layer schema', () => {
    expect(parseDoneContract(JSON.stringify({ schema: 'done-contract.v1', floor: { checks: ['unit'] } })).floor?.checks).toEqual(['unit']);
  });
  it.each([
    ['duplicate-id', contract({ verify: [{ id: 'x', cmd: ['a'] }, { id: 'x', cmd: ['b'] }], acceptance: undefined })],
    ['duplicate-id', contract({ floor: { checks: ['unit'] }, verify: [{ id: 'unit', cmd: ['a'] }] })],
    ['unresolved-command-ref', contract({ acceptance: [{ id: 'a1', text: 't', evidence: 'command:ghost' }] })],
    ['no-enforceable-layer', { schema: 'done-contract.v1' }],
    ['schema-invalid', contract({ extra: 1 })],
    ['schema-invalid', contract({ verify: [{ id: 'x', cmd: ['a'], cwd: '../up' }] })],
  ])('rejects %s', (category, value) => {
    expect(() => parseDoneContract(JSON.stringify(value))).toThrow(category);
  });
  it('rejects non-JSON without echoing it', () => {
    expect(() => parseDoneContract('{SECRET-ish')).toThrow('not-json');
  });
});

describe('loadDoneContract precedence and absence', () => {
  it('is none (legacy) when nothing is claimed, and notes presence is reported', () => {
    expect(loadDoneContract(dir)).toMatchObject({ source: 'none', error: null, legacyNotesPresent: false });
    put('BRIDGE_NOTES.md', 'freeform notes');
    expect(loadDoneContract(dir)).toMatchObject({ source: 'none', error: null, legacyNotesPresent: true });
  });
  it('prefers explicit > root file > notes embed', () => {
    put('BRIDGE_NOTES.md', embed(JSON.stringify(contract({ job: 'FROM-NOTES' }))));
    expect(loadDoneContract(dir)).toMatchObject({ source: 'notes-embed', contract: { job: 'FROM-NOTES' } });
    put('DONE_CONTRACT.json', contract({ job: 'FROM-ROOT' }));
    expect(loadDoneContract(dir)).toMatchObject({ source: 'contract-file', contract: { job: 'FROM-ROOT' } });
    mkdirSync(join(dir, 'sub'));
    put('sub/explicit.json', contract({ job: 'FROM-EXPLICIT' }));
    expect(loadDoneContract(dir, { contractPath: 'sub/explicit.json' }).contract?.job).toBe('FROM-EXPLICIT');
  });
  it('fails closed on claimed-but-malformed contracts instead of falling back', () => {
    put('BRIDGE_NOTES.md', embed(JSON.stringify(contract())));
    put('DONE_CONTRACT.json', '{ nope');
    expect(loadDoneContract(dir)).toMatchObject({ source: 'contract-file', contract: null, error: 'not-json' });
    rmSync(join(dir, 'DONE_CONTRACT.json'));
    put('BRIDGE_NOTES.md', `${DONE_CONTRACT_OPEN}\nno fence\n${DONE_CONTRACT_CLOSE}`);
    expect(loadDoneContract(dir)).toMatchObject({ source: 'notes-embed', error: 'no-fenced-json' });
    put('BRIDGE_NOTES.md', embed('{"schema":"done-contract.v1"}'));
    expect(loadDoneContract(dir).error).toBe('no-enforceable-layer');
    expect(loadDoneContract(dir, { contractPath: 'missing.json' }).error).toBe('not-found');
  });
  it('rejects oversize, non-regular, symlink and traversal paths', () => {
    put('DONE_CONTRACT.json', ' '.repeat(MAX_CONTRACT_BYTES + 1));
    expect(loadDoneContract(dir).error).toBe('oversize');
    rmSync(join(dir, 'DONE_CONTRACT.json'));
    mkdirSync(join(dir, 'DONE_CONTRACT.json'));
    expect(loadDoneContract(dir).error).toBe('not-regular-file');
    rmSync(join(dir, 'DONE_CONTRACT.json'), { recursive: true });
    writeFileSync(join(outside, 'c.json'), JSON.stringify(contract()));
    symlinkSync(join(outside, 'c.json'), join(dir, 'DONE_CONTRACT.json'));
    expect(loadDoneContract(dir).error).toBe('symlink');
    symlinkSync(outside, join(dir, 'linkdir'));
    expect(loadDoneContract(dir, { contractPath: 'linkdir/c.json' }).error).toBe('path-escape');
    expect(loadDoneContract(dir, { contractPath: '../x.json' }).error).toBe('path-escape');
    expect(loadDoneContract(dir, { contractPath: join(outside, 'c.json') }).error).toBe('path-escape');
  });
});

describe('planDoneContract', () => {
  it('lists argv, ids and evidence, resolves named checks, and spawns nothing', () => {
    put('package.json', JSON.stringify({ scripts: { 'test:ci': 'x' } }));
    put('DONE_CONTRACT.json', contract({ floor: { checks: ['unit', 'lint'] } }));
    const { plan } = planDoneContract(dir);
    expect(plan?.checks.map((c) => [c.id, c.from, c.argv, c.resolved])).toEqual([
      ['unit', 'floor-check', ['npm', 'run', 'test:ci'], true],
      ['lint', 'floor-check', null, false],
      ['unit-a', 'verify', ['node', '--version'], true],
    ]);
    expect(plan?.acceptance).toEqual([{ id: 'a1', text: 'It works', evidence: 'command:unit-a', required: true }]);
    expect(spawnSpy).not.toHaveBeenCalled();
  });
  it('does not read a package.json that links outside the worktree', () => {
    writeFileSync(join(outside, 'package.json'), '{"scripts":{"test":"x"}}');
    symlinkSync(join(outside, 'package.json'), join(dir, 'package.json'));
    put('DONE_CONTRACT.json', contract({ floor: { checks: ['unit'] } }));
    const { plan } = planDoneContract(dir);
    expect(plan?.resolutionError).toBe('check-resolution-failed');
    expect(plan?.checks[0]).toMatchObject({ id: 'unit', argv: null, resolved: false });
  });
});

describe('cmdFleetDonePlan', () => {
  const run = async (args: string[]) => {
    const out: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((s: unknown) => void out.push(String(s)));
    vi.spyOn(console, 'error').mockImplementation((s: unknown) => void out.push(String(s)));
    const code = await cmdFleetDonePlan(args);
    return { code, out: out.join('\n') };
  };
  it('prints help', async () => {
    expect(await run(['--help'])).toMatchObject({ code: 0 });
  });
  it('emits deterministic JSON for a valid contract', async () => {
    put('DONE_CONTRACT.json', contract());
    const a = await run(['--worktree', dir, '--json']);
    const b = await run(['--worktree', dir, '--json']);
    expect(a).toEqual(b);
    expect(a.code).toBe(0);
    expect(JSON.parse(a.out)).toMatchObject({ schema: 'fleet.done-plan.v1', readOnly: true, status: 'contract', source: 'contract-file' });
  });
  it('reports legacy mode with exit 0 and an invalid contract with exit 1, echoing nothing', async () => {
    expect(JSON.parse((await run(['--worktree', dir, '--json'])).out)).toMatchObject({ status: 'legacy-notes', source: 'none' });
    put('DONE_CONTRACT.json', '{"schema":"done-contract.v1","verify":[{"id":"LEAK-ME","cmd":["x"]}]}');
    const bad = await run(['--worktree', dir, '--json']);
    expect(bad.code).toBe(1);
    expect(JSON.parse(bad.out)).toMatchObject({ status: 'invalid', error: 'schema-invalid' });
    expect(bad.out).not.toContain('LEAK-ME');
  });
  it('exits 2 for usage and worktree errors', async () => {
    expect((await run([])).code).toBe(2);
    expect((await run(['--worktree', dir, '--bogus'])).code).toBe(2);
    expect(await run(['--worktree', join(dir, 'nope'), '--json'])).toMatchObject({ code: 2 });
  });
  it('honours --contract', async () => {
    put('other.json', contract({ job: 'OTHER' }));
    const r = await run(['--worktree', dir, '--contract', 'other.json', '--json']);
    expect(JSON.parse(r.out).job).toBe('OTHER');
  });
});
