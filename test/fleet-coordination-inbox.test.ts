import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetCoordination } from '../src/cli/fleet-coordination.js';
import { cmdFleetInbox } from '../src/cli/fleet-inbox.js';

const T0 = 1_760_000_000_000;
const TTL = '86400';

let dir = '';
let ledgerPath = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'coordination-inbox-'));
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

async function cli(args: string[], inbox = cmdFleetCoordination) {
  const calls = vi.mocked(console.log).mock.calls.length;
  const code = await inbox(args);
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

const inbox = (agent: string, extra: string[] = []) =>
  cli(['inbox', '--agent', agent, ...extra, '--json']);

async function seed() {
  await post('alice', 'bob', 'deploy finished green', 0, 'm-deploy');
  await post('carol', 'bob', 'lunch?', 1_000, 'm-lunch');
  await post('alice', 'all', 'all hands: deploy freeze at noon', 2_000, 'm-all');
  await post('dave', 'carol', 'not for bob', 3_000, 'm-dave');
  await assign('ashlrai/phantom', 'deploy the inbox fix', 'bob', 4_000);
  await assign('ashlrai/other', 'unrelated chore', 'bob', 5_000);
  at(6_000);
}

describe('fleet coordination inbox read filters', () => {
  it('keeps the addressed set and narrows it by sender, window and text', async () => {
    await seed();

    const all = await inbox('bob');
    expect(all.code).toBe(0);
    expect(all.json.state).toBe('known');
    expect(all.json.messages.map((m: any) => m.id).sort()).toEqual(['m-all', 'm-deploy', 'm-lunch']);
    expect(all.json.proposals).toHaveLength(2);

    const fromAlice = await inbox('bob', ['--from', 'alice']);
    expect(fromAlice.json.messages.map((m: any) => m.id).sort()).toEqual(['m-all', 'm-deploy']);
    // Proposals carry no sender, so a sender read drops every proposal.
    expect(fromAlice.json.proposals).toEqual([]);

    const fromCarol = await inbox('bob', ['--from', 'carol']);
    expect(fromCarol.json.messages.map((m: any) => m.id)).toEqual(['m-lunch']);
    expect(fromCarol.json.proposals).toEqual([]);

    const fromDave = await inbox('bob', ['--from', 'dave']);
    expect(fromDave.json.messages).toEqual([]);
    expect(fromDave.json.proposals).toEqual([]);

    const deploy = await inbox('bob', ['--contains', 'DEPLOY']);
    expect(deploy.json.messages.map((m: any) => m.id).sort()).toEqual(['m-all', 'm-deploy']);
    // --contains matches a proposal's repo+task text: only the deploy task survives.
    expect(deploy.json.proposals).toHaveLength(1);
    expect(deploy.json.proposals[0].task).toBe('deploy the inbox fix');

    const hands = await inbox('bob', ['--contains', 'all   hands']);
    expect(hands.json.messages.map((m: any) => m.id)).toEqual(['m-all']);
    expect(hands.json.proposals).toEqual([]);
  });

  it('reads one [since, before) window on each record\'s at stamp', async () => {
    await seed();

    const since = await inbox('bob', ['--since', String(T0 + 1_000)]);
    expect(since.json.messages.map((m: any) => m.id).sort()).toEqual(['m-all', 'm-lunch']);
    expect(since.json.proposals).toHaveLength(2);

    const before = await inbox('bob', ['--before', String(T0 + 1_000)]);
    expect(before.json.messages.map((m: any) => m.id)).toEqual(['m-deploy']);
    expect(before.json.proposals).toEqual([]);

    // m-all sits exactly at the exclusive bound and drops out; m-deploy sits
    // exactly on the inclusive since bound and stays.
    const window = await inbox('bob', ['--since', String(T0), '--before', String(T0 + 2_000)]);
    expect(window.json.messages.map((m: any) => m.id).sort()).toEqual(['m-deploy', 'm-lunch']);

    // Proposals share the window on their own at stamps.
    const proposalWindow = await inbox('bob', ['--before', String(T0 + 4_500)]);
    expect(proposalWindow.json.proposals).toHaveLength(1);
    expect(proposalWindow.json.proposals[0].task).toBe('deploy the inbox fix');

    // Filters compose: alice's posts inside the window.
    const composed = await inbox('bob', ['--from', 'alice', '--since', String(T0 + 1_500)]);
    expect(composed.json.messages.map((m: any) => m.id)).toEqual(['m-all']);
    expect(composed.json.proposals).toEqual([]);
  });

  it('accepts the shared relative and ISO since grammar', async () => {
    await seed();
    at(T0 + 61_000);
    await post('alice', 'bob', 'late ping', 61_000, 'm-late');

    // now = T0+61s; 1m ago = T0+1s, so m-lunch (at exactly T0+1s) stays and m-deploy drops.
    const rel = await inbox('bob', ['--since', '1m']);
    expect(rel.json.messages.map((m: any) => m.id).sort()).toEqual(['m-all', 'm-late', 'm-lunch']);

    const iso = await inbox('bob', ['--since', new Date(T0 + 2_000).toISOString()]);
    expect(iso.json.messages.map((m: any) => m.id).sort()).toEqual(['m-all', 'm-late']);
  });

  it('refuses malformed filters and keeps board free of them', async () => {
    await seed();
    for (const args of [
      ['--from', 'bad label'],
      ['--since', 'bogus'],
      ['--before', '15x'],
      ['--contains', '   '],
    ]) {
      const { code } = await inbox('bob', args);
      expect(code).toBe(2);
    }
    const { code: boardCode } = await cli(['board', '--from', 'alice', '--json']);
    expect(boardCode).toBe(2);
  });

  it('serves the same filters through the phm fleet inbox alias', async () => {
    await seed();
    const { code, json } = await cli(['--agent', 'bob', '--from', 'alice', '--json'], cmdFleetInbox);
    expect(code).toBe(0);
    expect(json.messages.map((m: any) => m.id).sort()).toEqual(['m-all', 'm-deploy']);
    expect(json.proposals).toEqual([]);
  });

  it('keeps an unreadable ledger unknown instead of fabricating rows', async () => {
    vi.stubEnv('PHANTOM_FLEET_LEDGER_PATH', join(dir, 'missing', 'coordination.jsonl'));
    const { code, json } = await inbox('bob', ['--from', 'alice', '--contains', 'deploy']);
    expect(code).toBe(1);
    expect(json).toMatchObject({ schema: 'fleet.coordination.v1', state: 'unknown', messages: [], proposals: [] });
  });
});
