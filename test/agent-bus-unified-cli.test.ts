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

  it('lists channels for discovery and filters by agent', async () => {
    // Before any registry exists the list is verified-empty, not an error.
    expect(await run(['channel', 'list'])).toMatchObject({ code: 0,
      json: { status: 'ok', source: 'missing', agent: null, channels: [] } });
    expect((await run(['id', 'register', 'atlas', '--cli', 'claude'])).json).toMatchObject({ status: 'created' });
    expect((await run(['id', 'register', 'nova'])).json).toMatchObject({ status: 'created' });
    expect((await run(['channel', 'create', 'zeta', '--from', 'atlas', '--member', 'nova'])).json).toMatchObject({ status: 'created' });
    expect((await run(['channel', 'create', 'alpha', '--from', 'nova'])).json).toMatchObject({ status: 'created' });
    const all = await run(['channel', 'list']);
    expect(all.code).toBe(0);
    expect(all.json).toMatchObject({ status: 'ok', source: 'available', agent: null });
    expect(all.json.channels.map((c: { name: string }) => c.name)).toEqual(['alpha', 'zeta']);
    expect(all.json.channels[1]).toMatchObject({ createdBy: 'atlas', members: ['atlas', 'nova'] });
    const mine = await run(['channel', 'list', '--agent', 'agent:atlas']);
    expect(mine.json).toMatchObject({ status: 'ok', agent: 'atlas' });
    expect(mine.json.channels.map((c: { name: string }) => c.name)).toEqual(['zeta']);
    expect(await run(['channel', 'list', '--agent', 'ghost'])).toMatchObject({ code: 1, json: { status: 'unknown-agent' } });
    expect(await run(['channel', 'list', 'extra'])).toMatchObject({ code: 2 });
    // Human output prints members, creator and the honest source footer.
    const text: string[] = [];
    expect(await runAgentsBusUnified(['channel', 'list', '--root', root], t => text.push(t), () => {}, {})).toBe(0);
    expect(text.join('\n')).toContain('#zeta  members=atlas,nova  createdBy=atlas');
    expect(text.join('\n')).toContain('channels=2 source=available');
  });

  it('reads a channel transcript with topic and sender filters', async () => {
    expect((await run(['id', 'register', 'atlas', '--cli', 'claude'])).json).toMatchObject({ status: 'created' });
    expect((await run(['id', 'register', 'nova', '--alias', 'lane-nova'])).json).toMatchObject({ status: 'created' });
    expect((await run(['channel', 'create', 'release', '--from', 'atlas', '--member', 'nova'])).json).toMatchObject({ status: 'created' });
    expect((await run(['channel', 'post', 'release', '--from', 'atlas', '--text', 'first', '--id', 'rd-1'])).json)
      .toMatchObject({ status: 'posted' });
    expect((await run(['channel', 'post', 'release', '--from', 'nova', '--topic', 'deploy', '--text', 'second', '--id', 'rd-2'])).json)
      .toMatchObject({ status: 'posted' });
    // Reading needs no identity: the transcript is the shared room history.
    const page = await run(['channel', 'read', 'release']);
    expect(page.code).toBe(0);
    expect(page.json).toMatchObject({ status: 'ok', channel: 'release' });
    expect(page.json.messages.map((m: { envelope: { id: string }; topic: string; fromAgent: string }) =>
      `${m.envelope.id}:${m.topic}:${m.fromAgent}`)).toEqual(['rd-1:general:atlas', 'rd-2:deploy:nova']);
    expect((await run(['channel', 'read', 'release', '--topic', 'deploy'])).json.messages
      .map((m: { envelope: { id: string } }) => m.envelope.id)).toEqual(['rd-2']);
    // --from resolves every label of one identity, aliases included.
    expect((await run(['channel', 'read', 'release', '--from', 'lane-nova'])).json.messages
      .map((m: { envelope: { id: string } }) => m.envelope.id)).toEqual(['rd-2']);
    expect(await run(['channel', 'read', 'missing'])).toMatchObject({ code: 1, json: { status: 'unknown-channel' } });
    expect(await run(['channel', 'read', 'release', 'extra'])).toMatchObject({ code: 2 });
    // Human output prints cursor, priority, topic, id and resolved sender.
    const text: string[] = [];
    expect(await runAgentsBusUnified(['channel', 'read', 'release', '--root', root], t => text.push(t), () => {}, {})).toBe(0);
    expect(text.join('\n')).toContain('#release:deploy rd-2 from nova');
    expect(text.join('\n')).toContain('nextCursor');
  });

  it('resolves one retained envelope by id without needing an identity', async () => {
    expect((await run(['id', 'register', 'atlas', '--cli', 'claude'])).json).toMatchObject({ status: 'created' });
    expect((await run(['id', 'register', 'nova'])).json).toMatchObject({ status: 'created' });
    expect((await run(['dm', '--from', 'atlas', '--to', 'nova', '--text', 'find me', '--id', 'show-1'])).json)
      .toMatchObject({ status: 'posted' });
    // The read needs no --from or PHM_AGENT_ID: the id alone resolves the row.
    const found = await run(['show', 'show-1']);
    expect(found.code).toBe(0);
    expect(found.json).toMatchObject({ status: 'ok', id: 'show-1',
      message: { fromAgent: 'atlas', envelope: { id: 'show-1', from: 'agent:atlas', to: 'agent:nova' } } });
    expect(await run(['show', 'show-404'])).toMatchObject({ code: 1, json: { status: 'not-found', id: 'show-404' } });
    expect(await run(['show', 'bad id'])).toMatchObject({ code: 1, json: { status: 'invalid' } });
    expect(await run(['show'])).toMatchObject({ code: 2 });
    expect(await run(['show', 'show-1', 'extra'])).toMatchObject({ code: 2 });
    // Human output prints cursor, priority, id, resolved sender, recipient and a body summary.
    const text: string[] = [];
    expect(await runAgentsBusUnified(['show', 'show-1', '--root', root], t => text.push(t), () => {}, {})).toBe(0);
    expect(text.join('\n')).toContain('show-1');
    expect(text.join('\n')).toContain('agent:nova');
    expect(text.join('\n')).toContain('find me');
  });

  it('filters inbox and channel reads by --thread', async () => {
    expect((await run(['id', 'register', 'atlas', '--cli', 'claude'])).json).toMatchObject({ status: 'created' });
    expect((await run(['id', 'register', 'nova'])).json).toMatchObject({ status: 'created' });
    expect((await run(['channel', 'create', 'release', '--from', 'atlas', '--member', 'nova'])).json)
      .toMatchObject({ status: 'created' });
    expect((await run(['dm', '--from', 'atlas', '--to', 'nova', '--text', 'q1', '--thread', 'rq-1', '--id', 't-dm-1'])).json)
      .toMatchObject({ status: 'posted' });
    expect((await run(['dm', '--from', 'atlas', '--to', 'nova', '--text', 'q2', '--thread', 'rq-2', '--id', 't-dm-2'])).json)
      .toMatchObject({ status: 'posted' });
    expect((await run(['dm', '--from', 'atlas', '--to', 'nova', '--text', 'plain', '--id', 't-dm-3'])).json)
      .toMatchObject({ status: 'posted' });
    expect((await run(['channel', 'post', 'release', '--from', 'atlas', '--text', 'c1', '--thread', 'rq-1', '--id', 't-ch-1'])).json)
      .toMatchObject({ status: 'posted' });
    expect((await run(['channel', 'post', 'release', '--from', 'atlas', '--text', 'c2', '--thread', 'rq-9', '--id', 't-ch-2'])).json)
      .toMatchObject({ status: 'posted' });

    const inbox = await run(['inbox', 'nova', '--thread', 'rq-1']);
    expect(inbox.code).toBe(0);
    expect(inbox.json.messages.map((m: { envelope: { id: string } }) => m.envelope.id)).toEqual(['t-dm-1', 't-ch-1']);
    const channel = await run(['channel', 'read', 'release', '--thread', 'rq-1']);
    expect(channel.json.messages.map((m: { envelope: { id: string } }) => m.envelope.id)).toEqual(['t-ch-1']);
    expect((await run(['channel', 'read', 'release', '--thread', 'rq-9'])).json.messages
      .map((m: { envelope: { id: string } }) => m.envelope.id)).toEqual(['t-ch-2']);
    // A thread label must be a printable v2 label; anything else fails closed.
    expect(await run(['inbox', 'nova', '--thread', 'has space'])).toMatchObject({ code: 1, json: { status: 'invalid' } });
    expect(await run(['channel', 'read', 'release', '--thread', ''])).toMatchObject({ code: 1, json: { status: 'invalid' } });
  });

  it('records repeatable --ref values as v2 note refs on dm and channel post', async () => {
    expect((await run(['id', 'register', 'atlas', '--cli', 'claude'])).json).toMatchObject({ status: 'created' });
    expect((await run(['id', 'register', 'nova'])).json).toMatchObject({ status: 'created' });
    expect((await run(['channel', 'create', 'release', '--from', 'atlas', '--member', 'nova'])).json)
      .toMatchObject({ status: 'created' });
    expect((await run(['dm', '--from', 'atlas', '--to', 'nova', '--text', 'see the fix',
      '--ref', 'RQ-CLI-REF', '--ref', 'pr:ashlrai/phantom#7310', '--id', 'ref-dm'])).json)
      .toMatchObject({ status: 'posted' });
    expect((await run(['channel', 'post', 'release', '--from', 'atlas', '--text', 'posted',
      '--ref', 'ashlrai/phantom#7311', '--id', 'ref-ch'])).json).toMatchObject({ status: 'posted' });
    const inbox = await run(['inbox', 'nova']);
    const refs = new Map(inbox.json.messages.map((m: { envelope: { id: string; body: { refs?: string[] } } }) =>
      [m.envelope.id, m.envelope.body.refs]));
    expect(refs.get('ref-dm')).toEqual(['RQ-CLI-REF', 'pr:ashlrai/phantom#7310']);
    expect(refs.get('ref-ch')).toEqual(['ashlrai/phantom#7311']);
    // Refs stay bounded by the v2 note contract: an empty ref refuses the send.
    expect(await run(['dm', '--from', 'atlas', '--to', 'nova', '--text', 'x', '--ref=']))
      .toMatchObject({ code: 1, json: { status: 'invalid' } });
  });

  it('sends v2 wake requests that land in the inbox and wakes', async () => {
    expect((await run(['id', 'register', 'atlas', '--cli', 'claude'])).json).toMatchObject({ status: 'created' });
    expect((await run(['id', 'register', 'nova'])).json).toMatchObject({ status: 'created' });
    expect((await run(['wake', '--from', 'atlas', '--to', 'nova', '--reason', 'feed moved',
      '--job', 'RQ-CLI-WK', '--id', 'cli-wk'])).json)
      .toMatchObject({ status: 'posted', to: 'agent:nova', wake: 'queued' });
    const inbox = await run(['inbox', 'nova']);
    expect(inbox.json.messages.map((m: { envelope: { id: string }; kind: string }) => `${m.envelope.id}:${m.kind}`))
      .toEqual(['cli-wk:dm']);
    const wakes = await run(['wakes', 'nova']);
    expect(wakes.json.wakes.map((w: { id: string; to: string }) => `${w.id}:${w.to}`)).toEqual(['cli-wk:agent:nova']);
    // The verb always records its hint: the wake flags are usage errors, and
    // unknown endpoints refuse like a DM.
    expect(await run(['wake', '--from', 'atlas', '--to', 'nova', '--reason', 'x', '--no-wake'])).toMatchObject({ code: 2 });
    expect(await run(['wake', '--from', 'atlas', '--to', 'nova', '--reason', 'x', '--wake'])).toMatchObject({ code: 2 });
    expect(await run(['wake', '--from', 'atlas', '--to', 'ghost', '--reason', 'x'])).toMatchObject({ code: 1, json: { status: 'unknown-recipient' } });
    expect(await run(['wake', '--from', 'atlas', '--to', 'nova'])).toMatchObject({ code: 2 });
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
      jobs: [{ id: 'RQ-FEED', status: 'running', owner: 'agent:atlas', to: 'leaders', provider: 'claude' }] });
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
      .toEqual([{ id: 'RQ-FEED', owner: 'agent:atlas', status: 'running', title: 'Read me' }]);
    // Without --jobs no feed join or feed state is reported.
    expect(claims.json.feed).toBeUndefined();
    expect(claims.json.claims[0].jobs).toBeUndefined();

    // Human output shares the fleet feed lines; reads need no identity.
    const text: string[] = [];
    expect(await runAgentsBusUnified(['work', 'feed', '--root', root], t => text.push(t), () => {}, {})).toBe(0);
    expect(text.join('\n')).toContain('RQ-FEED running "Read me" owner=agent:atlas to=leaders provider=claude repo=ashlrai/phantom keys=repo:ashlrai/phantom');
    expect(text.join('\n')).toContain('jobs=1 receipts=2 feed=ok');
    const claimText: string[] = [];
    expect(await runAgentsBusUnified(['claim', 'list', '--root', root], t => claimText.push(t), () => {}, {})).toBe(0);
    expect(claimText.join('\n')).toContain('repo:ashlrai/phantom owner=atlas origin=resource');
    expect(claimText.join('\n')).toContain('claims=1 source=available');
    const claimJobsText: string[] = [];
    expect(await runAgentsBusUnified(['claim', 'list', '--jobs', '--root', root], t => claimJobsText.push(t), () => {}, {})).toBe(0);
    expect(claimJobsText.join('\n')).toContain('jobs=RQ-FEED(running) "Read me"');
    expect(claimJobsText.join('\n')).toContain('feed=ok');
  });

  it('claims a work-feed job key in one step and joins it to the feed holds', async () => {
    expect((await run(['id', 'register', 'atlas', '--cli', 'claude'])).json).toMatchObject({ status: 'created' });
    expect((await run(['work', 'post', '--from', 'atlas', '--job', 'RQ-CLI-CLAIM', '--title', 'Claim me',
      '--repo', 'ashlrai/phantom', '--claim', 'queue:RQ-CLI-CLAIM', '--claim', 'repo:ashlrai/phantom',
      '--id', 'cli-wc'])).json).toMatchObject({ status: 'posted' });

    // The default resolves the declared queue:<jobId> key; --owner defaults to PHM_AGENT_ID.
    const claimed = await run(['work', 'claim', '--job', 'RQ-CLI-CLAIM', '--lease-ms', '600000',
      '--owner', 'worker-1', '--id', 'cli-wc-1']);
    expect(claimed.code).toBe(0);
    expect(claimed.json).toMatchObject({ status: 'acquired',
      job: { id: 'RQ-CLI-CLAIM', owner: 'agent:atlas', status: 'queued', repo: 'ashlrai/phantom' },
      claim: { claimKey: 'queue:RQ-CLI-CLAIM', owner: 'worker-1', leaseMs: 600000 } });
    expect(claimed.json.claim.token).toMatch(/^[a-f0-9]{64}$/);
    // The new hold joins the job on the feed read, owner label and all.
    const feed = await run(['work', 'feed', '--claims']);
    expect(feed.json.claims.holds).toEqual([expect.objectContaining({ jobId: 'RQ-CLI-CLAIM',
      claimKey: 'queue:RQ-CLI-CLAIM', owner: 'worker-1' })]);

    // A second owner conflicts on the same key; --key picks another declared key.
    const conflict = await run(['work', 'claim', '--job', 'RQ-CLI-CLAIM', '--lease-ms', '600000', '--owner', 'worker-2']);
    expect(conflict.code).toBe(1);
    expect(conflict.json).toMatchObject({ status: 'conflict',
      holder: { owner: 'worker-1', claimKey: 'queue:RQ-CLI-CLAIM' } });
    expect(JSON.stringify(conflict.json)).not.toContain(claimed.json.claim.token);
    const other = await run(['work', 'claim', '--job', 'RQ-CLI-CLAIM', '--key', 'repo:ashlrai/phantom',
      '--lease-ms', '600000', '--owner', 'worker-2']);
    expect(other.json).toMatchObject({ status: 'acquired', claim: { claimKey: 'repo:ashlrai/phantom', owner: 'worker-2' } });

    // Undeclared keys and unknown jobs refuse honestly; usage errors exit 2.
    expect(await run(['work', 'claim', '--job', 'RQ-CLI-CLAIM', '--key', 'queue:OTHER',
      '--lease-ms', '600000', '--owner', 'w'])).toMatchObject({ code: 1,
      json: { status: 'refused', reason: 'undeclared-key' } });
    expect(await run(['work', 'claim', '--job', 'RQ-GONE', '--lease-ms', '600000', '--owner', 'w']))
      .toMatchObject({ code: 2, json: { status: 'invalid', reason: 'unknown-job' } });
    expect(await run(['work', 'claim', '--job', 'RQ-CLI-CLAIM'])).toMatchObject({ code: 2 });
    expect(await run(['work', 'claim', '--job', 'RQ-CLI-CLAIM', '--lease-ms', '600000',
      '--key', 'bogus', '--owner', 'w'])).toMatchObject({ code: 2 });

    // Human output names the job and shows the token only to the acquirer.
    const text: string[] = [];
    expect(await runAgentsBusUnified(['work', 'claim', '--job', 'RQ-CLI-CLAIM', '--key', 'repo:ashlrai/phantom',
      '--lease-ms', '600000', '--owner', 'worker-3', '--root', root], t => text.push(t), () => {}, {})).toBe(1);
    expect(text.join('\n')).toContain('conflict repo:ashlrai/phantom');
    expect(text.join('\n')).toContain('RQ-CLI-CLAIM(queued)');
  });

  it('filters the work feed by announcement address under one agent identity', async () => {
    expect((await run(['id', 'register', 'atlas', '--cli', 'claude'])).json).toMatchObject({ status: 'created' });
    expect((await run(['id', 'register', 'nova'])).json).toMatchObject({ status: 'created' });
    expect((await run(['work', 'post', '--from', 'atlas', '--job', 'RQ-SINK', '--title', 'Fleet job',
      '--repo', 'ashlrai/phantom', '--provider', 'claude', '--id', 'feed-sink'])).json)
      .toMatchObject({ status: 'posted', to: 'leaders' });
    expect((await run(['work', 'post', '--from', 'atlas', '--job', 'RQ-DIRECT', '--title', 'Directed job',
      '--repo', 'ashlrai/phantom', '--provider', 'claude', '--to', 'agent:nova', '--id', 'feed-direct'])).json)
      .toMatchObject({ status: 'posted', to: 'agent:nova' });

    // The unfiltered feed shows both jobs with their announcement addresses.
    const all = (await run(['work', 'feed'])).json.jobs as Array<{ id: string; to: string }>;
    expect(all).toHaveLength(2);
    expect(all.find(job => job.id === 'RQ-SINK')).toMatchObject({ to: 'leaders' });
    expect(all.find(job => job.id === 'RQ-DIRECT')).toMatchObject({ to: 'agent:nova' });
    // --to matches the literal label and every label of one identity.
    for (const ref of ['agent:nova', 'nova']) {
      expect((await run(['work', 'feed', '--to', ref])).json.jobs)
        .toEqual([expect.objectContaining({ id: 'RQ-DIRECT', to: 'agent:nova' })]);
    }
    expect((await run(['work', 'feed', '--to', 'leaders'])).json.jobs)
      .toEqual([expect.objectContaining({ id: 'RQ-SINK', to: 'leaders' })]);
    expect((await run(['work', 'feed', '--to', 'ghost'])).json.jobs).toEqual([]);
    // Status and address filters compose; holds still regroup under shown jobs.
    expect((await run(['work', 'feed', '--to', 'nova', '--status', 'done'])).json.jobs).toEqual([]);
    expect(await run(['work', 'feed', '--to', 'bad label'])).toMatchObject({ code: 2 });
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
