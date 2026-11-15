import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetCoordination, FLEET_COORDINATION_HELP } from '../src/cli/fleet-coordination.js';

let dir: string;
let ledger: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'return-cross-repo-379s-'));
  ledger = join(dir, 'board.jsonl');
  vi.stubEnv('PHANTOM_FLEET_LEDGER_PATH', ledger);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });

async function run(args: string[], code = 0) {
  expect(await cmdFleetCoordination([...args, '--json'])).toBe(code);
  return JSON.parse(vi.mocked(console.log).mock.calls.at(-1)![0] as string);
}

describe('cross-repository coordination returns', () => {
  it('keeps same-number reviews and replayed receipts isolated on disk', async () => {
    const first = { repo: 'synthetic-orchard/alpha', agent: 'reviewer-alpha', head: 'a123456789abcdef0123456789abcdef01234567', task: 'Review #379: "résumé": alpha' };
    const second = { repo: 'synthetic-harbor/beta', agent: 'reviewer-beta', head: 'b123456789abcdef0123456789abcdef01234567', task: 'Review #379: "東京": beta' };
    const claim = async (item: typeof first) => (await run(['claim', '--repo', item.repo, '--task', item.task, '--agent', item.agent])).value;
    const a = await claim(first);
    const b = await claim(second);
    expect(a.claim.id).not.toBe(b.claim.id);
    const privateValues = [a.lease, b.lease, ...[a.lease, b.lease].map(lease => createHash('sha256').update(lease).digest('hex'))];
    const publicView = async (command: string) => {
      const view = await run([command]);
      const serialized = JSON.stringify(view);
      expect(serialized).not.toContain('leaseHash');
      expect(serialized).not.toContain('"lease"');
      for (const value of privateValues) expect(serialized.includes(value)).toBe(false);
      return view;
    };
    const firstReturn = ['return', a.claim.id, '--agent', first.agent, '--lease', a.lease, '--pr', '379', '--head', first.head];
    expect((await run(firstReturn)).outcome).toBe('returned');
    const active = await publicView('board');
    expect(active.claims).toEqual([expect.objectContaining({ id: b.claim.id, repo: second.repo, task: second.task, agent: second.agent })]);
    const dependency = `waiting for review #379 head ${second.head}: "upstream"`;
    expect((await run(['return', b.claim.id, '--agent', second.agent, '--lease', b.lease, '--blocked', dependency])).outcome).toBe('returned');

    const board = await publicView('board');
    expect(board.claims).toEqual([]);
    expect(board.messages).toHaveLength(2);
    const messageA = board.messages.find((m: { id: string }) => m.id === `return-${a.claim.id}`);
    const messageB = board.messages.find((m: { id: string }) => m.id === `return-${b.claim.id}`);
    expect(messageA).toMatchObject({ from: first.agent, to: 'all', body: `RESULT VERIFIED ${first.repo} claim ${a.claim.id} task "${first.task}": pr #379 head ${first.head}` });
    expect(messageB).toMatchObject({ from: second.agent, to: 'all', body: `RESULT BLOCKED ${second.repo} claim ${b.claim.id} task "${second.task}": dependency ${dependency}` });
    expect(messageA.body).not.toContain(second.head);
    expect(messageB.body).not.toContain(first.head);
    const projection = await publicView('returns');
    expect(projection).toMatchObject({ state: 'known', unparsed: 0 });
    expect(projection.returns).toHaveLength(2);
    expect(projection.returns).toEqual(expect.arrayContaining([
      expect.objectContaining({ claimId: a.claim.id, repo: first.repo, from: first.agent, result: 'VERIFIED', evidenceKind: 'pr', pr: 379, head: first.head, evidence: `pr #379 head ${first.head}` }),
      expect.objectContaining({ claimId: b.claim.id, repo: second.repo, from: second.agent, result: 'BLOCKED', evidenceKind: 'dependency', pr: null, head: null, evidence: `dependency ${dependency}` }),
    ]));
    expect(FLEET_COORDINATION_HELP).toContain('does not merge, verify or close anything');
    const beforeReplay = readFileSync(ledger, 'utf8');
    expect((await run(firstReturn)).outcome).toBe('already-returned');
    expect(readFileSync(ledger, 'utf8')).toBe(beforeReplay);
    const after = await publicView('board');
    expect(after.claims).toEqual([]);
    expect(after.messages).toEqual(board.messages);
    expect((await publicView('returns')).returns).toEqual(projection.returns);
  });

  it('reports a missing ledger as unknown', async () => {
    expect(await run(['board'], 1)).toMatchObject({ state: 'unknown', claims: [], messages: [] });
    expect(await run(['returns'], 1)).toMatchObject({ state: 'unknown', returns: [] });
  });
});
