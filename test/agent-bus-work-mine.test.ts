import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerAgentIdentity, stableAgentId } from '../src/core/agents/bus-identity.js';
import { acquireCoordination } from '../src/core/agents/claim-store.js';
import { announceWork, readAgentInbox, sendDirectMessage, sendHandoff, sendWakeRequest,
  updateWorkStatus } from '../src/core/agents/bus-unified.js';
import { busWorkMineJobAnnotation, formatBusWorkMine, readBusWorkMine,
  type BusWorkMineOptions } from '../src/core/agents/bus-work-mine.js';
import type { WorkJob } from '../src/core/agents/bus-v2-schema.js';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';
import type { BusEnvelope } from '../src/core/fleet/bus-envelope.js';
import { mutateBusWorkClaim } from '../src/core/fleet/bus-work-claims.js';
import { runAgentsBusUnified } from '../src/cli/agents-bus-unified.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function setup(at = 1_000): BusWorkMineOptions & { clock: { now: number }; root: string; runsRoot: string } {
  const base = mkdtempSync(join(tmpdir(), 'bus-work-mine-'));
  dirs.push(base);
  const clock = { now: at };
  return { root: join(base, 'fleet'), runsRoot: join(base, 'runs'), now: () => clock.now, clock };
}

function register(options: BusWorkMineOptions, ...handles: string[]): void {
  for (const handle of handles) expect(registerAgentIdentity({ handle }, options).status).toBe('created');
}

function claim(options: BusWorkMineOptions, key: string, owner: string, sourceId: string, now: number): void {
  const leaseMs = 60_000;
  expect(acquireCoordination({ root: options.root, origin: 'resource', key, owner, leaseMs,
    leaseUntil: now + leaseMs, sourceId, now, started: new Date(now).toISOString() }).status).toBe('acquired');
}

/** Post a raw claimable (`kind:'work'`) envelope addressed to atlas by default. */
function postClaimable(options: BusWorkMineOptions, id: string, changes: Partial<BusEnvelope> = {}): void {
  const envelope: BusEnvelope = { id, from: 'agent:nova', to: 'agent:atlas',
    priority: 'P2', ttl: 120_000, body: { kind: 'work', text: `fake work ${id}` }, ...changes };
  expect(appendBusInbox(envelope, { root: options.root, now: options.now }).status).toBe('posted');
}

/** The bus-next claim path: message journal row plus its coordination lease. */
function takeWork(options: BusWorkMineOptions, id: string, owner: string, leaseMs = 60_000) {
  const result = mutateBusWorkClaim({ action: 'acquire', id, owner, leaseMs, root: options.root });
  expect(result.status).toBe('acquired');
  return result;
}

async function announce(options: BusWorkMineOptions, from: string, jobId: string,
  claimKeys: string[], to?: string): Promise<void> {
  const result = await announceWork({ from, jobId, title: `Job ${jobId}`, repo: 'a/b', claimKeys,
    ...(to === undefined ? {} : { to }), id: `post-${jobId}` }, options);
  expect(result.status).toBe('posted');
}

const job = (over: Partial<WorkJob>): WorkJob => ({ id: 'J', owner: 'agent:atlas', to: 'leaders',
  provider: 'claude', repo: 'a/b', title: 'T', claimKeys: ['queue:J'], status: 'queued',
  updatedAt: 1, ...over });

describe('busWorkMineJobAnnotation', () => {
  it('marks provably free, provably held and unknown coverage honestly', () => {
    const held = new Set(['queue:J', 'repo:a/b']);
    // Complete coverage: unheld declared keys are free, held ones are not.
    expect(busWorkMineJobAnnotation(job({ claimKeys: ['queue:J', 'path:x'] }), held, 'complete', false))
      .toMatchObject({ freeKeys: ['path:x'], heldKeys: ['queue:J'], claimable: true });
    expect(busWorkMineJobAnnotation(job({ claimKeys: ['queue:J', 'repo:a/b'] }), held, 'complete', false))
      .toMatchObject({ freeKeys: [], heldKeys: ['queue:J', 'repo:a/b'], claimable: false });
    // Truncated coverage: shown holds are real, but an unshown key might still be held.
    expect(busWorkMineJobAnnotation(job({ claimKeys: ['queue:J', 'path:x'] }), held, 'truncated', false))
      .toMatchObject({ freeKeys: null, heldKeys: ['queue:J'], claimable: null });
    expect(busWorkMineJobAnnotation(job({ claimKeys: ['queue:J', 'repo:a/b'] }), held, 'truncated', false))
      .toMatchObject({ freeKeys: null, heldKeys: ['queue:J', 'repo:a/b'], claimable: false });
    // Unknown coverage: nothing is provable, so nothing is claimed free or held.
    expect(busWorkMineJobAnnotation(job({}), undefined, 'unknown', true))
      .toMatchObject({ freeKeys: null, heldKeys: null, claimable: null, addressed: true });
  });
});

describe('readBusWorkMine', () => {
  it('composes claims, open jobs and wakes for one agent in one snapshot', async () => {
    const options = setup();
    register(options, 'atlas', 'nova');
    registerAgentIdentity({ handle: 'atlas', runtime: { cli: 'claude', provider: 'claude', model: 'opus' } }, options);
    registerAgentIdentity({ handle: 'nova', runtime: { cli: 'codex', provider: 'codex-personal', model: null } }, options);

    await announce(options, 'atlas', 'RQ-M-1', ['queue:RQ-M-1']);
    await announce(options, 'atlas', 'RQ-M-2', ['queue:RQ-M-2', 'repo:a/b']);
    await announce(options, 'nova', 'RQ-M-3', ['queue:RQ-M-3'], 'agent:atlas');
    // A terminal job is not open work and must not appear.
    await announce(options, 'nova', 'RQ-M-4', ['queue:RQ-M-4']);
    expect(await updateWorkStatus({ from: 'nova', jobId: 'RQ-M-4', status: 'done' }, options))
      .toMatchObject({ status: 'posted' });

    const now = options.clock.now;
    // atlas holds claims of its own; nova holds the other half of RQ-M-2.
    claim(options, 'path:c/d:src/**', 'atlas', 'test:atlas-1', now);
    claim(options, 'repo:a/b', 'atlas', 'test:atlas-2', now);
    claim(options, 'queue:RQ-M-2', 'nova', 'test:nova-1', now);
    // A claim under another label of atlas's identity still counts as atlas's.
    claim(options, 'pr:ashlrai/phantom#9', 'agent:atlas', 'test:atlas-3', now);

    expect(await sendWakeRequest({ from: 'nova', to: 'atlas', reason: 'feed moved', id: 'wk-mine-1' }, options))
      .toMatchObject({ status: 'posted' });

    const result = readBusWorkMine('atlas', options);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('unreachable');
    expect(result.agent).toEqual({ ref: 'atlas', handle: 'atlas', identity: stableAgentId('atlas'),
      registry: 'available' });
    expect(result.asOf).toBe(new Date(now).toISOString());

    // Claims: atlas's own three leases under any of its labels, never nova's.
    expect(result.claims.status).toBe('ok');
    if (result.claims.status !== 'ok') throw new Error('unreachable');
    expect(result.claims.source).toBe('available');
    expect(result.claims.owner).toMatchObject({ ref: 'atlas', identity: stableAgentId('atlas'), registry: 'available' });
    const keys = result.claims.claims.map(row => row.key).sort();
    expect(keys).toEqual(['path:c/d:src/**', 'pr:ashlrai/phantom#9', 'repo:a/b']);
    // The claim->job join names the feed job each lease's keys block.
    const repoClaim = result.claims.claims.find(row => row.key === 'repo:a/b');
    expect(repoClaim?.jobs).toEqual([{ id: 'RQ-M-2', owner: 'agent:atlas', status: 'queued', title: 'Job RQ-M-2' }]);
    const pathClaim = result.claims.claims.find(row => row.key === 'path:c/d:src/**');
    expect(pathClaim?.jobs).toEqual([]);

    // Jobs: only open jobs declaring claim keys, hold-annotated.
    expect(result.jobs.status).toBe('ok');
    if (result.jobs.status !== 'ok') throw new Error('unreachable');
    expect(result.jobs.holds).toBe('complete');
    expect(result.jobs.open).toBe(3);
    expect(result.jobs.truncated).toBe(false);
    const byId = new Map(result.jobs.jobs.map(entry => [entry.id, entry]));
    expect(byId.get('RQ-M-1')).toMatchObject({ claimable: true, addressed: false,
      freeKeys: ['queue:RQ-M-1'], heldKeys: [], status: 'queued' });
    // Both declared keys are held (one by nova, one by atlas): not claimable.
    expect(byId.get('RQ-M-2')).toMatchObject({ claimable: false, addressed: false,
      freeKeys: [], heldKeys: ['queue:RQ-M-2', 'repo:a/b'] });
    // Announced to agent:atlas, so the address resolves to this identity.
    expect(byId.get('RQ-M-3')).toMatchObject({ claimable: true, addressed: true,
      freeKeys: ['queue:RQ-M-3'], heldKeys: [] });
    expect(byId.has('RQ-M-4')).toBe(false);

    // Wakes: the hint addressed to atlas under any of its labels.
    expect(result.wakes).toMatchObject({ status: 'ok', agent: 'atlas', truncated: false });
    if (result.wakes.status !== 'ok') throw new Error('unreachable');
    expect(result.wakes.wakes).toEqual([expect.objectContaining({ id: 'wk-mine-1', from: 'agent:nova', to: 'agent:atlas' })]);

    // Inbox: the RQ-M-3 announcement addressed to agent:atlas and the wake
    // request are the only mail; leaders-sink traffic stays out.
    expect(result.inbox.status).toBe('ok');
    if (result.inbox.status !== 'ok') throw new Error('unreachable');
    expect(result.inbox.truncated).toBe(false);
    expect(result.inbox.messages.map(m => m.id)).toEqual(['post-RQ-M-3', 'wk-mine-1']);
    expect(result.inbox.messages[0]).toMatchObject({ kind: 'dm', from: 'agent:nova', fromAgent: 'nova' });
    expect(result.inbox.messages[0]!.summary).toContain('RQ-M-3');
    expect(result.inbox.messages[1]).toMatchObject({ id: 'wk-mine-1', kind: 'dm',
      from: 'agent:nova', fromAgent: 'nova', channel: null });
    expect(result.inbox.messages[1]!.summary).toContain('feed moved');
    expect(result.inbox.nextCursor).toBeGreaterThan(0);
  });

  it('lists addressed mail with claim handles and resumes the page without loss', async () => {
    const options = setup();
    register(options, 'atlas', 'nova');
    registerAgentIdentity({ handle: 'atlas', runtime: { cli: 'claude', provider: 'claude', model: null } }, options);
    registerAgentIdentity({ handle: 'nova', runtime: { cli: 'codex', provider: 'codex-personal', model: null } }, options);

    expect(await sendDirectMessage({ from: 'nova', to: 'atlas', text: 'please review the feed',
      id: 'dm-m-1', priority: 'P1' }, options)).toMatchObject({ status: 'posted' });
    expect(await sendHandoff({ from: 'nova', to: 'atlas', taskId: 'RQ-M-9', prompt: 'take this task',
      id: 'ho-m-1' }, options)).toMatchObject({ status: 'posted' });
    // Mail addressed to nova or to a channel atlas is not in must not appear.
    expect(await sendDirectMessage({ from: 'atlas', to: 'nova', text: 'not atlas mail',
      id: 'dm-m-2' }, options)).toMatchObject({ status: 'posted' });

    const result = readBusWorkMine('atlas', options);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('unreachable');
    expect(result.inbox.status).toBe('ok');
    if (result.inbox.status !== 'ok') throw new Error('unreachable');
    expect(result.inbox.truncated).toBe(false);
    // Highest priority first inside the page: the P1 DM leads the P1-default handoff.
    expect(result.inbox.messages.map(m => m.id)).toEqual(['dm-m-1', 'ho-m-1']);
    const dm = result.inbox.messages[0]!;
    expect(dm).toMatchObject({ kind: 'dm', priority: 'P1', from: 'agent:nova', fromAgent: 'nova',
      channel: null, summary: 'please review the feed' });
    expect(typeof dm.ts).toBe('string');
    expect(dm.cursor).toBeGreaterThan(0);
    const handoff = result.inbox.messages[1]!;
    expect(handoff).toMatchObject({ kind: 'handoff', from: 'agent:nova', fromAgent: 'nova' });
    expect(handoff.summary).toContain('take this task');

    // A second agent's digest never sees atlas's mail.
    const other = readBusWorkMine('nova', options);
    if (other.status !== 'ok') throw new Error('unreachable');
    expect(other.inbox.status).toBe('ok');
    if (other.inbox.status !== 'ok') throw new Error('unreachable');
    expect(other.inbox.messages.map(m => m.id)).toEqual(['dm-m-2']);
  });

  it('marks the inbox page truncated only when mail provably remains, resumable before the dropped row', async () => {
    const options = setup();
    register(options, 'atlas', 'nova');
    registerAgentIdentity({ handle: 'atlas', runtime: { cli: 'claude', provider: 'claude', model: null } }, options);
    registerAgentIdentity({ handle: 'nova', runtime: { cli: 'codex', provider: 'codex-personal', model: null } }, options);
    for (let i = 1; i <= 21; i += 1) {
      expect(await sendDirectMessage({ from: 'nova', to: 'atlas', text: `mail ${i}`,
        id: `dm-t-${String(i).padStart(2, '0')}` }, options)).toMatchObject({ status: 'posted' });
    }

    const result = readBusWorkMine('atlas', options);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('unreachable');
    expect(result.inbox.status).toBe('ok');
    if (result.inbox.status !== 'ok') throw new Error('unreachable');
    // 21 pending: the oldest 20 show, the newest is provably beyond nextCursor.
    expect(result.inbox.truncated).toBe(true);
    expect(result.inbox.messages).toHaveLength(20);
    const shownIds = result.inbox.messages.map(m => m.id);
    expect(shownIds).not.toContain('dm-t-21');
    expect(shownIds).toContain('dm-t-01');
    expect(shownIds).toContain('dm-t-20');

    // Resuming at nextCursor redelivers nothing shown and surfaces the dropped row.
    const rest = readAgentInbox('atlas', { after: result.inbox.nextCursor }, options);
    expect(rest.status).toBe('ok');
    if (rest.status !== 'ok') throw new Error('unreachable');
    expect(rest.messages.map(m => m.envelope.id)).toEqual(['dm-t-21']);
    expect(rest.messages.some(m => shownIds.includes(m.envelope.id))).toBe(false);

    // Exactly at the cap there is no provable remainder: truncated stays false.
    const options2 = setup(2_000);
    register(options2, 'atlas', 'nova');
    registerAgentIdentity({ handle: 'atlas', runtime: { cli: 'claude', provider: 'claude', model: null } }, options2);
    registerAgentIdentity({ handle: 'nova', runtime: { cli: 'codex', provider: 'codex-personal', model: null } }, options2);
    for (let i = 1; i <= 20; i += 1) {
      expect(await sendDirectMessage({ from: 'nova', to: 'atlas', text: `mail ${i}`,
        id: `dm-e-${String(i).padStart(2, '0')}` }, options2)).toMatchObject({ status: 'posted' });
    }
    const exact = readBusWorkMine('atlas', options2);
    if (exact.status !== 'ok') throw new Error('unreachable');
    expect(exact.inbox.status).toBe('ok');
    if (exact.inbox.status !== 'ok') throw new Error('unreachable');
    expect(exact.inbox.truncated).toBe(false);
    expect(exact.inbox.messages).toHaveLength(20);
  });

  it('reports unknown hold coverage instead of guessing when the table is unreadable', async () => {
    const options = setup();
    register(options, 'atlas');
    registerAgentIdentity({ handle: 'atlas', runtime: { cli: 'claude', provider: 'claude', model: null } }, options);
    await announce(options, 'atlas', 'RQ-M-9', ['queue:RQ-M-9']);
    claim(options, 'queue:RQ-M-9', 'nova', 'test:nova-held', options.clock.now);
    // Poison the coordination table after the lease lands.
    writeFileSync(join(options.root, 'coordination', 'claims.json'), 'invalid JSON');

    const result = readBusWorkMine('atlas', options);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('unreachable');
    expect(result.claims).toEqual({ status: 'unavailable' });
    expect(result.jobs).toMatchObject({ status: 'ok', holds: 'unknown' });
    if (result.jobs.status !== 'ok') throw new Error('unreachable');
    expect(result.jobs.jobs[0]).toMatchObject({ id: 'RQ-M-9', claimable: null, freeKeys: null, heldKeys: null });
    // The claimable-envelope walk degrades the same way: listed, holds unknown.
    expect(result.next).toMatchObject({ status: 'ok', holds: 'unknown', matched: 0 });
    // The handoff walk shares the scan and the hold join: same honest unknown.
    expect(result.handoffs).toMatchObject({ status: 'ok', holds: 'unknown', matched: 0 });
    // The feed itself still reads; only the hold join is unknown.
    expect(result.wakes.status).toBe('ok');
  });

  it('degrades honestly for an agent that is not a registered identity', () => {
    const options = setup();
    // No registry at all: exact owner-label matching still applies to claims.
    claim(options, 'queue:RQ-G-1', 'ghost', 'test:ghost-1', options.clock.now);
    const result = readBusWorkMine('ghost', options);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('unreachable');
    expect(result.agent).toEqual({ ref: 'ghost', handle: null, identity: null, registry: 'missing' });
    expect(result.claims).toMatchObject({ status: 'ok', source: 'available' });
    if (result.claims.status !== 'ok') throw new Error('unreachable');
    expect(result.claims.claims.map(row => row.key)).toEqual(['queue:RQ-G-1']);
    expect(result.claims.owner).toMatchObject({ ref: 'ghost', identity: null, registry: 'missing' });
    // Wakes and inbox need a registered identity: unknown, never an empty list.
    expect(result.wakes.status).toBe('unknown-agent');
    expect(result.inbox).toMatchObject({ status: 'unknown-agent' });
  });

  it('rejects an invalid agent ref before reading anything', () => {
    expect(readBusWorkMine('bad agent!', setup())).toEqual({ status: 'invalid', reason: 'invalid-agent' });
    expect(readBusWorkMine('', setup())).toEqual({ status: 'invalid', reason: 'invalid-agent' });
  });

  it('previews claimable work envelopes in bus-next order with honest hold state', () => {
    const options = setup(Date.now());
    register(options, 'nova');
    expect(registerAgentIdentity({ handle: 'atlas', aliases: ['atlas-alias'],
      runtime: { cli: 'claude', provider: 'claude', model: null } }, options).status).toBe('created');
    expect(registerAgentIdentity({ handle: 'nova',
      runtime: { cli: 'codex', provider: 'codex-personal', model: null } }, options).status).toBe('updated');

    postClaimable(options, 'w-low', { priority: 'P3' });
    postClaimable(options, 'w-high-1', { priority: 'P0' });
    postClaimable(options, 'w-high-2', { priority: 'P0', to: 'atlas-alias' });
    // Excluded: non-work bodies, other recipients and a disguised protocol.
    postClaimable(options, 'w-chat', { body: 'plain chat' });
    postClaimable(options, 'w-note', { body: { kind: 'note', text: 'just a note' } });
    postClaimable(options, 'w-disguised',
      { body: { kind: 'work', text: 'not really', protocol: { version: 1, kind: 'status' } } });
    postClaimable(options, 'w-other', { to: 'agent:nova', priority: 'P0' });

    // Held through the canonical bus-next claim path (journal + coordination).
    takeWork(options, 'w-high-1', 'nova');
    // Held only through the shared coordination table on the queue key.
    claim(options, 'queue:w-low', 'ghost', 'test:coord-only', options.clock.now);

    const result = readBusWorkMine('atlas', options);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('unreachable');
    expect(result.next).toMatchObject({ status: 'ok', holds: 'complete', matched: 3, truncated: false });
    if (result.next.status !== 'ok') throw new Error('unreachable');
    // bus-next order: priority band, then cursor — w-high-1 precedes w-high-2.
    expect(result.next.items.map(item => item.id)).toEqual(['w-high-1', 'w-high-2', 'w-low']);
    expect(result.next.items[0]).toMatchObject({ priority: 'P0', kind: 'work',
      from: 'agent:nova', fromAgent: 'nova', held: true, holder: 'nova' });
    expect(result.next.items[0]!.summary).toContain('fake work w-high-1');
    expect(result.next.items[1]).toMatchObject({ id: 'w-high-2', priority: 'P0', held: false, holder: null });
    expect(result.next.items[2]).toMatchObject({ id: 'w-low', priority: 'P3', held: true, holder: 'ghost' });
    expect(result.next.items[0]!.ts).toBe(new Date(options.clock.now).toISOString());
    expect(Date.parse(result.next.items[0]!.expiresAt)).toBeGreaterThan(Date.parse(result.next.items[0]!.ts));
    // The digest is read-only: the preview never takes or releases a claim.
    const again = mutateBusWorkClaim({ action: 'acquire', id: 'w-high-2', owner: 'late',
      leaseMs: 60_000, root: options.root });
    expect(again.status).toBe('acquired');
  });

  it('lists live worker-handoff assignments with the envelope ids handoff-receive takes', async () => {
    const options = setup(Date.now());
    register(options, 'atlas', 'nova');
    registerAgentIdentity({ handle: 'atlas', aliases: ['atlas-alias'],
      runtime: { cli: 'claude', provider: 'claude', model: null } }, options);
    registerAgentIdentity({ handle: 'nova',
      runtime: { cli: 'codex', provider: 'codex-personal', model: null } }, options);

    // Two receivable handoffs in claim order: the P0 alias-addressed one first.
    expect(await sendHandoff({ from: 'nova', to: 'atlas-alias', taskId: 'RQ-H-1',
      prompt: 'take the alpha task', id: 'ho-p0', priority: 'P0' }, options))
      .toMatchObject({ status: 'posted' });
    expect(await sendHandoff({ from: 'nova', to: 'atlas', taskId: 'RQ-H-2',
      prompt: 'take the beta task', id: 'ho-p2', priority: 'P2' }, options))
      .toMatchObject({ status: 'posted' });
    // A raw handoff addressed to the alias label matches while the registry resolves it.
    const aliasPost = appendBusInbox({ id: 'ho-alias', from: 'agent:nova', to: 'atlas-alias',
      priority: 'P2', ttl: 120_000,
      body: { kind: 'worker-handoff', taskId: 'RQ-H-3', prompt: 'alias addressed' } },
      { root: options.root, now: options.now });
    expect(aliasPost.status).toBe('posted');
    // Handoff-shaped bodies handoff-receive would refuse are not pending assignments.
    for (const [i, body] of [
      { kind: 'worker-handoff', taskId: 'not a job id!', prompt: 'x' },
      { kind: 'worker-handoff', taskId: 'RQ-H-9', prompt: '' },
      { kind: 'worker-handoff', taskId: 'RQ-H-9', prompt: 'x', extra: 1 },
      { kind: 'worker-handoff', taskId: 'RQ-H-9' },
      { kind: 'note', text: 'worker-handoff-ish' },
    ].entries()) {
      const posted = appendBusInbox({ id: `ho-bad-${i}`, from: 'agent:nova', to: 'agent:atlas',
        priority: 'P0', ttl: 120_000, body: body as BusEnvelope['body'] },
        { root: options.root, now: options.now });
      expect(posted.status).toBe('posted');
    }
    // A handoff addressed to someone else never appears in atlas's digest.
    expect(await sendHandoff({ from: 'atlas', to: 'nova', taskId: 'RQ-H-7',
      prompt: 'not atlas work', id: 'ho-nova' }, options)).toMatchObject({ status: 'posted' });

    // A bus-next claim on one handoff is reported as evidence, not a gate.
    takeWork(options, 'ho-p2', 'nova');

    const result = readBusWorkMine('atlas', options);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('unreachable');
    expect(result.handoffs).toMatchObject({ status: 'ok', holds: 'complete', matched: 3, truncated: false });
    if (result.handoffs.status !== 'ok') throw new Error('unreachable');
    // Claim order: P0 first, then the two P2 labels in cursor order.
    expect(result.handoffs.items.map(item => item.id)).toEqual(['ho-p0', 'ho-p2', 'ho-alias']);
    expect(result.handoffs.items[0]).toMatchObject({ taskId: 'RQ-H-1', priority: 'P0',
      from: 'agent:nova', fromAgent: 'nova', held: false, holder: null });
    expect(result.handoffs.items[0]!.summary).toContain('handoff task RQ-H-1');
    expect(result.handoffs.items[0]!.summary).toContain('take the alpha task');
    expect(result.handoffs.items[1]).toMatchObject({ taskId: 'RQ-H-2', held: true, holder: 'nova' });
    expect(result.handoffs.items[2]).toMatchObject({ taskId: 'RQ-H-3', held: false });
    for (const item of result.handoffs.items) {
      expect(item.id).toMatch(/^ho-/);
      expect(Date.parse(item.expiresAt)).toBeGreaterThan(Date.parse(item.ts));
    }
    // The digest stays read-only: the handoffs it lists are still receivable.
    const inbox = readAgentInbox('atlas', {}, options);
    expect(inbox.status).toBe('ok');

    // The same handoffs surface under every label of the identity.
    for (const ref of ['agent:atlas', 'atlas-alias', stableAgentId('atlas')]) {
      const other = readBusWorkMine(ref, options);
      expect(other.status).toBe('ok');
      if (other.status !== 'ok' || other.handoffs.status !== 'ok') throw new Error('unreachable');
      expect(other.handoffs.matched).toBe(3);
    }

    // An unreadable registry narrows to the literal label, never widens.
    writeFileSync(join(options.root, 'agent-identities', 'registry.json'), '{invalid', { mode: 0o600 });
    const narrowed = readBusWorkMine('agent:atlas', options);
    expect(narrowed.status).toBe('ok');
    if (narrowed.status !== 'ok' || narrowed.handoffs.status !== 'ok') throw new Error('unreachable');
    expect(narrowed.handoffs.matched).toBe(2);
    expect(narrowed.handoffs.items.map(item => item.id)).toEqual(['ho-p0', 'ho-p2']);
    expect(narrowed.handoffs.items.every(item => item.fromAgent === null)).toBe(true);
    const aliased = readBusWorkMine('atlas-alias', options);
    expect(aliased.status).toBe('ok');
    if (aliased.status !== 'ok' || aliased.handoffs.status !== 'ok') throw new Error('unreachable');
    expect(aliased.handoffs.matched).toBe(1);
    expect(aliased.handoffs.items[0]).toMatchObject({ id: 'ho-alias' });
  });

  it('caps shown handoffs at twenty with the true total', () => {
    const options = setup();
    register(options, 'atlas');
    for (let i = 1; i <= 21; i += 1) {
      const posted = appendBusInbox({ id: `ho-cap-${String(i).padStart(2, '0')}`, from: 'agent:nova',
        to: 'agent:atlas', priority: 'P2', ttl: 120_000,
        body: { kind: 'worker-handoff', taskId: `RQ-C-${i}`, prompt: `handoff ${i}` } },
        { root: options.root, now: options.now });
      expect(posted.status).toBe('posted');
    }

    const result = readBusWorkMine('atlas', options);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok' || result.handoffs.status !== 'ok') throw new Error('unreachable');
    expect(result.handoffs).toMatchObject({ holds: 'complete', matched: 21, truncated: true });
    expect(result.handoffs.items).toHaveLength(20);
    // Same priority, so claim order is cursor order: the first twenty show.
    expect(result.handoffs.items[0]).toMatchObject({ id: 'ho-cap-01', taskId: 'RQ-C-1' });
    expect(result.handoffs.items[19]).toMatchObject({ id: 'ho-cap-20', taskId: 'RQ-C-20' });
  });

  it('keeps completed work taken and frees released and expired claims', () => {
    const options = setup(Date.now());
    register(options, 'atlas', 'nova');
    postClaimable(options, 'w-live');
    postClaimable(options, 'w-done');
    postClaimable(options, 'w-gone');
    postClaimable(options, 'w-expired');

    takeWork(options, 'w-live', 'nova');
    const done = takeWork(options, 'w-done', 'atlas');
    expect(mutateBusWorkClaim({ action: 'complete', id: 'w-done', token: done.token!,
      root: options.root }).status).toBe('completed');
    const gone = takeWork(options, 'w-gone', 'ghost');
    expect(mutateBusWorkClaim({ action: 'release', id: 'w-gone', token: gone.token!,
      root: options.root }).status).toBe('released');
    takeWork(options, 'w-expired', 'nova', 1);
    // The one-millisecond lease lapses; every envelope itself stays live.
    options.clock.now += 10_000;

    const result = readBusWorkMine('atlas', options);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok' || result.next.status !== 'ok') throw new Error('unreachable');
    expect(result.next.matched).toBe(4);
    const byId = new Map(result.next.items.map(item => [item.id, item]));
    // A completed row stays taken: bus-next would skip it, so it is not free.
    expect(byId.get('w-live')).toMatchObject({ held: true, holder: 'nova' });
    expect(byId.get('w-done')).toMatchObject({ held: true, holder: 'atlas' });
    expect(byId.get('w-gone')).toMatchObject({ held: false, holder: null });
    expect(byId.get('w-expired')).toMatchObject({ held: false, holder: null });
  });

  it('matches work under every label of the agent identity, narrowing to exact labels when the registry is unreadable', () => {
    const options = setup();
    expect(registerAgentIdentity({ handle: 'atlas', aliases: ['atlas-alias'] }, options).status).toBe('created');
    expect(registerAgentIdentity({ handle: 'nova' }, options).status).toBe('created');
    postClaimable(options, 'w-address', { to: 'agent:atlas', priority: 'P1' });
    postClaimable(options, 'w-alias', { to: 'atlas-alias' });
    postClaimable(options, 'w-bare', { to: 'atlas' });
    postClaimable(options, 'w-other', { to: 'agent:nova', priority: 'P0' });

    for (const ref of ['atlas', 'agent:atlas', 'atlas-alias', stableAgentId('atlas')]) {
      const result = readBusWorkMine(ref, options);
      expect(result.status).toBe('ok');
      if (result.status !== 'ok' || result.next.status !== 'ok') throw new Error('unreachable');
      expect(result.next.matched).toBe(3);
      // P1 address first, then the two P2 labels in cursor order.
      expect(result.next.items.map(item => item.id)).toEqual(['w-address', 'w-alias', 'w-bare']);
      expect(result.next.items.every(item => item.fromAgent === 'nova')).toBe(true);
    }

    // An unreadable registry narrows to the literal label, never widens.
    writeFileSync(join(options.root, 'agent-identities', 'registry.json'), '{invalid', { mode: 0o600 });
    const narrowed = readBusWorkMine('agent:atlas', options);
    expect(narrowed.status).toBe('ok');
    if (narrowed.status !== 'ok' || narrowed.next.status !== 'ok') throw new Error('unreachable');
    expect(narrowed.next.matched).toBe(1);
    expect(narrowed.next.items[0]).toMatchObject({ id: 'w-address', fromAgent: null });
  });

  it('lists protocol task envelopes and caps the page at ten with the true total', () => {
    const options = setup();
    register(options, 'atlas');
    for (let i = 1; i <= 11; i += 1) postClaimable(options, `w-t-${String(i).padStart(2, '0')}`);
    const proto = appendBusInbox({ id: 'w-proto', from: 'agent:nova', to: 'fleet.deploy',
      priority: 'P0', ttl: 120_000,
      body: { protocol: { version: 1, kind: 'task', topic: 'fleet.deploy', payload_ref: 'deploy-ref-1' },
        correlation_id: 'c-1', payload: {} } },
      { root: options.root, now: options.now });
    expect(proto.status).toBe('posted');

    const result = readBusWorkMine('atlas', options);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok' || result.next.status !== 'ok') throw new Error('unreachable');
    expect(result.next).toMatchObject({ holds: 'complete', matched: 11, truncated: true });
    expect(result.next.items).toHaveLength(10);
    expect(result.next.items[0]).toMatchObject({ id: 'w-t-01', kind: 'work', held: false });
    // The protocol task is claimable work too, addressed to its topic label.
    const topic = readBusWorkMine('fleet.deploy', options);
    expect(topic.status).toBe('ok');
    if (topic.status !== 'ok' || topic.next.status !== 'ok') throw new Error('unreachable');
    expect(topic.next.matched).toBe(1);
    expect(topic.next.items[0]).toMatchObject({ id: 'w-proto', kind: 'task', held: false });
    expect(topic.next.items[0]!.summary).toContain('deploy-ref-1');
  });

  it('degrades next to unknown holds when the claim journal is unreadable', () => {
    const options = setup(Date.now());
    register(options, 'atlas', 'nova');
    postClaimable(options, 'w-held');
    takeWork(options, 'w-held', 'nova');
    // Poison the message-claim journal after the lease lands.
    writeFileSync(join(options.root, 'bus-work-claims', 'claims.json'), '{invalid', { mode: 0o600 });

    const result = readBusWorkMine('atlas', options);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok' || result.next.status !== 'ok') throw new Error('unreachable');
    // Candidates stay listed; only the provable hold state degrades.
    expect(result.next).toMatchObject({ holds: 'unknown', matched: 1, truncated: false });
    expect(result.next.items[0]).toMatchObject({ id: 'w-held', held: null, holder: null });
    // The handoff section shares the same walk and hold coverage.
    expect(result.handoffs).toMatchObject({ holds: 'unknown', matched: 0 });
  });

  it('reports the claimable walk unavailable when the bus store is unreadable', () => {
    const options = setup();
    register(options, 'atlas');
    postClaimable(options, 'w-1');
    writeFileSync(join(options.root, 'bus-inbox', 'messages.json'), '{invalid', { mode: 0o600 });

    const result = readBusWorkMine('atlas', options);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('unreachable');
    expect(result.next).toEqual({ status: 'unavailable', reason: 'Bus store is not readable.' });
    expect(result.handoffs).toEqual({ status: 'unavailable', reason: 'Bus store is not readable.' });
  });
});

describe('formatBusWorkMine', () => {
  it('renders every section with unknown states spelled out', async () => {
    const options = setup();
    register(options, 'atlas');
    registerAgentIdentity({ handle: 'atlas', runtime: { cli: 'claude', provider: 'claude', model: null } }, options);
    await announce(options, 'atlas', 'RQ-F-1', ['queue:RQ-F-1']);
    const result = readBusWorkMine('atlas', options);
    const text = formatBusWorkMine(result).join('\n');
    expect(text).toContain('agent=atlas');
    expect(text).toContain('claims=0 source=missing');
    expect(text).toContain('jobs=1 shown=1 holds=complete');
    expect(text).toContain('RQ-F-1 queued "Job RQ-F-1" claimable=yes addressed=false');
    expect(text).toContain('next=0 shown=0 holds=complete');
    expect(text).toContain('handoffs=0 shown=0 holds=complete');
    expect(text).toContain('wakes=0');
    expect(text).toContain('inbox=0');
    // A non-ok top-level result renders its status line only.
    expect(formatBusWorkMine({ status: 'invalid', reason: 'invalid-agent' })).toEqual(['invalid: invalid-agent']);
  });
});

describe('phm agents bus work mine', () => {
  let base: string;
  let root: string;
  let previousRuns: string | undefined;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'bus-work-mine-cli-'));
    dirs.push(base);
    root = join(base, 'fleet');
    previousRuns = process.env['ASHLR_RUNS_DIR'];
    process.env['ASHLR_RUNS_DIR'] = join(base, 'runs');
  });
  afterEach(() => {
    if (previousRuns === undefined) delete process.env['ASHLR_RUNS_DIR'];
    else process.env['ASHLR_RUNS_DIR'] = previousRuns;
  });

  async function run(args: string[], env: NodeJS.ProcessEnv = {}) {
    const out: string[] = [], err: string[] = [];
    const code = await runAgentsBusUnified([...args, '--root', root, '--json'], t => out.push(t), t => err.push(t), env);
    return { code, json: out.length ? JSON.parse(out.join('\n')) : JSON.parse(err.join('\n')) };
  }

  it('prints the digest as JSON and honors PHM_AGENT_ID', async () => {
    const env = { PHM_AGENT_ID: 'atlas' };
    expect((await run(['id', 'register', 'atlas', '--cli', 'claude'], env)).json).toMatchObject({ status: 'created' });
    const result = await run(['work', 'mine'], env);
    expect(result.code).toBe(0);
    expect(result.json).toMatchObject({ status: 'ok',
      agent: { ref: 'atlas', handle: 'atlas', registry: 'available' },
      claims: { status: 'ok', source: 'missing', claims: [] },
      jobs: { status: 'ok', holds: 'complete', jobs: [] },
      next: { status: 'ok', holds: 'complete', matched: 0, items: [], truncated: false },
      handoffs: { status: 'ok', holds: 'complete', matched: 0, items: [], truncated: false },
      wakes: { status: 'ok', wakes: [] },
      inbox: { status: 'ok', messages: [], truncated: false } });
  });

  it('prints human lines without --json', async () => {
    const env = { PHM_AGENT_ID: 'atlas' };
    await run(['id', 'register', 'atlas', '--cli', 'claude'], env);
    const out: string[] = [];
    const code = await runAgentsBusUnified(['work', 'mine', '--root', root], t => out.push(t), () => {}, env);
    expect(code).toBe(0);
    expect(out.join('\n')).toContain('agent=atlas');
    expect(out.join('\n')).toContain('claims=0 source=missing');
  });

  it('requires an agent or PHM_AGENT_ID and rejects extra operands', async () => {
    expect((await run(['work', 'mine'], {})).code).toBe(2);
    expect((await run(['work', 'mine', 'atlas', 'extra'], {})).code).toBe(2);
    expect((await run(['work', 'mine', 'bad agent'], {})).code).toBe(2);
  });
});
