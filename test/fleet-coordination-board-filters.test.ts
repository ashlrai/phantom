import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetCoordination } from '../src/cli/fleet-coordination.js';

const T0 = 1_760_000_000_000;
const TTL = '86400';

let dir = '';
let ledgerPath = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'coordination-board-'));
  ledgerPath = join(dir, 'coordination.jsonl');
  vi.stubEnv('PHANTOM_FLEET_LEDGER_PATH', ledgerPath);
  vi.useFakeTimers({ toFake: ['Date'], now: T0 });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

const lastText = () => String(vi.mocked(console.log).mock.calls.at(-1)![0]);
const at = (offsetMs: number) => vi.setSystemTime(T0 + offsetMs);

async function cli(args: string[]) {
  const calls = vi.mocked(console.log).mock.calls.length;
  const code = await cmdFleetCoordination(args);
  const callsAfter = vi.mocked(console.log).mock.calls.length;
  const text = callsAfter === calls ? '' : lastText();
  return { code, json: (text ? JSON.parse(text) : null) as any, text };
}

async function post(from: string, to: string, message: string, offsetMs: number, id?: string) {
  at(offsetMs);
  const { code, json } = await cli(['post', '--from', from, '--to', to, '--message', message,
    '--ttl-seconds', TTL, ...(id ? ['--id', id] : []), '--json']);
  expect(code).toBe(0);
  expect(json.ok).toBe(true);
}

async function assign(repo: string, task: string, to: string, offsetMs: number) {
  at(offsetMs);
  const { code, json } = await cli(['assign', '--repo', repo, '--task', task, '--to', to,
    '--ttl-seconds', TTL, '--json']);
  expect(code).toBe(0);
  expect(json.ok).toBe(true);
}

async function claim(repo: string, task: string, agent: string, offsetMs: number) {
  at(offsetMs);
  const { code, json } = await cli(['claim', '--repo', repo, '--task', task, '--agent', agent,
    '--ttl-seconds', TTL, '--json']);
  expect(code).toBe(0);
  expect(json.ok).toBe(true);
  return json.value.claim.id as string;
}

const board = (extra: string[] = []) => cli(['board', ...extra, '--json']);

async function seed() {
  const claimA = await claim('ashlrai/phantom', 'deploy the board fix', 'alice', 0);
  await post('alice', 'bob', 'deploy finished green', 1_000, 'm-deploy');
  const claimB = await claim('ashlrai/other', 'unrelated chore', 'carol', 2_000);
  await post('carol', 'bob', 'lunch?', 3_000, 'm-lunch');
  await assign('ashlrai/phantom', 'review the board filters', 'bob', 4_000);
  await assign('ashlrai/other', 'unrelated proposal', 'carol', 5_000);
  await post('alice', 'all', 'all hands: deploy freeze at noon', 6_000, 'm-all');
  at(7_000);
  return { claimA, claimB };
}

describe('fleet coordination board read filters', () => {
  it('serves the whole board unfiltered, then narrows each collection by its own fields', async () => {
    const { claimA, claimB } = await seed();

    const all = await board();
    expect(all.code).toBe(0);
    expect(all.json.state).toBe('known');
    expect(all.json.claims).toHaveLength(2);
    expect(all.json.messages).toHaveLength(3);
    expect(all.json.proposals).toHaveLength(2);

    // --agent keeps only claims that label owns; messages and proposals
    // record no claim owner and drop out.
    const agentClaims = await board(['--agent', 'alice']);
    expect(agentClaims.json.claims.map((c: any) => c.id)).toEqual([claimA]);
    expect(agentClaims.json.messages).toEqual([]);
    expect(agentClaims.json.proposals).toEqual([]);

    const carolClaims = await board(['--agent', 'carol']);
    expect(carolClaims.json.claims.map((c: any) => c.id)).toEqual([claimB]);
    expect(carolClaims.json.messages).toEqual([]);
    expect(carolClaims.json.proposals).toEqual([]);

    // --repo keeps claims and proposals on that repo case-insensitively;
    // messages record no repo and drop out.
    const repo = await board(['--repo', 'ASHLRAI/Phantom']);
    expect(repo.json.claims.map((c: any) => c.id)).toEqual([claimA]);
    expect(repo.json.proposals).toHaveLength(1);
    expect(repo.json.proposals[0].task).toBe('review the board filters');
    expect(repo.json.messages).toEqual([]);

    // --from keeps only messages the sender wrote; claims and proposals
    // record no sender and drop out.
    const fromAlice = await board(['--from', 'alice']);
    expect(fromAlice.json.messages.map((m: any) => m.id).sort()).toEqual(['m-all', 'm-deploy']);
    expect(fromAlice.json.claims).toEqual([]);
    expect(fromAlice.json.proposals).toEqual([]);

    // --exclude-from drops only that sender's messages; claims and
    // proposals have no sender to exclude and stay listed.
    const notAlice = await board(['--exclude-from', 'alice']);
    expect(notAlice.json.messages.map((m: any) => m.id)).toEqual(['m-lunch']);
    expect(notAlice.json.claims).toHaveLength(2);
    expect(notAlice.json.proposals).toHaveLength(2);

    // --to keeps messages and proposals addressed to the label; claims
    // record no recipient and drop out. m-all is addressed to `all`, not bob.
    const toBob = await board(['--to', 'bob']);
    expect(toBob.json.messages.map((m: any) => m.id).sort()).toEqual(['m-deploy', 'm-lunch']);
    expect(toBob.json.proposals).toHaveLength(1);
    expect(toBob.json.proposals[0].to).toBe('bob');
    expect(toBob.json.claims).toEqual([]);

    // --id keeps the one row whose own id strictly equals it, in whichever
    // collection carries it.
    const byClaim = await board(['--id', claimB]);
    expect(byClaim.json.claims.map((c: any) => c.id)).toEqual([claimB]);
    expect(byClaim.json.messages).toEqual([]);
    expect(byClaim.json.proposals).toEqual([]);

    const byMessage = await board(['--id', 'm-lunch']);
    expect(byMessage.json.messages.map((m: any) => m.id)).toEqual(['m-lunch']);
    expect(byMessage.json.claims).toEqual([]);
    expect(byMessage.json.proposals).toEqual([]);
  });

  it('reads one [since, before) window on each row\'s recorded stamp', async () => {
    await seed();

    // claimA stamped at T0+0, claimB at T0+2s; m-deploy T0+1s, m-lunch T0+3s,
    // m-all T0+6s; proposal one T0+4s, proposal two T0+5s.
    const since = await board(['--since', String(T0 + 2_000)]);
    expect(since.json.claims.map((c: any) => c.agent)).toEqual(['carol']);
    expect(since.json.messages.map((m: any) => m.id).sort()).toEqual(['m-all', 'm-lunch']);
    expect(since.json.proposals).toHaveLength(2);

    const before = await board(['--before', String(T0 + 2_000)]);
    expect(before.json.claims.map((c: any) => c.agent)).toEqual(['alice']);
    expect(before.json.messages.map((m: any) => m.id)).toEqual(['m-deploy']);
    expect(before.json.proposals).toEqual([]);

    // The exclusive upper bound drops the row stamped exactly at it:
    // claimB sits exactly on before and drops, m-lunch sits inside.
    const window = await board(['--since', String(T0 + 500), '--before', String(T0 + 3_500)]);
    expect(window.json.claims.map((c: any) => c.agent)).toEqual(['carol']);
    expect(window.json.messages.map((m: any) => m.id).sort()).toEqual(['m-deploy', 'm-lunch']);
    expect(window.json.proposals).toEqual([]);

    // Filters compose across collections: claims owned by alice inside the
    // window still match on their own stamps.
    const composed = await board(['--agent', 'alice', '--since', String(T0)]);
    expect(composed.json.claims).toHaveLength(1);
    expect(composed.json.messages).toEqual([]);
    expect(composed.json.proposals).toEqual([]);
  });

  it('keeps rows whose displayed fields carry the needle, case-insensitively', async () => {
    const { claimA } = await seed();

    const deploy = await board(['--contains', 'DEPLOY']);
    // claimA's task, m-deploy's body and m-all's body all carry the word.
    expect(deploy.json.claims.map((c: any) => c.id)).toEqual([claimA]);
    expect(deploy.json.messages.map((m: any) => m.id).sort()).toEqual(['m-all', 'm-deploy']);
    expect(deploy.json.proposals).toEqual([]);

    const unrelated = await board(['--contains', 'UNRELATED']);
    expect(unrelated.json.claims.map((c: any) => c.task)).toEqual(['unrelated chore']);
    expect(unrelated.json.messages).toEqual([]);
    expect(unrelated.json.proposals.map((p: any) => p.task)).toEqual(['unrelated proposal']);

    const sender = await board(['--contains', 'carol']);
    // The needle matches displayed fields only: claimB's owner label, the
    // proposal addressed to carol and m-lunch's sender/recipient text.
    expect(sender.json.claims).toHaveLength(1);
    expect(sender.json.messages.map((m: any) => m.id)).toEqual(['m-lunch']);
    expect(sender.json.proposals).toHaveLength(1);
  });

  it('rejects malformed filter values as usage errors', async () => {
    await seed();
    for (const args of [
      ['board', '--agent', 'bad agent!', '--json'],
      ['board', '--from', '', '--json'],
      ['board', '--repo', 'not-a-repo', '--json'],
      ['board', '--to', 'x'.repeat(200), '--json'],
      ['board', '--since', 'not-a-time', '--json'],
      ['board', '--before', 'not-a-time', '--json'],
      ['board', '--contains', '   ', '--json'],
      ['board', '--unknown-flag', 'x', '--json'],
    ]) {
      const { code } = await cli(args);
      expect(code).toBe(2);
    }
  });
});
