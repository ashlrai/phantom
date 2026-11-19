import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runAgentsCli } from '../src/cli/agents-bus-contract.js';
import { runAgentsBusUnified } from '../src/cli/agents-bus-unified.js';
import * as seats from '../src/core/bots/seats.js';

let base: string;
let root: string;
let previousRuns: string | undefined;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'agent-bus-cli-'));
  root = join(base, 'fleet');
  previousRuns = process.env['ASHLR_RUNS_DIR'];
  process.env['ASHLR_RUNS_DIR'] = join(base, 'runs');
});
afterEach(() => {
  if (previousRuns === undefined) delete process.env['ASHLR_RUNS_DIR'];
  else process.env['ASHLR_RUNS_DIR'] = previousRuns;
  rmSync(base, { recursive: true, force: true });
});

async function run(args: string[], env: NodeJS.ProcessEnv = {}) {
  const out: string[] = [], err: string[] = [];
  const code = await runAgentsBusUnified([...args, '--root', root, '--json'], t => out.push(t), t => err.push(t), env);
  return { code, json: out.length ? JSON.parse(out.join('\n')) : JSON.parse(err.join('\n')) };
}

describe('phm agents bus (unified)', () => {
  it('lists configured seat participants additively without registering identities or channels', async () => {
    const participant = { participantId: 'review-seat', provider: 'devin' as const, displayName: 'Reviewer', capabilities: ['code'],
      status: 'idle' as const, wake: { kind: 'poll' as const, target: 'review-seat' } };
    const read = vi.spyOn(seats, 'seatParticipants').mockResolvedValueOnce([participant]);
    try {
      expect(await run(['id', 'list'])).toMatchObject({ code: 0, json: { identities: [], channels: [], participants: [participant] } });
    } finally { read.mockRestore(); }
    expect((await run(['id', 'list'])).json.participants).toEqual([]);
  });
  it('surfaces unavailable seat rosters without registering identities', async () => {
    const read = vi.spyOn(seats, 'seatParticipants').mockRejectedValueOnce(new Error('Unsafe seat file.'));
    try {
      await expect(run(['id', 'list'])).rejects.toThrow('Unsafe seat file.');
    } finally { read.mockRestore(); }
    expect((await run(['id', 'list'])).json.identities).toEqual([]);
  });
  it('registers, messages, hands off and reads an inbox end to end', async () => {
    expect((await run(['id', 'register', 'atlas', '--cli', 'claude', '--model', 'opus'])).json).toMatchObject({ status: 'created', identity: { handle: 'atlas' } });
    expect((await run(['id', 'register'], { PHM_AGENT_ID: 'nova', CODEX_SANDBOX: 'seatbelt' })).json)
      .toMatchObject({ status: 'created', identity: { runtimes: [{ cli: 'codex', provider: 'codex-personal' }] } });
    expect((await run(['id', 'register', 'orion', '--alias', 'dot-main', '--alias', 'lane-x'])).json)
      .toMatchObject({ status: 'created', identity: { aliases: ['dot-main', 'lane-x'], runtimes: [] } });
    const list = await run(['id', 'list']);
    expect(list.json.identities.map((i: { handle: string }) => i.handle)).toEqual(['atlas', 'nova', 'orion']);

    expect((await run(['dm', '--to', 'nova', '--text', 'hello', '--priority', 'P0', '--id', 'cli-dm'], { PHM_AGENT_ID: 'atlas' })).json)
      .toMatchObject({ status: 'posted', to: 'agent:nova', wake: 'queued' });
    expect((await run(['channel', 'create', 'release', '--from', 'atlas', '--member', 'nova'])).json).toMatchObject({ status: 'created' });
    expect((await run(['channel', 'join', 'release', '--agent', 'dot-main'])).json).toMatchObject({ status: 'updated', channel: { members: ['atlas', 'nova', 'orion'] } });
    expect((await run(['channel', 'post', 'release', '--from', 'orion', '--text', 'ship it', '--id', 'cli-ch'])).json).toMatchObject({ status: 'posted', wake: 'not-requested' });
    expect((await run(['handoff', '--from', 'atlas', '--to', 'nova', '--task', 'RQ-CLI-1', '--prompt', 'take over', '--id', 'cli-ho'])).json)
      .toMatchObject({ status: 'posted', wake: 'queued' });

    const inbox = await run(['inbox', 'nova']);
    expect(inbox.code).toBe(0);
    expect(inbox.json.messages.map((m: { envelope: { id: string }; kind: string }) => `${m.envelope.id}:${m.kind}`))
      .toEqual(['cli-dm:dm', 'cli-ho:handoff', 'cli-ch:channel']);
    const framed = await run(['inbox', '--frame', 'cursor'], { PHM_AGENT_ID: 'nova' });
    expect(framed.json.framed).toContain('BEGIN UNTRUSTED AGENT BUS MESSAGES');
    const wakes = await run(['wakes', 'nova']);
    expect(wakes.json.wakes.map((w: { id: string }) => w.id)).toEqual(['cli-dm', 'cli-ho']);
    const adapters = await run(['adapters']);
    expect(adapters.json.adapters.map((a: { cli: string }) => a.cli)).toEqual(['claude', 'codex', 'devin', 'cursor', 'grok']);
  });

  it('announces and updates v2 work on the same bus, owner-only for status', async () => {
    expect((await run(['id', 'register', 'atlas', '--cli', 'claude'])).json).toMatchObject({ status: 'created' });
    expect((await run(['id', 'register', 'nova'])).json).toMatchObject({ status: 'created' });
    expect((await run(['work', 'post', '--from', 'atlas', '--job', 'RQ-CLI-W', '--title', 'Ship it',
      '--repo', 'ashlrai/phantom', '--claim', 'repo:ashlrai/phantom', '--id', 'cli-w'])).json)
      .toMatchObject({ status: 'posted', to: 'leaders', wake: 'not-requested' });
    expect((await run(['work', 'post', '--from', 'atlas', '--job', 'RQ-CLI-W2', '--title', 'Second',
      '--repo', 'ashlrai/phantom', '--provider', 'devin',
      '--tier', 'work', '--scope', 'bus lane', '--acceptance', 'feed shows done', '--id', 'cli-w2'])).json)
      .toMatchObject({ status: 'posted' });
    expect((await run(['work', 'status', '--from', 'atlas', '--job', 'RQ-CLI-W', '--status', 'running',
      '--detail', 'picked up', '--id', 'cli-ws'])).json).toMatchObject({ status: 'posted', to: 'leaders' });
    // Only the announcing identity may move the job.
    expect(await run(['work', 'status', '--from', 'nova', '--job', 'RQ-CLI-W', '--status', 'done']))
      .toMatchObject({ code: 1, json: { status: 'refused' } });
    expect((await run(['work', 'status', '--from', 'atlas', '--job', 'RQ-GONE', '--status', 'done'])).json)
      .toMatchObject({ status: 'invalid' });
  });

  it('reads the work feed and live claims on the same surface', async () => {
    expect((await run(['id', 'register', 'atlas', '--cli', 'claude'])).json).toMatchObject({ status: 'created' });
    // Empty stores read honestly before anything is posted or claimed.
    expect((await run(['work', 'feed'])).json).toMatchObject({ status: 'ok', jobs: [], receipts: 0 });
    expect((await run(['claim', 'list'])).json).toMatchObject({ status: 'ok', source: 'missing', claims: [] });

    expect((await run(['work', 'post', '--from', 'atlas', '--job', 'RQ-FEED', '--title', 'Read me',
      '--repo', 'ashlrai/phantom', '--claim', 'repo:ashlrai/phantom', '--id', 'cli-feed'])).json)
      .toMatchObject({ status: 'posted' });
    expect((await run(['work', 'status', '--from', 'atlas', '--job', 'RQ-FEED', '--status', 'running', '--id', 'cli-feed-s'])).json)
      .toMatchObject({ status: 'posted' });

    const feed = await run(['work', 'feed']);
    expect(feed.code).toBe(0);
    expect(feed.json).toMatchObject({ status: 'ok', receipts: 2,
      jobs: [{ id: 'RQ-FEED', status: 'running', owner: 'agent:atlas', provider: 'claude' }] });
    expect((await run(['work', 'feed', '--status', 'queued'])).json).toMatchObject({ status: 'ok', jobs: [] });
    expect((await run(['work', 'feed', '--status', 'running', '--claims'])).json)
      .toMatchObject({ status: 'ok', claims: { source: 'missing', holds: [] } });

    // A live claim lists with no token, narrows by --key, and joins the feed.
    expect((await run(['claim', 'acquire', '--key', 'repo:ashlrai/phantom', '--lease-ms', '600000',
      '--owner', 'atlas', '--id', 'cli-claim'])).json).toMatchObject({ status: 'acquired' });
    const claims = await run(['claim', 'list']);
    expect(claims.code).toBe(0);
    expect(claims.json).toMatchObject({ status: 'ok', source: 'available' });
    expect(claims.json.claims).toHaveLength(1);
    expect(claims.json.claims[0]).toMatchObject({ key: 'repo:ashlrai/phantom', owner: 'atlas',
      origin: 'resource', live: true });
    expect(JSON.stringify(claims.json)).not.toContain('token');
    expect((await run(['claim', 'list', '--key', 'path:ashlrai/phantom:src/**'])).json.claims
      .map((row: { key: string }) => row.key)).toEqual(['repo:ashlrai/phantom']);
    expect((await run(['claim', 'list', '--key', 'queue:RQ-FREE'])).json.claims).toEqual([]);
    expect((await run(['work', 'feed', '--claims'])).json.claims.holds)
      .toEqual([expect.objectContaining({ jobId: 'RQ-FEED', claimKey: 'repo:ashlrai/phantom', owner: 'atlas' })]);

    // --jobs is the reverse join: the claim names the feed job it blocks.
    const withJobs = await run(['claim', 'list', '--jobs']);
    expect(withJobs.json).toMatchObject({ status: 'ok', source: 'available', feed: 'ok' });
    expect(withJobs.json.claims[0].jobs)
      .toEqual([{ id: 'RQ-FEED', owner: 'agent:atlas', status: 'running' }]);
    // Without --jobs no feed join or feed state is reported.
    expect(claims.json.feed).toBeUndefined();
    expect(claims.json.claims[0].jobs).toBeUndefined();

    // Human output shares the fleet feed lines; reads need no identity.
    const text: string[] = [];
    expect(await runAgentsBusUnified(['work', 'feed', '--root', root], t => text.push(t), () => {}, {})).toBe(0);
    expect(text.join('\n')).toContain('RQ-FEED running owner=agent:atlas provider=claude');
    expect(text.join('\n')).toContain('jobs=1 receipts=2 feed=ok');
    const claimText: string[] = [];
    expect(await runAgentsBusUnified(['claim', 'list', '--root', root], t => claimText.push(t), () => {}, {})).toBe(0);
    expect(claimText.join('\n')).toContain('repo:ashlrai/phantom owner=atlas origin=resource');
    expect(claimText.join('\n')).toContain('claims=1 source=available');
    const claimJobsText: string[] = [];
    expect(await runAgentsBusUnified(['claim', 'list', '--jobs', '--root', root], t => claimJobsText.push(t), () => {}, {})).toBe(0);
    expect(claimJobsText.join('\n')).toContain('jobs=RQ-FEED(running)');
    expect(claimJobsText.join('\n')).toContain('feed=ok');
  });

  it('filters the work feed to jobs still open for a worker with --open', async () => {
    expect((await run(['id', 'register', 'atlas', '--cli', 'claude'])).json).toMatchObject({ status: 'created' });
    expect((await run(['work', 'post', '--from', 'atlas', '--job', 'RQ-OPEN', '--title', 'Open',
      '--repo', 'ashlrai/phantom', '--claim', 'queue:RQ-OPEN', '--id', 'open-1'])).json)
      .toMatchObject({ status: 'posted' });
    expect((await run(['work', 'post', '--from', 'atlas', '--job', 'RQ-HELD', '--title', 'Held',
      '--repo', 'ashlrai/phantom', '--claim', 'queue:RQ-HELD', '--id', 'open-2'])).json)
      .toMatchObject({ status: 'posted' });
    expect((await run(['work', 'post', '--from', 'atlas', '--job', 'RQ-DONE', '--title', 'Done',
      '--repo', 'ashlrai/phantom', '--claim', 'queue:RQ-DONE', '--id', 'open-3'])).json)
      .toMatchObject({ status: 'posted' });
    expect((await run(['work', 'status', '--from', 'atlas', '--job', 'RQ-DONE', '--status', 'done',
      '--id', 'open-3s'])).json).toMatchObject({ status: 'posted' });
    // Hold every claim key of RQ-HELD so no worker can take it.
    expect((await run(['claim', 'acquire', '--key', 'queue:RQ-HELD', '--lease-ms', '600000',
      '--owner', 'atlas', '--id', 'open-claim'])).json).toMatchObject({ status: 'acquired' });

    const feed = await run(['work', 'feed']);
    expect(feed.json.jobs.map((job: { id: string }) => job.id).sort()).toEqual(['RQ-DONE', 'RQ-HELD', 'RQ-OPEN']);
    // --open implies the claims join and keeps only the claimable queued job.
    const open = await run(['work', 'feed', '--open']);
    expect(open.code).toBe(0);
    expect(open.json.status).toBe('ok');
    expect(open.json.jobs.map((job: { id: string }) => job.id)).toEqual(['RQ-OPEN']);
    expect(open.json.claims).toMatchObject({ source: 'available' });
    expect(open.json.claims.holds).toEqual([]);
    // The held job's lease regroups only under --claims without --open.
    const claimed = await run(['work', 'feed', '--claims']);
    expect(claimed.json.claims.holds).toEqual([expect.objectContaining({ jobId: 'RQ-HELD', claimKey: 'queue:RQ-HELD' })]);
    // --open composes with --status as an intersection.
    expect((await run(['work', 'feed', '--open', '--status', 'done'])).json.jobs).toEqual([]);
  });

  it('filters claim list by owner through the identity registry', async () => {
    expect((await run(['id', 'register', 'atlas', '--alias', 'lane-atlas'])).json)
      .toMatchObject({ status: 'created' });
    for (const [key, owner, id] of [
      ['repo:ashlrai/phantom', 'atlas', 'own-1'],
      ['queue:RQ-A', 'agent:atlas', 'own-2'],
      ['queue:RQ-B', 'lane-atlas', 'own-3'],
      ['queue:RQ-C', 'other', 'own-4'],
    ] as const) {
      expect((await run(['claim', 'acquire', '--key', key, '--lease-ms', '600000', '--owner', owner, '--id', id])).json)
        .toMatchObject({ status: 'acquired' });
    }
    const mine = await run(['claim', 'list', '--owner', 'atlas']);
    expect(mine.code).toBe(0);
    expect(mine.json.claims).toHaveLength(3);
    expect(mine.json.owner).toMatchObject({ ref: 'atlas', registry: 'available' });
    expect(mine.json.owner.identity).toMatch(/^agt_[a-f0-9]{20}$/);
    for (const ref of ['agent:atlas', 'lane-atlas', mine.json.owner.identity]) {
      expect((await run(['claim', 'list', '--owner', ref])).json.claims).toHaveLength(3);
    }
    const other = await run(['claim', 'list', '--owner', 'other']);
    expect(other.json.owner).toMatchObject({ ref: 'other', identity: null, registry: 'available' });
    expect(other.json.claims.map((row: { owner: string }) => row.owner)).toEqual(['other']);
    expect((await run(['claim', 'list', '--owner', 'atlas', '--key', 'repo:ashlrai/phantom'])).json.claims)
      .toEqual([expect.objectContaining({ key: 'repo:ashlrai/phantom' })]);
    expect((await run(['claim', 'list', '--owner', 'atlas', '--key', 'queue:RQ-FREE'])).json.claims).toEqual([]);
    expect(await run(['claim', 'list', '--owner', 'bad owner'])).toMatchObject({ code: 2, json: { status: 'invalid' } });

    const text: string[] = [];
    expect(await runAgentsBusUnified(['claim', 'list', '--owner', 'atlas', '--root', root],
      t => text.push(t), () => {}, {})).toBe(0);
    expect(text.join('\n')).toContain('claims=3 source=available owner=atlas');
    expect(text.join('\n')).toContain('registry=available');
  });

  it('refuses bad work verbs and flags with usage errors', async () => {
    expect((await run(['id', 'register', 'atlas', '--cli', 'claude'])).json).toMatchObject({ status: 'created' });
    expect(await run(['work', 'post', '--from', 'atlas', '--title', 'x', '--repo', 'a/b']))
      .toMatchObject({ code: 2, json: { error: 'invalid-argument' } });
    expect(await run(['work', 'status', '--from', 'atlas', '--job', 'RQ-X', '--status', 'bogus']))
      .toMatchObject({ code: 2 });
    expect(await run(['work', 'post', '--from', 'atlas', '--job', 'RQ-X', '--title', 'x', '--repo', 'a/b',
      '--tier', 'work'])).toMatchObject({ code: 2 });
    expect(await run(['work', 'frobnicate'])).toMatchObject({ code: 2 });
    // An identity with no runtime and no --provider cannot announce.
    expect((await run(['id', 'register', 'orion'])).json).toMatchObject({ status: 'created' });
    expect((await run(['work', 'post', '--from', 'orion', '--job', 'RQ-X', '--title', 'x',
      '--repo', 'a/b'])).json).toMatchObject({ status: 'invalid' });
    expect((await run(['work', 'post', '--from', 'orion', '--job', 'RQ-X', '--title', 'x',
      '--repo', 'a/b', '--provider', 'local'])).json).toMatchObject({ status: 'posted' });
  });

  it('returns 1 for refusals and 2 for usage errors', async () => {
    expect(await run(['dm', '--to', 'nova', '--text', 'x'])).toMatchObject({ code: 2, json: { error: 'invalid-argument' } });
    expect(await run(['dm', '--from', 'ghost', '--to', 'nova', '--text', 'x'])).toMatchObject({ code: 1, json: { status: 'unknown-sender' } });
    expect(await run(['dm', '--from', 'a', '--to', 'b', '--text', 'x', '--wake', '--no-wake'])).toMatchObject({ code: 2 });
    expect(await run(['id', 'register', 'atlas', '--cli', 'gemini'])).toMatchObject({ code: 2 });
    expect(await run(['inbox', 'atlas', '--limit', '-1'])).toMatchObject({ code: 2 });
    expect(await run(['bogus'])).toMatchObject({ code: 2 });
    expect(await run(['id', 'list', 'extra'])).toMatchObject({ code: 2 });
  });

  it('is reachable from phm agents and listed in its help', async () => {
    const out: string[] = [];
    expect(await runAgentsCli(['--help'], t => out.push(t), () => {})).toBe(0);
    expect(out.join('\n')).toContain('ashlr agents bus dm --to <agent>');
    const routed: string[] = [];
    expect(await runAgentsCli(['bus', 'adapters', '--json'], t => routed.push(t), () => {})).toBe(0);
    expect(JSON.parse(routed[0]!).adapters).toHaveLength(5);
    // The pre-existing contract verb is untouched.
    const contract: string[] = [];
    expect(await runAgentsCli(['bus', 'contract', '--json'], t => contract.push(t), () => {})).toBe(0);
    expect(JSON.parse(contract[0]!).schemaVersion).toBe('agent-bus.v2');
  });
});
