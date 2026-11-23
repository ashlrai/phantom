import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runAgentsCli } from '../src/cli/agents-bus-contract.js';
import { runAgentsBusUnified } from '../src/cli/agents-bus-unified.js';
import * as seats from '../src/core/bots/seats.js';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';
import type { BusEnvelope } from '../src/core/fleet/bus-envelope.js';

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
    expect(wakes.json).toMatchObject({ matched: 2, truncated: false });
    expect(wakes.json.wakes.map((w: { id: string }) => w.id)).toEqual(['cli-dm', 'cli-ho']);
    // --job keeps only the hint whose referent names the job: the handoff's
    // taskId cites RQ-CLI-1, the plain DM names none.
    const jobWakes = await run(['wakes', 'nova', '--job', 'RQ-CLI-1']);
    expect(jobWakes.json).toMatchObject({ matched: 1, truncated: false });
    expect(jobWakes.json.wakes.map((w: { id: string }) => w.id)).toEqual(['cli-ho']);
    expect((await run(['wakes', 'nova', '--job', 'RQ-ABSENT'])).json)
      .toMatchObject({ matched: 0, wakes: [] });
    expect(await run(['wakes', 'nova', '--job', 'has space'])).toMatchObject({ code: 1, json: { status: 'invalid' } });
    const adapters = await run(['adapters']);
    expect(adapters.json.adapters.map((a: { cli: string }) => a.cli)).toEqual(['claude', 'codex', 'devin', 'cursor', 'grok']);
  });

  it('resolves one agent ref through id show — self, aliases and honest misses', async () => {
    expect((await run(['id', 'register', 'atlas', '--cli', 'claude', '--alias', 'lane-atlas', '--display', 'Atlas One'])).json)
      .toMatchObject({ status: 'created' });
    expect((await run(['id', 'register', 'nova'])).json).toMatchObject({ status: 'created' });
    expect((await run(['channel', 'create', 'ops', '--from', 'atlas', '--member', 'nova'])).json).toMatchObject({ status: 'created' });

    // Self view: PHM_AGENT_ID resolves to the card, the detected CLI rides along.
    const self = await run(['id', 'show'], { PHM_AGENT_ID: 'atlas', CLAUDECODE: '1' });
    expect(self.code).toBe(0);
    expect(self.json).toMatchObject({ status: 'ok', ref: 'atlas', self: true, address: 'agent:atlas', cli: 'claude',
      channels: ['ops'], identity: { handle: 'atlas', aliases: ['lane-atlas'], displayName: 'Atlas One' } });
    // Explicit refs resolve handle, alias and agent: address — self stays false and no cli is reported.
    for (const ref of ['atlas', 'lane-atlas', 'agent:atlas']) {
      const view = await run(['id', 'show', ref]);
      expect(view.code).toBe(0);
      expect(view.json).toMatchObject({ status: 'ok', ref, self: false, address: 'agent:atlas', channels: ['ops'],
        identity: { handle: 'atlas' } });
      expect(view.json).not.toHaveProperty('cli');
    }
    const stable = (await run(['id', 'list'])).json.identities.find((i: { handle: string }) => i.handle === 'atlas').id;
    expect((await run(['id', 'show', stable])).json).toMatchObject({ status: 'ok', self: false, identity: { id: stable } });
    // Honest misses: unset env, unregistered self and ref, malformed ref.
    expect(await run(['id', 'show'])).toMatchObject({ code: 1, json: { status: 'unset' } });
    expect(await run(['id', 'show'], { PHM_AGENT_ID: 'ghost' }))
      .toMatchObject({ code: 1, json: { status: 'unknown', self: true } });
    expect(await run(['id', 'show', 'ghost'])).toMatchObject({ code: 1, json: { status: 'unknown', self: false } });
    expect(await run(['id', 'show', 'has space'])).toMatchObject({ code: 1, json: { status: 'invalid' } });
    // Human output prints the same card without --json.
    const humanOut: string[] = [];
    const human = await runAgentsBusUnified(['id', 'show', 'atlas', '--root', root], t => humanOut.push(t), () => {});
    expect(human).toBe(0);
    const card = humanOut.join('\n');
    expect(card).toContain('atlas agt_');
    expect(card).toContain('agent:atlas');
    expect(card).toContain('channels=ops');
    expect(card).toContain('aliases=lane-atlas');
  });

  it('stamps --reply-to as the v2 inReplyTo citation on dm, post and channel post', async () => {
    expect((await run(['id', 'register', 'atlas'])).json).toMatchObject({ status: 'created' });
    expect((await run(['id', 'register', 'nova'])).json).toMatchObject({ status: 'created' });
    expect((await run(['dm', '--from', 'nova', '--to', 'atlas', '--text', 'question', '--id', 'rq-1'])).json)
      .toMatchObject({ status: 'posted' });
    expect((await run(['dm', '--from', 'atlas', '--to', 'nova', '--text', 'answer', '--reply-to', 'rq-1', '--id', 'rs-dm'])).json)
      .toMatchObject({ status: 'posted' });
    expect((await run(['channel', 'create', 'ops', '--from', 'atlas', '--member', 'nova'])).json).toMatchObject({ status: 'created' });
    expect((await run(['channel', 'post', 'ops', '--from', 'nova', '--text', 'channel answer', '--reply-to', 'rq-1', '--id', 'rs-ch'])).json)
      .toMatchObject({ status: 'posted' });
    expect((await run(['post', '--from', 'atlas', '--to', 'fleet.mesh', '--kind', 'context', '--text', '{}', '--reply-to', 'rq-1', '--id', 'rs-lp'])).json)
      .toMatchObject({ status: 'posted' });
    for (const id of ['rs-dm', 'rs-ch', 'rs-lp']) {
      const shown = await run(['show', id]);
      expect(shown.json).toMatchObject({ status: 'ok', message: { envelope: { body: { inReplyTo: 'rq-1' } } } });
    }
    // A target that is not a printable message id refuses like any invalid
    // send; the duplicate flag form is a usage error like every value flag.
    expect((await run(['dm', '--from', 'atlas', '--to', 'nova', '--text', 'x', '--reply-to', 'has space', '--id', 'rs-bad'])).code).toBe(1);
    expect((await run(['dm', '--from', 'atlas', '--to', 'nova', '--text', 'x', '--reply-to', 'a', '--reply-to', 'b'])).code).toBe(2);
  });

  it('filters wakes by sender identity', async () => {
    expect((await run(['id', 'register', 'atlas', '--alias', 'lane-atlas'])).json).toMatchObject({ status: 'created' });
    expect((await run(['id', 'register', 'nova'])).json).toMatchObject({ status: 'created' });
    expect((await run(['id', 'register', 'orion'])).json).toMatchObject({ status: 'created' });
    expect((await run(['dm', '--from', 'atlas', '--to', 'nova', '--text', 'a', '--priority', 'P0', '--id', 'wf-atlas'])).json)
      .toMatchObject({ status: 'posted', wake: 'queued' });
    expect((await run(['dm', '--from', 'orion', '--to', 'nova', '--text', 'b', '--priority', 'P0', '--id', 'wf-orion'])).json)
      .toMatchObject({ status: 'posted', wake: 'queued' });

    expect((await run(['wakes', 'nova'])).json).toMatchObject({ matched: 2 });
    // Handle, alias and agent: address all name the same sender identity.
    for (const from of ['atlas', 'lane-atlas', 'agent:atlas']) {
      const page = await run(['wakes', 'nova', '--from', from]);
      expect(page.json).toMatchObject({ matched: 1, truncated: false });
      expect(page.json.wakes.map((w: { id: string }) => w.id)).toEqual(['wf-atlas']);
    }
    expect((await run(['wakes', 'nova', '--from', 'orion'])).json.wakes.map((w: { id: string }) => w.id))
      .toEqual(['wf-orion']);
    // An unresolvable sender keeps exact-label matching — nothing widens.
    expect((await run(['wakes', 'nova', '--from', 'ghost'])).json)
      .toMatchObject({ matched: 0, wakes: [] });
    expect(await run(['wakes', 'nova', '--from='])).toMatchObject({ code: 1, json: { status: 'invalid' } });

    // --exclude-from drops one sender's hints under every label of its
    // identity; a sender both included and excluded matches nothing.
    expect((await run(['wakes', 'nova'])).json).toMatchObject({ matched: 2 });
    for (const excludeFrom of ['atlas', 'lane-atlas', 'agent:atlas']) {
      const page = await run(['wakes', 'nova', '--exclude-from', excludeFrom]);
      expect(page.json).toMatchObject({ matched: 1, truncated: false });
      expect(page.json.wakes.map((w: { id: string }) => w.id)).toEqual(['wf-orion']);
    }
    expect((await run(['wakes', 'nova', '--exclude-from', 'ghost'])).json)
      .toMatchObject({ matched: 2 });
    expect((await run(['wakes', 'nova', '--from', 'atlas', '--exclude-from', 'atlas'])).json)
      .toMatchObject({ matched: 0, wakes: [] });
    expect((await run(['wakes', 'nova', '--from', 'atlas', '--exclude-from', 'orion'])).json.wakes
      .map((w: { id: string }) => w.id)).toEqual(['wf-atlas']);
    expect(await run(['wakes', 'nova', '--exclude-from='])).toMatchObject({ code: 1, json: { status: 'invalid' } });
  });

  it('reads every wake hint fleet-wide with --all', async () => {
    expect((await run(['id', 'register', 'atlas'])).json).toMatchObject({ status: 'created' });
    expect((await run(['id', 'register', 'nova'])).json).toMatchObject({ status: 'created' });
    expect((await run(['id', 'register', 'orion'])).json).toMatchObject({ status: 'created' });
    expect((await run(['dm', '--from', 'atlas', '--to', 'nova', '--text', 'a', '--priority', 'P0', '--id', 'wa-nova'])).json)
      .toMatchObject({ status: 'posted', wake: 'queued' });
    expect((await run(['dm', '--from', 'orion', '--to', 'nova', '--text', 'b', '--priority', 'P0', '--id', 'wa-nova-2'])).json)
      .toMatchObject({ status: 'posted', wake: 'queued' });
    expect((await run(['dm', '--from', 'atlas', '--to', 'orion', '--text', 'c', '--priority', 'P0', '--id', 'wa-orion'])).json)
      .toMatchObject({ status: 'posted', wake: 'queued' });
    // A hint under a bare label no identity owns — the fleet page carries it
    // beside the registered addressees' hints in one read.
    expect((await run(['post', '--from', 'atlas', '--to', 'fleet.mesh', '--text', 'ping',
      '--priority', 'P1', '--id', 'wa-mesh'])).json).toMatchObject({ status: 'posted', wake: 'queued' });

    const all = await run(['wakes', '--all']);
    expect(all.json).toMatchObject({ status: 'ok', scope: 'fleet', matched: 4, truncated: false });
    expect(all.json.wakes.map((w: { id: string }) => w.id)).toEqual(['wa-nova', 'wa-nova-2', 'wa-orion', 'wa-mesh']);
    expect(all.json.wakes.map((w: { to: string }) => w.to)).toEqual(['agent:nova', 'agent:nova', 'agent:orion', 'fleet.mesh']);
    // The shared filters scope the fleet page the same way the per-agent read.
    expect((await run(['wakes', '--all', '--from', 'atlas'])).json.wakes
      .map((w: { id: string }) => w.id)).toEqual(['wa-nova', 'wa-orion', 'wa-mesh']);
    expect((await run(['wakes', '--all', '--exclude-from', 'atlas'])).json.wakes
      .map((w: { id: string }) => w.id)).toEqual(['wa-nova-2']);
    expect((await run(['wakes', '--all', '--priority', 'P0'])).json.wakes
      .map((w: { id: string }) => w.id)).toEqual(['wa-nova', 'wa-nova-2', 'wa-orion']);
    expect((await run(['wakes', '--all', '--job', 'RQ-ABSENT'])).json)
      .toMatchObject({ matched: 0, wakes: [] });
    // --all takes no agent operand; the per-agent read is unchanged.
    expect(await run(['wakes', '--all', 'nova'])).toMatchObject({ code: 2 });
    expect(await run(['wakes', '--all', '--from='])).toMatchObject({ code: 1, json: { status: 'invalid' } });
    expect((await run(['wakes', 'nova'])).json).toMatchObject({ matched: 2 });
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

  it('annotates work envelope lookups with the live feed job', async () => {
    expect((await run(['id', 'register', 'atlas', '--cli', 'claude'])).json).toMatchObject({ status: 'created' });
    expect((await run(['work', 'post', '--job', 'RQ-CLI-SHOW', '--title', 'CLI job', '--repo', 'ashlrai/phantom',
      '--claim', 'queue:RQ-CLI-SHOW', '--id', 'cli-wpost'], { PHM_AGENT_ID: 'atlas' })).json)
      .toMatchObject({ status: 'posted' });
    // The post citation resolves the job's live state — status and claim
    // coverage — without a second work feed read.
    const shown = await run(['show', 'cli-wpost']);
    expect(shown.code).toBe(0);
    expect(shown.json.job).toMatchObject({ jobId: 'RQ-CLI-SHOW', feed: 'ok',
      job: { id: 'RQ-CLI-SHOW', status: 'queued', claimable: true, postId: 'cli-wpost', statusId: null } });
    // Human output prints the same feed line the feed list renders.
    const text: string[] = [];
    expect(await runAgentsBusUnified(['show', 'cli-wpost', '--root', root], t => text.push(t), () => {}, {})).toBe(0);
    expect(text.join('\n')).toContain('RQ-CLI-SHOW');
    expect(text.join('\n')).toContain('claimable=yes');
    expect(text.join('\n')).toContain('post=cli-wpost');
    expect((await run(['work', 'status', '--job', 'RQ-CLI-SHOW', '--status', 'running', '--id', 'cli-wst'],
      { PHM_AGENT_ID: 'atlas' })).json).toMatchObject({ status: 'posted' });
    expect((await run(['show', 'cli-wst'])).json.job)
      .toMatchObject({ feed: 'ok', job: { status: 'running', statusId: 'cli-wst', postId: 'cli-wpost' } });
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

  it('filters inbox and channel reads by --priority', async () => {
    expect((await run(['id', 'register', 'atlas'])).json).toMatchObject({ status: 'created' });
    expect((await run(['id', 'register', 'nova'])).json).toMatchObject({ status: 'created' });
    expect((await run(['channel', 'create', 'release', '--from', 'atlas', '--member', 'nova'])).json)
      .toMatchObject({ status: 'created' });
    expect((await run(['dm', '--from', 'atlas', '--to', 'nova', '--text', 'urgent', '--priority', 'P0', '--id', 'p-dm'])).json)
      .toMatchObject({ status: 'posted' });
    expect((await run(['dm', '--from', 'atlas', '--to', 'nova', '--text', 'routine', '--priority', 'P2', '--id', 'p-dm2'])).json)
      .toMatchObject({ status: 'posted' });
    expect((await run(['channel', 'post', 'release', '--from', 'atlas', '--text', 'heads up', '--priority', 'P1', '--id', 'p-ch'])).json)
      .toMatchObject({ status: 'posted' });

    const urgent = await run(['inbox', 'nova', '--priority', 'P0']);
    expect(urgent.code).toBe(0);
    expect(urgent.json.messages.map((m: { envelope: { id: string } }) => m.envelope.id)).toEqual(['p-dm']);
    const channel = await run(['channel', 'read', 'release', '--priority', 'P1']);
    expect(channel.json.messages.map((m: { envelope: { id: string } }) => m.envelope.id)).toEqual(['p-ch']);
    // --matched counts only the band the same filters accept.
    const counted = await run(['inbox', 'nova', '--priority', 'P2', '--matched']);
    expect(counted.json.matched).toBe(1);
    expect(counted.json.messages.map((m: { envelope: { id: string } }) => m.envelope.id)).toEqual(['p-dm2']);
    // A band outside P0..P3 is a usage error on both reads.
    expect(await run(['inbox', 'nova', '--priority', 'P9'])).toMatchObject({ code: 2 });
    expect(await run(['channel', 'read', 'release', '--priority', 'high'])).toMatchObject({ code: 2 });
  });

  it('filters inbox, channel read and wakes by --since', async () => {
    expect((await run(['id', 'register', 'atlas'])).json).toMatchObject({ status: 'created' });
    expect((await run(['id', 'register', 'nova'])).json).toMatchObject({ status: 'created' });
    expect((await run(['channel', 'create', 'release', '--from', 'atlas', '--member', 'nova'])).json)
      .toMatchObject({ status: 'created' });
    // A P0 DM always queues a wake hint alongside the mail.
    expect((await run(['dm', '--from', 'atlas', '--to', 'nova', '--text', 'fresh', '--priority', 'P0', '--id', 's-dm'])).json)
      .toMatchObject({ status: 'posted', wake: 'queued' });
    expect((await run(['channel', 'post', 'release', '--from', 'atlas', '--text', 'room', '--id', 's-ch'])).json)
      .toMatchObject({ status: 'posted' });

    // The phm messages grammar resolves: a recent window keeps the fresh
    // rows, a cutoff in the future keeps none, epoch ms still works.
    const inbox = await run(['inbox', 'nova', '--since', '15m']);
    expect(inbox.code).toBe(0);
    expect(inbox.json.messages.map((m: { envelope: { id: string } }) => m.envelope.id).sort())
      .toEqual(['s-ch', 's-dm']);
    const channel = await run(['channel', 'read', 'release', '--since', '1h']);
    expect(channel.json.messages.map((m: { envelope: { id: string } }) => m.envelope.id)).toEqual(['s-ch']);
    const future = String(Date.now() + 3_600_000);
    expect((await run(['inbox', 'nova', '--since', future])).json).toMatchObject({ status: 'ok', messages: [] });
    expect((await run(['channel', 'read', 'release', '--since', future])).json).toMatchObject({ status: 'ok', messages: [] });
    expect((await run(['inbox', 'nova', '--since', '0'])).json.messages.length).toBe(2);

    // wakes takes the same grammar now: the queued hint is inside 15m and
    // outside a future cutoff.
    const wakes = await run(['wakes', 'nova', '--since', '15m']);
    expect(wakes.code).toBe(0);
    expect(wakes.json.wakes.length).toBeGreaterThan(0);
    expect((await run(['wakes', 'nova', '--since', future])).json.wakes).toEqual([]);

    // Anything outside the grammar is a usage error on every read.
    expect(await run(['inbox', 'nova', '--since', 'bogus'])).toMatchObject({ code: 2 });
    expect(await run(['channel', 'read', 'release', '--since', 'bogus'])).toMatchObject({ code: 2 });
    expect(await run(['wakes', 'nova', '--since', 'bogus'])).toMatchObject({ code: 2 });
  });

  it('filters inbox and channel reads by --contains', async () => {
    expect((await run(['id', 'register', 'atlas'])).json).toMatchObject({ status: 'created' });
    expect((await run(['id', 'register', 'nova'])).json).toMatchObject({ status: 'created' });
    expect((await run(['channel', 'create', 'release', '--from', 'atlas', '--member', 'nova'])).json)
      .toMatchObject({ status: 'created' });
    expect((await run(['dm', '--from', 'atlas', '--to', 'nova', '--text', 'review the RQ-88 rollout', '--id', 'c-dm'])).json)
      .toMatchObject({ status: 'posted' });
    expect((await run(['dm', '--from', 'atlas', '--to', 'nova', '--text', 'lunch plans', '--id', 'c-dm2'])).json)
      .toMatchObject({ status: 'posted' });
    expect((await run(['channel', 'post', 'release', '--from', 'atlas', '--text', 'deploy window RQ-88', '--id', 'c-ch'])).json)
      .toMatchObject({ status: 'posted' });

    // Case-insensitive substring over the scrubbed summary on both reads.
    const inbox = await run(['inbox', 'nova', '--contains', 'rq-88']);
    expect(inbox.code).toBe(0);
    expect(inbox.json.messages.map((m: { envelope: { id: string } }) => m.envelope.id).sort())
      .toEqual(['c-ch', 'c-dm']);
    const channel = await run(['channel', 'read', 'release', '--contains', 'RQ-88']);
    expect(channel.json.messages.map((m: { envelope: { id: string } }) => m.envelope.id)).toEqual(['c-ch']);
    // It composes with the other filters and --matched counts accepted rows.
    const counted = await run(['inbox', 'nova', '--contains', 'rq-88', '--matched']);
    expect(counted.json.matched).toBe(2);
    expect((await run(['inbox', 'nova', '--contains', 'rq-88', '--kind', 'dm'])).json.messages
      .map((m: { envelope: { id: string } }) => m.envelope.id)).toEqual(['c-dm']);
    // A blank or oversized needle fails closed on both reads.
    expect(await run(['inbox', 'nova', '--contains='])).toMatchObject({ code: 1, json: { status: 'invalid' } });
    expect(await run(['channel', 'read', 'release', '--contains', '   '])).toMatchObject({ code: 1, json: { status: 'invalid' } });
  });

  it('filters inbox and channel reads by --exclude-from', async () => {
    expect((await run(['id', 'register', 'atlas'])).json).toMatchObject({ status: 'created' });
    expect((await run(['id', 'register', 'nova'])).json).toMatchObject({ status: 'created' });
    expect((await run(['id', 'register', 'relay', '--alias', 'lane-relay'])).json).toMatchObject({ status: 'created' });
    expect((await run(['channel', 'create', 'release', '--from', 'atlas', '--member', 'nova', '--member', 'relay'])).json)
      .toMatchObject({ status: 'created' });
    expect((await run(['dm', '--from', 'atlas', '--to', 'nova', '--text', 'atlas dm', '--id', 'x-dm-a'])).json)
      .toMatchObject({ status: 'posted' });
    expect((await run(['dm', '--from', 'relay', '--to', 'nova', '--text', 'relay dm', '--id', 'x-dm-r'])).json)
      .toMatchObject({ status: 'posted' });
    expect((await run(['channel', 'post', 'release', '--from', 'atlas', '--text', 'atlas post', '--id', 'x-ch-a'])).json)
      .toMatchObject({ status: 'posted' });
    expect((await run(['channel', 'post', 'release', '--from', 'relay', '--text', 'relay post', '--id', 'x-ch-r'])).json)
      .toMatchObject({ status: 'posted' });

    // Every spelling of the excluded identity drops its mail on both reads.
    for (const ref of ['relay', 'lane-relay', 'agent:relay']) {
      const inbox = await run(['inbox', 'nova', '--exclude-from', ref]);
      expect(inbox.code).toBe(0);
      expect(inbox.json.messages.map((m: { envelope: { id: string } }) => m.envelope.id).sort())
        .toEqual(['x-ch-a', 'x-dm-a']);
      const channel = await run(['channel', 'read', 'release', '--exclude-from', ref]);
      expect(channel.json.messages.map((m: { envelope: { id: string } }) => m.envelope.id))
        .toEqual(['x-ch-a']);
    }
    // It composes with --from: a sender both included and excluded matches nothing.
    expect((await run(['inbox', 'nova', '--from', 'relay', '--exclude-from', 'relay'])).json.messages).toEqual([]);
    expect((await run(['channel', 'read', 'release', '--from', 'relay', '--exclude-from', 'relay'])).json.messages)
      .toEqual([]);
    // --matched counts only the accepted rows; a blank value fails closed.
    expect((await run(['inbox', 'nova', '--exclude-from', 'relay', '--matched'])).json.matched).toBe(2);
    expect(await run(['inbox', 'nova', '--exclude-from='])).toMatchObject({ code: 1, json: { status: 'invalid' } });
    expect(await run(['channel', 'read', 'release', '--exclude-from', ''])).toMatchObject({ code: 1, json: { status: 'invalid' } });
  });

  it('filters inbox reads by --kind', async () => {
    expect((await run(['id', 'register', 'atlas'])).json).toMatchObject({ status: 'created' });
    expect((await run(['id', 'register', 'nova'])).json).toMatchObject({ status: 'created' });
    expect((await run(['channel', 'create', 'release', '--from', 'atlas', '--member', 'nova'])).json)
      .toMatchObject({ status: 'created' });
    expect((await run(['dm', '--from', 'atlas', '--to', 'nova', '--text', 'dm', '--id', 'k-dm'])).json)
      .toMatchObject({ status: 'posted' });
    expect((await run(['channel', 'post', 'release', '--from', 'atlas', '--text', 'post', '--id', 'k-ch'])).json)
      .toMatchObject({ status: 'posted' });
    expect((await run(['handoff', '--from', 'atlas', '--to', 'nova', '--task', 'RQ-K-1', '--prompt', 'take over', '--id', 'k-ho'])).json)
      .toMatchObject({ status: 'posted' });
    // A post to the bare handle is legacy traffic in the agent's inbox.
    expect((await run(['post', '--from', 'atlas', '--to', 'nova', '--text', 'legacy', '--id', 'k-leg'])).json)
      .toMatchObject({ status: 'posted' });

    const dms = await run(['inbox', 'nova', '--kind', 'dm']);
    expect(dms.code).toBe(0);
    expect(dms.json.messages.map((m: { envelope: { id: string }; kind: string }) => `${m.envelope.id}:${m.kind}`))
      .toEqual(['k-dm:dm']);
    expect((await run(['inbox', 'nova', '--kind', 'channel'])).json.messages
      .map((m: { envelope: { id: string } }) => m.envelope.id)).toEqual(['k-ch']);
    expect((await run(['inbox', 'nova', '--kind', 'handoff'])).json.messages
      .map((m: { envelope: { id: string } }) => m.envelope.id)).toEqual(['k-ho']);
    expect((await run(['inbox', 'nova', '--kind', 'legacy'])).json.messages
      .map((m: { envelope: { id: string } }) => m.envelope.id)).toEqual(['k-leg']);
    // --kind composes with --matched: the count honors the same filter.
    const counted = await run(['inbox', 'nova', '--kind', 'dm', '--matched']);
    expect(counted.json.matched).toBe(1);
    // A kind outside the delivery enum is a usage error; a v2 body kind is not
    // an inbox kind.
    expect(await run(['inbox', 'nova', '--kind', 'bogus'])).toMatchObject({ code: 2 });
    expect(await run(['inbox', 'nova', '--kind', 'note'])).toMatchObject({ code: 2 });
  });

  it('filters inbox reads by --channel', async () => {
    expect((await run(['id', 'register', 'atlas'])).json).toMatchObject({ status: 'created' });
    expect((await run(['id', 'register', 'nova'])).json).toMatchObject({ status: 'created' });
    expect((await run(['channel', 'create', 'release', '--from', 'atlas', '--member', 'nova'])).json)
      .toMatchObject({ status: 'created' });
    expect((await run(['channel', 'create', 'ops', '--from', 'atlas', '--member', 'nova'])).json)
      .toMatchObject({ status: 'created' });
    expect((await run(['dm', '--from', 'atlas', '--to', 'nova', '--text', 'dm', '--id', 'ch-dm'])).json)
      .toMatchObject({ status: 'posted' });
    expect((await run(['channel', 'post', 'release', '--from', 'atlas', '--text', 'release post', '--id', 'ch-rel'])).json)
      .toMatchObject({ status: 'posted' });
    expect((await run(['channel', 'post', 'ops', '--from', 'atlas', '--text', 'ops post', '--id', 'ch-ops'])).json)
      .toMatchObject({ status: 'posted' });

    const release = await run(['inbox', 'nova', '--channel', 'release']);
    expect(release.code).toBe(0);
    expect(release.json.messages.map((m: { envelope: { id: string } }) => m.envelope.id)).toEqual(['ch-rel']);
    expect((await run(['inbox', 'nova', '--channel', 'ops'])).json.messages
      .map((m: { envelope: { id: string } }) => m.envelope.id)).toEqual(['ch-ops']);
    // --channel composes with --kind and --matched: the count honors the filter.
    expect((await run(['inbox', 'nova', '--channel', 'release', '--kind', 'channel'])).json.messages).toHaveLength(1);
    const counted = await run(['inbox', 'nova', '--channel', 'release', '--matched']);
    expect(counted.json.matched).toBe(1);
    // A name outside the channel grammar is invalid; a well-formed name with
    // no mail addressed through it reads ok-empty, never an error.
    expect(await run(['inbox', 'nova', '--channel', 'Bad'])).toMatchObject({ code: 1, json: { status: 'invalid' } });
    expect((await run(['inbox', 'nova', '--channel', 'missing'])).json).toMatchObject({ status: 'ok', messages: [] });
  });

  it('filters inbox reads by --job across feed citations and job-threaded mail', async () => {
    expect((await run(['id', 'register', 'atlas', '--cli', 'claude'])).json).toMatchObject({ status: 'created' });
    expect((await run(['id', 'register', 'nova'])).json).toMatchObject({ status: 'created' });
    expect((await run(['work', 'post', '--from', 'atlas', '--job', 'RQ-CLI-JF', '--title', 'Job filter',
      '--repo', 'a/b', '--claim', 'queue:RQ-CLI-JF', '--to', 'agent:nova', '--id', 'jf-post'])).json)
      .toMatchObject({ status: 'posted' });
    expect((await run(['work', 'status', '--from', 'atlas', '--job', 'RQ-CLI-JF', '--status', 'running',
      '--to', 'agent:nova', '--id', 'jf-st'])).json).toMatchObject({ status: 'posted' });
    // A note threaded job:<id> is the job's conversation bucket; a bare-id
    // thread and unrelated mail name different conversations.
    expect((await run(['dm', '--from', 'atlas', '--to', 'nova', '--text', 'job note',
      '--thread', 'job:RQ-CLI-JF', '--id', 'jf-note'])).json).toMatchObject({ status: 'posted' });
    expect((await run(['dm', '--from', 'atlas', '--to', 'nova', '--text', 'other job',
      '--thread', 'job:RQ-CLI-OTHER', '--id', 'jf-other'])).json).toMatchObject({ status: 'posted' });
    expect((await run(['dm', '--from', 'atlas', '--to', 'nova', '--text', 'plain', '--id', 'jf-plain'])).json)
      .toMatchObject({ status: 'posted' });

    const page = await run(['inbox', 'nova', '--job', 'RQ-CLI-JF']);
    expect(page.code).toBe(0);
    expect(page.json.messages.map((m: { envelope: { id: string } }) => m.envelope.id).sort())
      .toEqual(['jf-note', 'jf-post', 'jf-st']);
    // --job composes with --matched: the count honors the same filter.
    const counted = await run(['inbox', 'nova', '--job', 'RQ-CLI-JF', '--matched']);
    expect(counted.json.matched).toBe(3);
    expect((await run(['inbox', 'nova', '--job', 'RQ-ABSENT'])).json.messages).toEqual([]);
    // A job id must be a printable label; anything else fails closed.
    expect(await run(['inbox', 'nova', '--job', 'has space'])).toMatchObject({ code: 1, json: { status: 'invalid' } });
  });

  it('filters channel reads by --job across feed citations and job-threaded posts', async () => {
    expect((await run(['id', 'register', 'atlas', '--cli', 'claude'])).json).toMatchObject({ status: 'created' });
    expect((await run(['id', 'register', 'nova'])).json).toMatchObject({ status: 'created' });
    expect((await run(['channel', 'create', 'release', '--from', 'atlas', '--member', 'nova'])).json)
      .toMatchObject({ status: 'created' });
    expect((await run(['work', 'post', '--from', 'atlas', '--job', 'RQ-CLI-CJ', '--title', 'Channel job',
      '--repo', 'a/b', '--claim', 'queue:RQ-CLI-CJ', '--to', 'group:release:general', '--id', 'cj-post'])).json)
      .toMatchObject({ status: 'posted' });
    expect((await run(['work', 'status', '--from', 'atlas', '--job', 'RQ-CLI-CJ', '--status', 'running',
      '--to', 'group:release:general', '--id', 'cj-st'])).json).toMatchObject({ status: 'posted' });
    // A post threaded job:<id> is the job's bucket; other threads and plain
    // chatter name different conversations.
    expect((await run(['channel', 'post', 'release', '--from', 'atlas', '--text', 'job note',
      '--thread', 'job:RQ-CLI-CJ', '--id', 'cj-note'])).json).toMatchObject({ status: 'posted' });
    expect((await run(['channel', 'post', 'release', '--from', 'atlas', '--text', 'other job',
      '--thread', 'job:RQ-CLI-OTHER', '--id', 'cj-other'])).json).toMatchObject({ status: 'posted' });
    expect((await run(['channel', 'post', 'release', '--from', 'atlas', '--text', 'plain', '--id', 'cj-plain'])).json)
      .toMatchObject({ status: 'posted' });

    const page = await run(['channel', 'read', 'release', '--job', 'RQ-CLI-CJ']);
    expect(page.code).toBe(0);
    expect(page.json.messages.map((m: { envelope: { id: string } }) => m.envelope.id).sort())
      .toEqual(['cj-note', 'cj-post', 'cj-st']);
    // --job composes with --matched: the count honors the same filter.
    const counted = await run(['channel', 'read', 'release', '--job', 'RQ-CLI-CJ', '--matched']);
    expect(counted.json.matched).toBe(3);
    expect((await run(['channel', 'read', 'release', '--job', 'RQ-ABSENT'])).json.messages).toEqual([]);
    // A job id must be a printable label; anything else fails closed.
    expect(await run(['channel', 'read', 'release', '--job', 'has space'])).toMatchObject({ code: 1, json: { status: 'invalid' } });
  });

  it('reports the true pending total with --matched and resumes before unshown mail', async () => {
    expect((await run(['id', 'register', 'atlas'])).json).toMatchObject({ status: 'created' });
    expect((await run(['id', 'register', 'nova'])).json).toMatchObject({ status: 'created' });
    for (const id of ['m-1', 'm-2', 'm-3']) {
      expect((await run(['dm', '--from', 'atlas', '--to', 'nova', '--text', id, '--id', id])).json)
        .toMatchObject({ status: 'posted' });
    }
    // Without the flag the page shape is unchanged: no matched field at all.
    const plain = await run(['inbox', 'nova']);
    expect(plain.json.matched).toBeUndefined();

    const first = await run(['inbox', 'nova', '--matched', '--limit', '2']);
    expect(first.code).toBe(0);
    expect(first.json.matched).toBe(3);
    expect(first.json.messages).toHaveLength(2);
    // nextCursor resumes at the newest shown row: the unshown match sits beyond it.
    const shownCursors = first.json.messages.map((m: { cursor: number }) => m.cursor);
    expect(first.json.nextCursor).toBe(Math.max(...shownCursors));

    const second = await run(['inbox', 'nova', '--matched', '--limit', '2', '--after', String(first.json.nextCursor)]);
    expect(second.json.matched).toBe(1);
    expect(second.json.messages.map((m: { envelope: { id: string } }) => m.envelope.id)).toEqual(['m-3']);

    const done = await run(['inbox', 'nova', '--matched', '--after', String(second.json.nextCursor)]);
    expect(done.json.matched).toBe(0);
    expect(done.json.messages).toEqual([]);

    // Human output names the total as well.
    const text: string[] = [];
    expect(await runAgentsBusUnified(['inbox', 'nova', '--matched', '--limit', '2', '--root', root],
      t => text.push(t), () => {}, {})).toBe(0);
    expect(text.join('\n')).toContain('matched 3');
  });

  it('annotates work mail in the inbox with the live feed job state', async () => {
    expect((await run(['id', 'register', 'atlas', '--cli', 'claude'])).json).toMatchObject({ status: 'created' });
    expect((await run(['work', 'post', '--from', 'atlas', '--job', 'RQ-CLI-JOB', '--title', 'CLI job',
      '--repo', 'a/b', '--claim', 'queue:RQ-CLI-JOB', '--to', 'agent:atlas', '--id', 'cli-wp'])).json)
      .toMatchObject({ status: 'posted' });
    const inbox = await run(['inbox', 'atlas']);
    expect(inbox.code).toBe(0);
    expect(inbox.json.messages[0]?.job).toMatchObject({ jobId: 'RQ-CLI-JOB', feed: 'ok',
      job: { id: 'RQ-CLI-JOB', status: 'queued', claimable: true } });
    // The human line carries the same compact marker the frame injects.
    const text: string[] = [];
    expect(await runAgentsBusUnified(['inbox', 'atlas', '--root', root], t => text.push(t), () => {}, {})).toBe(0);
    expect(text.join('\n')).toContain('job=RQ-CLI-JOB:queued claimable=yes');
  });

  it('reports the true pending total on channel read --matched and resumes before unshown posts', async () => {
    expect((await run(['id', 'register', 'atlas'])).json).toMatchObject({ status: 'created' });
    expect((await run(['id', 'register', 'nova'])).json).toMatchObject({ status: 'created' });
    expect((await run(['channel', 'create', 'release', '--from', 'atlas', '--member', 'nova'])).json)
      .toMatchObject({ status: 'created' });
    for (const id of ['c-1', 'c-2', 'c-3']) {
      expect((await run(['channel', 'post', 'release', '--from', 'atlas', '--text', id, '--id', id])).json)
        .toMatchObject({ status: 'posted' });
    }
    // Without the flag the page shape is unchanged: no matched field at all.
    const plain = await run(['channel', 'read', 'release']);
    expect(plain.json.matched).toBeUndefined();

    const first = await run(['channel', 'read', 'release', '--matched', '--limit', '2']);
    expect(first.code).toBe(0);
    expect(first.json.matched).toBe(3);
    expect(first.json.messages).toHaveLength(2);
    // nextCursor resumes at the newest shown row: the unshown match sits beyond it.
    const shownCursors = first.json.messages.map((m: { cursor: number }) => m.cursor);
    expect(first.json.nextCursor).toBe(Math.max(...shownCursors));

    const second = await run(['channel', 'read', 'release', '--matched', '--limit', '2', '--after', String(first.json.nextCursor)]);
    expect(second.json.matched).toBe(1);
    expect(second.json.messages.map((m: { envelope: { id: string } }) => m.envelope.id)).toEqual(['c-3']);

    const done = await run(['channel', 'read', 'release', '--matched', '--after', String(second.json.nextCursor)]);
    expect(done.json.matched).toBe(0);
    expect(done.json.messages).toEqual([]);

    // Human output names the total as well.
    const text: string[] = [];
    expect(await runAgentsBusUnified(['channel', 'read', 'release', '--matched', '--limit', '2', '--root', root],
      t => text.push(t), () => {}, {})).toBe(0);
    expect(text.join('\n')).toContain('matched 3');
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

  it('posts v2 notes and context to plain routing labels', async () => {
    expect((await run(['id', 'register', 'atlas', '--cli', 'claude'])).json).toMatchObject({ status: 'created' });
    expect((await run(['id', 'register', 'nova', '--alias', 'lane-nova'])).json).toMatchObject({ status: 'created' });
    // A label post carries identity metadata like a DM but needs no recipient identity.
    expect((await run(['post', '--from', 'atlas', '--to', 'fleet.mesh', '--text', 'drift', '--thread', 'mesh',
      '--ref', 'RQ-CLI-P', '--id', 'cli-post'])).json).toMatchObject({ status: 'posted', to: 'fleet.mesh', wake: 'not-requested' });
    expect((await run(['post', '--from', 'atlas', '--to', 'leaders', '--kind', 'context', '--text', '{"a":1}', '--id', 'cli-ctx'])).json)
      .toMatchObject({ status: 'posted' });
    // Reserved prefixes keep their dedicated verbs; a bad --kind is a usage error.
    expect(await run(['post', '--from', 'atlas', '--to', 'agent:nova', '--text', 'x']))
      .toMatchObject({ code: 1, json: { status: 'invalid' } });
    expect(await run(['post', '--from', 'atlas', '--to', 'group:release:general', '--text', 'x']))
      .toMatchObject({ code: 1, json: { status: 'invalid' } });
    expect(await run(['post', '--from', 'atlas', '--to', 'fleet.mesh', '--text', 'x', '--kind', 'work.post']))
      .toMatchObject({ code: 2 });
    // The posted envelopes are readable by id with their v2 bodies.
    const note = await run(['show', 'cli-post']);
    expect(note.json).toMatchObject({ status: 'ok', message: { fromAgent: 'atlas',
      envelope: { to: 'fleet.mesh', body: { kind: 'note', thread: 'mesh', refs: ['RQ-CLI-P'] } } } });
    const ctx = await run(['show', 'cli-ctx']);
    expect(ctx.json.message.envelope.body).toEqual({ kind: 'context', text: '{"a":1}' });
    // A post to a label that is one of an identity's labels lands in its inbox.
    expect((await run(['post', '--from', 'atlas', '--to', 'lane-nova', '--text', 'ping', '--priority', 'P1', '--id', 'cli-alias'])).json)
      .toMatchObject({ status: 'posted', wake: 'queued' });
    const inbox = await run(['inbox', 'nova']);
    expect(inbox.json.messages.map((m: { envelope: { id: string } }) => m.envelope.id)).toEqual(['cli-alias']);
    // A wake hint queued under a bare unregistered label reads back under
    // label scope; the inbox still needs a registered identity.
    expect((await run(['post', '--from', 'atlas', '--to', 'fleet.mesh', '--text', 'ping',
      '--priority', 'P1', '--id', 'cli-mesh'])).json).toMatchObject({ status: 'posted', wake: 'queued' });
    expect(await run(['wakes', 'fleet.mesh'])).toMatchObject({ code: 0,
      json: { status: 'ok', agent: 'fleet.mesh', scope: 'label', matched: 1 } });
    expect(await run(['wakes', 'fleet.mesh'])).toMatchObject({ json: { wakes: [{ id: 'cli-mesh', to: 'fleet.mesh' }] } });
    expect(await run(['inbox', 'fleet.mesh'])).toMatchObject({ code: 1, json: { status: 'unknown-agent' } });
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
    expect((await run(['work', 'status', '--from', 'atlas', '--job', 'RQ-FEED', '--status', 'running',
      '--detail', 'picked up the feed', '--id', 'cli-feed-s'])).json).toMatchObject({ status: 'posted' });

    const feed = await run(['work', 'feed']);
    expect(feed.code).toBe(0);
    expect(feed.json).toMatchObject({ status: 'ok', receipts: 2,
      jobs: [{ id: 'RQ-FEED', status: 'running', owner: 'agent:atlas', to: 'leaders', provider: 'claude',
        detail: 'picked up the feed' }] });
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

    // --jobs is the reverse join: the claim names the feed job it blocks,
    // with the retained post/status receipt citations behind it.
    const withJobs = await run(['claim', 'list', '--jobs']);
    expect(withJobs.json).toMatchObject({ status: 'ok', source: 'available', feed: 'ok' });
    expect(withJobs.json.claims[0].jobs)
      .toEqual([{ id: 'RQ-FEED', owner: 'agent:atlas', status: 'running', title: 'Read me',
        detail: 'picked up the feed', postId: 'cli-feed', statusId: 'cli-feed-s' }]);
    // Without --jobs no feed join or feed state is reported.
    expect(claims.json.feed).toBeUndefined();
    expect(claims.json.claims[0].jobs).toBeUndefined();

    // Human output shares the fleet feed lines; reads need no identity.
    const text: string[] = [];
    expect(await runAgentsBusUnified(['work', 'feed', '--root', root], t => text.push(t), () => {}, {})).toBe(0);
    expect(text.join('\n')).toContain('RQ-FEED running "Read me" detail="picked up the feed" owner=agent:atlas to=leaders provider=claude repo=ashlrai/phantom keys=repo:ashlrai/phantom');
    expect(text.join('\n')).toContain('jobs=1 receipts=2 feed=ok');
    const claimText: string[] = [];
    expect(await runAgentsBusUnified(['claim', 'list', '--root', root], t => claimText.push(t), () => {}, {})).toBe(0);
    expect(claimText.join('\n')).toContain('repo:ashlrai/phantom owner=atlas origin=resource');
    expect(claimText.join('\n')).toContain('claims=1 source=available');
    const claimJobsText: string[] = [];
    expect(await runAgentsBusUnified(['claim', 'list', '--jobs', '--root', root], t => claimJobsText.push(t), () => {}, {})).toBe(0);
    expect(claimJobsText.join('\n')).toContain('jobs=RQ-FEED(running) "Read me" detail="picked up the feed" post=cli-feed status=cli-feed-s');
    expect(claimJobsText.join('\n')).toContain('feed=ok');
  });

  it('filters the work feed by --since on last activity', async () => {
    const spy = vi.spyOn(Date, 'now');
    let clock = 1_800_000_000_000;
    spy.mockImplementation(() => clock);
    try {
      expect((await run(['id', 'register', 'atlas', '--cli', 'claude'])).json).toMatchObject({ status: 'created' });
      expect((await run(['work', 'post', '--from', 'atlas', '--job', 'RQ-SINCE-OLD', '--title', 'old',
        '--repo', 'ashlrai/phantom', '--claim', 'repo:ashlrai/phantom', '--id', 'sf-old'])).json)
        .toMatchObject({ status: 'posted' });
      clock += 120_000;
      expect((await run(['work', 'post', '--from', 'atlas', '--job', 'RQ-SINCE-NEW', '--title', 'new',
        '--repo', 'ashlrai/phantom', '--claim', 'repo:ashlrai/phantom', '--id', 'sf-new'])).json)
        .toMatchObject({ status: 'posted' });
      const ids = (feed: { json: { jobs: { id: string }[] } }) => feed.json.jobs.map(job => job.id);
      // A cutoff between the two announcement times keeps only the newer job.
      const between = await run(['work', 'feed', '--since', String(clock - 60_000)]);
      expect(between.code).toBe(0);
      expect(ids(between)).toEqual(['RQ-SINCE-NEW']);
      // The shared grammar resolves the same way: 1m back still drops the stale job.
      expect(ids(await run(['work', 'feed', '--since', '1m']))).toEqual(['RQ-SINCE-NEW']);
      // A status moves the older job's last activity to now — it re-enters the window.
      clock += 10_000;
      expect((await run(['work', 'status', '--from', 'atlas', '--job', 'RQ-SINCE-OLD', '--status', 'running',
        '--id', 'sf-old-s'])).json).toMatchObject({ status: 'posted' });
      expect(ids(await run(['work', 'feed', '--since', '1m']))).toEqual(['RQ-SINCE-OLD', 'RQ-SINCE-NEW']);
      // A future cutoff keeps none; an unparseable one is a usage error.
      const future = await run(['work', 'feed', '--since', String(clock + 3_600_000)]);
      expect(future.json).toMatchObject({ status: 'ok', jobs: [] });
      expect(await run(['work', 'feed', '--since', 'bogus'])).toMatchObject({ code: 2 });
    } finally {
      spy.mockRestore();
    }
  });

  it('filters the work feed by --channel on the announcement room address', async () => {
    expect((await run(['id', 'register', 'atlas', '--cli', 'claude'])).json).toMatchObject({ status: 'created' });
    expect((await run(['work', 'post', '--from', 'atlas', '--job', 'RQ-ROOM', '--title', 'room job',
      '--repo', 'ashlrai/phantom', '--claim', 'repo:ashlrai/phantom',
      '--to', 'group:release:deploy', '--id', 'ch-post'])).json).toMatchObject({ status: 'posted' });
    expect((await run(['work', 'post', '--from', 'atlas', '--job', 'RQ-SINK', '--title', 'sink job',
      '--repo', 'ashlrai/phantom', '--claim', 'repo:ashlrai/phantom', '--id', 'ch-sink'])).json)
      .toMatchObject({ status: 'posted' });
    const ids = (feed: { json: { jobs: { id: string }[] } }) => feed.json.jobs.map(job => job.id);
    // The room's traffic under every topic — the same group:<name>: prefix
    // inbox --channel and channel read match.
    expect(ids(await run(['work', 'feed', '--channel', 'release']))).toEqual(['RQ-ROOM']);
    expect(ids(await run(['work', 'feed', '--channel', 'ops']))).toEqual([]);
    // The filter composes with the other view filters.
    expect(ids(await run(['work', 'feed', '--channel', 'release', '--status', 'done']))).toEqual([]);
    // A name outside the channel grammar is a usage error, never a guessed match.
    for (const bad of ['Has Space', 'UPPER', 'a:b']) {
      expect(await run(['work', 'feed', '--channel', bad])).toMatchObject({ code: 2 });
    }
  });

  it('pages the work feed with --limit and reports matched/omitted', async () => {
    const spy = vi.spyOn(Date, 'now');
    let clock = 1_800_000_000_000;
    spy.mockImplementation(() => clock);
    try {
      expect((await run(['id', 'register', 'atlas', '--cli', 'claude'])).json).toMatchObject({ status: 'created' });
      for (const [job, title] of [['RQ-P1', 'first'], ['RQ-P2', 'second'], ['RQ-P3', 'third']] as const) {
        clock += 1_000;
        expect((await run(['work', 'post', '--from', 'atlas', '--job', job, '--title', title,
          '--repo', 'ashlrai/phantom', '--claim', 'repo:ashlrai/phantom', '--id', `pg-${job}`])).json)
          .toMatchObject({ status: 'posted' });
      }
      // Newest first: the two newest jobs page ahead of the rest.
      const page = await run(['work', 'feed', '--limit', '2']);
      expect(page.code).toBe(0);
      expect(page.json).toMatchObject({ status: 'ok', matched: 3, omitted: 1 });
      expect(page.json.jobs.map((job: { id: string }) => job.id)).toEqual(['RQ-P3', 'RQ-P2']);
      // Filters narrow before the slice; a wide page reports zero omitted.
      const filtered = await run(['work', 'feed', '--limit', '1', '--status', 'queued']);
      expect(filtered.json).toMatchObject({ matched: 3, omitted: 2 });
      const wide = await run(['work', 'feed', '--limit', '200']);
      expect(wide.json).toMatchObject({ matched: 3, omitted: 0 });
      expect(wide.json.jobs).toHaveLength(3);
      // Out-of-range and malformed limits are usage errors, never a silent widen.
      for (const bad of ['0', '201', 'abc', '1.5']) {
        expect(await run(['work', 'feed', '--limit', bad])).toMatchObject({ code: 2 });
      }
      // The human footer names the page.
      const text: string[] = [];
      expect(await runAgentsBusUnified(['work', 'feed', '--limit', '2', '--root', root], t => text.push(t), () => {}, {})).toBe(0);
      expect(text.join('\n')).toContain('matched=3 omitted=1');
    } finally {
      spy.mockRestore();
    }
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
      job: { id: 'RQ-CLI-CLAIM', owner: 'agent:atlas', status: 'queued', repo: 'ashlrai/phantom',
        postId: 'cli-wc', statusId: null },
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

  it('claims the next pending work envelope addressed to an agent', async () => {
    expect((await run(['id', 'register', 'atlas'])).json).toMatchObject({ status: 'created' });
    expect((await run(['id', 'register', 'nova'])).json).toMatchObject({ status: 'created' });
    const post = (id: string, to: string, priority: BusEnvelope['priority'], body: unknown): void => {
      expect(appendBusInbox({ id, from: 'agent:nova', to, priority, ttl: 3_600_000,
        body: body as BusEnvelope['body'] }, { root }).status).toBe('posted');
    };
    // bus-next order is priority band then cursor: the P0 claims first though posted last.
    post('wn-routine', 'agent:atlas', 'P2', { kind: 'work', text: 'routine sweep' });
    post('wn-note', 'agent:atlas', 'P1', { kind: 'note', text: 'not claimable' });
    post('wn-urgent', 'agent:atlas', 'P0', { kind: 'work', text: 'urgent fix' });
    post('wn-other', 'agent:nova', 'P0', { kind: 'work', text: 'nova only' });

    // PHM_AGENT_ID supplies both the addressee and the default claim owner.
    const first = await run(['work', 'next', '--lease-ms', '60000'], { PHM_AGENT_ID: 'atlas' });
    expect(first.code).toBe(0);
    expect(first.json).toMatchObject({ status: 'acquired',
      receipt: { cursor: expect.any(Number), envelope: { id: 'wn-urgent', from: 'agent:nova',
        to: 'agent:atlas', priority: 'P0' } } });
    expect(first.json.token).toMatch(/^[a-f0-9]{64}$/);
    expect(first.json.leaseUntil).toBeGreaterThan(Date.now());

    // The positional agent resolves under any of its labels; --owner records independently.
    const second = await run(['work', 'next', 'agent:atlas', '--lease-ms', '60000', '--owner', 'crew-a']);
    expect(second.code).toBe(0);
    expect(second.json).toMatchObject({ status: 'acquired',
      receipt: { envelope: { id: 'wn-routine' } } });
    const claims = await run(['claim', 'list', '--owner', 'crew-a']);
    expect(claims.json.claims).toEqual([expect.objectContaining({ key: 'queue:wn-routine',
      owner: 'crew-a', origin: 'message', live: true })]);

    // Both atlas-addressed claimable receipts are now leased: empty reports the
    // observed scan totals, distinguishing held work from a dry well.
    const drained = await run(['work', 'next', '--lease-ms', '60000'], { PHM_AGENT_ID: 'atlas' });
    expect(drained.code).toBe(0);
    expect(drained.json).toEqual({ status: 'empty', candidates: 2, held: 2 });
    // A different addressee still finds its own pending work.
    const nova = await run(['work', 'next', 'nova', '--lease-ms', '60000']);
    expect(nova.json).toMatchObject({ status: 'acquired',
      receipt: { envelope: { id: 'wn-other', to: 'agent:nova' } } });

    // Usage errors exit 2; a lease past the cap is an invalid result, not a claim.
    expect(await run(['work', 'next'])).toMatchObject({ code: 2 });
    expect(await run(['work', 'next', '--lease-ms', '60000'], {})).toMatchObject({ code: 2 });
    expect(await run(['work', 'next', '--lease-ms', 'abc'], { PHM_AGENT_ID: 'atlas' })).toMatchObject({ code: 2 });
    expect(await run(['work', 'next', '--lease-ms', '3600001'], { PHM_AGENT_ID: 'atlas' }))
      .toMatchObject({ code: 2, json: { status: 'invalid' } });

    // Human output names the claimed id, owner, lease and token plus the routing line.
    post('wn-last', 'agent:nova', 'P3', { kind: 'work', text: 'last one' });
    const text: string[] = [];
    expect(await runAgentsBusUnified(['work', 'next', 'nova', '--lease-ms', '60000',
      '--root', root], t => text.push(t), () => {}, {})).toBe(0);
    expect(text.join('\n')).toContain('acquired wn-last owner=nova');
    expect(text.join('\n')).toContain('token=');
    expect(text.join('\n')).toContain('agent:nova');
    const emptyText: string[] = [];
    expect(await runAgentsBusUnified(['work', 'next', 'nova', '--lease-ms', '60000',
      '--root', root], t => emptyText.push(t), () => {}, {})).toBe(0);
    expect(emptyText.join('\n')).toContain('empty candidates=2 held=2');
  });

  it('filters the next-work claim by contains, since and priority', async () => {
    expect((await run(['id', 'register', 'atlas'])).json).toMatchObject({ status: 'created' });
    const post = (id: string, priority: BusEnvelope['priority'], body: unknown): void => {
      expect(appendBusInbox({ id, from: 'agent:nova', to: 'agent:atlas', priority, ttl: 3_600_000,
        body: body as BusEnvelope['body'] }, { root }).status).toBe('posted');
    };
    post('wf-old', 'P0', { kind: 'work', text: 'deploy alpha' });
    post('wf-chore', 'P3', { kind: 'work', text: 'unrelated chore' });
    post('wf-alpha', 'P1', { kind: 'work', text: 'ship ALPHA build' });
    const env = { PHM_AGENT_ID: 'atlas' };
    const complete = async (id: string, token: string): Promise<void> => {
      expect(await run(['claim', 'message', 'complete', '--id', id, '--token', token], env))
        .toMatchObject({ code: 0, json: { status: 'completed' } });
    };

    // --priority keeps only the exact band: the P1 alpha claims while the
    // higher-priority old-alpha and lower-priority chore stay outside it.
    const byPriority = await run(['work', 'next', '--lease-ms', '60000', '--priority', 'P1'], env);
    expect(byPriority.json).toMatchObject({ status: 'acquired',
      receipt: { envelope: { id: 'wf-alpha' } } });
    await complete('wf-alpha', byPriority.json.token);

    // --contains matches the scrubbed one-line summary case-insensitively:
    // both alpha receipts remain candidates (one completed), so claim order
    // takes the P0 old-alpha; the chore never enters the filtered scan.
    const byContains = await run(['work', 'next', '--lease-ms', '60000', '--contains', '  ALPHA  '], env);
    expect(byContains.json).toMatchObject({ status: 'acquired',
      receipt: { envelope: { id: 'wf-old' } } });
    await complete('wf-old', byContains.json.token);

    // --since is the inclusive receivedAt cutoff in the phm messages grammar:
    // a cutoff past every receipt's arrival empties the filtered scan, while
    // 15m keeps all three — completed receipts still count as candidates.
    const future = String(Date.now() + 3_600_000);
    expect(await run(['work', 'next', '--lease-ms', '60000', '--since', future], env))
      .toMatchObject({ code: 0, json: { status: 'empty', candidates: 0, held: 0 } });
    const bySince = await run(['work', 'next', '--lease-ms', '60000', '--since', '15m'], env);
    expect(bySince.json).toMatchObject({ status: 'acquired',
      receipt: { envelope: { id: 'wf-chore' } } });
    await complete('wf-chore', bySince.json.token);

    // Malformed filters are usage or invalid results, never a widened claim.
    expect(await run(['work', 'next', '--lease-ms', '60000', '--priority', 'P9'], env))
      .toMatchObject({ code: 2 });
    expect(await run(['work', 'next', '--lease-ms', '60000', '--since', 'bogus'], env))
      .toMatchObject({ code: 2 });
    expect(await run(['work', 'next', '--lease-ms', '60000', '--contains', '   '], env))
      .toMatchObject({ code: 2, json: { status: 'invalid' } });
  });

  it('claims one envelope id and renews, releases and completes its message claim', async () => {
    expect(appendBusInbox({ id: 'mc-work', from: 'agent:nova', to: 'agent:atlas', priority: 'P2',
      ttl: 3_600_000, body: { kind: 'work', text: 'named work' } }, { root }).status).toBe('posted');
    expect(appendBusInbox({ id: 'mc-note', from: 'agent:nova', to: 'agent:atlas', priority: 'P1',
      ttl: 3_600_000, body: { kind: 'note', text: 'not claimable by next' } }, { root }).status).toBe('posted');

    // claim message targets one retained envelope id directly — including a
    // note work next would never scan — through the same claim journal.
    const acquired = await run(['claim', 'message', 'acquire', '--id', 'mc-note', '--lease-ms', '60000'],
      { PHM_AGENT_ID: 'atlas' });
    expect(acquired.code).toBe(0);
    expect(acquired.json).toMatchObject({ status: 'acquired', id: 'mc-note' });
    const token = acquired.json.token as string;
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    expect(acquired.json.leaseUntil).toBeGreaterThan(Date.now());

    // A live lease answers conflict to every other claimant of the same id.
    expect(await run(['claim', 'message', 'acquire', '--id', 'mc-note', '--owner', 'peer', '--lease-ms', '60000']))
      .toMatchObject({ code: 1, json: { status: 'conflict', id: 'mc-note' } });

    // Renew keeps the stored lease length; a wrong token is fenced out.
    expect(await run(['claim', 'message', 'renew', '--id', 'mc-note', '--token', token], { PHM_AGENT_ID: 'atlas' }))
      .toMatchObject({ code: 0, json: { status: 'renewed', id: 'mc-note', leaseUntil: expect.any(Number) } });
    expect(await run(['claim', 'message', 'complete', '--id', 'mc-note', '--token', '0'.repeat(64)]))
      .toMatchObject({ code: 1, json: { status: 'mismatched-token' } });

    // Release frees the id; a fresh acquire gets a new fencing token.
    expect(await run(['claim', 'message', 'release', '--id', 'mc-note', '--token', token]))
      .toMatchObject({ code: 0, json: { status: 'released', id: 'mc-note' } });
    const again = await run(['claim', 'message', 'acquire', '--id', 'mc-note', '--lease-ms', '60000'],
      { PHM_AGENT_ID: 'atlas' });
    expect(again.json).toMatchObject({ status: 'acquired', id: 'mc-note' });
    expect(again.json.token).not.toBe(token);

    // Complete retires the claim; later verbs on it answer 'completed'.
    expect(await run(['claim', 'message', 'complete', '--id', 'mc-note', '--token', again.json.token]))
      .toMatchObject({ code: 0, json: { status: 'completed', id: 'mc-note' } });
    expect(await run(['claim', 'message', 'renew', '--id', 'mc-note', '--token', again.json.token]))
      .toMatchObject({ code: 0, json: { status: 'completed' } });

    // An id with no retained receipt answers missing — never a fabricated claim.
    expect(await run(['claim', 'message', 'acquire', '--id', 'mc-ghost', '--lease-ms', '60000'],
      { PHM_AGENT_ID: 'atlas' })).toMatchObject({ code: 1, json: { status: 'missing' } });

    // Usage errors exit 2; an over-cap lease is an invalid result, not a claim.
    expect(await run(['claim', 'message'])).toMatchObject({ code: 2 });
    expect(await run(['claim', 'message', 'bogus', '--id', 'mc-work'])).toMatchObject({ code: 2 });
    expect(await run(['claim', 'message', 'acquire', '--lease-ms', '60000'], { PHM_AGENT_ID: 'atlas' }))
      .toMatchObject({ code: 2 });
    expect(await run(['claim', 'message', 'acquire', '--id', 'mc-work'], { PHM_AGENT_ID: 'atlas' }))
      .toMatchObject({ code: 2 });
    expect(await run(['claim', 'message', 'acquire', '--id', 'mc-work', '--lease-ms', '60000'], {}))
      .toMatchObject({ code: 2 });
    expect(await run(['claim', 'message', 'renew', '--id', 'mc-work'], { PHM_AGENT_ID: 'atlas' }))
      .toMatchObject({ code: 2 });
    expect(await run(['claim', 'message', 'acquire', '--id', 'mc-work', '--lease-ms', '3600001'],
      { PHM_AGENT_ID: 'atlas' })).toMatchObject({ code: 2, json: { status: 'invalid' } });

    // Human output names the envelope id, lease and the acquire-only token.
    const text: string[] = [];
    expect(await runAgentsBusUnified(['claim', 'message', 'acquire', '--id', 'mc-work', '--lease-ms', '60000',
      '--root', root], t => text.push(t), () => {}, { PHM_AGENT_ID: 'atlas' })).toBe(0);
    expect(text.join('\n')).toContain('acquired mc-work');
    expect(text.join('\n')).toContain('token=');
    const renewText: string[] = [];
    const workToken = /token=([a-f0-9]{64})/.exec(text.join('\n'))![1]!;
    expect(await runAgentsBusUnified(['claim', 'message', 'renew', '--id', 'mc-work', '--token', workToken,
      '--root', root], t => renewText.push(t), () => {}, {})).toBe(0);
    expect(renewText.join('\n')).toContain('renewed mc-work');
    expect(renewText.join('\n')).not.toContain('token=');
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

  it('filters the work feed by job id and announcing agent', async () => {
    expect((await run(['id', 'register', 'atlas', '--cli', 'claude'])).json).toMatchObject({ status: 'created' });
    expect((await run(['id', 'register', 'nova'])).json).toMatchObject({ status: 'created' });
    expect((await run(['work', 'post', '--from', 'atlas', '--job', 'RQ-J-1', '--title', 'Mine',
      '--repo', 'ashlrai/phantom', '--provider', 'claude', '--id', 'feed-j1'])).json)
      .toMatchObject({ status: 'posted' });
    expect((await run(['work', 'post', '--from', 'nova', '--job', 'RQ-J-2', '--title', 'Theirs',
      '--repo', 'ashlrai/phantom', '--provider', 'local', '--id', 'feed-j2'])).json)
      .toMatchObject({ status: 'posted' });
    expect((await run(['work', 'status', '--from', 'atlas', '--job', 'RQ-J-1', '--status', 'running',
      '--id', 'feed-j1s'])).json).toMatchObject({ status: 'posted' });

    // --job resolves the exact id through its whole lifecycle.
    expect((await run(['work', 'feed', '--job', 'RQ-J-1'])).json.jobs)
      .toEqual([expect.objectContaining({ id: 'RQ-J-1', status: 'running', owner: 'agent:atlas' })]);
    expect((await run(['work', 'feed', '--job', 'RQ-GONE'])).json.jobs).toEqual([]);
    // --owner keeps jobs announced by that agent under every label of its identity.
    for (const ref of ['atlas', 'agent:atlas']) {
      expect((await run(['work', 'feed', '--owner', ref])).json.jobs)
        .toEqual([expect.objectContaining({ id: 'RQ-J-1', owner: 'agent:atlas' })]);
    }
    expect((await run(['work', 'feed', '--owner', 'nova'])).json.jobs)
      .toEqual([expect.objectContaining({ id: 'RQ-J-2', owner: 'agent:nova' })]);
    // Filters compose: atlas's running job only; holds regroup under shown jobs.
    expect((await run(['work', 'feed', '--owner', 'atlas', '--status', 'queued'])).json.jobs).toEqual([]);
    expect((await run(['work', 'feed', '--job', 'RQ-J-1', '--owner', 'atlas', '--claims'])).json)
      .toMatchObject({ status: 'ok', claims: { source: 'missing', holds: [] } });
    expect((await run(['work', 'feed', '--job', 'RQ-J-1', '--owner', 'nova'])).json.jobs).toEqual([]);
    // Unresolvable owner refs keep exact-label matching — never widen.
    expect((await run(['work', 'feed', '--owner', 'ghost'])).json.jobs).toEqual([]);
    expect(await run(['work', 'feed', '--job', 'bad job'])).toMatchObject({ code: 2 });
    expect(await run(['work', 'feed', '--owner', 'bad owner'])).toMatchObject({ code: 2 });
  });

  it('filters the work feed by repo, provider and claimable', async () => {
    expect((await run(['id', 'register', 'atlas', '--cli', 'claude'])).json).toMatchObject({ status: 'created' });
    expect((await run(['work', 'post', '--from', 'atlas', '--job', 'RQ-REPO-A', '--title', 'Repo job',
      '--repo', 'AshlrAI/Phantom', '--provider', 'claude', '--claim', 'repo:ashlrai/phantom',
      '--id', 'feed-ra'])).json).toMatchObject({ status: 'posted' });
    expect((await run(['work', 'post', '--from', 'atlas', '--job', 'RQ-REPO-B', '--title', 'Other job',
      '--repo', 'ashlrai/other', '--provider', 'local', '--claim', 'repo:ashlrai/other',
      '--id', 'feed-rb'])).json).toMatchObject({ status: 'posted' });

    // --repo matches the announced owner/name case-insensitively, the claim-key rule.
    for (const ref of ['ashlrai/phantom', 'AshlrAI/Phantom', 'ASHLRAI/PHANTOM']) {
      expect((await run(['work', 'feed', '--repo', ref])).json.jobs)
        .toEqual([expect.objectContaining({ id: 'RQ-REPO-A', repo: 'AshlrAI/Phantom' })]);
    }
    expect((await run(['work', 'feed', '--repo', 'ashlrai/other'])).json.jobs)
      .toEqual([expect.objectContaining({ id: 'RQ-REPO-B' })]);
    expect((await run(['work', 'feed', '--repo', 'ghost/repo'])).json.jobs).toEqual([]);
    // --provider keeps jobs announced for that provider; filters compose.
    expect((await run(['work', 'feed', '--provider', 'claude'])).json.jobs)
      .toEqual([expect.objectContaining({ id: 'RQ-REPO-A', provider: 'claude' })]);
    expect((await run(['work', 'feed', '--provider', 'local'])).json.jobs)
      .toEqual([expect.objectContaining({ id: 'RQ-REPO-B', provider: 'local' })]);
    expect((await run(['work', 'feed', '--repo', 'ashlrai/phantom', '--provider', 'local'])).json.jobs).toEqual([]);

    // --claimable implies the claims join and keeps only provably-free open jobs.
    expect((await run(['claim', 'acquire', '--key', 'repo:ashlrai/other', '--lease-ms', '600000',
      '--owner', 'holder', '--id', 'feed-rb-hold'])).json).toMatchObject({ status: 'acquired' });
    const claimable = await run(['work', 'feed', '--claimable']);
    expect(claimable.code).toBe(0);
    expect(claimable.json).toMatchObject({ status: 'ok', claims: { source: 'available' } });
    expect(claimable.json.jobs).toEqual([expect.objectContaining({ id: 'RQ-REPO-A', claimable: true })]);
    // The unfiltered claims view still shows both jobs with honest tri-state coverage.
    const claims = await run(['work', 'feed', '--claims']);
    expect(claims.json.jobs).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'RQ-REPO-A', claimable: true }),
      expect.objectContaining({ id: 'RQ-REPO-B', claimable: false }),
    ]));
    expect((await run(['work', 'feed', '--claimable', '--repo', 'ashlrai/other'])).json.jobs).toEqual([]);
    expect((await run(['work', 'feed', '--claimable', '--provider', 'local'])).json.jobs).toEqual([]);

    // Bad filter values are usage errors, never silent empty views.
    expect(await run(['work', 'feed', '--repo', 'no-slash'])).toMatchObject({ code: 2 });
    expect(await run(['work', 'feed', '--repo', 'a/b/c'])).toMatchObject({ code: 2 });
    expect(await run(['work', 'feed', '--provider', 'bogus'])).toMatchObject({ code: 2 });
    expect(await run(['work', 'feed', '--claimable', '--claimable'])).toMatchObject({ code: 2 });
  });

  it('filters the work feed by declared dispatch tier', async () => {
    expect((await run(['id', 'register', 'atlas', '--cli', 'claude'])).json).toMatchObject({ status: 'created' });
    expect((await run(['work', 'post', '--from', 'atlas', '--job', 'RQ-TIER-A', '--title', 'Quick fix',
      '--repo', 'ashlrai/phantom', '--claim', 'repo:ashlrai/phantom', '--id', 'feed-ta',
      '--tier', 'fast', '--scope', 'Small fix', '--acceptance', 'Green'])).json)
      .toMatchObject({ status: 'posted' });
    expect((await run(['work', 'post', '--from', 'atlas', '--job', 'RQ-TIER-B', '--title', 'Big move',
      '--repo', 'ashlrai/other', '--claim', 'repo:ashlrai/other', '--id', 'feed-tb',
      '--tier', 'frontier', '--scope', 'Big scope', '--acceptance', 'Shipped'])).json)
      .toMatchObject({ status: 'posted' });
    expect((await run(['work', 'post', '--from', 'atlas', '--job', 'RQ-TIER-C', '--title', 'Plain job',
      '--repo', 'ashlrai/third', '--claim', 'repo:ashlrai/third', '--id', 'feed-tc'])).json)
      .toMatchObject({ status: 'posted' });

    // --tier keeps only jobs whose work.post declared that dispatch tier.
    expect((await run(['work', 'feed', '--tier', 'fast'])).json.jobs)
      .toEqual([expect.objectContaining({ id: 'RQ-TIER-A', dispatch: expect.objectContaining({ tier: 'fast' }) })]);
    expect((await run(['work', 'feed', '--tier', 'frontier'])).json.jobs)
      .toEqual([expect.objectContaining({ id: 'RQ-TIER-B' })]);
    // A job carrying no dispatch spec declares no tier and never matches.
    expect((await run(['work', 'feed', '--tier', 'mid'])).json).toMatchObject({ status: 'ok', jobs: [] });
    // The filter composes with the other structured filters.
    expect((await run(['work', 'feed', '--tier', 'fast', '--repo', 'ashlrai/other'])).json.jobs).toEqual([]);
    expect((await run(['work', 'feed', '--tier', 'fast', '--status', 'queued'])).json.jobs)
      .toEqual([expect.objectContaining({ id: 'RQ-TIER-A' })]);
    // Bad tier values and duplicates are usage errors, never silent empty views.
    expect(await run(['work', 'feed', '--tier', 'bogus'])).toMatchObject({ code: 2 });
    expect(await run(['work', 'feed', '--tier', 'fast', '--tier', 'mid'])).toMatchObject({ code: 2 });
  });

  it('filters the work feed by --contains over title, detail and dispatch text', async () => {
    expect((await run(['id', 'register', 'atlas', '--cli', 'claude'])).json).toMatchObject({ status: 'created' });
    expect((await run(['work', 'post', '--from', 'atlas', '--job', 'RQ-CONTAINS-A', '--title', 'Drain the queue',
      '--repo', 'ashlrai/phantom', '--claim', 'repo:ashlrai/phantom', '--id', 'feed-ca',
      '--tier', 'work', '--scope', 'Migrate the drain path', '--acceptance', 'Drain lands green'])).json)
      .toMatchObject({ status: 'posted' });
    expect((await run(['work', 'post', '--from', 'atlas', '--job', 'RQ-CONTAINS-B', '--title', 'Polish the docs',
      '--repo', 'ashlrai/other', '--claim', 'repo:ashlrai/other', '--id', 'feed-cb'])).json)
      .toMatchObject({ status: 'posted' });
    expect((await run(['work', 'status', '--from', 'atlas', '--job', 'RQ-CONTAINS-B', '--status', 'running',
      '--detail', 'waiting on drain review', '--id', 'feed-cb-s'])).json).toMatchObject({ status: 'posted' });

    // 'drain' matches the first job's title and dispatch and the second's
    // newest status detail — every descriptive field the job line renders.
    const both = await run(['work', 'feed', '--contains', 'DRAIN']);
    expect(both.code).toBe(0);
    expect(both.json.jobs.map((job: { id: string }) => job.id)).toEqual(['RQ-CONTAINS-B', 'RQ-CONTAINS-A']);
    // A phrase only the dispatch scope carries narrows to that one job, and
    // the filter composes with the structured ones.
    expect((await run(['work', 'feed', '--contains', 'drain path'])).json.jobs)
      .toEqual([expect.objectContaining({ id: 'RQ-CONTAINS-A' })]);
    expect((await run(['work', 'feed', '--contains', 'drain', '--status', 'queued'])).json.jobs)
      .toEqual([expect.objectContaining({ id: 'RQ-CONTAINS-A' })]);
    // Whitespace collapses on both sides like every other --contains read.
    expect((await run(['work', 'feed', '--contains', '  drain\n  lands  '])).json.jobs)
      .toEqual([expect.objectContaining({ id: 'RQ-CONTAINS-A' })]);
    // A needle nothing carries is an honest empty view; ids, keys, statuses
    // and labels are structured fields, never search text.
    for (const needle of ['bogus-needle', 'RQ-CONTAINS-A', 'running', 'repo:ashlrai/phantom', 'leaders', 'claude']) {
      expect((await run(['work', 'feed', '--contains', needle])).json).toMatchObject({ status: 'ok', jobs: [] });
    }
    // Blank, overlong and duplicate needles are usage errors, never a silent widen.
    expect(await run(['work', 'feed', '--contains', ''])).toMatchObject({ code: 2 });
    expect(await run(['work', 'feed', '--contains', '   '])).toMatchObject({ code: 2 });
    expect(await run(['work', 'feed', '--contains', 'x'.repeat(513)])).toMatchObject({ code: 2 });
    expect(await run(['work', 'feed', '--contains', 'a', '--contains', 'b'])).toMatchObject({ code: 2 });
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

  it('agents help names the roster read and the real conversations and chat flags', async () => {
    const out: string[] = [];
    expect(await runAgentsCli(['--help'], t => out.push(t), () => {})).toBe(0);
    const help = out.join('\n');
    // `phm agents --help` is the complete agents reference: it must name every
    // dispatched subcommand and the filters each read actually accepts, so an
    // agent discovering the surface here is not told a narrower command than
    // the dispatcher runs.
    expect(help).toContain('ashlr agents roster [--json]');
    expect(help).toMatch(/ashlr agents conversations [^\n]*--contains <text>/);
    expect(help).toMatch(/ashlr agents chat [^\n]*--after <cursor>/);
    expect(help).toMatch(/ashlr agents chat [^\n]*--limit <1-100>/);
  });
});
