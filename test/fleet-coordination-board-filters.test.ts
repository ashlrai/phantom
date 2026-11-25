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

async function claim(repo: string, task: string, agent: string, offsetMs: number, ttl = TTL) {
  at(offsetMs);
  const { code, json } = await cli(['claim', '--repo', repo, '--task', task, '--agent', agent,
    '--ttl-seconds', ttl, '--json']);
  expect(code).toBe(0);
  expect(json.ok).toBe(true);
}

const board = (extra: string[] = []) => cli(['board', ...extra, '--json']);
const claimKeys = (json: any) => json.claims.map((c: any) => `${c.agent}:${c.repo} ${c.task}`).sort();
const messageIds = (json: any) => json.messages.map((m: any) => m.id).sort();
const proposalTasks = (json: any) => json.proposals.map((p: any) => p.task).sort();

async function seed() {
  await claim('ashlrai/phantom', 'deploy the board fix', 'alice', 0);
  await claim('ashlrai/other', 'unrelated chore', 'bob', 1_000);
  await post('alice', 'bob', 'deploy finished green', 2_000, 'm-deploy');
  await post('carol', 'all', 'deploy freeze at noon', 3_000, 'm-freeze');
  await post('dave', 'carol', 'not for bob', 4_000, 'm-dave');
  await assign('ashlrai/phantom', 'review the deploy', 'carol', 5_000);
  await assign('ashlrai/other', 'unrelated chore', 'bob', 6_000);
  at(7_000);
}

describe('fleet coordination board read filters', () => {
  it('shows the whole ledger unfiltered, then narrows by sender, repo, window and text', async () => {
    await seed();

    const all = await board();
    expect(all.code).toBe(0);
    expect(all.json.state).toBe('known');
    expect(all.json.claims).toHaveLength(2);
    expect(messageIds(all.json)).toEqual(['m-dave', 'm-deploy', 'm-freeze']);
    expect(all.json.proposals).toHaveLength(2);
    expect(all.json.expiredClaims).toBe(0);

    const fromAlice = await board(['--from', 'alice']);
    // alice holds one claim and posted one message; proposals carry no sender.
    expect(claimKeys(fromAlice.json)).toEqual(['alice:ashlrai/phantom deploy the board fix']);
    expect(messageIds(fromAlice.json)).toEqual(['m-deploy']);
    expect(fromAlice.json.proposals).toEqual([]);

    // Repo compares case-insensitively across claims and proposals; messages carry no repo.
    const repo = await board(['--repo', 'AshlrAI/Phantom']);
    expect(claimKeys(repo.json)).toEqual(['alice:ashlrai/phantom deploy the board fix']);
    expect(repo.json.messages).toEqual([]);
    expect(proposalTasks(repo.json)).toEqual(['review the deploy']);

    const deploy = await board(['--contains', 'DEPLOY']);
    expect(claimKeys(deploy.json)).toEqual(['alice:ashlrai/phantom deploy the board fix']);
    expect(messageIds(deploy.json)).toEqual(['m-deploy', 'm-freeze']);
    expect(proposalTasks(deploy.json)).toEqual(['review the deploy']);
  });

  it('reads one [since, before) window on each record\'s own stamp', async () => {
    await seed();

    // Claims stamp claimedAt; messages and proposals stamp at.
    const since = await board(['--since', String(T0 + 1_500)]);
    expect(claimKeys(since.json)).toEqual([]);
    expect(messageIds(since.json)).toEqual(['m-dave', 'm-deploy', 'm-freeze']);
    expect(proposalTasks(since.json)).toHaveLength(2);

    const before = await board(['--before', String(T0 + 1_500)]);
    expect(claimKeys(before.json)).toEqual([
      'alice:ashlrai/phantom deploy the board fix',
      'bob:ashlrai/other unrelated chore',
    ]);
    expect(before.json.messages).toEqual([]);
    expect(before.json.proposals).toEqual([]);

    // m-dave sits exactly at the exclusive bound and drops out; m-deploy sits
    // exactly on the inclusive since bound and stays.
    const window = await board(['--since', String(T0 + 2_000), '--before', String(T0 + 4_000)]);
    expect(messageIds(window.json)).toEqual(['m-deploy', 'm-freeze']);
    expect(window.json.claims).toEqual([]);
    expect(window.json.proposals).toEqual([]);

    // Filters compose across collections: alice's claim predates the window,
    // her m-deploy post sits inside it, and proposals drop out under --from.
    const composed = await board(['--from', 'alice', '--since', String(T0 + 1_500)]);
    expect(composed.json.claims).toEqual([]);
    expect(messageIds(composed.json)).toEqual(['m-deploy']);
    expect(composed.json.proposals).toEqual([]);
  });

  it('accepts the shared relative and ISO since grammar', async () => {
    await seed();
    at(61_000);
    await post('alice', 'bob', 'late ping', 61_000, 'm-late');

    // now = T0+61s; 1m ago = T0+1s, so records stamped at T0+1s and later stay.
    const rel = await board(['--since', '1m']);
    expect(claimKeys(rel.json)).toEqual(['bob:ashlrai/other unrelated chore']);
    expect(messageIds(rel.json)).toEqual(['m-dave', 'm-deploy', 'm-freeze', 'm-late']);

    const iso = await board(['--since', new Date(T0 + 3_000).toISOString()]);
    expect(messageIds(iso.json)).toEqual(['m-dave', 'm-freeze', 'm-late']);
    expect(proposalTasks(iso.json)).toHaveLength(2);
  });

  it('keeps expiredClaims ledger-wide while the collections narrow', async () => {
    await claim('ashlrai/phantom', 'short lived', 'alice', 0, '1');
    await claim('ashlrai/other', 'long lived', 'bob', 500);
    at(5_000);

    const all = await board();
    expect(all.json.state).toBe('known');
    expect(claimKeys(all.json)).toEqual(['bob:ashlrai/other long lived']);
    expect(all.json.expiredClaims).toBe(1);

    // The expired claim's repo no longer matches anything live, yet the
    // ledger-wide expired count stays honest under every filter.
    const filtered = await board(['--repo', 'ashlrai/phantom']);
    expect(filtered.json.claims).toEqual([]);
    expect(filtered.json.expiredClaims).toBe(1);
  });

  it('refuses malformed filters', async () => {
    await seed();
    for (const args of [
      ['--from', 'bad label'],
      ['--repo', 'not-a-repo'],
      ['--repo', 'owner/name/extra'],
      ['--since', 'bogus'],
      ['--before', '15x'],
      ['--contains', '   '],
      ['--contains', 'x'.repeat(600)],
    ]) {
      const { code } = await board(args);
      expect(code).toBe(2);
    }
    const { code } = await cli(['board', '--agent', 'alice', '--json']);
    expect(code).toBe(2);
  });

  it('keeps an unreadable ledger unknown instead of fabricating rows', async () => {
    vi.stubEnv('PHANTOM_FLEET_LEDGER_PATH', join(dir, 'missing', 'coordination.jsonl'));
    const { code, json } = await board(['--from', 'alice', '--contains', 'deploy']);
    expect(code).toBe(1);
    expect(json).toMatchObject({ schema: 'fleet.coordination.v1', state: 'unknown',
      claims: [], messages: [], proposals: [], expiredClaims: null });
  });
});
