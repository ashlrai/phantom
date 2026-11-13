/**
 * Preservation boundary for original PR #4165 (RQ-SWE5-DONE-CONTRACT), job
 * RQ-PHX-DONEORIGINALRECONCILE265S. Proves the `--plan` read-only flow and the
 * real evaluate flow of `phm verify done` against the current master
 * implementation: the plan prints the declared command plan without executing
 * it, evaluate runs the same argv through the real spawnSync runner, and a
 * malformed contract fails the plan closed without running anything.
 *
 * Hermetic: fixture worktrees in tmpdir only; the sentinel command is a
 * `node -e` argv that writes one file inside the fixture root. No live HOME,
 * fleet state or endpoints.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { cmdVerify } from '../src/cli/verify.js';
import { DONE_CONTRACT_FILE } from '../src/core/done-contract.js';

const SENTINEL = 'sentinel-4165.txt';
const SENTINEL_ARGV = ['node', '-e', `require('node:fs').writeFileSync('${SENTINEL}','sentinel')`];

const roots: string[] = [];
function fixture(files: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'done-contract-4165-'));
  roots.push(root);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, name), text);
  return root;
}
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

async function runCli(args: string[]) {
  const out = vi.spyOn(console, 'log').mockImplementation(() => {});
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  const code = await cmdVerify(args);
  return {
    code,
    stdout: out.mock.calls.map((c) => String(c[0])).join('\n'),
    stderr: err.mock.calls.map((c) => String(c[0])).join('\n'),
  };
}

const sentinelContract = JSON.stringify({
  schema: 'done-contract.v1',
  job: 'RQ-PHX-DONEORIGINALRECONCILE265S',
  notesFile: null,
  verify: [{ id: 'sentinel', cmd: SENTINEL_ARGV, required: true }],
  acceptance: [
    { id: 'a1', text: 'sentinel command ran', evidence: 'command:sentinel' },
    { id: 'a2', text: 'sentinel file exists', evidence: `file:${SENTINEL}` },
  ],
});

describe('phm verify done — #4165 plan/evaluate isolation', () => {
  it('--plan prints the declared command plan and never executes it', async () => {
    const root = fixture({ [DONE_CONTRACT_FILE]: sentinelContract });
    const plan = await runCli(['done', '--worktree', root, '--plan']);
    expect(plan.code).toBe(0);
    const parsed = JSON.parse(plan.stdout);
    expect(parsed).toMatchObject({ mode: 'contract', job: 'RQ-PHX-DONEORIGINALRECONCILE265S', source: 'contract-file', error: null });
    expect(parsed.commands).toHaveLength(1);
    expect(parsed.commands[0]).toMatchObject({ id: 'sentinel', source: 'verify', argv: SENTINEL_ARGV, required: true, resolved: true });
    expect(parsed.acceptance.map((a: { id: string }) => a.id)).toEqual(['a1', 'a2']);
    expect(plan.stderr).toContain('Done contract plan:');
    expect(existsSync(join(root, SENTINEL))).toBe(false);
  });

  it('evaluate executes the same argv and emits the machine-readable verdict', async () => {
    const root = fixture({ [DONE_CONTRACT_FILE]: sentinelContract });
    const result = await runCli(['done', '--worktree', root]);
    expect(result.code).toBe(0);
    expect(existsSync(join(root, SENTINEL))).toBe(true);
    const verdict = JSON.parse(result.stdout);
    expect(verdict).toMatchObject({
      pass: true, mode: 'contract', job: 'RQ-PHX-DONEORIGINALRECONCILE265S',
      source: 'contract-file', notes_file: null, notes_present: false, error: null,
    });
    expect(verdict.checks).toEqual([
      expect.objectContaining({ id: 'sentinel', source: 'verify', required: true, ok: true, first_error: null }),
    ]);
    expect(verdict.acceptance.map((a: { id: string; status: string }) => [a.id, a.status])).toEqual([
      ['a1', 'proven'], ['a2', 'proven'],
    ]);
    expect(result.stderr).toContain('Done contract: PASS');
  }, 60_000);

  it('a malformed contract fails --plan closed without executing the sentinel command', async () => {
    // Schema-invalid (acceptance references an undeclared command id) but still
    // names the sentinel argv — proves plan failure precedes any execution.
    const malformed = JSON.stringify({
      schema: 'done-contract.v1',
      notesFile: null,
      verify: [{ id: 'sentinel', cmd: SENTINEL_ARGV }],
      acceptance: [{ id: 'a1', text: 'x', evidence: 'command:ghost' }],
    });
    const root = fixture({ [DONE_CONTRACT_FILE]: malformed });
    const plan = await runCli(['done', '--worktree', root, '--plan']);
    expect(plan.code).toBe(1);
    const parsed = JSON.parse(plan.stdout);
    expect(parsed.error).toContain('invalid contract');
    expect(parsed.commands ?? []).toEqual([]);
    expect(existsSync(join(root, SENTINEL))).toBe(false);

    const evalRun = await runCli(['done', '--worktree', root]);
    expect(evalRun.code).toBe(1);
    expect(JSON.parse(evalRun.stdout).pass).toBe(false);
    expect(existsSync(join(root, SENTINEL))).toBe(false);
  });
});
