/**
 * done-contract.v1 — the layered, file-based done contract (RQ-SWE5-DONE-CONTRACT).
 *
 * Hermetic: fixture worktrees in tmpdir, an injected command runner that never
 * spawns, and fs stubs — nothing touches the real HOME or real endpoints. A few
 * cases run `node -e` argv through the real spawnSync runner, matching
 * verify-change.test.ts's convention of executing only fixture scripts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { cmdVerify } from '../src/cli/verify.js';
import {
  DONE_CONTRACT_CLOSE, DONE_CONTRACT_FILE, DONE_CONTRACT_OPEN, DONE_CONTRACT_SCHEMA, DONE_NOTES_FILE,
  attestedIds, contractNotesFile, doneContractBlock, doneContractHandoff, doneContractPlan,
  evaluateDoneContract, extractDoneContract, loadDoneContract, parseDoneContract,
  type DoneContract, type DoneContractRunResult,
} from '../src/core/done-contract.js';

const roots: string[] = [];
function fixture(files: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'done-contract-'));
  roots.push(root);
  for (const [name, text] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, text);
  }
  return root;
}
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const contract = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  schema: DONE_CONTRACT_SCHEMA,
  job: 'RQ-SWE5-DONE-CONTRACT',
  floor: { commands: [{ id: 'floor1', cmd: ['node', '-e', 'process.exit(0)'] }] },
  acceptance: [
    { id: 'a1', text: 'validator lands', evidence: 'command:floor1' },
    { id: 'a2', text: 'notes kept', evidence: 'notes' },
  ],
  verify: [{ id: 'v1', cmd: ['node', '-e', 'process.exit(0)'], required: false }],
  ...over,
});

/** Runner that records argv/cwd/timeout and maps argv tails to scripted results. */
function fakeRunner(script: Record<string, DoneContractRunResult>, calls: string[][] = []) {
  return (argv: readonly string[], _cwd: string, _timeoutMs: number): DoneContractRunResult => {
    calls.push([...argv]);
    return script[argv.join(' ')] ?? { status: 0 };
  };
}

describe('done-contract schema', () => {
  it('round-trips a valid contract and rejects malformed shapes', () => {
    const parsed = parseDoneContract(JSON.stringify(contract({ frozenAt: '2026-11-08T12:00:00Z', notesFile: null })));
    expect(parsed.job).toBe('RQ-SWE5-DONE-CONTRACT');
    expect(parsed.notesFile).toBeNull();
    expect(() => parseDoneContract('not json')).toThrow('not JSON');
    for (const bad of [
      { schema: 'done-contract.v2' },                                   // wrong discriminator
      { schema: DONE_CONTRACT_SCHEMA },                               // no enforceable layer
      { schema: DONE_CONTRACT_SCHEMA, unexpected: 1, acceptance: [{ id: 'a1', text: 'x' }] },
      { schema: DONE_CONTRACT_SCHEMA, job: 'has space', acceptance: [{ id: 'a1', text: 'x' }] },
      { schema: DONE_CONTRACT_SCHEMA, floor: { checks: ['mypy'] } },
      { schema: DONE_CONTRACT_SCHEMA, floor: { commands: [{ id: 'X', cmd: ['true'] }] } },   // id must be lowercase
      { schema: DONE_CONTRACT_SCHEMA, floor: { commands: [{ id: 'ok', cmd: ['true'], cwd: '../escape' }] } },
      { schema: DONE_CONTRACT_SCHEMA, floor: { commands: [{ id: 'ok', cmd: ['true'], timeoutMs: 10 }] } },
      { schema: DONE_CONTRACT_SCHEMA, acceptance: [{ id: 'a1', text: 'x' }, { id: 'a1', text: 'y' }] },
      { schema: DONE_CONTRACT_SCHEMA, verify: [{ id: 'v1', cmd: ['true'] }, { id: 'v1', cmd: ['true'] }] },
      { schema: DONE_CONTRACT_SCHEMA, acceptance: [{ id: 'a1', text: 'x', evidence: 'command:nope' }] },
      { schema: DONE_CONTRACT_SCHEMA, acceptance: [{ id: 'a1', text: 'x', evidence: 'file:/abs/path' }] },
      { schema: DONE_CONTRACT_SCHEMA, acceptance: [{ id: 'a1', text: 'x', evidence: 'file:../out' }] },
      { schema: DONE_CONTRACT_SCHEMA, floor: { checks: ['typecheck'], commands: [{ id: 'typecheck', cmd: ['true'] }] } },
      { schema: DONE_CONTRACT_SCHEMA, notesFile: 'docs/NOTES.md', acceptance: [{ id: 'a1', text: 'x' }] },
    ]) {
      expect(() => parseDoneContract(JSON.stringify(bad)), JSON.stringify(bad)).toThrow('invalid contract');
    }
  });

  it('renders an embed block extractable from surrounding notes, ignoring checklist lines inside the markers', () => {
    const c = parseDoneContract(JSON.stringify(contract()));
    const notes = ['# Bridge notes', '', doneContractBlock(c), '', '- [ ] a2 — pending', ''].join('\n');
    expect(extractDoneContract(notes)).toEqual(c);
    expect(extractDoneContract('no block here')).toBeNull();
    expect(() => extractDoneContract(`${DONE_CONTRACT_OPEN}\nnothing fenced\n${DONE_CONTRACT_CLOSE}`)).toThrow('no fenced JSON');
    expect(() => extractDoneContract(`${DONE_CONTRACT_OPEN}\n\`\`\`json\n{}\n\`\`\`\n${DONE_CONTRACT_CLOSE}`)).toThrow('invalid contract');
  });

  it('resolves notesFile precedence: option > contract > default', () => {
    const c = parseDoneContract(JSON.stringify(contract()));
    expect(contractNotesFile(c)).toBe(DONE_NOTES_FILE);
    expect(contractNotesFile(c, { notesFile: 'OTHER.md' })).toBe('OTHER.md');
    const noNotes = parseDoneContract(JSON.stringify(contract({ notesFile: null })));
    expect(contractNotesFile(noNotes)).toBeNull();
    expect(contractNotesFile(noNotes, { notesFile: 'OTHER.md' })).toBe('OTHER.md');
  });
});

describe('checklist attestation (batcher grammar)', () => {
  it('attests checked items only when the status word is not negative, last line wins', () => {
    const notes = [
      '- [x] a1 — done: landed',
      '- [ ] a2 — pending',
      '- [x] a3 — failed: red test',      // checked but failed is not attested
      '- [x] a4 — some custom words',     // unknown word + checked box counts done
      '- [x] a5 — done: first line',
      '- [ ] a5 — deferred: last line wins',
      '- [x] noseparator',                // bare checkbox without separator never matches
    ].join('\n');
    expect([...attestedIds(notes)].sort()).toEqual(['a1', 'a4']);
  });
});

describe('loadDoneContract', () => {
  it('prefers an explicit contract path, then DONE_CONTRACT.json, then the notes embed', () => {
    const root = fixture({ 'other.json': JSON.stringify(contract({ job: 'RQ-OTHER' })) });
    expect(loadDoneContract(root, { contractPath: 'other.json' }).contract?.job).toBe('RQ-OTHER');
    writeFileSync(join(root, DONE_CONTRACT_FILE), JSON.stringify(contract({ job: 'RQ-FILE' })));
    expect(loadDoneContract(root).contract?.job).toBe('RQ-FILE');
    expect(loadDoneContract(root).source).toBe('contract-file');
    rmSync(join(root, DONE_CONTRACT_FILE));
    writeFileSync(join(root, DONE_NOTES_FILE), `# notes\n${doneContractBlock(contract() as DoneContract)}\n`);
    expect(loadDoneContract(root).source).toBe('notes-embed');
    expect(loadDoneContract(fixture()).source).toBe('none');
  });

  it('fails closed on a malformed contract instead of falling back to notes', () => {
    const root = fixture({ [DONE_CONTRACT_FILE]: '{broken' });
    const loaded = loadDoneContract(root);
    expect(loaded.source).toBe('contract-file');
    expect(loaded.contract).toBeNull();
    expect(loaded.error).toContain('not JSON');
  });
});

describe('evaluateDoneContract — legacy notes mode', () => {
  it('passes when BRIDGE_NOTES.md exists non-empty, fails when absent or empty', () => {
    expect(evaluateDoneContract(fixture(), {}, { runner: fakeRunner({}) }).pass).toBe(false);
    expect(evaluateDoneContract(fixture({ [DONE_NOTES_FILE]: '   \n' }), {}, { runner: fakeRunner({}) }).pass).toBe(false);
    const verdict = evaluateDoneContract(fixture({ [DONE_NOTES_FILE]: 'summary\n' }), {}, { runner: fakeRunner({}) });
    expect(verdict).toMatchObject({ pass: true, mode: 'notes', source: 'none', notes_present: true });
    expect(doneContractHandoff(verdict)).toContain('mode=notes');
  });

  it('fails closed when a claimed contract is malformed even if notes exist', () => {
    const root = fixture({ [DONE_NOTES_FILE]: `# notes\n${DONE_CONTRACT_OPEN}\nno fence\n${DONE_CONTRACT_CLOSE}\n` });
    const verdict = evaluateDoneContract(root, {}, { runner: fakeRunner({}) });
    expect(verdict.pass).toBe(false);
    expect(verdict.mode).toBe('contract');
    expect(verdict.error).toContain('no fenced JSON');
  });
});

describe('evaluateDoneContract — contract mode', () => {
  it('runs floor + verify commands through the injected runner and evaluates every evidence kind', () => {
    const calls: string[][] = [];
    const runner = fakeRunner({ 'v1 run': { status: 3 } }, calls);
    const root = fixture({
      [DONE_CONTRACT_FILE]: JSON.stringify(contract({
        acceptance: [
          { id: 'a1', text: 'floor proven', evidence: 'command:floor1' },
          { id: 'a2', text: 'notes attested', evidence: 'notes' },
          { id: 'a3', text: 'file proven', evidence: 'file:target/out.txt' },
          { id: 'a4', text: 'verify failed', evidence: 'command:v1' },
          { id: 'a5', text: 'human call', evidence: 'manual' },
          { id: 'a6', text: 'optional gap', evidence: 'notes', required: false },
        ],
        verify: [{ id: 'v1', cmd: ['v1', 'run'] }],
      })),
      [DONE_NOTES_FILE]: '# notes\n- [x] a2 — done: recorded\n',
      'target/out.txt': 'evidence',
    });
    const verdict = evaluateDoneContract(root, {}, { runner });
    expect(calls).toEqual([['node', '-e', 'process.exit(0)'], ['v1', 'run']]);
    expect(verdict.checks.map((c) => [c.id, c.ok])).toEqual([['floor1', true], ['v1', false]]);
    expect(verdict.acceptance.map((a) => [a.id, a.status])).toEqual([
      ['a1', 'proven'], ['a2', 'attested'], ['a3', 'proven'], ['a4', 'unproven'], ['a5', 'manual'], ['a6', 'optional-unmet'],
    ]);
    expect(verdict.pass).toBe(false);   // a4's required command failed
  });

  it('passes a complete contract: commands ok, criteria proven/attested, notes present', () => {
    const root = fixture({
      [DONE_NOTES_FILE]: `# notes\n${doneContractBlock(contract() as DoneContract)}\n- [x] a2 — done: kept\n`,
    });
    const verdict = evaluateDoneContract(root);   // real spawnSync runner; node -e exits 0
    expect(verdict).toMatchObject({ pass: true, mode: 'contract', source: 'notes-embed', notes_present: true });
    expect(JSON.stringify(verdict)).not.toContain(process.env.HOME ?? 'no-home');
  }, 60_000);

  it('fails closed when a floor check name has no detected repository command', () => {
    const root = fixture({
      [DONE_CONTRACT_FILE]: JSON.stringify(contract({ floor: { checks: ['typecheck'] }, verify: undefined, acceptance: [{ id: 'a1', text: 'tc', evidence: 'command:typecheck' }] })),
      [DONE_NOTES_FILE]: 'summary\n',
    });
    const verdict = evaluateDoneContract(root, {}, { runner: fakeRunner({}) });
    expect(verdict.checks[0]).toMatchObject({ id: 'typecheck', ok: false, first_error: 'No matching repository check configured' });
    expect(verdict.pass).toBe(false);
  });

  it('detects floor checks repo-agnostically through package.json scripts', () => {
    const root = fixture({
      'package.json': JSON.stringify({ scripts: { typecheck: 'node -e "process.exit(0)"' } }),
      [DONE_CONTRACT_FILE]: JSON.stringify(contract({ floor: { checks: ['typecheck'] }, acceptance: [{ id: 'a1', text: 'tc', evidence: 'command:typecheck' }] })),
      [DONE_NOTES_FILE]: 'summary\n',
    });
    const verdict = evaluateDoneContract(root);
    expect(verdict.checks[0]).toMatchObject({ id: 'typecheck', ok: true });
    expect(verdict.pass).toBe(true);
  }, 60_000);

  it('requires the notes file in contract mode unless notesFile is null', () => {
    const root = fixture({ [DONE_CONTRACT_FILE]: JSON.stringify(contract()) });
    expect(evaluateDoneContract(root).pass).toBe(false);
    expect(evaluateDoneContract(root).error).toContain(DONE_NOTES_FILE);
    const detached = fixture({
      [DONE_CONTRACT_FILE]: JSON.stringify(contract({ notesFile: null })),
    });
    const verdict = evaluateDoneContract(detached);
    // a2 has notes evidence and can never be attested without a notes file
    expect(verdict.pass).toBe(false);
    expect(verdict.acceptance.find((a) => a.id === 'a2')?.status).toBe('unproven');
  }, 60_000);

  it('never leaks child output into the verdict', () => {
    const root = fixture({
      [DONE_CONTRACT_FILE]: JSON.stringify(contract({
        acceptance: [{ id: 'a1', text: 'x', evidence: 'command:leaker' }],
        verify: [{ id: 'leaker', cmd: ['node', '-e', `console.log("${'A'.repeat(64)}");process.exit(1)`] }],
      })),
      [DONE_NOTES_FILE]: 's\n',
    });
    const verdict = evaluateDoneContract(root);
    expect(verdict.pass).toBe(false);
    expect(JSON.stringify(verdict)).not.toContain('A'.repeat(64));
    expect(verdict.checks.find((c) => c.id === 'leaker')?.first_error).toContain('withheld');
  }, 60_000);

  it('keeps command cwd inside the worktree and fails closed on escape', () => {
    const root = fixture({
      [DONE_CONTRACT_FILE]: JSON.stringify(contract({
        floor: { commands: [{ id: 'f', cmd: ['pwd'], cwd: 'sub' }] },
        acceptance: [{ id: 'a1', text: 'ran' }],
      })),
      [DONE_NOTES_FILE]: 's\n',
    });
    mkdirSync(join(root, 'sub'));
    const ok = evaluateDoneContract(root);
    expect(ok.checks[0]?.ok).toBe(true);
    // Schema-level rejection of ../ paths:
    expect(() => parseDoneContract(JSON.stringify(contract({ floor: { commands: [{ id: 'f', cmd: ['pwd'], cwd: 'sub/../../..' }] } })))).toThrow('invalid contract');
  }, 60_000);
});

describe('doneContractPlan', () => {
  it('reports resolved commands without running them', () => {
    const root = fixture({
      'package.json': JSON.stringify({ scripts: { typecheck: 'true' } }),
      [DONE_CONTRACT_FILE]: JSON.stringify(contract()),
      [DONE_NOTES_FILE]: 's\n',
    });
    const plan = doneContractPlan(root);
    expect(plan.mode).toBe('contract');
    expect(plan.commands.map((c) => c.id)).toEqual(['floor1', 'v1']);
    expect(plan.commands[0]?.argv).toEqual(['node', '-e', 'process.exit(0)']);
    expect(plan.acceptance.map((a) => a.id)).toEqual(['a1', 'a2']);
    expect(doneContractPlan(fixture()).mode).toBe('notes');
  });
});

describe('phm verify done', () => {
  async function runCli(args: string[]) {
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const code = await cmdVerify(args);
    return { code, stdout: String(out.mock.calls[0]?.[0] ?? ''), stderr: err.mock.calls.map((c) => String(c[0])).join('\n') };
  }

  it('exits 0/1/2 for pass/fail/usage and emits JSON verdict + handoff', async () => {
    const root = fixture({ [DONE_NOTES_FILE]: 'summary\n' });
    expect((await runCli(['done', '--worktree', root])).code).toBe(0);
    expect((await runCli(['done', '--worktree', fixture()])).code).toBe(1);
    expect((await runCli(['done'])).code).toBe(2);
    expect((await runCli(['done', '--worktree', root, '--bogus', 'x'])).code).toBe(2);
    const planRun = await runCli(['done', '--worktree', root, '--plan']);
    expect(planRun.code).toBe(0);
    expect(JSON.parse(planRun.stdout).mode).toBe('notes');
  });

  it('evaluates a contract file end to end', async () => {
    const root = fixture({
      [DONE_CONTRACT_FILE]: JSON.stringify(contract()),
      [DONE_NOTES_FILE]: '# n\n- [x] a2 — done: ok\n',
    });
    const result = await runCli(['done', '--worktree', root]);
    expect(result.code).toBe(0);
    const verdict = JSON.parse(result.stdout);
    expect(verdict).toMatchObject({ pass: true, mode: 'contract', job: 'RQ-SWE5-DONE-CONTRACT' });
    expect(result.stderr).toContain('Done contract: PASS');
  }, 60_000);
});
