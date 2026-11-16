import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as coordination from '../src/core/fleet/coordination.js';
import { returnFleetClaim } from '../src/core/fleet/coordination-return.js';
import { projectCoordinationReturns } from '../src/core/fleet/coordination-returns-view.js';

const dirs: string[] = [];
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'claim-return-378s-'));
  dirs.push(dir);
  const options = { path: join(dir, 'board.jsonl'), now: 1000 };
  const claim = coordination.claimFleetWork({ repo: 'ashlrai/phantom', task: 'Return work', agent: 'test-agent' }, options);
  if (!claim.ok) throw new Error('fixture claim failed');
  return { options, input: { id: claim.value.claim.id, agent: 'test-agent', lease: claim.value.lease } };
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function ledgerEvents(path: string): ({ kind: string } & Record<string, any>)[] {
  return readFileSync(path, 'utf8').trimEnd().split('\n').map(line => JSON.parse(line));
}
const kinds = (path: string, kind: string) => ledgerEvents(path).filter(event => event.kind === kind);

describe('durable claim return (378s)', () => {
  it('records release+result intent and one posted receipt, leaving no live claim', () => {
    const { options, input } = fixture();
    const result = returnFleetClaim({ ...input, artifact: 'verify-report.txt' }, options);
    expect(result).toMatchObject({ ok: true, outcome: 'returned', claimId: input.id,
      message: { id: `return-${input.id}`, from: 'test-agent', to: 'all' } });
    const intents = kinds(options.path, 'return');
    const posts = kinds(options.path, 'post');
    expect(intents).toHaveLength(1);
    expect(posts).toHaveLength(1);
    expect(intents[0]).toMatchObject({ version: 1, kind: 'return', id: input.id, agent: 'test-agent' });
    expect(intents[0].leaseHash).toMatch(/^[a-f0-9]{64}$/);
    expect(intents[0].message).toEqual(posts[0].message);
    expect(posts[0].message.body).toBe(
      `RESULT VERIFIED ashlrai/phantom claim ${input.id} task "Return work": artifact verify-report.txt`);
    const board = coordination.readFleetBoard(options);
    expect(board.claims).toEqual([]);
    expect(board.messages).toEqual([result.message]);
    expect(projectCoordinationReturns(board, options.now)).toMatchObject({ state: 'known', unparsed: 0,
      returns: [{ claimId: input.id, result: 'VERIFIED', evidenceKind: 'artifact' }] });
    expect(readFileSync(options.path, 'utf8')).not.toContain(input.lease);
  });
  it('leaves claim and ledger bytes unchanged on wrong-owner returns', () => {
    const { options, input } = fixture();
    const before = readFileSync(options.path, 'utf8');
    for (const changed of [{ lease: 'wrong-lease' }, { agent: 'other-agent' }]) {
      expect(returnFleetClaim({ ...input, ...changed, tests: 'passed' }, options))
        .toMatchObject({ ok: false, outcome: 'not-owner' });
    }
    expect(readFileSync(options.path, 'utf8')).toBe(before);
    const board = coordination.readFleetBoard(options);
    expect(board).toMatchObject({ claims: [{ id: input.id }], messages: [] });
    expect(projectCoordinationReturns(board, options.now).returns).toEqual([]);
  });
  it('keeps the live claim when the intent write fails, then completes on retry', () => {
    const { options, input } = fixture();
    vi.spyOn(coordination, 'concludeFleetClaim').mockReturnValueOnce({ ok: false, error: 'unavailable' });
    expect(returnFleetClaim({ ...input, tests: 'passed' }, options))
      .toEqual({ ok: false, outcome: 'unavailable', claimId: input.id });
    expect(coordination.readFleetBoard(options)).toMatchObject({ claims: [{ id: input.id }], messages: [] });
    expect(kinds(options.path, 'return')).toHaveLength(0);
    const retry = returnFleetClaim({ ...input, tests: 'passed' }, options);
    expect(retry).toMatchObject({ ok: true, outcome: 'returned', claimId: input.id });
    const board = coordination.readFleetBoard(options);
    expect(board.claims).toEqual([]);
    expect(board.messages).toHaveLength(1);
    expect(kinds(options.path, 'return')).toHaveLength(1);
    expect(kinds(options.path, 'post')).toHaveLength(1);
  });
  it('makes a failed receipt publish retriable: the owner reposts exactly one receipt', () => {
    const { options, input } = fixture();
    vi.spyOn(coordination, 'postFleetMessage').mockReturnValueOnce({ ok: false, error: 'unavailable' });
    const failed = returnFleetClaim({ ...input, tests: 'passed' }, options);
    expect(failed).toEqual({ ok: false, outcome: 'released-unposted', claimId: input.id,
      id: `return-${input.id}`,
      body: `RESULT VERIFIED ashlrai/phantom claim ${input.id} task "Return work": tests passed` });
    // The claim is released but the intent is durable; nothing was posted.
    expect(coordination.readFleetBoard(options)).toMatchObject({ claims: [], messages: [] });
    expect(kinds(options.path, 'return')).toHaveLength(1);
    expect(kinds(options.path, 'post')).toHaveLength(0);
    const retry = returnFleetClaim({ ...input, tests: 'passed' }, options);
    expect(retry).toMatchObject({ ok: true, outcome: 'returned', claimId: input.id });
    expect(retry.message?.body).toBe(failed.body);
    expect(kinds(options.path, 'return')).toHaveLength(1);
    expect(kinds(options.path, 'post')).toHaveLength(1);
    const board = coordination.readFleetBoard(options);
    expect(board.messages).toHaveLength(1);
    expect(projectCoordinationReturns(board, options.now)).toMatchObject({ state: 'known', unparsed: 0,
      returns: [{ claimId: input.id, result: 'VERIFIED', evidenceKind: 'tests' }] });
    expect(returnFleetClaim({ ...input, artifact: 'other evidence' }, options).outcome).toBe('already-returned');
  });
  it('refuses a wrong-lease retry on a pending return; the owner still completes once', () => {
    const { options, input } = fixture();
    vi.spyOn(coordination, 'postFleetMessage').mockReturnValueOnce({ ok: false, error: 'unavailable' });
    expect(returnFleetClaim({ ...input, tests: 'passed' }, options).outcome).toBe('released-unposted');
    for (const changed of [{ lease: 'wrong-lease' }, { agent: 'other-agent' }]) {
      expect(returnFleetClaim({ ...input, ...changed, tests: 'passed' }, options).outcome).toBe('not-owner');
    }
    const stalled = coordination.readFleetBoard(options);
    expect(stalled).toMatchObject({ claims: [], messages: [] });
    expect(kinds(options.path, 'post')).toHaveLength(0);
    expect(returnFleetClaim({ ...input, tests: 'passed' }, options).outcome).toBe('returned');
    const board = coordination.readFleetBoard(options);
    expect(board.messages).toHaveLength(1);
    expect(kinds(options.path, 'post')).toHaveLength(1);
  });
  it('keeps a completed return idempotent under identical and different evidence retries', () => {
    const { options, input } = fixture();
    const first = returnFleetClaim({ ...input, blocked: 'upstream schema change' }, options);
    expect(first.outcome).toBe('returned');
    for (const form of [{ blocked: 'upstream schema change' }, { tests: 'different evidence' }]) {
      expect(returnFleetClaim({ ...input, ...form }, options))
        .toEqual({ ok: true, outcome: 'already-returned', claimId: input.id, message: first.message });
    }
    const board = coordination.readFleetBoard(options);
    expect(board.messages).toEqual([first.message]);
    expect(projectCoordinationReturns(board, options.now)).toMatchObject({ state: 'known', unparsed: 0,
      returns: [{ claimId: input.id, result: 'BLOCKED', evidenceKind: 'dependency' }] });
    expect(kinds(options.path, 'return')).toHaveLength(1);
    expect(kinds(options.path, 'post')).toHaveLength(1);
  });
  it('still reports not-found for an old-style released claim without intent or receipt', () => {
    const { options, input } = fixture();
    expect(coordination.releaseFleetClaim(input, options).ok).toBe(true);
    expect(returnFleetClaim({ ...input, tests: 'x' }, options))
      .toEqual({ ok: false, outcome: 'not-found', claimId: input.id });
    expect(kinds(options.path, 'return')).toHaveLength(0);
    expect(kinds(options.path, 'release')).toHaveLength(1);
    expect(coordination.readFleetBoard(options)).toMatchObject({ claims: [], messages: [] });
  });
  it('coexists with old-format claim/release/post events in one ledger', () => {
    const { options, input } = fixture();
    expect(coordination.releaseFleetClaim(input, options).ok).toBe(true);
    const body = `RESULT VERIFIED ashlrai/phantom claim ${input.id} task "Return work": tests legacy receipt`;
    expect(coordination.postFleetMessage({ id: `return-${input.id}`, from: input.agent, to: 'all', body }, options).ok).toBe(true);
    const second = coordination.claimFleetWork({ repo: 'ashlrai/phantom', task: 'Second work', agent: 'test-agent' }, options);
    if (!second.ok) throw new Error('fixture second claim failed');
    expect(returnFleetClaim({ id: second.value.claim.id, agent: 'test-agent', lease: second.value.lease, artifact: 'report.txt' }, options).outcome).toBe('returned');
    const board = coordination.readFleetBoard(options);
    expect(board.claims).toEqual([]);
    expect(board.messages).toHaveLength(2);
    expect(ledgerEvents(options.path).map(event => event.kind)).toEqual(['claim', 'release', 'post', 'claim', 'return', 'post']);
    const projected = projectCoordinationReturns(board, options.now);
    expect(projected).toMatchObject({ state: 'known', unparsed: 0 });
    expect(projected.returns.map(row => row.claimId).sort()).toEqual([input.id, second.value.claim.id].sort());
  });
  it('serializes concurrent owner returns into exactly one durable receipt', async () => {
    const { options, input } = fixture();
    const childScript = `
import { returnFleetClaim } from './src/core/fleet/coordination-return.ts';
const [path, id, agent, lease, evidence, at] = process.argv.slice(1);
const options = { path, now: Number(at) };
let out;
for (let i = 0; i < 8; i++) {
  out = returnFleetClaim({ id, agent, lease, tests: evidence }, options);
  if (out.outcome !== 'unavailable') break;
}
process.stdout.write(JSON.stringify({ outcome: out.outcome, message: out.message ?? null }));
`;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', childScript,
      options.path, input.id, input.agent, input.lease, 'child evidence', String(options.now)],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => stdout += chunk);
    child.stderr.on('data', chunk => stderr += chunk);
    let parent = returnFleetClaim({ ...input, tests: 'parent evidence' }, options);
    for (let i = 0; parent.outcome === 'unavailable' && i < 8; i++) {
      parent = returnFleetClaim({ ...input, tests: 'parent evidence' }, options);
    }
    const code = await new Promise<number | null>(resolve => child.on('exit', resolve));
    expect(code, stderr).toBe(0);
    const childOut = JSON.parse(stdout) as { outcome: string; message: { id: string; body: string } | null };
    expect([parent.outcome, childOut.outcome].sort()).toEqual(['already-returned', 'returned']);
    const board = coordination.readFleetBoard(options);
    expect(board.claims).toEqual([]);
    expect(board.messages).toHaveLength(1);
    const [message] = board.messages;
    expect(['parent evidence', 'child evidence'].some(evidence => message!.body.endsWith(`tests ${evidence}`))).toBe(true);
    for (const seen of [parent.message, childOut.message]) if (seen) expect(seen).toEqual(message);
    expect(kinds(options.path, 'return')).toHaveLength(1);
    expect(kinds(options.path, 'post')).toHaveLength(1);
    expect(projectCoordinationReturns(board, options.now)).toMatchObject({ state: 'known', unparsed: 0,
      returns: [{ claimId: input.id, result: 'VERIFIED', evidenceKind: 'tests' }] });
  }, 30_000);
});
