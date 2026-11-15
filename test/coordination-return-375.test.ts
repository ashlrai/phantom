import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as coordination from '../src/core/fleet/coordination.js';
import { returnFleetClaim } from '../src/core/fleet/coordination-return.js';

const dirs: string[] = [];
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'claim-return-375-'));
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
describe('lease-fenced claim return', () => {
  it('releases and records PR evidence, then returns the identical receipt on retry', () => {
    const { options, input } = fixture();
    const result = returnFleetClaim({ ...input, pr: 375, head: 'abcdef1234567' }, options);
    expect(result).toMatchObject({ ok: true, outcome: 'returned', claimId: input.id,
      message: { id: `return-${input.id}`, from: input.agent, to: 'all', expiresAt: options.now + 86400000 } });
    expect(result.message?.body).toBe(`RESULT VERIFIED ashlrai/phantom claim ${input.id} task "Return work": pr #375 head abcdef1234567`);
    expect(coordination.readFleetBoard(options).claims).toEqual([]);
    expect(returnFleetClaim({ ...input, tests: 'different retry evidence' }, options)).toEqual({
      ok: true, outcome: 'already-returned', claimId: input.id, message: result.message,
    });
    expect(coordination.readFleetBoard(options).messages).toEqual([result.message]);
  });
  it('preserves live work on a wrong lease or wrong agent', () => {
    const { options, input } = fixture();
    for (const changed of [{ lease: 'wrong' }, { agent: 'other-agent' }]) {
      expect(returnFleetClaim({ ...input, ...changed, tests: 'passed' }, options).outcome).toBe('not-owner');
    }
    expect(coordination.readFleetBoard(options)).toMatchObject({ claims: [{ id: input.id }], messages: [] });
  });
  it('distinguishes an unknown claim from an unavailable board without writing', () => {
    const { options, input } = fixture();
    const before = readFileSync(options.path, 'utf8');
    expect(returnFleetClaim({ ...input, id: 'missing', tests: 'passed' }, options).outcome).toBe('not-found');
    expect(readFileSync(options.path, 'utf8')).toBe(before);
    expect(returnFleetClaim({ ...input, tests: 'passed' }, { ...options, path: join(dirs.at(-1)!, 'missing') }).outcome).toBe('unavailable');
  });
  it.each([
    [{ blocked: 'upstream\nchange\u0000needed' }, 'BLOCKED', 'dependency upstream change needed'],
    [{ tests: '12 tests\r\npassed' }, 'VERIFIED', 'tests 12 tests  passed'],
    [{ artifact: 'build\u2028report' }, 'VERIFIED', 'artifact build report'],
  ])('records the result form %j as one line', (form, status, suffix) => {
    const { options, input } = fixture();
    const result = returnFleetClaim({ ...input, ...form, ttlMs: 2000 }, options);
    expect(result.outcome).toBe('returned');
    expect(result.message?.body).toContain(`RESULT ${status}`);
    expect(result.message?.body.endsWith(suffix)).toBe(true);
    for (const control of ['\r', '\n', '\u0000', '\u2028']) expect(result.message?.body).not.toContain(control);
    expect(result.message?.expiresAt).toBe(3000);
  });
  it.each([
    {}, { pr: 1 }, { head: 'abcdef1' }, { pr: 0, head: 'abcdef1' }, { pr: 1, head: 'badsha' },
    { tests: 'ok', artifact: 'also' }, { blocked: '\n' }, { tests: 'x', ttlMs: 604800001 },
    { tests: 'x'.repeat(4000) }, { tests: 'x', id: 'a'.repeat(122) },
  ])('rejects invalid input before releasing: %j', form => {
    const { options, input } = fixture();
    const before = readFileSync(options.path, 'utf8');
    expect(returnFleetClaim({ ...input, ...form }, options).outcome).toBe('invalid-input');
    expect(readFileSync(options.path, 'utf8')).toBe(before);
  });
  it('exposes the exact recovery body and id when posting fails after release', () => {
    const { options, input } = fixture();
    vi.spyOn(coordination, 'postFleetMessage').mockReturnValueOnce({ ok: false, error: 'unavailable' });
    const result = returnFleetClaim({ ...input, tests: 'passed' }, options);
    expect(result).toEqual({ ok: false, outcome: 'released-unposted', claimId: input.id,
      id: `return-${input.id}`, body: `RESULT VERIFIED ashlrai/phantom claim ${input.id} task "Return work": tests passed` });
    expect(coordination.readFleetBoard(options)).toMatchObject({ claims: [], messages: [] });
    expect(coordination.postFleetMessage({ id: result.id, body: result.body!, from: input.agent, to: 'all' }, options).ok).toBe(true);
    expect(returnFleetClaim({ ...input, tests: 'passed' }, options).outcome).toBe('already-returned');
  });
});
