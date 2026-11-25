/**
 * fleet bus-thread live evidence: `readBusThread`'s opt-in `liveEvidence`
 * read annotates each thread message with the same `held`/`holder`/`job`/
 * `fromAgent` fields `agents bus inbox`, `agents bus channel read` and
 * `agents bus show` report through the shared `annotateLiveEvidence` —
 * while the raw read the worker-run prompt path uses stays untouched, and
 * an unreadable hold store degrades the answer to unknown, never free.
 *
 * Hermetic: temp fleet roots, real bus-inbox/claims/coordination/registry/
 * work-feed stores, no home directory access.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetBusThread } from '../src/cli/fleet-bus-thread.js';
import { registerAgentIdentity } from '../src/core/agents/bus-identity.js';
import { announceWork } from '../src/core/agents/bus-unified.js';
import { acquireCoordination } from '../src/core/agents/claim-store.js';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';
import { mutateBusWorkClaim } from '../src/core/fleet/bus-work-claims.js';
import { readBusThread } from '../src/core/fleet/bus-thread-context.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function setup(at = Date.now()) {
  const base = mkdtempSync(join(tmpdir(), 'bus-thread-evidence-'));
  dirs.push(base);
  const clock = { now: at };
  const options = { root: join(base, 'fleet'), runsRoot: join(base, 'runs'), now: () => clock.now, clock };
  const post = (id: string, from: string, to: string, body: unknown, inReplyTo?: string): void => {
    expect(appendBusInbox({ id, from, to, priority: 'P2', ttl: 120_000,
      body: inReplyTo === undefined ? body : { ...(body as Record<string, unknown>), inReplyTo } },
      { root: options.root, now: options.now }).status).toBe('posted');
  };
  return { base, clock, options, post };
}

function register(options: ReturnType<typeof setup>['options'], ...handles: string[]): void {
  for (const handle of handles) expect(registerAgentIdentity({ handle }, options).status).toBe('created');
}

describe('readBusThread live evidence', () => {
  it('annotates held, holder, job and fromAgent only when liveEvidence is asked', async () => {
    const { options, post } = setup();
    register(options, 'atlas', 'nova');
    registerAgentIdentity({ handle: 'atlas', runtime: { cli: 'claude', provider: 'claude', model: null } }, options);
    // One thread rooted at a note: a message-id-claimed work body, a free
    // work body, and a kindless reply from a sender the registry cannot
    // resolve. A worker-handoff body is strict — kind/taskId/prompt only —
    // so it can never carry inReplyTo and only ever roots its own thread.
    post('t-root', 'agent:atlas', 'agent:nova', { kind: 'note', text: 'thread root' });
    post('t-work', 'agent:nova', 'agent:atlas', { kind: 'work', text: 'fake work t-work' }, 't-root');
    post('t-free', 'agent:nova', 'agent:atlas', { kind: 'work', text: 'fake work t-free' }, 't-work');
    post('t-ghost', 'agent:ghost', 'agent:atlas', { text: 'ack' }, 't-free');
    // A second thread rooted at the handoff itself, with one reply citing it.
    post('t-ho', 'agent:nova', 'agent:atlas', { kind: 'worker-handoff', taskId: 'RQ-T-1', prompt: 'take over' });
    post('t-ho-reply', 'agent:atlas', 'agent:nova', { text: 'handoff ack' }, 't-ho');
    // An announcement outside both threads projects the job the handoff cites.
    expect(await announceWork({ from: 'atlas', jobId: 'RQ-T-1', title: 'Handoff job', repo: 'ashlrai/phantom',
      claimKeys: ['repo:ashlrai/phantom'], to: 'agent:nova', id: 't-announce' }, options))
      .toMatchObject({ status: 'posted' });
    // Free, message-id-claimed and coordination-held coverage across the reads.
    expect(mutateBusWorkClaim({ action: 'acquire', id: 't-work', owner: 'nova', leaseMs: 60_000,
      root: options.root }).status).toBe('acquired');
    expect(acquireCoordination({ root: options.root, origin: 'resource', key: 'queue:t-ho',
      owner: 'atlas', leaseMs: 60_000, leaseUntil: options.clock.now + 60_000, sourceId: 't-ho-src',
      now: options.clock.now, started: new Date(options.clock.now).toISOString() }).status).toBe('acquired');

    const thread = readBusThread('t-root', { ...options, liveEvidence: true });
    expect(thread).toMatchObject({ rootFound: true, complete: true, sourceFailure: null });
    const byId = new Map(thread.messages.map(m => [m.envelope.id, m]));
    expect([...byId.keys()]).toEqual(['t-root', 't-work', 't-free', 't-ghost']);
    // The note root: a resolved sender, and no evidence a non-claimable,
    // non-citing body can carry.
    expect(byId.get('t-root')).toMatchObject({ fromAgent: 'atlas' });
    expect(byId.get('t-root')).not.toHaveProperty('held');
    expect(byId.get('t-root')).not.toHaveProperty('job');
    // Message-id claim: held with its owner; a kind:'work' body cites no job.
    expect(byId.get('t-work')).toMatchObject({ held: true, holder: 'nova', fromAgent: 'nova' });
    expect(byId.get('t-work')).not.toHaveProperty('job');
    // Claimable and free: proof of free, not a guess.
    expect(byId.get('t-free')).toMatchObject({ held: false, holder: null, fromAgent: 'nova' });
    // An unresolvable sender label stays null — a label is never authentication.
    expect(byId.get('t-ghost')).toMatchObject({ fromAgent: null });
    expect(byId.get('t-ghost')).not.toHaveProperty('held');

    // The handoff thread: the strict body roots it, so the root itself
    // carries the coordination hold and the taskId feed citation.
    const handoff = readBusThread('t-ho', { ...options, liveEvidence: true });
    const hoById = new Map(handoff.messages.map(m => [m.envelope.id, m]));
    expect([...hoById.keys()]).toEqual(['t-ho', 't-ho-reply']);
    expect(hoById.get('t-ho')).toMatchObject({ held: true, holder: 'atlas', fromAgent: 'nova',
      job: { jobId: 'RQ-T-1', feed: 'ok', job: { id: 'RQ-T-1', status: 'queued' } } });
    expect(hoById.get('t-ho-reply')).toMatchObject({ fromAgent: 'atlas' });
    expect(hoById.get('t-ho-reply')).not.toHaveProperty('held');

    // The raw read — the worker-run prompt path — carries none of it.
    const raw = readBusThread('t-root', options);
    expect(raw.rootFound).toBe(true);
    for (const message of raw.messages) {
      expect(message).not.toHaveProperty('held');
      expect(message).not.toHaveProperty('holder');
      expect(message).not.toHaveProperty('job');
      expect(message).not.toHaveProperty('fromAgent');
    }
    const rawHandoff = readBusThread('t-ho', options);
    for (const message of rawHandoff.messages) {
      expect(message).not.toHaveProperty('held');
      expect(message).not.toHaveProperty('job');
      expect(message).not.toHaveProperty('fromAgent');
    }
  });

  it('reports held unknown on thread rows when a hold store cannot be read', async () => {
    const { options, post } = setup();
    register(options, 'atlas', 'nova');
    post('u-root', 'agent:atlas', 'agent:nova', { kind: 'note', text: 'root' });
    post('u-work', 'agent:nova', 'agent:atlas', { kind: 'work', text: 'fake work' }, 'u-root');
    post('u-note', 'agent:nova', 'agent:atlas', { text: 'chat' }, 'u-work');
    const claimsDir = join(options.root, 'bus-work-claims');
    mkdirSync(claimsDir, { recursive: true });
    const claimsFile = join(claimsDir, 'claims.json');
    writeFileSync(claimsFile, 'not json');
    chmodSync(claimsFile, 0o600);
    const thread = readBusThread('u-root', { ...options, liveEvidence: true });
    const byId = new Map(thread.messages.map(m => [m.envelope.id, m]));
    expect(byId.get('u-work')).toMatchObject({ held: null, holder: null, fromAgent: 'nova' });
    expect(byId.get('u-note')).not.toHaveProperty('held');
  });

  it('fleet bus-thread --json serves the same annotated rows', async () => {
    const { options, post } = setup();
    register(options, 'atlas', 'nova');
    post('c-root', 'agent:atlas', 'agent:nova', { kind: 'note', text: 'root' });
    post('c-work', 'agent:nova', 'agent:atlas', { kind: 'work', text: 'fake work' }, 'c-root');
    expect(mutateBusWorkClaim({ action: 'acquire', id: 'c-work', owner: 'nova', leaseMs: 60_000,
      root: options.root }).status).toBe('acquired');
    const output = vi.fn(), error = vi.fn();
    const code = await cmdFleetBusThread(['--id', 'c-root', '--json'], options, { output, error });
    expect(code).toBe(0);
    const result = JSON.parse(output.mock.lastCall![0]);
    const byId = new Map(result.messages.map((m: { envelope: { id: string } }) => [m.envelope.id, m]));
    expect(byId.get('c-root')).toMatchObject({ fromAgent: 'atlas' });
    expect(byId.get('c-work')).toMatchObject({ held: true, holder: 'nova', fromAgent: 'nova' });
  });
});
