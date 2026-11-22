import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerAgentIdentity } from '../src/core/agents/bus-identity.js';
import { appendBusInbox, listBusInboxAfter, scanBusInbox } from '../src/core/fleet/bus-inbox.js';
import {
  formatAgentMessagesText, parseAgentMessagesQuery, parseSince, readAgentMessages,
} from '../src/core/fleet/agent-messages.js';
import { createAgentBusApi } from '../src/core/verse/agent-bus-api.js';

const T0 = Date.UTC(2026, 10, 17, 12, 0, 0);
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function store() {
  const root = mkdtempSync(join(tmpdir(), 'agent-messages-'));
  roots.push(root);
  return root;
}
function post(root: string, at: number, envelope: Record<string, unknown>) {
  const result = appendBusInbox({ priority: 'P2', ttl: 86_400_000, ...envelope }, { root, now: () => at });
  expect(result.status).toBe('posted');
}
const read = (root: string, query = {}, now = T0 + 60_000) => readAgentMessages(query, { root, now: () => now });

describe('phm messages projection', () => {
  it('reads an empty bus as missing with no messages', () => {
    const root = store();
    expect(read(root)).toEqual({ schema: 'agent-messages.v1', source: 'missing', messages: [], matched: 0, skipped: 0 });
    expect(formatAgentMessagesText(read(root))).toBe('No agent messages.');
  });

  it('follows a handoff chain across three agents, newest first, in one conversation', () => {
    const root = store();
    post(root, T0, { id: 'm1', from: 'agent:claude-1', to: 'agent:codex-local-2', channel: 'handoff', channel_ref: 'agent:codex-local-2',
      sender: { agent_id: 'agent:claude-1', vendor: 'claude', human: false, team: true }, external: false,
      body: { kind: 'worker-handoff', taskId: 'RQ-CHAINA1', prompt: 'Take over the parser fix', thread: 't-chain' } });
    post(root, T0 + 1_000, { id: 'm2', from: 'agent:codex-local-2', to: 'agent:grok-3',
      body: { kind: 'note', text: 'Can you review ashlrai/phantom#6670 before I hand off?', thread: 't-chain' } });
    post(root, T0 + 2_000, { id: 'm3', from: 'agent:grok-3', to: 'agent:claude-1',
      body: { kind: 'note', text: 'Reviewed, looks good', replyTo: 'm2' } });
    const result = read(root);
    expect(result.messages.map(m => [m.id, m.kind, m.from.name, m.to.name])).toEqual([
      ['m3', 'reply', 'grok-3', 'claude-1'],
      ['m2', 'ask', 'codex-local-2', 'grok-3'],
      ['m1', 'handoff', 'claude-1', 'codex-local-2'],
    ]);
    expect(new Set(result.messages.map(m => m.conversation))).toEqual(new Set(['t-chain']));
    expect(result.messages[2]).toMatchObject({ job: 'RQ-CHAINA1', from: { lane: 'claude' }, to: { lane: 'codex-local' }, ts: new Date(T0).toISOString() });
    expect(result.messages[1]).toMatchObject({ pr: 'ashlrai/phantom#6670', job: null });
    expect(read(root, { agent: 'grok-3' }).messages.map(m => m.id)).toEqual(['m3', 'm2']);
    expect(read(root, { since: T0 + 1_500 }).messages.map(m => m.id)).toEqual(['m3']);
    expect(read(root, { limit: 1 })).toMatchObject({ matched: 3, messages: [{ id: 'm3' }] });
    expect(formatAgentMessagesText(read(root))).toContain('handoff claude-1 (claude) → codex-local-2 (codex-local): handoff task RQ-CHAINA1: Take over the parser fix  [RQ-CHAINA1]');
  });

  it('matches --agent and --with through the identity registry, never widening without it', () => {
    const root = store();
    expect(registerAgentIdentity({ handle: 'atlas', aliases: ['devin-cloud'] }, { root }).status).toBe('created');
    post(root, T0, { id: 'i1', from: 'agent:atlas', to: 'agent:claude-1', body: { kind: 'note', text: 'handle label' } });
    post(root, T0 + 1_000, { id: 'i2', from: 'devin-cloud', to: 'agent:claude-1', body: { kind: 'note', text: 'alias label' } });
    post(root, T0 + 2_000, { id: 'i3', from: 'grok-9', to: 'agent:claude-1', body: { kind: 'note', text: 'other agent' } });
    // An alias query finds every label of the one identity, newest first.
    expect(read(root, { agent: 'devin-cloud' }).messages.map(m => m.id)).toEqual(['i2', 'i1']);
    expect(read(root, { agent: 'atlas' }).messages.map(m => m.id)).toEqual(['i2', 'i1']);
    // --with narrows the pair across labels on both sides.
    expect(read(root, { agent: 'atlas', with: 'claude-1' }).messages.map(m => m.id)).toEqual(['i2', 'i1']);
    // An unregistered label still matches only its exact name or lane.
    expect(read(root, { agent: 'grok-9' }).messages.map(m => m.id)).toEqual(['i3']);
    expect(read(root, { agent: 'nobody' }).messages).toEqual([]);
    // A damaged registry reads unavailable: the filter falls back to strict labels.
    writeFileSync(join(root, 'agent-identities', 'registry.json'), '{"broken"', { mode: 0o600 });
    expect(read(root, { agent: 'devin-cloud' }).messages.map(m => m.id)).toEqual(['i2']);
    // No registry at all is the same strict read.
    const bare = store();
    post(bare, T0, { id: 'i1', from: 'agent:atlas', to: 'agent:claude-1', body: { kind: 'note', text: 'handle label' } });
    post(bare, T0 + 1_000, { id: 'i2', from: 'devin-cloud', to: 'agent:claude-1', body: { kind: 'note', text: 'alias label' } });
    expect(read(bare, { agent: 'devin-cloud' }).messages.map(m => m.id)).toEqual(['i2']);
  });

  it('skips and counts a malformed record instead of failing the whole read', () => {
    const root = store();
    post(root, T0, { id: 'good-1', from: 'a', to: 'b', body: { kind: 'note', text: 'first' } });
    post(root, T0 + 1, { id: 'good-2', from: 'b', to: 'a', body: { kind: 'note', text: 'second' } });
    const file = join(root, 'bus-inbox', 'messages.json');
    const snapshot = JSON.parse(readFileSync(file, 'utf8')) as { rows: unknown[] };
    snapshot.rows.splice(1, 0, { cursor: 'x', receivedAt: T0, envelope: { id: 'broken' } });
    writeFileSync(file, JSON.stringify(snapshot), { mode: 0o600 });
    // The strict writer path still refuses damaged storage.
    expect(listBusInboxAfter(0, 50, { root, now: () => T0 + 10 }).status).toBe('unavailable');
    expect(scanBusInbox({ root, now: () => T0 + 10 })).toMatchObject({ source: 'available', skipped: 1 });
    const result = read(root);
    expect(result).toMatchObject({ source: 'available', skipped: 1, matched: 2 });
    expect(result.messages.map(m => m.id)).toEqual(['good-2', 'good-1']);
    expect(formatAgentMessagesText(result)).toContain('Skipped 1 damaged bus record.');
  });

  it('redacts a secret-shaped value from summaries', () => {
    const root = store();
    const secret = ['ghp', '_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'].join('');
    post(root, T0, { id: 's1', from: 'claude', to: 'codex-cmp', body: { kind: 'note', text: `use token ${secret} for the push` } });
    const out = JSON.stringify(read(root));
    expect(out).not.toContain(secret);
    expect(read(root).messages[0]!.summary).toMatch(/^use token .*REDACTED.* for the push$/i);
  });

  it('emits stable JSON: fixed key order and deterministic output', () => {
    const root = store();
    post(root, T0, { id: 'k1', from: 'claude', to: 'grok', body: { kind: 'cos-blocked', reason: 'CI red on master' } });
    post(root, T0, { id: 'k2', from: 'grok', to: 'claude', body: { kind: 'work.status', status: 'running' } });
    const first = JSON.stringify(read(root)), second = JSON.stringify(read(root));
    expect(first).toBe(second);
    const parsed = JSON.parse(first) as { messages: Record<string, unknown>[] };
    expect(Object.keys(parsed)).toEqual(['schema', 'source', 'messages', 'matched', 'skipped']);
    expect(Object.keys(parsed.messages[0]!)).toEqual(['id', 'ts', 'priority', 'from', 'to', 'kind', 'summary', 'conversation', 'job', 'pr']);
    // Same timestamp: cursor order breaks the tie, newest cursor first.
    expect(parsed.messages.map(m => [m.id, m.kind])).toEqual([['k2', 'status'], ['k1', 'blocker']]);
  });

  it('summarizes v2 work bodies from typed fields, threads them by job, never prints tokens', () => {
    const root = store();
    post(root, T0, { id: 'w1', from: 'peer-a', to: 'peer-b',
      body: { kind: 'work.post', jobId: 'RQ-PEER1', title: 'Fix the parser', repo: 'ashlrai/phantom', provider: 'devin',
        claimKeys: ['repo:ashlrai/phantom', 'queue:peer-work-abc'],
        dispatch: { tier: 'work', scope: 'scope text', acceptance: 'acceptance text' } } });
    post(root, T0 + 1_000, { id: 'w2', from: 'peer-b', to: 'peer-a',
      body: { kind: 'work.result', jobId: 'RQ-PEER1', claimKey: 'queue:peer-work-abc',
        queueId: 'peer-work-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', receiptId: 'pw-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        outcome: 'admitted' } });
    post(root, T0 + 2_000, { id: 'w3', from: 'peer-b', to: 'peer-a',
      body: { kind: 'work.result', jobId: 'RQ-PEER1', claimKey: 'queue:peer-work-abc',
        queueId: 'peer-work-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', receiptId: 'pw-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        outcome: 'failed', reason: 'repo-not-allowed' } });
    post(root, T0 + 3_000, { id: 'w4', from: 'peer-a', to: 'peer-b',
      body: { kind: 'work.status', jobId: 'RQ-PEER1', status: 'blocked', detail: 'waiting on review' } });
    post(root, T0 + 4_000, { id: 'w5', from: 'peer-b', to: 'peer-a',
      body: { kind: 'work.claim', op: 'acquire', jobId: 'RQ-PEER1', claimKey: 'repo:ashlrai/phantom', owner: 'peer-b', leaseMs: 60_000 } });
    post(root, T0 + 5_000, { id: 'w6', from: 'peer-b', to: 'peer-a',
      body: { kind: 'work.claim', op: 'renew', claimKey: 'repo:ashlrai/phantom', token: 'e'.repeat(64), leaseMs: 60_000 } });
    post(root, T0 + 6_000, { id: 'w7', from: 'peer-a', to: 'peer-b',
      body: { kind: 'work.release', claimKey: 'repo:ashlrai/phantom', token: 'f'.repeat(64), outcome: 'released' } });
    const result = read(root);
    const byId = new Map(result.messages.map(m => [m.id, m]));
    expect(byId.get('w1')).toMatchObject({ kind: 'ask', summary: 'work.post RQ-PEER1: Fix the parser (ashlrai/phantom)', job: 'RQ-PEER1', conversation: 'job:RQ-PEER1' });
    expect(byId.get('w2')).toMatchObject({ kind: 'reply', summary: 'admitted', conversation: 'job:RQ-PEER1', job: 'RQ-PEER1' });
    expect(byId.get('w3')).toMatchObject({ kind: 'blocker', summary: 'failed: repo-not-allowed', conversation: 'job:RQ-PEER1', job: 'RQ-PEER1' });
    expect(byId.get('w4')).toMatchObject({ kind: 'blocker', summary: 'blocked: waiting on review', conversation: 'job:RQ-PEER1' });
    expect(byId.get('w5')).toMatchObject({ summary: 'acquire repo:ashlrai/phantom', conversation: 'job:RQ-PEER1' });
    // work.claim renew and work.release name only a claimKey; the newest post
    // listing it owns the job thread and the job link.
    expect(byId.get('w6')).toMatchObject({ summary: 'renew repo:ashlrai/phantom', conversation: 'job:RQ-PEER1', job: 'RQ-PEER1' });
    expect(byId.get('w7')).toMatchObject({ summary: 'release repo:ashlrai/phantom: released', conversation: 'job:RQ-PEER1', job: 'RQ-PEER1' });
    // Claim tokens and dispatch internals never reach a summary or the read.
    const out = JSON.stringify(result);
    expect(out).not.toContain('e'.repeat(64));
    expect(out).not.toContain('f'.repeat(64));
    expect(out).not.toContain('pw-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  });

  it('annotates feed-citing bodies with the live job state agents bus resolves', () => {
    const root = store();
    post(root, T0, { id: 'j1', from: 'agent:planner', to: 'leaders',
      body: { kind: 'work.post', jobId: 'RQ-FEED1', title: 'Fix the feed', repo: 'a/b',
        claimKeys: ['repo:a/b'], provider: 'devin' } });
    post(root, T0 + 1_000, { id: 'j2', from: 'agent:planner', to: 'agent:worker',
      body: { kind: 'work.status', jobId: 'RQ-FEED1', status: 'running', detail: 'halfway' } });
    post(root, T0 + 2_000, { id: 'j3', from: 'agent:worker', to: 'agent:planner',
      body: { kind: 'work.result', jobId: 'RQ-FEED1', claimKey: 'repo:a/b',
        queueId: 'peer-work-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', receiptId: 'pw-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        outcome: 'admitted' } });
    post(root, T0 + 3_000, { id: 'j4', from: 'agent:worker', to: 'agent:planner',
      body: { kind: 'work.claim', op: 'acquire', jobId: 'RQ-FEED1', claimKey: 'repo:a/b', owner: 'agent:worker', leaseMs: 60_000 } });
    post(root, T0 + 4_000, { id: 'j5', from: 'agent:worker', to: 'agent:planner',
      body: { kind: 'wake', target: 'agent:planner', jobId: 'RQ-FEED1', reason: 'the feed has work' } });
    post(root, T0 + 5_000, { id: 'j6', from: 'agent:worker', to: 'agent:planner',
      body: { kind: 'work.status', jobId: 'RQ-GONE9', status: 'running' } });
    const byId = new Map(read(root).messages.map(m => [m.id, m]));
    // post, status, result and wake cite the feed; the job's live state and its
    // retained post/status receipts ride along, the same read `agents bus show` gives.
    for (const id of ['j1', 'j2', 'j3', 'j5']) {
      expect(byId.get(id)!.jobState).toMatchObject({ jobId: 'RQ-FEED1', feed: 'ok',
        job: { id: 'RQ-FEED1', status: 'running', postId: 'j1', statusId: 'j2' } });
    }
    // An orphaned citation resolves feed-ok with no live job — never a guess.
    expect(byId.get('j6')!.jobState).toEqual({ jobId: 'RQ-GONE9', feed: 'ok', job: null });
    // work.claim executes as an operation: its jobId is a parameter, not a citation.
    expect(byId.get('j4')).not.toHaveProperty('jobState');
    // The human line prints the same job marker the inbox frame uses — the
    // feed job's newest work.result outcome rides along as evidence.
    expect(formatAgentMessagesText(read(root))).toContain('job=RQ-FEED1:running result=admitted');
  });

  it('annotates worker-handoff taskIds with the same live job state', () => {
    const root = store();
    post(root, T0, { id: 'h1', from: 'agent:planner', to: 'leaders',
      body: { kind: 'work.post', jobId: 'RQ-HOFEED', title: 'Hand off', repo: 'a/b',
        claimKeys: ['repo:a/b'], provider: 'devin' } });
    post(root, T0 + 1_000, { id: 'h2', from: 'agent:planner', to: 'agent:worker',
      body: { kind: 'worker-handoff', taskId: 'RQ-HOFEED', prompt: 'take it over' } });
    // A handoff-shaped body handoff-receive would refuse cites no job state.
    post(root, T0 + 2_000, { id: 'h3', from: 'agent:planner', to: 'agent:worker',
      body: { kind: 'worker-handoff', taskId: 'RQ-HOFEED' } });
    const byId = new Map(read(root).messages.map(m => [m.id, m]));
    // The receivable handoff's taskId resolves the same feed job the post announced.
    expect(byId.get('h2')).toMatchObject({ kind: 'handoff', job: 'RQ-HOFEED',
      jobState: { jobId: 'RQ-HOFEED', feed: 'ok', job: { id: 'RQ-HOFEED', status: 'queued' } } });
    expect(byId.get('h3')).not.toHaveProperty('jobState');
    expect(formatAgentMessagesText(read(root))).toContain('job=RQ-HOFEED:queued');
  });

  it('reports a poisoned feed as refused on every citation, never a guessed state', () => {
    const root = store();
    post(root, T0, { id: 'p1', from: 'agent:planner', to: 'leaders',
      body: { kind: 'work.post', jobId: 'RQ-OK1', title: 'ok', repo: 'a/b',
        claimKeys: ['repo:a/b'], provider: 'devin' } });
    // A post with no resolvable provider refuses the whole feed projection.
    post(root, T0 + 1_000, { id: 'p2', from: 'agent:ghost', to: 'leaders',
      body: { kind: 'work.post', jobId: 'RQ-BAD', title: 'x', repo: 'a/b', claimKeys: [] } });
    const byId = new Map(read(root).messages.map(m => [m.id, m]));
    expect(byId.get('p1')!.jobState).toMatchObject({ jobId: 'RQ-OK1', feed: 'refused', reason: 'missing-provider' });
    expect(byId.get('p2')!.jobState).toMatchObject({ jobId: 'RQ-BAD', feed: 'refused',
      reason: 'missing-provider', receipt: { id: 'p2' } });
  });

  it('reads job and pr links from declared note refs ahead of prose mentions', () => {
    const root = store();
    post(root, T0, { id: 'r1', from: 'a', to: 'b',
      body: { kind: 'note', text: 'unrelated mention of RQ-PROSE-1 and ashlrai/phantom#99',
        refs: ['RQ-REF-1', 'pr:ashlrai/phantom#42'] } });
    post(root, T0 + 1_000, { id: 'r2', from: 'a', to: 'b', body: { kind: 'note', text: 'no refs here' } });
    const result = read(root);
    const byId = new Map(result.messages.map(m => [m.id, m]));
    expect(byId.get('r1')).toMatchObject({ job: 'RQ-REF-1', pr: 'ashlrai/phantom#42' });
    expect(byId.get('r2')).toMatchObject({ job: null, pr: null });
  });

  it('keeps unknown work fields honest: no jobId means no job thread, malformed falls back', () => {
    const root = store();
    post(root, T0, { id: 'u1', from: 'a', to: 'b', body: { kind: 'work.status', status: 'running' } });
    post(root, T0 + 1_000, { id: 'u2', from: 'a', to: 'b', body: { kind: 'work.status' } });
    post(root, T0 + 2_000, { id: 'u3', from: 'a', to: 'b',
      body: { kind: 'work.result', outcome: 'complete', claimKey: 'repo:ashlrai/phantom' } });
    const result = read(root);
    const byId = new Map(result.messages.map(m => [m.id, m]));
    expect(byId.get('u1')).toMatchObject({ summary: 'running', conversation: 'pair:a|b', job: null });
    expect(byId.get('u2')).toMatchObject({ summary: 'work.status', conversation: 'pair:a|b' });
    expect(byId.get('u3')).toMatchObject({ summary: 'complete', kind: 'reply', conversation: 'pair:a|b', job: null });
  });

  it('reads slack-coordination messageType as the declared ask or reply', () => {
    const root = store();
    const slack = (id: string, at: number, messageType: string, text: string, over: Record<string, unknown> = {}) =>
      post(root, at, { id, from: 'agent:peer-a', to: 'agent:peer-b', channel: 'slack', channel_ref: 'T1/C1/1.2',
        sender: { agent_id: 'agent:peer-a', vendor: 'peer', human: false, team: true }, external: false, origin_bridge: 'remote-bridge',
        body: { kind: 'slack-coordination', trust: 'untrusted', messageType, routeMode: 'peer', text,
          messageId: 'm-1', inReplyTo: null, workspaceId: 'T1', channelId: 'C1', threadTs: '1.2', eventTs: '1.2',
          originBridge: 'remote-bridge', visitedBridges: ['remote-bridge', 'local-bridge'], ...over } });
    slack('s1', T0, 'request', 'can you pick up the review?');
    slack('s2', T0 + 1_000, 'request', 'second ask', { inReplyTo: 'remote-9' });
    slack('s3', T0 + 2_000, 'reply', 'done, PR is up');
    slack('s4', T0 + 3_000, 'status', 'still working', { inReplyTo: 'remote-9' });
    slack('s5', T0 + 4_000, 'note', 'fyi only');
    const result = read(root);
    const byId = new Map(result.messages.map(m => [m.id, m]));
    // The declared type wins over text shape and local reply hints: a request
    // asks even when threaded, a reply answers even without inReplyTo.
    expect(byId.get('s1')).toMatchObject({ kind: 'ask', summary: 'slack-coordination request peer: can you pick up the review?' });
    expect(byId.get('s2')).toMatchObject({ kind: 'ask' });
    expect(byId.get('s3')).toMatchObject({ kind: 'reply', summary: 'slack-coordination reply peer: done, PR is up' });
    // Unmapped types keep the existing heuristics: inReplyTo still reads as a reply.
    expect(byId.get('s4')).toMatchObject({ kind: 'reply' });
    expect(byId.get('s5')).toMatchObject({ kind: 'status' });
  });

  it('summarizes channel, notice and wake bodies with the same composer as the inbox frame', () => {
    const root = store();
    post(root, T0, { id: 'c1', from: 'mason', to: 'leaders',
      body: { kind: 'interjection', channel: 'telegram', text: 'how is the fleet?', receivedAt: T0, dedupeKey: 'd1' } });
    post(root, T0 + 1_000, { id: 'c2', from: 'agent:claude-1', to: 'leaders',
      body: { kind: 'owner-thread', threadId: 't-9', channel: 'imessage', redacted: true } });
    post(root, T0 + 2_000, { id: 'c3', from: 'desktop', to: 'agent:claude-1',
      body: { kind: 'desktop.intent', verb: 'click', app: 'Slack', window: 'compose', chars: 42 } });
    post(root, T0 + 3_000, { id: 'c4', from: 'agent:peer-a', to: 'agent:claude-1',
      body: { kind: 'wake', target: 'agent:claude-1', jobId: 'RQ-WAKE9', reason: 'the feed has work for you' } });
    // A kind the composer does not know keeps the legacy text fallback.
    post(root, T0 + 4_000, { id: 'c5', from: 'a', to: 'b', body: { kind: 'unlisted-kind', text: 'plain words' } });
    const byId = new Map(read(root).messages.map(m => [m.id, m]));
    expect(byId.get('c1')).toMatchObject({ summary: 'interjection telegram: how is the fleet?', kind: 'ask' });
    expect(byId.get('c2')).toMatchObject({ summary: 'owner-thread imessage: redacted' });
    expect(byId.get('c3')).toMatchObject({ summary: 'desktop.intent click Slack: compose 42 chars' });
    expect(byId.get('c4')).toMatchObject({ summary: 'wake agent:claude-1 (RQ-WAKE9): the feed has work for you', job: 'RQ-WAKE9', conversation: 'job:RQ-WAKE9' });
    expect(byId.get('c5')).toMatchObject({ summary: 'plain words' });
  });

  it('validates flags and reads relative --since', () => {
    expect(parseSince('15m', T0)).toBe(T0 - 900_000);
    expect(parseSince('2026-11-17T00:00:00Z')).toBe(Date.UTC(2026, 10, 17));
    expect(parseSince('soon')).toBeNull();
    expect(parseAgentMessagesQuery({ limit: '0' }).ok).toBe(false);
    expect(parseAgentMessagesQuery({ limit: '5000' }).ok).toBe(false);
    expect(parseAgentMessagesQuery({ agent: 'bad name' }).ok).toBe(false);
    expect(parseAgentMessagesQuery({ since: '1h', agent: 'claude', limit: '10' }, T0)).toEqual({ ok: true, query: { since: T0 - 3_600_000, agent: 'claude', limit: 10 } });
  });

  it('filters to one classified kind and counts only the rows it accepts', () => {
    const root = store();
    post(root, T0, { id: 'q1', from: 'a', to: 'b', body: { kind: 'note', text: 'can you review the parser?' } });
    post(root, T0 + 1_000, { id: 'r1', from: 'b', to: 'a', body: { kind: 'note', text: 'looks good', replyTo: 'q1' } });
    post(root, T0 + 2_000, { id: 's1', from: 'a', to: 'b', body: { kind: 'work.status', jobId: 'RQ-KIND1', status: 'running' } });
    post(root, T0 + 3_000, { id: 'x1', from: 'a', to: 'b', body: { kind: 'cos-blocked', reason: 'CI red on master' } });
    const asks = read(root, { kind: 'ask' });
    expect(asks.messages.map(m => m.id)).toEqual(['q1']);
    expect(asks.matched).toBe(1);
    const blockers = read(root, { kind: 'blocker' });
    expect(blockers.messages.map(m => m.id)).toEqual(['x1']);
    expect(blockers.matched).toBe(1);
    // Kind composes with the other filters; an unmatched kind is an empty page, not an error.
    const scoped = read(root, { kind: 'reply', agent: 'a' });
    expect(scoped.messages.map(m => m.id)).toEqual(['r1']);
    expect(read(root, { kind: 'handoff' }).messages).toEqual([]);
    expect(read(root, { kind: 'handoff' }).matched).toBe(0);
  });

  it('parses --kind case-insensitively and refuses an unknown kind', () => {
    expect(parseAgentMessagesQuery({ kind: 'ASK' })).toEqual({ ok: true, query: { kind: 'ask' } });
    expect(parseAgentMessagesQuery({ kind: 'blocker', limit: '5' })).toEqual({ ok: true, query: { kind: 'blocker', limit: 5 } });
    expect(parseAgentMessagesQuery({ kind: 'chatter' }).ok).toBe(false);
    expect(parseAgentMessagesQuery({ kind: '' }).ok).toBe(false);
  });

  it('carries the envelope priority band on every row and filters reads by it', () => {
    const root = store();
    post(root, T0, { id: 'p0', from: 'a', to: 'b', priority: 'P0', body: { kind: 'note', text: 'page the on-call now' } });
    post(root, T0 + 1_000, { id: 'p2', from: 'b', to: 'a', body: { kind: 'note', text: 'status update' } });
    post(root, T0 + 2_000, { id: 'p3', from: 'a', to: 'b', priority: 'P3', body: { kind: 'note', text: 'fyi whenever' } });
    const byId = new Map(read(root).messages.map(m => [m.id, m]));
    expect(byId.get('p0')).toMatchObject({ priority: 'P0' });
    expect(byId.get('p2')).toMatchObject({ priority: 'P2' });
    expect(byId.get('p3')).toMatchObject({ priority: 'P3' });
    // --priority keeps only one band — the same exact match comms bus read
    // --priority applies — composes with the other filters, and matched
    // counts only the rows it accepts.
    expect(read(root, { priority: 'P0' })).toMatchObject({ matched: 1, messages: [{ id: 'p0', priority: 'P0' }] });
    expect(read(root, { priority: 'P2' }).messages.map(m => m.id)).toEqual(['p2']);
    expect(read(root, { priority: 'P3', agent: 'a' }).messages.map(m => m.id)).toEqual(['p3']);
    expect(read(root, { priority: 'P1' })).toMatchObject({ matched: 0, messages: [] });
    // The human line prints the band so urgent traffic stands out in --text.
    expect(formatAgentMessagesText(read(root))).toContain('P0 status');
  });

  it('parses --priority as an exact band and refuses anything else', () => {
    expect(parseAgentMessagesQuery({ priority: 'P0' })).toEqual({ ok: true, query: { priority: 'P0' } });
    expect(parseAgentMessagesQuery({ priority: 'P3', kind: 'ask', limit: '5' })).toEqual({ ok: true, query: { kind: 'ask', priority: 'P3', limit: 5 } });
    expect(parseAgentMessagesQuery({ priority: 'p0' }).ok).toBe(false);
    expect(parseAgentMessagesQuery({ priority: 'P9' }).ok).toBe(false);
    expect(parseAgentMessagesQuery({ priority: '' }).ok).toBe(false);
  });

  it('filters to one job across citations, thread members and claim operations', () => {
    const root = store();
    post(root, T0, { id: 'j1', from: 'agent:planner', to: 'leaders',
      body: { kind: 'work.post', jobId: 'RQ-JOB1', title: 'Fix the parser', repo: 'a/b',
        claimKeys: ['repo:a/b'], provider: 'devin' } });
    post(root, T0 + 1_000, { id: 'j2', from: 'agent:worker', to: 'agent:planner',
      body: { kind: 'work.status', jobId: 'RQ-JOB1', status: 'running' } });
    post(root, T0 + 2_000, { id: 'j3', from: 'agent:planner', to: 'agent:worker',
      body: { kind: 'worker-handoff', taskId: 'RQ-JOB1', prompt: 'take it over' } });
    // work.claim is an operation, not a citation: no jobState, but the row's
    // own job link and job:<id> conversation still tie it to the job.
    post(root, T0 + 3_000, { id: 'j4', from: 'agent:worker', to: 'agent:planner',
      body: { kind: 'work.claim', op: 'acquire', jobId: 'RQ-JOB1', claimKey: 'repo:a/b', owner: 'agent:worker', leaseMs: 60_000 } });
    // A reply into the job's conversation inherits the job:<id> bucket.
    post(root, T0 + 4_000, { id: 'j5', from: 'agent:worker', to: 'agent:planner',
      body: { kind: 'note', text: 'halfway there', replyTo: 'j2' } });
    // A note carrying the job:<id> thread label joins the same bucket.
    post(root, T0 + 5_000, { id: 't1', from: 'a', to: 'b',
      body: { kind: 'note', text: 'fyi on the job', thread: 'job:RQ-JOB1' } });
    // The row's job link is the projection's own call — a declared ref or a
    // prose mention the summary carries both count.
    post(root, T0 + 6_000, { id: 'p1', from: 'a', to: 'b',
      body: { kind: 'note', text: 'RQ-JOB1 looks close to done' } });
    // Another job's post and plain uncited traffic never pass the filter.
    post(root, T0 + 7_000, { id: 'x1', from: 'agent:planner', to: 'leaders',
      body: { kind: 'work.post', jobId: 'RQ-JOB2', title: 'Other work', repo: 'a/c',
        claimKeys: ['repo:a/c'], provider: 'devin' } });
    post(root, T0 + 8_000, { id: 'n1', from: 'a', to: 'b', body: { kind: 'note', text: 'lunch?' } });
    const job1 = read(root, { job: 'RQ-JOB1' });
    expect(job1.messages.map(m => m.id)).toEqual(['p1', 't1', 'j5', 'j4', 'j3', 'j2', 'j1']);
    expect(job1.matched).toBe(7);
    expect(job1.messages.find(m => m.id === 'j4')).not.toHaveProperty('jobState');
    expect(job1.messages.find(m => m.id === 'j5')).not.toHaveProperty('jobState');
    expect(job1.messages.find(m => m.id === 'j3')!.jobState).toMatchObject({ jobId: 'RQ-JOB1' });
    // The other job and uncited mail stay out; an unknown job is an empty page.
    expect(read(root, { job: 'RQ-JOB2' }).messages.map(m => m.id)).toEqual(['x1']);
    expect(read(root, { job: 'RQ-GONE' })).toMatchObject({ matched: 0, messages: [] });
    // --job composes with the other filters and matched still counts only
    // the rows every filter accepts; limit caps the page, not the count.
    expect(read(root, { job: 'RQ-JOB1', kind: 'handoff' }).messages.map(m => m.id)).toEqual(['j3']);
    expect(read(root, { job: 'RQ-JOB1', agent: 'planner' }).messages.map(m => m.id))
      .toEqual(['j5', 'j4', 'j3', 'j2', 'j1']);
    expect(read(root, { job: 'RQ-JOB1', limit: 2 })).toMatchObject({ matched: 7, messages: [{ id: 'p1' }, { id: 't1' }] });
  });

  it('parses --job as a printable label and refuses anything else', () => {
    expect(parseAgentMessagesQuery({ job: 'RQ-JOB1' })).toEqual({ ok: true, query: { job: 'RQ-JOB1' } });
    expect(parseAgentMessagesQuery({ job: 'RQ-JOB1', kind: 'ask', limit: '5' })).toEqual({ ok: true, query: { job: 'RQ-JOB1', kind: 'ask', limit: 5 } });
    expect(parseAgentMessagesQuery({ job: 'has space' }).ok).toBe(false);
    expect(parseAgentMessagesQuery({ job: '' }).ok).toBe(false);
    expect(parseAgentMessagesQuery({ job: 'x'.repeat(129) }).ok).toBe(false);
  });

  it('filters to one v2 thread label — the same busBodyThread match every bus read applies', () => {
    const root = store();
    post(root, T0, { id: 't1', from: 'a', to: 'b',
      body: { kind: 'note', text: 'question on the parser?', thread: 't-parser' } });
    post(root, T0 + 1_000, { id: 't2', from: 'b', to: 'a',
      body: { kind: 'context', text: 'the context the thread needs', thread: 't-parser' } });
    // A different label, a note without the field and a non-note/context body
    // carrying a thread-shaped field never match.
    post(root, T0 + 2_000, { id: 't3', from: 'a', to: 'b',
      body: { kind: 'note', text: 'other thread', thread: 't-other' } });
    post(root, T0 + 3_000, { id: 't4', from: 'a', to: 'b', body: { kind: 'note', text: 'no label' } });
    post(root, T0 + 4_000, { id: 't5', from: 'a', to: 'b',
      body: { kind: 'worker-handoff', taskId: 'RQ-T1', prompt: 'take it', thread: 't-parser' } });
    const thread = read(root, { thread: 't-parser' });
    expect(thread.messages.map(m => m.id)).toEqual(['t2', 't1']);
    expect(thread.matched).toBe(2);
    // --thread composes with the other filters; an unmatched label is an
    // empty page, not an error, and matched counts only accepted rows.
    expect(read(root, { thread: 't-parser', kind: 'ask' }).messages.map(m => m.id)).toEqual(['t1']);
    expect(read(root, { thread: 't-parser', kind: 'reply' })).toMatchObject({ matched: 0, messages: [] });
    expect(read(root, { thread: 't-gone' })).toMatchObject({ matched: 0, messages: [] });
    expect(read(root, { thread: 't-parser', limit: 1 })).toMatchObject({ matched: 2, messages: [{ id: 't2' }] });
  });

  it('parses --thread as a printable label and refuses anything else', () => {
    expect(parseAgentMessagesQuery({ thread: 't-parser' })).toEqual({ ok: true, query: { thread: 't-parser' } });
    expect(parseAgentMessagesQuery({ thread: 't-parser', kind: 'ask', limit: '5' })).toEqual({ ok: true, query: { thread: 't-parser', kind: 'ask', limit: 5 } });
    expect(parseAgentMessagesQuery({ thread: 'has space' }).ok).toBe(false);
    expect(parseAgentMessagesQuery({ thread: '' }).ok).toBe(false);
    expect(parseAgentMessagesQuery({ thread: 'x'.repeat(129) }).ok).toBe(false);
  });

  it('filters to messages whose scrubbed summary carries the needle', () => {
    const root = store();
    post(root, T0, { id: 'c1', from: 'a', to: 'b', body: { kind: 'note', text: 'the parser fix is ready for review' } });
    post(root, T0 + 1_000, { id: 'c2', from: 'b', to: 'a', body: { kind: 'note', text: 'ship the renderer tweak instead' } });
    post(root, T0 + 2_000, { id: 'c3', from: 'a', to: 'b', body: { kind: 'note', text: 'PARSER follow-up landed' } });
    // Case-insensitive substring over the scrubbed one-line summary the row shows.
    const hits = read(root, { contains: 'parser' });
    expect(hits.messages.map(m => m.id)).toEqual(['c3', 'c1']);
    expect(hits.matched).toBe(2);
    // Whitespace collapses the same way the summary's does, so stray spacing still finds its line.
    expect(read(root, { contains: '  RENDERER   tweak ' }).messages.map(m => m.id)).toEqual(['c2']);
    // --contains composes with the other filters; matched counts only the rows
    // every filter accepts and limit caps the page, not the count.
    expect(read(root, { contains: 'parser', agent: 'a' }).messages.map(m => m.id)).toEqual(['c3', 'c1']);
    expect(read(root, { contains: 'parser', kind: 'reply' })).toMatchObject({ matched: 0, messages: [] });
    expect(read(root, { contains: 'parser', limit: 1 })).toMatchObject({ matched: 2, messages: [{ id: 'c3' }] });
    // A needle no summary carries is an empty page, not an error.
    expect(read(root, { contains: 'nonexistent-needle' })).toMatchObject({ matched: 0, messages: [] });
  });

  it('never lets --contains reach past the scrubbed summary into the raw body', () => {
    const root = store();
    const secret = ['ghp', '_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'].join('');
    post(root, T0, { id: 'sec', from: 'a', to: 'b', body: { kind: 'note', text: `token ${secret} leaked` } });
    // The needle matches the scrubbed summary, so the raw secret text is
    // unfindable even though it sits in the stored body; the redaction marker
    // it left behind is the only searchable trace.
    expect(read(root, { contains: secret })).toMatchObject({ matched: 0, messages: [] });
    expect(read(root, { contains: 'REDACTED' }).messages.map(m => m.id)).toEqual(['sec']);
  });

  it('parses --contains as bounded free text and refuses empty or oversized needles', () => {
    expect(parseAgentMessagesQuery({ contains: 'parser fix' })).toEqual({ ok: true, query: { contains: 'parser fix' } });
    expect(parseAgentMessagesQuery({ contains: 'a', kind: 'ask', limit: '5' })).toEqual({ ok: true, query: { kind: 'ask', contains: 'a', limit: 5 } });
    expect(parseAgentMessagesQuery({ contains: '' }).ok).toBe(false);
    expect(parseAgentMessagesQuery({ contains: '   ' }).ok).toBe(false);
    expect(parseAgentMessagesQuery({ contains: 'x'.repeat(513) }).ok).toBe(false);
    expect(parseAgentMessagesQuery({ contains: 'x'.repeat(512) }).ok).toBe(true);
  });

  it('serves the same read at GET /api/verse/agent-bus/messages', async () => {
    const calls: unknown[] = [];
    const api = createAgentBusApi({ messages: query => { calls.push(query); return { schema: 'agent-messages.v1', source: 'missing', messages: [], matched: 0, skipped: 0 }; } });
    const ctx = { readSession: { expiresAt: Date.now() + 60_000 } } as never;
    const send = async (url: string) => {
      let status = 0, body = '';
      const res = { writeHead: (s: number) => { status = s; return res; }, setHeader: () => res, end: (b?: string) => { body = b ?? ''; }, statusCode: 0 } as never;
      const handled = await api(ctx, { url, headers: {} } as never, res, url.split('?')[0]!, 'GET');
      return { handled, status: status || (res as { statusCode: number }).statusCode, body };
    };
    const ok = await send('/api/verse/agent-bus/messages?agent=claude&kind=ask&priority=P0&job=RQ-JOB1&thread=t-1&contains=parser%20fix&limit=5');
    expect(ok.handled).toBe(true);
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body)).toMatchObject({ schema: 'agent-messages.v1' });
    expect(calls).toEqual([{ kind: 'ask', priority: 'P0', job: 'RQ-JOB1', thread: 't-1', contains: 'parser fix', agent: 'claude', limit: 5 }]);
    expect((await send('/api/verse/agent-bus/messages?limit=0')).status).toBe(400);
    expect((await send('/api/verse/agent-bus/messages?kind=chatter')).status).toBe(400);
    expect((await send('/api/verse/agent-bus/messages?priority=urgent')).status).toBe(400);
    expect((await send('/api/verse/agent-bus/messages?job=has%20space')).status).toBe(400);
    expect((await send('/api/verse/agent-bus/messages?thread=has%20space')).status).toBe(400);
    expect((await send('/api/verse/agent-bus/messages?contains=')).status).toBe(400);
    expect((await send('/api/verse/agent-bus/messages?after=1')).status).toBe(400);
  });
});
