import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetBoard } from '../src/cli/fleet-board.js';
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

async function cli(args: string[], board = cmdFleetCoordination) {
  const calls = vi.mocked(console.log).mock.calls.length;
  const code = await board(args);
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
}

const board = (extra: string[] = []) => cli(['board', ...extra, '--json']);

async function seed() {
  await claim('ashlrai/phantom', 'deploy the board filters', 'alice', 0);
  await claim('ashlrai/other', 'unrelated chore', 'carol', 1_000);
  await post('alice', 'bob', 'deploy finished green', 2_000, 'm-deploy');
  await post('carol', 'bob', 'lunch?', 3_000, 'm-lunch');
  await post('alice', 'all', 'all hands: deploy freeze at noon', 4_000, 'm-all');
  await post('dave', 'carol', 'not for bob', 5_000, 'm-dave');
  await assign('ashlrai/phantom', 'deploy the board fix', 'bob', 6_000);
  await assign('ashlrai/other', 'unrelated chore', 'carol', 7_000);
  at(8_000);
}

describe('fleet coordination board read filters', () => {
  it('lists every section unfiltered, then narrows claims and proposals by repo', async () => {
    await seed();

    const all = await board();
    expect(all.code).toBe(0);
    expect(all.json.state).toBe('known');
    expect(all.json.claims).toHaveLength(2);
    expect(all.json.messages).toHaveLength(4);
    expect(all.json.proposals).toHaveLength(2);
    expect(all.json.expiredClaims).toBe(0);

    const phantom = await board(['--repo', 'ashlrai/phantom']);
    expect(phantom.json.claims.map((c: any) => c.task)).toEqual(['deploy the board filters']);
    expect(phantom.json.proposals.map((p: any) => p.task)).toEqual(['deploy the board fix']);
    // A message records no repo, so a repo read drops every message — a
    // positive filter never guesses one in.
    expect(phantom.json.messages).toEqual([]);

    // Repo names compare case-insensitively, the returns read's rule.
    const upper = await board(['--repo', 'ASHLRAI/PHANTOM']);
    expect(upper.json.claims).toHaveLength(1);
    expect(upper.json.proposals).toHaveLength(1);
    expect(upper.json.messages).toEqual([]);
  });

  it('keeps records naming the agent label in each section', async () => {
    await seed();

    // alice holds one claim, sends two posts and is assigned nothing; the
    // `all` broadcast names every agent, so it lists under her too.
    const alice = await board(['--agent', 'alice']);
    expect(alice.json.claims.map((c: any) => c.agent)).toEqual(['alice']);
    expect(alice.json.messages.map((m: any) => m.id).sort()).toEqual(['m-all', 'm-deploy']);
    expect(alice.json.proposals).toEqual([]);

    // bob is assigned the phantom proposal and is the addressee of two
    // posts plus the broadcast; he sends and holds nothing.
    const bob = await board(['--agent', 'bob']);
    expect(bob.json.claims).toEqual([]);
    expect(bob.json.messages.map((m: any) => m.id).sort()).toEqual(['m-all', 'm-deploy', 'm-lunch']);
    expect(bob.json.proposals.map((p: any) => p.task)).toEqual(['deploy the board fix']);

    // carol holds the other claim, is assigned one proposal, sent one post
    // and received dave's — plus the broadcast every agent names.
    const carol = await board(['--agent', 'carol']);
    expect(carol.json.claims.map((c: any) => c.task)).toEqual(['unrelated chore']);
    expect(carol.json.messages.map((m: any) => m.id).sort()).toEqual(['m-all', 'm-dave', 'm-lunch']);
    expect(carol.json.proposals.map((p: any) => p.task)).toEqual(['unrelated chore']);

    // A label nothing claims or proposes still sees the broadcast — `all`
    // is addressed to every agent — while its own sections stay empty.
    const nobody = await board(['--agent', 'nobody']);
    expect(nobody.json.claims).toEqual([]);
    expect(nobody.json.messages.map((m: any) => m.id)).toEqual(['m-all']);
    expect(nobody.json.proposals).toEqual([]);
    expect(nobody.json.state).toBe('known');
  });

  it('searches each section\'s own text and reads one [since, before) window', async () => {
    await seed();

    const deploy = await board(['--contains', 'DEPLOY']);
    expect(deploy.json.claims.map((c: any) => c.task)).toEqual(['deploy the board filters']);
    expect(deploy.json.messages.map((m: any) => m.id).sort()).toEqual(['m-all', 'm-deploy']);
    expect(deploy.json.proposals.map((p: any) => p.task)).toEqual(['deploy the board fix']);

    const chore = await board(['--contains', '  unrelated   CHORE ']);
    expect(chore.json.claims.map((c: any) => c.task)).toEqual(['unrelated chore']);
    expect(chore.json.messages).toEqual([]);
    expect(chore.json.proposals.map((p: any) => p.task)).toEqual(['unrelated chore']);

    // Claims stamp claimedAt, messages and proposals stamp at — one window
    // on each record's own time. alice's claim sits exactly on the
    // inclusive since bound and stays; carol's claim at T0+1s is inside;
    // m-lunch sits exactly on the exclusive before bound and drops out.
    const window = await board(['--since', String(T0), '--before', String(T0 + 3_000)]);
    expect(window.json.claims).toHaveLength(2);
    expect(window.json.messages.map((m: any) => m.id)).toEqual(['m-deploy']);
    expect(window.json.proposals).toEqual([]);

    // Filters compose: the phantom repo inside the window keeps only bob's
    // proposal — no claim or message survives both.
    const composed = await board(['--repo', 'ashlrai/phantom', '--since', String(T0 + 5_500)]);
    expect(composed.json.claims).toEqual([]);
    expect(composed.json.messages).toEqual([]);
    expect(composed.json.proposals.map((p: any) => p.task)).toEqual(['deploy the board fix']);
  });

  it('accepts the shared relative and ISO since grammar', async () => {
    await seed();
    await post('alice', 'bob', 'late ping', 63_000, 'm-late');

    // now = T0+63s; 1m ago = T0+3s — m-deploy (T0+2s) drops, m-lunch sits
    // exactly on the inclusive bound and stays; every claim and proposal
    // predates the cutoff.
    const rel = await board(['--since', '1m']);
    expect(rel.json.messages.map((m: any) => m.id).sort()).toEqual(['m-all', 'm-dave', 'm-late', 'm-lunch']);
    expect(rel.json.claims).toEqual([]);
    expect(rel.json.proposals).toHaveLength(2);

    const iso = await board(['--since', new Date(T0 + 4_000).toISOString()]);
    expect(iso.json.messages.map((m: any) => m.id).sort()).toEqual(['m-all', 'm-dave', 'm-late']);
    expect(iso.json.claims).toEqual([]);
    expect(iso.json.proposals.map((p: any) => p.to).sort()).toEqual(['bob', 'carol']);
  });

  it('refuses malformed filters and keeps inbox flags off the board', async () => {
    await seed();
    for (const args of [
      ['--repo', 'not-a-repo'],
      ['--agent', 'bad label'],
      ['--since', 'bogus'],
      ['--before', '15x'],
      ['--contains', '   '],
      ['--from', 'alice'],
    ]) {
      const { code } = await board(args);
      expect(code).toBe(2);
    }
  });

  it('serves the same filters through the phm fleet board alias', async () => {
    await seed();
    const { code, json } = await cli(['--repo', 'ashlrai/other', '--json'], cmdFleetBoard);
    expect(code).toBe(0);
    expect(json.claims.map((c: any) => c.task)).toEqual(['unrelated chore']);
    expect(json.proposals.map((p: any) => p.task)).toEqual(['unrelated chore']);
    expect(json.messages).toEqual([]);
  });

  it('keeps an unreadable ledger unknown instead of fabricating rows', async () => {
    vi.stubEnv('PHANTOM_FLEET_LEDGER_PATH', join(dir, 'missing', 'coordination.jsonl'));
    const { code, json } = await board(['--repo', 'ashlrai/phantom', '--agent', 'alice']);
    expect(code).toBe(1);
    expect(json).toMatchObject({ schema: 'fleet.coordination.v1', state: 'unknown',
      claims: [], messages: [], proposals: [], expiredClaims: null });
  });
});
