import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAgentChannel, registerAgentIdentity, stableAgentId } from '../src/core/agents/bus-identity.js';
import { acquireCoordination } from '../src/core/agents/claim-store.js';
import { announceWork, readAgentInbox, sendDirectMessage, sendHandoff, sendWakeRequest,
  updateWorkStatus } from '../src/core/agents/bus-unified.js';
import { busWorkMineAnnouncedAnnotation, busWorkMineJobAnnotation, formatBusWorkMine, readBusWorkMine,
  type BusWorkMineOptions } from '../src/core/agents/bus-work-mine.js';
import { busWorkMineSeatsFromPlan, readBusWorkMineSeats, readBusWorkMineWithSeats } from '../src/core/agents/bus-work-mine-seats.js';
import { planSeatHandoffs, type SeatHandoffsPlan, type SeatOptions } from '../src/core/bots/seats.js';
import { emptyState } from '../src/core/drive/nodes/state.js';
import type { BusWorkFeedJob } from '../src/core/agents/bus-work-feed-read.js';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';
import { BusBoard } from '../src/core/fleet/bus-board.js';
import { enqueueBusWake } from '../src/core/fleet/bus-wake-queue.js';
import { createBusMailbox } from '../src/core/fleet/bus-mailbox.js';
import { SharedStore } from '../src/core/fleet/shared-store.js';
import type { AshlrConfig } from '../src/core/types.js';
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

const job = (over: Partial<BusWorkFeedJob>): BusWorkFeedJob => ({ id: 'J', owner: 'agent:atlas', to: 'leaders',
  provider: 'claude', repo: 'a/b', title: 'T', claimKeys: ['queue:J'], status: 'queued',
  updatedAt: 1, postId: 'm-post', statusId: null, ...over });

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

describe('busWorkMineAnnouncedAnnotation', () => {
  it('summarizes per-key hold coverage as an honest held tri-state', () => {
    const held = new Set(['queue:J', 'repo:a/b']);
    // Complete coverage: a shown hold is held; unheld keys are provably free.
    expect(busWorkMineAnnouncedAnnotation(job({ claimKeys: ['queue:J', 'path:x'] }), held, 'complete'))
      .toMatchObject({ held: true, heldKeys: ['queue:J'], freeKeys: ['path:x'] });
    expect(busWorkMineAnnouncedAnnotation(job({ claimKeys: ['path:x'] }), held, 'complete'))
      .toMatchObject({ held: false, heldKeys: [], freeKeys: ['path:x'] });
    // Truncated coverage: shown holds are real, but an unshown key might still
    // be held, so free stays unknown and held stays unknown without a show.
    expect(busWorkMineAnnouncedAnnotation(job({ claimKeys: ['queue:J', 'path:x'] }), held, 'truncated'))
      .toMatchObject({ held: true, heldKeys: ['queue:J'], freeKeys: null });
    expect(busWorkMineAnnouncedAnnotation(job({ claimKeys: ['path:x'] }), new Set(), 'truncated'))
      .toMatchObject({ held: null, heldKeys: [], freeKeys: null });
    // Unknown coverage: nothing is provable.
    expect(busWorkMineAnnouncedAnnotation(job({}), undefined, 'unknown'))
      .toMatchObject({ held: null, heldKeys: null, freeKeys: null });
    // No declared keys: nothing a hold could cover, provable without the table.
    expect(busWorkMineAnnouncedAnnotation(job({ claimKeys: [] }), undefined, 'unknown'))
      .toMatchObject({ held: false, heldKeys: null, freeKeys: null });
    expect(busWorkMineAnnouncedAnnotation(job({ claimKeys: [] }), undefined, 'truncated'))
      .toMatchObject({ held: false, heldKeys: [], freeKeys: null });
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
    // The claim->job join names the feed job each lease's keys block, with
    // the retained post/status receipt citations behind it.
    const repoClaim = result.claims.claims.find(row => row.key === 'repo:a/b');
    expect(repoClaim?.jobs).toEqual([{ id: 'RQ-M-2', owner: 'agent:atlas', status: 'queued', title: 'Job RQ-M-2',
      postId: 'post-RQ-M-2', statusId: null }]);
    const pathClaim = result.claims.claims.find(row => row.key === 'path:c/d:src/**');
    expect(pathClaim?.jobs).toEqual([]);

    // Jobs: only open jobs declaring claim keys, hold-annotated.
    expect(result.jobs.status).toBe('ok');
    if (result.jobs.status !== 'ok') throw new Error('unreachable');
    expect(result.jobs.holds).toBe('complete');
    expect(result.jobs.open).toBe(3);
    expect(result.jobs.truncated).toBe(false);
    const byId = new Map(result.jobs.jobs.map(entry => [entry.id, entry]));
    expect(byId.get('RQ-M-1')).toMatchObject({ claimable: true, addressed: false, announced: true,
      freeKeys: ['queue:RQ-M-1'], heldKeys: [], status: 'queued' });
    // Both declared keys are held (one by nova, one by atlas): not claimable.
    expect(byId.get('RQ-M-2')).toMatchObject({ claimable: false, addressed: false, announced: true,
      freeKeys: [], heldKeys: ['queue:RQ-M-2', 'repo:a/b'] });
    // Announced to agent:atlas, so the address resolves to this identity; nova announced it.
    expect(byId.get('RQ-M-3')).toMatchObject({ claimable: true, addressed: true, announced: false,
      freeKeys: ['queue:RQ-M-3'], heldKeys: [] });
    expect(byId.has('RQ-M-4')).toBe(false);

    // Wakes: the hint addressed to atlas under any of its labels.
    expect(result.wakes).toMatchObject({ status: 'ok', agent: 'atlas', matched: 1, truncated: false });
    if (result.wakes.status !== 'ok') throw new Error('unreachable');
    expect(result.wakes.wakes).toEqual([expect.objectContaining({ id: 'wk-mine-1', from: 'agent:nova', to: 'agent:atlas' })]);

    // Inbox: the RQ-M-3 announcement addressed to agent:atlas and the wake
    // request are the only mail; leaders-sink traffic stays out.
    expect(result.inbox.status).toBe('ok');
    if (result.inbox.status !== 'ok') throw new Error('unreachable');
    expect(result.inbox.truncated).toBe(false);
    expect(result.inbox.matched).toBe(2);
    expect(result.inbox.messages.map(m => m.id)).toEqual(['post-RQ-M-3', 'wk-mine-1']);
    expect(result.inbox.messages[0]).toMatchObject({ kind: 'dm', from: 'agent:nova', fromAgent: 'nova' });
    expect(result.inbox.messages[0]!.summary).toContain('RQ-M-3');
    // The work.post citation resolves the same live feed job `bus show` reports.
    expect(result.inbox.messages[0]).toMatchObject({ job: { jobId: 'RQ-M-3', feed: 'ok',
      job: { id: 'RQ-M-3', status: 'queued', claimable: true } } });
    expect(result.inbox.messages[1]).toMatchObject({ id: 'wk-mine-1', kind: 'dm',
      from: 'agent:nova', fromAgent: 'nova', channel: null });
    expect(result.inbox.messages[1]!.summary).toContain('feed moved');
    expect(result.inbox.messages[1]).not.toHaveProperty('job');
    expect(result.inbox.nextCursor).toBeGreaterThan(0);
  });

  it('carries the newest status detail into the jobs section and the claim join', async () => {
    const options = setup();
    register(options, 'atlas');
    registerAgentIdentity({ handle: 'atlas', runtime: { cli: 'claude', provider: 'claude', model: null } }, options);
    await announce(options, 'atlas', 'RQ-M-D', ['repo:a/b']);
    claim(options, 'repo:a/b', 'atlas', 'test:atlas-d', options.clock.now);
    expect(await updateWorkStatus({ from: 'atlas', jobId: 'RQ-M-D',
      status: 'rescheduled', detail: 'waiting on fake upstream', id: 'ws-RQ-M-D' }, options))
      .toMatchObject({ status: 'posted' });

    const result = readBusWorkMine('atlas', options);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('unreachable');
    if (result.jobs.status !== 'ok') throw new Error('unreachable');
    // rescheduled stays open, so the job lists with the reason it was rescheduled.
    expect(result.jobs.jobs.find(entry => entry.id === 'RQ-M-D'))
      .toMatchObject({ status: 'rescheduled', detail: 'waiting on fake upstream' });
    // The claim->job join names the same detail and receipt citations.
    if (result.claims.status !== 'ok') throw new Error('unreachable');
    const repoClaim = result.claims.claims.find(row => row.key === 'repo:a/b');
    expect(repoClaim?.jobs).toEqual([{ id: 'RQ-M-D', owner: 'agent:atlas',
      status: 'rescheduled', title: 'Job RQ-M-D', detail: 'waiting on fake upstream',
      postId: 'post-RQ-M-D', statusId: 'ws-RQ-M-D' }]);
    // The human line names the detail too (the claims line prints `RQ-M-D(rescheduled)`).
    const line = formatBusWorkMine(result).find(text => text.includes('RQ-M-D rescheduled'));
    expect(line).toContain('detail="waiting on fake upstream"');
  });

  it('cites the post and newest status envelopes on each open job', async () => {
    const options = setup();
    register(options, 'atlas');
    registerAgentIdentity({ handle: 'atlas', runtime: { cli: 'claude', provider: 'claude', model: null } }, options);
    await announce(options, 'atlas', 'RQ-C-1', ['queue:RQ-C-1']);
    await announce(options, 'atlas', 'RQ-C-2', ['queue:RQ-C-2']);
    expect(await updateWorkStatus({ from: 'atlas', jobId: 'RQ-C-2',
      status: 'rescheduled', id: 'ws-RQ-C-2' }, options)).toMatchObject({ status: 'posted' });

    const result = readBusWorkMine('atlas', options);
    if (result.status !== 'ok' || result.jobs.status !== 'ok') throw new Error('unreachable');
    const byId = new Map(result.jobs.jobs.map(entry => [entry.id, entry]));
    // postId is the announcement envelope; statusId is the newest accepted
    // status envelope, null while none has moved the job.
    expect(byId.get('RQ-C-1')).toMatchObject({ postId: 'post-RQ-C-1', statusId: null });
    expect(byId.get('RQ-C-2')).toMatchObject({ postId: 'post-RQ-C-2', statusId: 'ws-RQ-C-2',
      status: 'rescheduled' });
    const moved = formatBusWorkMine(result).find(text => text.includes('RQ-C-2 rescheduled'))!;
    expect(moved).toContain('post=post-RQ-C-2 status=ws-RQ-C-2');
    const fresh = formatBusWorkMine(result).find(text => text.includes('RQ-C-1 queued'))!;
    expect(fresh).toContain('post=post-RQ-C-1');
    expect(fresh).not.toContain('status=');
  });

  it('lists the agent\'s live announced jobs across every non-terminal status', async () => {
    const options = setup();
    register(options, 'atlas', 'nova');
    registerAgentIdentity({ handle: 'atlas', runtime: { cli: 'claude', provider: 'claude', model: null } }, options);
    registerAgentIdentity({ handle: 'nova', runtime: { cli: 'codex', provider: 'codex-personal', model: null } }, options);

    // atlas's announcements across the lifecycle; nova's own stay out.
    await announce(options, 'atlas', 'RQ-A-1', ['queue:RQ-A-1']);
    await announce(options, 'atlas', 'RQ-A-2', ['queue:RQ-A-2']);
    // A claim-key-less announcement is never claimable work but still the
    // announcer's to move.
    await announce(options, 'atlas', 'RQ-A-3', []);
    await announce(options, 'atlas', 'RQ-A-4', ['queue:RQ-A-4']);
    await announce(options, 'atlas', 'RQ-A-5', ['queue:RQ-A-5']);
    await announce(options, 'atlas', 'RQ-A-6', ['queue:RQ-A-6']);
    await announce(options, 'nova', 'RQ-N-1', ['queue:RQ-N-1']);

    expect(await updateWorkStatus({ from: 'atlas', jobId: 'RQ-A-2', status: 'running', id: 'ws-a2' }, options))
      .toMatchObject({ status: 'posted' });
    options.clock.now += 1_000;
    expect(await updateWorkStatus({ from: 'atlas', jobId: 'RQ-A-3', status: 'blocked',
      detail: 'waiting on fake review', id: 'ws-a3' }, options)).toMatchObject({ status: 'posted' });
    options.clock.now += 1_000;
    expect(await updateWorkStatus({ from: 'atlas', jobId: 'RQ-A-4', status: 'failed',
      detail: 'fake crash', id: 'ws-a4' }, options)).toMatchObject({ status: 'posted' });
    expect(await updateWorkStatus({ from: 'atlas', jobId: 'RQ-A-5', status: 'done', id: 'ws-a5' }, options))
      .toMatchObject({ status: 'posted' });
    expect(await updateWorkStatus({ from: 'atlas', jobId: 'RQ-A-6', status: 'terminated', id: 'ws-a6' }, options))
      .toMatchObject({ status: 'posted' });
    expect(await updateWorkStatus({ from: 'nova', jobId: 'RQ-N-1', status: 'running', id: 'ws-n1' }, options))
      .toMatchObject({ status: 'posted' });

    const result = readBusWorkMine('atlas', options);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('unreachable');
    // done and terminated drop off; failed stays — only the announcer may move it.
    expect(result.announced).toMatchObject({ status: 'ok', matched: 4, truncated: false });
    if (result.announced.status !== 'ok') throw new Error('unreachable');
    // Newest update first; the two t=1000 jobs keep feed order.
    expect(result.announced.items.map(item => item.id)).toEqual(['RQ-A-4', 'RQ-A-3', 'RQ-A-1', 'RQ-A-2']);
    const byId = new Map(result.announced.items.map(item => [item.id, item]));
    expect(byId.get('RQ-A-2')).toMatchObject({ status: 'running', postId: 'post-RQ-A-2', statusId: 'ws-a2' });
    expect(byId.get('RQ-A-3')).toMatchObject({ status: 'blocked', detail: 'waiting on fake review',
      postId: 'post-RQ-A-3', statusId: 'ws-a3', claimKeys: [] });
    expect(byId.get('RQ-A-4')).toMatchObject({ status: 'failed', detail: 'fake crash',
      postId: 'post-RQ-A-4', statusId: 'ws-a4' });
    expect(byId.get('RQ-A-1')).toMatchObject({ status: 'queued', statusId: null });

    // The still-open announcement appears in both views: jobs is the
    // claimable view, announced the ownership view.
    expect(result.jobs.status).toBe('ok');
    if (result.jobs.status !== 'ok') throw new Error('unreachable');
    expect(result.jobs.jobs.map(job => job.id)).toEqual(['RQ-A-1']);

    // nova's running job is not atlas's announcement; atlas's are not nova's.
    const other = readBusWorkMine('nova', options);
    expect(other.status).toBe('ok');
    if (other.status !== 'ok') throw new Error('unreachable');
    expect(other.announced).toMatchObject({ status: 'ok', matched: 1, truncated: false });
    if (other.announced.status !== 'ok') throw new Error('unreachable');
    expect(other.announced.items[0]).toMatchObject({ id: 'RQ-N-1', status: 'running' });
  });

  it('annotates announced jobs with live claim coverage of their declared keys', async () => {
    const options = setup();
    register(options, 'atlas', 'nova');
    registerAgentIdentity({ handle: 'atlas', runtime: { cli: 'claude', provider: 'claude', model: null } }, options);
    registerAgentIdentity({ handle: 'nova', runtime: { cli: 'codex', provider: 'codex-personal', model: null } }, options);

    // RQ-H-1 reports running while nova holds one of its declared keys;
    // RQ-H-2 stays queued and unheld; RQ-H-3 declares no keys at all.
    await announce(options, 'atlas', 'RQ-H-1', ['queue:RQ-H-1', 'repo:a/b']);
    await announce(options, 'atlas', 'RQ-H-2', ['queue:RQ-H-2']);
    await announce(options, 'atlas', 'RQ-H-3', []);
    options.clock.now += 1_000;
    expect(await updateWorkStatus({ from: 'atlas', jobId: 'RQ-H-1', status: 'running', id: 'ws-h1' }, options))
      .toMatchObject({ status: 'posted' });
    options.clock.now += 1_000;
    expect(await updateWorkStatus({ from: 'atlas', jobId: 'RQ-H-3', status: 'blocked', id: 'ws-h3' }, options))
      .toMatchObject({ status: 'posted' });
    claim(options, 'queue:RQ-H-1', 'nova', 'test:nova-h1', options.clock.now);

    const result = readBusWorkMine('atlas', options);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok' || result.announced.status !== 'ok') throw new Error('unreachable');
    expect(result.announced.matched).toBe(3);
    const byId = new Map(result.announced.items.map(item => [item.id, item]));
    // A shown hold is real under complete coverage: the claimed key reads held,
    // the unclaimed repo key reads provably free.
    expect(byId.get('RQ-H-1')).toMatchObject({ status: 'running', held: true,
      heldKeys: ['queue:RQ-H-1'], freeKeys: ['repo:a/b'] });
    // Complete coverage with no holds: every declared key is provably free.
    // RQ-H-2 is open, so the feed annotates it claimable — announced items
    // report the held tri-state instead and must not carry that field.
    expect(byId.get('RQ-H-2')).toMatchObject({ status: 'queued', held: false,
      heldKeys: [], freeKeys: ['queue:RQ-H-2'] });
    expect(byId.get('RQ-H-2')).not.toHaveProperty('claimable');
    // No declared keys: nothing a hold could cover.
    expect(byId.get('RQ-H-3')).toMatchObject({ status: 'blocked', held: false,
      heldKeys: [], freeKeys: [], claimKeys: [] });
    // The human lines carry the same tri-state the JSON does; announced
    // lines are the ones carrying heldkeys= (open jobs list in jobs too).
    const text = formatBusWorkMine(result);
    const announcedLine = (id: string): string =>
      text.find(line => line.includes(id) && line.includes('heldkeys='))!;
    expect(announcedLine('RQ-H-1 running')).toContain('held=yes');
    expect(announcedLine('RQ-H-1 running')).toContain('heldkeys=queue:RQ-H-1');
    expect(announcedLine('RQ-H-2 queued')).toContain('held=no');
    expect(announcedLine('RQ-H-3 blocked')).toContain('held=no');
  });

  it('keeps announced hold coverage unknown when the coordination table is unreadable', async () => {
    const options = setup();
    register(options, 'atlas');
    registerAgentIdentity({ handle: 'atlas', runtime: { cli: 'claude', provider: 'claude', model: null } }, options);
    await announce(options, 'atlas', 'RQ-U-1', ['queue:RQ-U-1']);
    claim(options, 'queue:RQ-U-1', 'nova', 'test:nova-u1', options.clock.now);
    // Poison the coordination table after the lease lands: coverage is
    // unknown, never proven free or held.
    writeFileSync(join(options.root, 'coordination', 'claims.json'), 'invalid JSON');

    const result = readBusWorkMine('atlas', options);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok' || result.announced.status !== 'ok') throw new Error('unreachable');
    expect(result.announced.items[0]).toMatchObject({ id: 'RQ-U-1', held: null,
      heldKeys: null, freeKeys: null });
    expect(formatBusWorkMine(result)
      .find(line => line.includes('RQ-U-1 queued') && line.includes('heldkeys='))).toContain('held=unknown');
  });

  it('matches announced jobs under every identity label and narrows when the registry is unreadable', async () => {
    const options = setup();
    expect(registerAgentIdentity({ handle: 'atlas', aliases: ['atlas-alias'],
      runtime: { cli: 'claude', provider: 'claude', model: null } }, options).status).toBe('created');
    await announce(options, 'atlas', 'RQ-ID-1', ['queue:RQ-ID-1']);

    for (const ref of ['atlas', 'agent:atlas', 'atlas-alias', stableAgentId('atlas')]) {
      const result = readBusWorkMine(ref, options);
      expect(result.status).toBe('ok');
      if (result.status !== 'ok') throw new Error('unreachable');
      expect(result.announced).toMatchObject({ status: 'ok', matched: 1, truncated: false });
      if (result.announced.status !== 'ok') throw new Error('unreachable');
      expect(result.announced.items[0]).toMatchObject({ id: 'RQ-ID-1', owner: 'agent:atlas' });
    }

    // An unreadable registry narrows to the literal label, never widens: the
    // job's owner is agent:atlas, so only that exact ref still matches.
    writeFileSync(join(options.root, 'agent-identities', 'registry.json'), '{invalid', { mode: 0o600 });
    const narrowed = readBusWorkMine('agent:atlas', options);
    expect(narrowed.status).toBe('ok');
    if (narrowed.status !== 'ok') throw new Error('unreachable');
    expect(narrowed.announced).toMatchObject({ status: 'ok', matched: 1 });
    const alias = readBusWorkMine('atlas-alias', options);
    expect(alias.status).toBe('ok');
    if (alias.status !== 'ok') throw new Error('unreachable');
    expect(alias.announced).toMatchObject({ status: 'ok', matched: 0, items: [] });
  });

  it('caps shown announced jobs at fifty with the true total', async () => {
    const options = setup();
    register(options, 'atlas');
    registerAgentIdentity({ handle: 'atlas', runtime: { cli: 'claude', provider: 'claude', model: null } }, options);
    for (let i = 1; i <= 51; i += 1) {
      await announce(options, 'atlas', `RQ-CAP-${String(i).padStart(2, '0')}`, [`queue:RQ-CAP-${String(i).padStart(2, '0')}`]);
    }

    const result = readBusWorkMine('atlas', options);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('unreachable');
    expect(result.announced).toMatchObject({ status: 'ok', matched: 51, truncated: true });
    if (result.announced.status !== 'ok') throw new Error('unreachable');
    expect(result.announced.items).toHaveLength(50);
    // All jobs share one timestamp, so feed order holds: the first fifty show.
    expect(result.announced.items[0]).toMatchObject({ id: 'RQ-CAP-01' });
    expect(result.announced.items[49]).toMatchObject({ id: 'RQ-CAP-50' });
    expect(result.announced.items.some(item => item.id === 'RQ-CAP-51')).toBe(false);
  });

  it('reports the feed state on announced rather than an empty list', async () => {
    const options = setup();
    register(options, 'atlas');
    registerAgentIdentity({ handle: 'atlas', runtime: { cli: 'claude', provider: 'claude', model: null } }, options);
    await announce(options, 'atlas', 'RQ-DUP', ['queue:RQ-DUP']);
    // A second announcement of the same job id poisons the whole feed projection.
    const dup = appendBusInbox({ id: 'post-dup-2', from: 'agent:atlas', to: 'leaders',
      priority: 'P2', ttl: 120_000,
      body: { kind: 'work.post', jobId: 'RQ-DUP', title: 'dup', repo: 'a/b',
        claimKeys: ['queue:RQ-DUP'], provider: 'claude' } },
      { root: options.root, now: options.now });
    expect(dup.status).toBe('posted');

    const result = readBusWorkMine('atlas', options);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('unreachable');
    // The refused feed names the retained receipt that poisoned it.
    expect(result.announced).toEqual({ status: 'refused', reason: 'duplicate-job', receipts: 2,
      receipt: { id: 'post-dup-2', receivedAt: 1_000, ttl: 120_000 } });
    // The jobs section reports the same feed state.
    expect(result.jobs).toMatchObject({ status: 'refused', reason: 'duplicate-job',
      receipt: { id: 'post-dup-2' } });
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
    // 21 pending: the oldest 20 show, the newest is provably beyond nextCursor,
    // and matched reports the true pending total, not just the shown window.
    expect(result.inbox.truncated).toBe(true);
    expect(result.inbox.matched).toBe(21);
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
    expect(exact.inbox.matched).toBe(20);
    expect(exact.inbox.messages).toHaveLength(20);
  });

  it('reports the true wake-hint and mail totals when the shown windows overflow', async () => {
    const options = setup();
    register(options, 'atlas', 'nova');
    registerAgentIdentity({ handle: 'atlas', runtime: { cli: 'claude', provider: 'claude', model: null } }, options);
    registerAgentIdentity({ handle: 'nova', runtime: { cli: 'codex', provider: 'codex-personal', model: null } }, options);
    for (let i = 1; i <= 25; i += 1) {
      expect(await sendWakeRequest({ from: 'nova', to: 'atlas', reason: `wake ${i}`,
        id: `wk-over-${String(i).padStart(2, '0')}` }, options)).toMatchObject({ status: 'posted' });
    }

    const result = readBusWorkMine('atlas', options);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('unreachable');
    // 25 matched hints, newest 20 shown — matched is the total, not the window.
    expect(result.wakes.status).toBe('ok');
    if (result.wakes.status !== 'ok') throw new Error('unreachable');
    expect(result.wakes.matched).toBe(25);
    expect(result.wakes.truncated).toBe(true);
    expect(result.wakes.wakes).toHaveLength(20);
    expect(result.wakes.wakes[0]).toMatchObject({ id: 'wk-over-06' });
    expect(result.wakes.wakes.at(-1)).toMatchObject({ id: 'wk-over-25' });
    // The same 25 wake envelopes are also pending mail: the inbox total agrees.
    expect(result.inbox.status).toBe('ok');
    if (result.inbox.status !== 'ok') throw new Error('unreachable');
    expect(result.inbox.matched).toBe(25);
    expect(result.inbox.truncated).toBe(true);
    expect(result.inbox.messages).toHaveLength(20);
  });

  it('carries the inbox hold evidence on claimable and handoff mail only', async () => {
    const options = setup(Date.now());
    register(options, 'atlas', 'nova');
    registerAgentIdentity({ handle: 'atlas', runtime: { cli: 'claude', provider: 'claude', model: null } }, options);
    registerAgentIdentity({ handle: 'nova', runtime: { cli: 'codex', provider: 'codex-personal', model: null } }, options);

    // Claimable work mail held through the canonical bus-next claim path,
    // claimable work mail nobody has taken, a worker-handoff assignment and
    // plain mail that must carry no held field at all.
    postClaimable(options, 'w-held');
    takeWork(options, 'w-held', 'nova');
    postClaimable(options, 'w-free');
    expect(await sendHandoff({ from: 'nova', to: 'atlas', taskId: 'RQ-M-7', prompt: 'take this task',
      id: 'ho-m-2' }, options)).toMatchObject({ status: 'posted' });
    expect(await sendDirectMessage({ from: 'nova', to: 'atlas', text: 'just talk',
      id: 'dm-plain-1' }, options)).toMatchObject({ status: 'posted' });

    const result = readBusWorkMine('atlas', options);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok' || result.inbox.status !== 'ok') throw new Error('unreachable');
    const byId = new Map(result.inbox.messages.map(message => [message.id, message]));
    expect(byId.get('w-held')).toMatchObject({ held: true, holder: 'nova' });
    expect(byId.get('w-free')).toMatchObject({ held: false, holder: null });
    expect(byId.get('ho-m-2')).toMatchObject({ held: false, holder: null });
    expect(byId.get('dm-plain-1')?.held).toBeUndefined();
    expect(byId.get('dm-plain-1')?.holder).toBeUndefined();

    // The human line shows the same evidence inside the bracket the inbox
    // frame uses, and plain mail stays unchanged.
    const lines = formatBusWorkMine(result);
    expect(lines.find(text => text.includes('id=w-held'))).toContain('held=yes holder=nova');
    expect(lines.find(text => text.includes('id=w-free'))).toContain('held=no');
    expect(lines.find(text => text.includes('id=ho-m-2'))).toContain('held=no');
    const plain = lines.find(text => text.includes('id=dm-plain-1'))!;
    expect(plain).not.toContain('held=');
  });

  it('reports inbox hold state as unknown when a hold store cannot be read', () => {
    const options = setup();
    register(options, 'atlas');
    registerAgentIdentity({ handle: 'atlas', runtime: { cli: 'claude', provider: 'claude', model: null } }, options);
    postClaimable(options, 'w-unk');
    claim(options, 'queue:w-unk', 'nova', 'test:nova-held', options.clock.now);
    // Poison the coordination table after the lease lands: coverage is
    // unknown, never proven free.
    writeFileSync(join(options.root, 'coordination', 'claims.json'), 'invalid JSON');

    const result = readBusWorkMine('atlas', options);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok' || result.inbox.status !== 'ok') throw new Error('unreachable');
    expect(result.inbox.messages.find(message => message.id === 'w-unk'))
      .toMatchObject({ held: null, holder: null });
    expect(formatBusWorkMine(result).find(text => text.includes('id=w-unk'))).toContain('held=unknown');
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
    // Wakes keep exact-label matching for the unregistered ref: a hint
    // queued under the literal label surfaces under scope 'label'; inbox
    // needs a registered identity: unknown, never an empty list.
    enqueueBusWake({ kind: 'bus.send', id: 'wk-ghost', from: 'agent:atlas', to: 'ghost' },
      { root: options.runsRoot });
    const hinted = readBusWorkMine('ghost', options);
    expect(hinted.status).toBe('ok');
    if (hinted.status !== 'ok') throw new Error('unreachable');
    expect(hinted.wakes).toMatchObject({ status: 'ok', agent: 'ghost', scope: 'label', matched: 1 });
    if (hinted.wakes.status !== 'ok') throw new Error('unreachable');
    expect(hinted.wakes.wakes.map(row => row.id)).toEqual(['wk-ghost']);
    // The earlier digest predates the hint: matched 0, never an error.
    expect(result.wakes).toMatchObject({ status: 'ok', agent: 'ghost', scope: 'label', matched: 0, wakes: [] });
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

  it('drops a worker-handoff the addressee already answered with a routed reply', async () => {
    const options = setup(Date.now());
    register(options, 'atlas', 'nova');
    expect(await sendHandoff({ from: 'nova', to: 'atlas', taskId: 'RQ-H-A',
      prompt: 'take the answered task', id: 'ho-ans' }, options)).toMatchObject({ status: 'posted' });
    const before = readBusWorkMine('atlas', options);
    if (before.status !== 'ok' || before.handoffs.status !== 'ok') throw new Error('unreachable');
    expect(before.handoffs.matched).toBe(1);
    // The worker-exit reply the handoff verbs publish routes recipient ->
    // sender (atlas -> nova) and cites the handoff id — the same evidence the
    // conversation projection credits when it marks the thread answered.
    const reply = appendBusInbox({ id: 'ho-ans-reply', from: 'agent:atlas', to: 'agent:nova',
      priority: 'P2', ttl: 120_000,
      body: { kind: 'worker-exit', inReplyTo: 'ho-ans', exitCode: 0, succeeded: true } },
      { root: options.root, now: options.now });
    expect(reply.status).toBe('posted');
    const after = readBusWorkMine('atlas', options);
    if (after.status !== 'ok' || after.handoffs.status !== 'ok') throw new Error('unreachable');
    expect(after.handoffs).toMatchObject({ status: 'ok', matched: 0, items: [], truncated: false });
    // The assigner still sees nothing pending either — the handoff was theirs.
    const assigner = readBusWorkMine('nova', options);
    if (assigner.status !== 'ok' || assigner.handoffs.status !== 'ok') throw new Error('unreachable');
    expect(assigner.handoffs.matched).toBe(0);
  });

  it('keeps a worker-handoff pending when the citation is not the assignee answering back', async () => {
    const options = setup(Date.now());
    register(options, 'atlas', 'nova', 'bystander');
    expect(await sendHandoff({ from: 'nova', to: 'atlas', taskId: 'RQ-H-B',
      prompt: 'take the unanswered task', id: 'ho-unans' }, options)).toMatchObject({ status: 'posted' });
    // A bystander citing the id and the assigner replying onward are not the
    // assignee's routed answer, so the assignment stays pending.
    for (const env of [
      { id: 'ho-unans-bye', from: 'agent:bystander', to: 'leaders',
        body: { kind: 'note', inReplyTo: 'ho-unans', text: 'fyi' } },
      { id: 'ho-unans-fwd', from: 'agent:nova', to: 'agent:atlas',
        body: { kind: 'worker-exit', inReplyTo: 'ho-unans', exitCode: 0, succeeded: true } },
    ]) {
      const posted = appendBusInbox({ ...env, priority: 'P2', ttl: 120_000 } as BusEnvelope,
        { root: options.root, now: options.now });
      expect(posted.status).toBe('posted');
    }
    const result = readBusWorkMine('atlas', options);
    if (result.status !== 'ok' || result.handoffs.status !== 'ok') throw new Error('unreachable');
    expect(result.handoffs.matched).toBe(1);
    expect(result.handoffs.items.map(item => item.id)).toEqual(['ho-unans']);
  });

  it('includes claimable work and handoffs posted to channels the agent belongs to, minus its own posts', async () => {
    const options = setup(Date.now());
    register(options, 'atlas', 'nova', 'ghost');
    registerAgentIdentity({ handle: 'atlas', aliases: ['atlas-alias'],
      runtime: { cli: 'claude', provider: 'claude', model: null } }, options);
    registerAgentIdentity({ handle: 'nova',
      runtime: { cli: 'codex', provider: 'codex-personal', model: null } }, options);
    // eng: atlas + nova. ops: nova only. ghost belongs to neither.
    expect(createAgentChannel({ name: 'eng', createdBy: 'atlas', members: ['nova'] }, options).status)
      .toBe('created');
    expect(createAgentChannel({ name: 'ops', createdBy: 'nova' }, options).status).toBe('created');

    // Claimable work and a worker-handoff posted into atlas's channel by a
    // third party, so both members see them as pending.
    postClaimable(options, 'w-chan', { to: 'group:eng:general', from: 'agent:ghost', priority: 'P1' });
    const handoffPost = appendBusInbox({ id: 'ho-chan', from: 'agent:ghost', to: 'group:eng:alerts',
      priority: 'P1', ttl: 120_000,
      body: { kind: 'worker-handoff', taskId: 'RQ-CH-1', prompt: 'channel handoff' } },
      { root: options.root, now: options.now });
    expect(handoffPost.status).toBe('posted');
    // Atlas's own channel posts never count as pending for atlas.
    postClaimable(options, 'w-chan-self', { to: 'group:eng:general', from: 'agent:atlas' });
    const selfHandoff = appendBusInbox({ id: 'ho-chan-self', from: 'agent:atlas', to: 'group:eng:alerts',
      priority: 'P0', ttl: 120_000,
      body: { kind: 'worker-handoff', taskId: 'RQ-CH-2', prompt: 'self handoff' } },
      { root: options.root, now: options.now });
    expect(selfHandoff.status).toBe('posted');
    // A channel atlas is not a member of stays out, even for claimable work.
    postClaimable(options, 'w-chan-ops', { to: 'group:ops:general', from: 'agent:ghost', priority: 'P0' });
    // A non-work body in the channel is mail, not pending work.
    postClaimable(options, 'w-chan-note', { to: 'group:eng:general',
      body: { kind: 'note', text: 'just a note' } });
    // Directly addressed work still matches under every identity label.
    postClaimable(options, 'w-direct', { to: 'atlas-alias', priority: 'P2' });

    const result = readBusWorkMine('atlas', options);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok' || result.next.status !== 'ok' || result.handoffs.status !== 'ok') {
      throw new Error('unreachable');
    }
    // Claim order: the P1 channel work and the P2 alias work; self and
    // non-member channel posts stay out.
    expect(result.next.matched).toBe(2);
    expect(result.next.items.map(item => item.id)).toEqual(['w-chan', 'w-direct']);
    expect(result.next.items[0]).toMatchObject({ to: 'group:eng:general', kind: 'work',
      from: 'agent:ghost', fromAgent: 'ghost', held: false });
    expect(result.next.items[1]).toMatchObject({ to: 'atlas-alias', held: false });
    expect(result.handoffs.matched).toBe(1);
    expect(result.handoffs.items[0]).toMatchObject({ id: 'ho-chan', to: 'group:eng:alerts',
      taskId: 'RQ-CH-1', fromAgent: 'ghost', held: false });

    // A channel member sees the same channel work — including atlas's own
    // channel post, which is pending for everyone but its author. The ops
    // channel is nova's alone here; the atlas alias work is not nova's.
    const other = readBusWorkMine('nova', options);
    expect(other.status).toBe('ok');
    if (other.status !== 'ok' || other.next.status !== 'ok' || other.handoffs.status !== 'ok') {
      throw new Error('unreachable');
    }
    expect(other.next.matched).toBe(3);
    expect(other.next.items.map(item => item.id)).toEqual(['w-chan-ops', 'w-chan', 'w-chan-self']);
    expect(other.handoffs.matched).toBe(2);
    expect(other.handoffs.items.map(item => item.id)).toEqual(['ho-chan-self', 'ho-chan']);

    // A registered agent in no channel sees only label-addressed work.
    const outsider = readBusWorkMine('ghost', options);
    expect(outsider.status).toBe('ok');
    if (outsider.status !== 'ok' || outsider.next.status !== 'ok' || outsider.handoffs.status !== 'ok') {
      throw new Error('unreachable');
    }
    expect(outsider.next.matched).toBe(0);
    expect(outsider.handoffs.matched).toBe(0);

    // The literal group address still works as an exact-label ref.
    const topic = readBusWorkMine('group:eng:general', options);
    expect(topic.status).toBe('ok');
    if (topic.status !== 'ok' || topic.next.status !== 'ok') throw new Error('unreachable');
    expect(topic.next.matched).toBe(2);
    expect(topic.next.items.map(item => item.id)).toEqual(['w-chan', 'w-chan-self']);

    // An unreadable registry narrows channel matching away entirely.
    writeFileSync(join(options.root, 'agent-identities', 'registry.json'), '{invalid', { mode: 0o600 });
    const narrowed = readBusWorkMine('agent:atlas', options);
    expect(narrowed.status).toBe('ok');
    if (narrowed.status !== 'ok' || narrowed.next.status !== 'ok' || narrowed.handoffs.status !== 'ok') {
      throw new Error('unreachable');
    }
    expect(narrowed.next.matched).toBe(0);
    expect(narrowed.handoffs.matched).toBe(0);
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
    expect(result.threads).toEqual({ status: 'unavailable', reason: 'Bus store is not readable.' });
    expect(result.blocked).toEqual({ status: 'unavailable', reason: 'Bus store is not readable.' });
  });

  it('lists conversation threads waiting on the agent and clears them once answered', async () => {
    const options = setup();
    register(options, 'atlas', 'nova', 'ghost');
    registerAgentIdentity({ handle: 'atlas', runtime: { cli: 'claude', provider: 'claude', model: null } }, options);
    registerAgentIdentity({ handle: 'nova', runtime: { cli: 'codex', provider: 'codex-personal', model: null } }, options);

    // An ask waits on atlas; a plain note and an ask to someone else do not.
    expect(await sendDirectMessage({ from: 'nova', to: 'atlas', text: 'can you review the feed?',
      thread: 't-review', id: 'ask-1' }, options)).toMatchObject({ status: 'posted' });
    expect(await sendDirectMessage({ from: 'nova', to: 'atlas', text: 'fyi only',
      thread: 't-note', id: 'note-1' }, options)).toMatchObject({ status: 'posted' });
    expect(await sendDirectMessage({ from: 'nova', to: 'ghost', text: 'ghost question?',
      id: 'ask-ghost' }, options)).toMatchObject({ status: 'posted' });

    const result = readBusWorkMine('atlas', options);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('unreachable');
    expect(result.threads).toMatchObject({ status: 'ok', source: 'available', matched: 1,
      truncated: false, skipped: 0 });
    if (result.threads.status !== 'ok') throw new Error('unreachable');
    expect(result.threads.items).toHaveLength(1);
    const item = result.threads.items[0]!;
    expect(item).toMatchObject({ id: 't-review', messageId: 'ask-1', kind: 'ask',
      waitingOn: 'atlas', from: 'nova', fromAgent: 'nova', messageCount: 1 });
    expect(item.subject).toContain('can you review the feed?');
    expect(item.waitingMs).toBe(0);
    expect(item.lastAt).toBe(new Date(options.clock.now).toISOString());
    // The human line cites the same wait.
    expect(formatBusWorkMine(result).join('\n')).toContain('waiting=');

    // The sender does not owe itself the answer.
    const sender = readBusWorkMine('nova', options);
    if (sender.status !== 'ok' || sender.threads.status !== 'ok') throw new Error('unreachable');
    expect(sender.threads.matched).toBe(0);

    // Answering in the same thread clears the wait. The clock advances so the
    // reply sorts after the ask (same-instant messages order by envelope id).
    options.clock.now += 60_000;
    expect(await sendDirectMessage({ from: 'atlas', to: 'nova', text: 'reviewed, looks good',
      thread: 't-review', id: 'ans-1' }, options)).toMatchObject({ status: 'posted' });
    const after = readBusWorkMine('atlas', options);
    if (after.status !== 'ok' || after.threads.status !== 'ok') throw new Error('unreachable');
    expect(after.threads).toMatchObject({ matched: 0, items: [] });
  });

  it('lists channel waits for members minus the author, and handoffs as waiting threads', async () => {
    const options = setup();
    register(options, 'atlas', 'nova', 'ghost');
    registerAgentIdentity({ handle: 'atlas', runtime: { cli: 'claude', provider: 'claude', model: null } }, options);
    registerAgentIdentity({ handle: 'nova', runtime: { cli: 'codex', provider: 'codex-personal', model: null } }, options);
    registerAgentIdentity({ handle: 'ghost', runtime: { cli: 'grok', provider: 'local', model: null } }, options);
    // eng: atlas + nova. ops: nova only.
    expect(createAgentChannel({ name: 'eng', createdBy: 'atlas', members: ['nova'] }, options).status)
      .toBe('created');
    expect(createAgentChannel({ name: 'ops', createdBy: 'nova' }, options).status).toBe('created');

    const post = (id: string, from: string, to: string, text: string) => {
      const posted = appendBusInbox({ id, from, to, priority: 'P2', ttl: 120_000,
        body: { kind: 'note', text } }, { root: options.root, now: options.now });
      expect(posted.status).toBe('posted');
    };
    post('ch-ask', 'agent:ghost', 'group:eng:general', 'can someone check the deploy?');
    post('ch-self', 'agent:atlas', 'group:eng:general', 'eng question for the room?');
    post('ops-ask', 'agent:ghost', 'group:ops:general', 'ops question?');
    // A handoff waits too — kind handoff in the same thread projection.
    expect(await sendHandoff({ from: 'nova', to: 'atlas', taskId: 'RQ-T-1',
      prompt: 'take this', id: 'ho-wait' }, options)).toMatchObject({ status: 'posted' });

    const atlas = readBusWorkMine('atlas', options);
    if (atlas.status !== 'ok' || atlas.threads.status !== 'ok') throw new Error('unreachable');
    // The eng ask and the handoff; atlas's own eng post and the ops channel stay out.
    expect(atlas.threads.matched).toBe(2);
    const byMessage = new Map(atlas.threads.items.map(item => [item.messageId, item]));
    expect(byMessage.get('ch-ask')).toMatchObject({ kind: 'ask', waitingOn: 'group:eng:general',
      from: 'ghost', fromAgent: 'ghost' });
    expect(byMessage.get('ho-wait')).toMatchObject({ kind: 'handoff', waitingOn: 'atlas',
      from: 'nova', fromAgent: 'nova' });
    expect(byMessage.has('ch-self')).toBe(false);
    expect(byMessage.has('ops-ask')).toBe(false);

    const nova = readBusWorkMine('nova', options);
    if (nova.status !== 'ok' || nova.threads.status !== 'ok') throw new Error('unreachable');
    // nova is in eng and ops: both eng asks (including atlas's own), the ops
    // ask — but not the handoff nova itself sent.
    expect(nova.threads.matched).toBe(3);
    const novaIds = nova.threads.items.map(item => item.messageId);
    expect(novaIds).toEqual(expect.arrayContaining(['ch-ask', 'ch-self', 'ops-ask']));
    expect(novaIds).not.toContain('ho-wait');
  });

  it('narrows threads to literal labels when the registry is unreadable', async () => {
    const options = setup();
    expect(registerAgentIdentity({ handle: 'atlas', aliases: ['atlas-alias'],
      runtime: { cli: 'claude', provider: 'claude', model: null } }, options).status).toBe('created');
    expect(registerAgentIdentity({ handle: 'nova',
      runtime: { cli: 'codex', provider: 'codex-personal', model: null } }, options).status).toBe('created');

    await sendDirectMessage({ from: 'nova', to: 'atlas', text: 'direct question?', id: 'ask-direct' }, options);
    // Alias-addressed mail keeps the literal alias label only via a raw post —
    // sendDirectMessage normalizes every recipient to agent:<handle>.
    const aliasPost = appendBusInbox({ id: 'ask-alias', from: 'agent:nova', to: 'atlas-alias',
      priority: 'P2', ttl: 120_000, body: { kind: 'note', text: 'alias question?' } },
      { root: options.root, now: options.now });
    expect(aliasPost.status).toBe('posted');

    // Both labels resolve to atlas's identity.
    const full = readBusWorkMine('atlas', options);
    if (full.status !== 'ok' || full.threads.status !== 'ok') throw new Error('unreachable');
    expect(full.threads.matched).toBe(2);

    // An unreadable registry narrows to the literal label, never widens.
    writeFileSync(join(options.root, 'agent-identities', 'registry.json'), '{invalid', { mode: 0o600 });
    const narrowed = readBusWorkMine('agent:atlas', options);
    expect(narrowed.status).toBe('ok');
    if (narrowed.status !== 'ok' || narrowed.threads.status !== 'ok') throw new Error('unreachable');
    expect(narrowed.threads.matched).toBe(1);
    expect(narrowed.threads.items[0]).toMatchObject({ messageId: 'ask-direct', fromAgent: null });
  });

  it('matches waiting threads by literal label for an unregistered agent', async () => {
    const options = setup();
    register(options, 'atlas', 'nova');
    registerAgentIdentity({ handle: 'atlas', runtime: { cli: 'claude', provider: 'claude', model: null } }, options);
    registerAgentIdentity({ handle: 'nova', runtime: { cli: 'codex', provider: 'codex-personal', model: null } }, options);
    const posted = appendBusInbox({ id: 'ask-ghost', from: 'agent:nova', to: 'agent:ghost',
      priority: 'P2', ttl: 120_000, body: { kind: 'note', text: 'ghost question?' } },
      { root: options.root, now: options.now });
    expect(posted.status).toBe('posted');

    const ghost = readBusWorkMine('ghost', options);
    expect(ghost.status).toBe('ok');
    if (ghost.status !== 'ok' || ghost.threads.status !== 'ok') throw new Error('unreachable');
    expect(ghost.threads.matched).toBe(1);
    expect(ghost.threads.items[0]).toMatchObject({ messageId: 'ask-ghost', kind: 'ask',
      waitingOn: 'ghost', from: 'nova', fromAgent: 'nova' });
    // A registered agent the wait is not on never sees it.
    const atlas = readBusWorkMine('atlas', options);
    if (atlas.status !== 'ok' || atlas.threads.status !== 'ok') throw new Error('unreachable');
    expect(atlas.threads.matched).toBe(0);
  });

  it('reports threads empty on a missing store and unavailable on an unreadable one', async () => {
    const options = setup();
    register(options, 'atlas');
    // No bus store at all: a verified-empty ok, never unknown.
    const empty = readBusWorkMine('atlas', options);
    expect(empty.status).toBe('ok');
    if (empty.status !== 'ok') throw new Error('unreachable');
    expect(empty.threads).toMatchObject({ status: 'ok', source: 'missing', matched: 0,
      items: [], truncated: false, skipped: 0 });
    expect(empty.blocked).toMatchObject({ status: 'ok', source: 'missing', matched: 0,
      items: [], truncated: false, skipped: 0 });

    // A poisoned store is unknown, never an empty list.
    postClaimable(options, 'w-1');
    writeFileSync(join(options.root, 'bus-inbox', 'messages.json'), '{invalid', { mode: 0o600 });
    const down = readBusWorkMine('atlas', options);
    expect(down.status).toBe('ok');
    if (down.status !== 'ok') throw new Error('unreachable');
    expect(down.threads).toEqual({ status: 'unavailable', reason: 'Bus store is not readable.' });
    expect(down.awaiting).toEqual({ status: 'unavailable', reason: 'Bus store is not readable.' });
    expect(down.blocked).toEqual({ status: 'unavailable', reason: 'Bus store is not readable.' });
  });

  it('lists conversations the agent is waiting on and clears them once answered', async () => {
    const options = setup();
    register(options, 'atlas', 'nova', 'ghost');
    registerAgentIdentity({ handle: 'atlas', runtime: { cli: 'claude', provider: 'claude', model: null } }, options);
    registerAgentIdentity({ handle: 'nova', runtime: { cli: 'codex', provider: 'codex-personal', model: null } }, options);

    // atlas's ask waits on nova; a plain note and nova's own ask do not count.
    expect(await sendDirectMessage({ from: 'atlas', to: 'nova', text: 'can you check the feed?',
      thread: 't-out', id: 'out-ask' }, options)).toMatchObject({ status: 'posted' });
    expect(await sendDirectMessage({ from: 'atlas', to: 'nova', text: 'fyi only',
      thread: 't-note', id: 'out-note' }, options)).toMatchObject({ status: 'posted' });
    expect(await sendDirectMessage({ from: 'nova', to: 'ghost', text: 'ghost question?',
      id: 'ask-ghost' }, options)).toMatchObject({ status: 'posted' });

    const result = readBusWorkMine('atlas', options);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('unreachable');
    expect(result.awaiting).toMatchObject({ status: 'ok', source: 'available', matched: 1,
      truncated: false, skipped: 0 });
    if (result.awaiting.status !== 'ok') throw new Error('unreachable');
    const item = result.awaiting.items[0]!;
    expect(item).toMatchObject({ id: 't-out', messageId: 'out-ask', kind: 'ask',
      waitingOn: 'nova', waitingOnAgent: 'nova', from: 'atlas', fromAgent: 'atlas',
      messageCount: 1 });
    expect(item.subject).toContain('can you check the feed?');
    expect(item.waitingMs).toBe(0);
    expect(item.lastAt).toBe(new Date(options.clock.now).toISOString());
    expect(formatBusWorkMine(result).join('\n')).toContain('awaiting=1');

    // The recipient sees the mirror: the same thread waits on atlas for nova,
    // and atlas's own note and nova's ghost ask stay out of both directions.
    const recipient = readBusWorkMine('nova', options);
    if (recipient.status !== 'ok' || recipient.threads.status !== 'ok' ||
        recipient.awaiting.status !== 'ok') throw new Error('unreachable');
    expect(recipient.threads.matched).toBe(1);
    expect(recipient.threads.items[0]).toMatchObject({ messageId: 'out-ask', waitingOn: 'nova' });
    expect(recipient.awaiting.matched).toBe(1);
    expect(recipient.awaiting.items[0]).toMatchObject({ messageId: 'ask-ghost',
      waitingOn: 'ghost', waitingOnAgent: 'ghost' });

    // Answering in the same thread clears the wait for both sides.
    options.clock.now += 60_000;
    expect(await sendDirectMessage({ from: 'nova', to: 'atlas', text: 'checked, looks good',
      thread: 't-out', id: 'out-ans' }, options)).toMatchObject({ status: 'posted' });
    const after = readBusWorkMine('atlas', options);
    if (after.status !== 'ok' || after.awaiting.status !== 'ok') throw new Error('unreachable');
    expect(after.awaiting).toMatchObject({ matched: 0, items: [] });
    const recipientAfter = readBusWorkMine('nova', options);
    if (recipientAfter.status !== 'ok' || recipientAfter.threads.status !== 'ok') throw new Error('unreachable');
    expect(recipientAfter.threads.matched).toBe(0);
  });

  it('lists sent handoffs and channel asks as awaiting, minus waits on itself', async () => {
    const options = setup();
    register(options, 'atlas', 'nova', 'ghost');
    registerAgentIdentity({ handle: 'atlas', runtime: { cli: 'claude', provider: 'claude', model: null } }, options);
    registerAgentIdentity({ handle: 'nova', runtime: { cli: 'codex', provider: 'codex-personal', model: null } }, options);
    registerAgentIdentity({ handle: 'ghost', runtime: { cli: 'grok', provider: 'local', model: null } }, options);
    expect(createAgentChannel({ name: 'eng', createdBy: 'atlas', members: ['nova'] }, options).status)
      .toBe('created');

    // A sent handoff waits on its assignee; a channel ask waits on the room.
    expect(await sendHandoff({ from: 'atlas', to: 'nova', taskId: 'RQ-T-9',
      prompt: 'take this', id: 'ho-out' }, options)).toMatchObject({ status: 'posted' });
    const post = appendBusInbox({ id: 'ch-out', from: 'agent:atlas', to: 'group:eng:general',
      priority: 'P2', ttl: 120_000, body: { kind: 'note', text: 'eng question for the room?' } },
      { root: options.root, now: options.now });
    expect(post.status).toBe('posted');
    // atlas cannot wait on itself: a self-addressed ask never counts.
    const selfPost = appendBusInbox({ id: 'self-out', from: 'agent:atlas', to: 'agent:atlas',
      priority: 'P2', ttl: 120_000, body: { kind: 'note', text: 'note to self?' } },
      { root: options.root, now: options.now });
    expect(selfPost.status).toBe('posted');

    const result = readBusWorkMine('atlas', options);
    if (result.status !== 'ok' || result.awaiting.status !== 'ok') throw new Error('unreachable');
    expect(result.awaiting.matched).toBe(2);
    const byMessage = new Map(result.awaiting.items.map(item => [item.messageId, item]));
    expect(byMessage.get('ho-out')).toMatchObject({ kind: 'handoff', waitingOn: 'nova',
      waitingOnAgent: 'nova', from: 'atlas' });
    expect(byMessage.get('ch-out')).toMatchObject({ kind: 'ask', waitingOn: 'group:eng:general',
      waitingOnAgent: null, from: 'atlas' });
    expect(byMessage.has('self-out')).toBe(false);
    // The sent handoff also shows in the receivable handoffs of its assignee,
    // while atlas's awaiting section never lists inbound waits.
    const nova = readBusWorkMine('nova', options);
    if (nova.status !== 'ok' || nova.awaiting.status !== 'ok' || nova.threads.status !== 'ok') {
      throw new Error('unreachable');
    }
    expect(nova.awaiting.matched).toBe(0);
    expect(nova.threads.matched).toBe(2);
  });

  it('narrows awaiting to literal labels when the registry is unreadable', async () => {
    const options = setup();
    register(options, 'atlas', 'nova');
    registerAgentIdentity({ handle: 'atlas', aliases: ['atlas-alias'],
      runtime: { cli: 'claude', provider: 'claude', model: null } }, options);
    registerAgentIdentity({ handle: 'nova',
      runtime: { cli: 'codex', provider: 'codex-personal', model: null } }, options);
    expect(await sendDirectMessage({ from: 'atlas', to: 'nova', text: 'alias-side question?',
      id: 'out-alias' }, options)).toMatchObject({ status: 'posted' });

    const full = readBusWorkMine('atlas', options);
    if (full.status !== 'ok' || full.awaiting.status !== 'ok') throw new Error('unreachable');
    expect(full.awaiting.matched).toBe(1);
    expect(full.awaiting.items[0]).toMatchObject({ waitingOn: 'nova', waitingOnAgent: 'nova' });

    writeFileSync(join(options.root, 'agent-identities', 'registry.json'), '{invalid', { mode: 0o600 });
    const narrowed = readBusWorkMine('agent:atlas', options);
    expect(narrowed.status).toBe('ok');
    if (narrowed.status !== 'ok' || narrowed.awaiting.status !== 'ok') throw new Error('unreachable');
    expect(narrowed.awaiting.matched).toBe(1);
    expect(narrowed.awaiting.items[0]).toMatchObject({ messageId: 'out-alias',
      waitingOnAgent: null, fromAgent: null });
  });

  it('lists blocked threads the agent is a party to, longest-standing first', async () => {
    const options = setup();
    register(options, 'atlas', 'nova', 'ghost');
    registerAgentIdentity({ handle: 'atlas', runtime: { cli: 'claude', provider: 'claude', model: null } }, options);
    registerAgentIdentity({ handle: 'nova', runtime: { cli: 'codex', provider: 'codex-personal', model: null } }, options);
    registerAgentIdentity({ handle: 'ghost', runtime: { cli: 'grok', provider: 'local', model: null } }, options);

    const post = (id: string, from: string, to: string, body: Record<string, unknown>) => {
      const posted = appendBusInbox({ id, from, to, priority: 'P2', ttl: 120_000, body },
        { root: options.root, now: options.now });
      expect(posted.status).toBe('posted');
    };
    // Two blocked threads atlas is a party to — one it reported itself — plus
    // one between agents atlas never touched, an answered thread and a done one.
    post('blk-old', 'agent:atlas', 'agent:nova',
      { kind: 'blocker', text: 'deploy blocked on creds', thread: 't-old' });
    options.clock.now += 60_000;
    post('blk-new', 'agent:nova', 'agent:atlas',
      { kind: 'blocker', text: 'review blocked on access', thread: 't-new' });
    post('blk-other', 'agent:nova', 'agent:ghost',
      { kind: 'blocker', text: 'ghost-side block', thread: 't-other' });
    post('ask-1', 'agent:nova', 'agent:atlas', { kind: 'note', text: 'still open?', thread: 't-ask' });
    post('ans-1', 'agent:atlas', 'agent:nova', { kind: 'note', text: 'yes', thread: 't-ask' });
    post('done-1', 'agent:nova', 'agent:atlas',
      { kind: 'note', text: 'shipped it', status: 'done', thread: 't-done' });

    const result = readBusWorkMine('atlas', options);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('unreachable');
    expect(result.blocked).toMatchObject({ status: 'ok', source: 'available', matched: 2,
      truncated: false, skipped: 0 });
    if (result.blocked.status !== 'ok') throw new Error('unreachable');
    // Longest-standing first: the block atlas reported an hour ago leads, and
    // the block it reported itself still lists — the thread stays pending.
    expect(result.blocked.items.map(item => item.id)).toEqual(['t-old', 't-new']);
    const old = result.blocked.items[0]!;
    expect(old).toMatchObject({ messageId: 'blk-old', kind: 'blocker', from: 'atlas',
      fromAgent: 'atlas', to: 'nova', messageCount: 1 });
    expect(old.subject).toContain('deploy blocked on creds');
    expect(old.blockedMs).toBe(60_000);
    expect(old.lastAt).toBe(new Date(1_000).toISOString());
    const fresh = result.blocked.items[1]!;
    expect(fresh).toMatchObject({ messageId: 'blk-new', kind: 'blocker', from: 'nova',
      fromAgent: 'nova', to: 'atlas', messageCount: 1 });
    expect(fresh.blockedMs).toBe(0);
    expect(formatBusWorkMine(result).join('\n')).toContain('blocked=2 shown=2');

    // A party to none of atlas's threads sees only its own block.
    const ghost = readBusWorkMine('ghost', options);
    if (ghost.status !== 'ok' || ghost.blocked.status !== 'ok') throw new Error('unreachable');
    expect(ghost.blocked.matched).toBe(1);
    expect(ghost.blocked.items[0]).toMatchObject({ id: 't-other', messageId: 'blk-other' });
    // nova is a party to both atlas threads plus its own other block.
    const nova = readBusWorkMine('nova', options);
    if (nova.status !== 'ok' || nova.blocked.status !== 'ok') throw new Error('unreachable');
    expect(nova.blocked.matched).toBe(3);
  });

  it('lists blocked threads touching channels the agent belongs to', async () => {
    const options = setup();
    register(options, 'atlas', 'nova', 'ghost', 'ops');
    for (const handle of ['atlas', 'nova', 'ghost', 'ops']) {
      registerAgentIdentity({ handle,
        runtime: { cli: 'claude', provider: 'claude', model: null } }, options);
    }
    // eng: atlas + nova. ops: ops only.
    expect(createAgentChannel({ name: 'eng', createdBy: 'atlas', members: ['nova'] }, options).status)
      .toBe('created');
    expect(createAgentChannel({ name: 'ops', createdBy: 'ops' }, options).status).toBe('created');

    const post = (id: string, from: string, to: string, text: string) => {
      const posted = appendBusInbox({ id, from, to, priority: 'P2', ttl: 120_000,
        body: { kind: 'blocker', text, thread: id } }, { root: options.root, now: options.now });
      expect(posted.status).toBe('posted');
    };
    post('blk-eng', 'agent:ghost', 'group:eng:general', 'eng deploy blocked');
    post('blk-ops', 'agent:ghost', 'group:ops:general', 'ops deploy blocked');
    post('blk-self', 'agent:atlas', 'group:eng:general', 'atlas-reported eng block');

    const atlas = readBusWorkMine('atlas', options);
    if (atlas.status !== 'ok' || atlas.blocked.status !== 'ok') throw new Error('unreachable');
    // Both eng-addressed blocks — including atlas's own report — and never ops.
    expect(atlas.blocked.matched).toBe(2);
    expect(atlas.blocked.items.map(item => item.id).sort()).toEqual(['blk-eng', 'blk-self']);
    const nova = readBusWorkMine('nova', options);
    if (nova.status !== 'ok' || nova.blocked.status !== 'ok') throw new Error('unreachable');
    expect(nova.blocked.matched).toBe(2);
    const ops = readBusWorkMine('ops', options);
    if (ops.status !== 'ok' || ops.blocked.status !== 'ok') throw new Error('unreachable');
    expect(ops.blocked.matched).toBe(1);
    expect(ops.blocked.items[0]).toMatchObject({ id: 'blk-ops' });
  });

  it('caps shown blocked threads at twenty with the true total', async () => {
    const options = setup();
    register(options, 'atlas', 'nova');
    registerAgentIdentity({ handle: 'atlas', runtime: { cli: 'claude', provider: 'claude', model: null } }, options);
    registerAgentIdentity({ handle: 'nova', runtime: { cli: 'codex', provider: 'codex-personal', model: null } }, options);
    for (let i = 0; i < 21; i++) {
      const posted = appendBusInbox({ id: `blk-cap-${i}`, from: 'agent:nova', to: 'agent:atlas',
        priority: 'P2', ttl: 120_000,
        body: { kind: 'blocker', text: `block ${i}`, thread: `t-cap-${i}` } },
        { root: options.root, now: options.now });
      expect(posted.status).toBe('posted');
    }
    const result = readBusWorkMine('atlas', options);
    if (result.status !== 'ok' || result.blocked.status !== 'ok') throw new Error('unreachable');
    expect(result.blocked).toMatchObject({ matched: 21, truncated: true, skipped: 0 });
    expect(result.blocked.items).toHaveLength(20);
  });

  it('resolves message-id claims to the live envelope they lease', async () => {
    const options = setup(Date.now());
    register(options, 'atlas', 'nova');
    registerAgentIdentity({ handle: 'nova', runtime: { cli: 'codex', provider: 'codex-personal', model: null } }, options);
    // A claimable work envelope and a plain note — the journal leases any
    // retained receipt, not only claimable work.
    postClaimable(options, 'w-lease', { priority: 'P1' });
    const note = appendBusInbox({ id: 'n-lease', from: 'agent:atlas', to: 'agent:nova',
      priority: 'P2', ttl: 120_000, body: { kind: 'note', text: 'lease me anyway' } },
      { root: options.root, now: options.now });
    expect(note.status).toBe('posted');
    takeWork(options, 'w-lease', 'nova');
    takeWork(options, 'n-lease', 'nova');
    // A scope claim covers a key, not mail, and stays bare.
    claim(options, 'repo:a/b', 'nova', 'test:nova-scope', options.clock.now);

    const result = readBusWorkMine('nova', options);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok' || result.claims.status !== 'ok') throw new Error('unreachable');
    const byKey = new Map(result.claims.claims.map(row => [row.key, row]));
    const work = byKey.get('queue:w-lease');
    expect(work).toMatchObject({ origin: 'message', owner: 'nova' });
    const workMessage = work!.message!;
    expect(workMessage).toMatchObject({ status: 'resolved', id: 'w-lease', priority: 'P1',
      to: 'agent:atlas', from: 'agent:nova', fromAgent: 'nova', bodyKind: 'work',
      ts: new Date(options.clock.now).toISOString(),
      expiresAt: new Date(options.clock.now + 120_000).toISOString(),
      pinned: true });
    if (workMessage.status === 'resolved') expect(workMessage.summary).toContain('fake work w-lease');
    const noteClaim = byKey.get('queue:n-lease');
    expect(noteClaim!.message).toMatchObject({ status: 'resolved', id: 'n-lease',
      bodyKind: 'note', from: 'agent:atlas', to: 'agent:nova', pinned: true });
    // Every claim in the digest is nova's; the resource claim carries no message.
    expect(result.claims.claims.every(row => row.owner === 'nova')).toBe(true);
    expect(byKey.get('repo:a/b')!.message).toBeUndefined();

    // The human line names the leased message inline.
    const line = formatBusWorkMine(result).find(text => text.includes('queue:w-lease'))!;
    expect(line).toContain('msg=w-lease work "work: fake work w-lease"');
    expect(line).toContain('from=agent:nova to=agent:atlas');
    expect(line).not.toContain('pinned=');
  });

  it('annotates a claimed feed announcement with the job its body cites', async () => {
    const options = setup(Date.now());
    register(options, 'atlas', 'nova');
    registerAgentIdentity({ handle: 'atlas', runtime: { cli: 'claude', provider: 'claude', model: 'opus' } }, options);
    registerAgentIdentity({ handle: 'nova', runtime: { cli: 'codex', provider: 'codex-personal', model: null } }, options);
    await announce(options, 'atlas', 'RQ-L-1', ['queue:RQ-L-1']);
    // The work.post receipt itself is claimable mail: lease it like any message.
    takeWork(options, 'post-RQ-L-1', 'nova');

    const result = readBusWorkMine('nova', options);
    if (result.status !== 'ok' || result.claims.status !== 'ok') throw new Error('unreachable');
    const claim = result.claims.claims.find(row => row.key === 'queue:post-RQ-L-1');
    expect(claim).toMatchObject({ origin: 'message' });
    expect(claim!.message).toMatchObject({ status: 'resolved', id: 'post-RQ-L-1',
      bodyKind: 'work.post', pinned: true,
      job: { jobId: 'RQ-L-1', feed: 'ok', job: { id: 'RQ-L-1', status: 'queued' } } });
    expect(formatBusWorkMine(result).find(text => text.includes('queue:post-RQ-L-1')))
      .toContain('job=RQ-L-1:queued');
  });

  it('reports a claim whose pinned receipt is gone as not-found, never a same-id stand-in', () => {
    const options = setup(Date.now());
    register(options, 'nova');
    postClaimable(options, 'w-ghost-pin');
    // Drift: a live message claim plus a journal row pinning a receipt triple
    // the store never served — the live same-id receipt is a different
    // generation the claim does not cover.
    const fakeToken = 'a'.repeat(64);
    mkdirSync(join(options.root, 'bus-work-claims'), { mode: 0o700 });
    writeFileSync(join(options.root, 'bus-work-claims', 'claims.json'), JSON.stringify([{
      id: 'w-ghost-pin', cursor: 999_999, receivedAt: 1, ttl: 120_000, token: fakeToken,
      owner: 'nova', leaseMs: 60_000, leaseUntil: 60_001, completedAt: null,
    }]), { mode: 0o600 });
    expect(acquireCoordination({ root: options.root, origin: 'message', key: 'queue:w-ghost-pin',
      owner: 'nova', leaseMs: 60_000, leaseUntil: options.clock.now + 60_000,
      sourceId: 'w-ghost-pin:999999:1', now: options.clock.now }).status).toBe('acquired');

    const result = readBusWorkMine('nova', options);
    if (result.status !== 'ok' || result.claims.status !== 'ok') throw new Error('unreachable');
    const claim = result.claims.claims.find(row => row.key === 'queue:w-ghost-pin');
    expect(claim!.message).toEqual({ status: 'not-found', id: 'w-ghost-pin' });
    expect(formatBusWorkMine(result).find(text => text.includes('queue:w-ghost-pin')))
      .toContain('msg=w-ghost-pin not-found');
  });

  it('resolves by bare id with pinned unknown when the claim journal cannot be read', () => {
    const options = setup(Date.now());
    register(options, 'nova');
    postClaimable(options, 'w-unpinned');
    takeWork(options, 'w-unpinned', 'nova');
    writeFileSync(join(options.root, 'bus-work-claims', 'claims.json'), '{invalid', { mode: 0o600 });

    const result = readBusWorkMine('nova', options);
    if (result.status !== 'ok' || result.claims.status !== 'ok') throw new Error('unreachable');
    const claim = result.claims.claims.find(row => row.key === 'queue:w-unpinned');
    expect(claim!.message).toMatchObject({ status: 'resolved', id: 'w-unpinned', pinned: null });
    expect(formatBusWorkMine(result).find(text => text.includes('queue:w-unpinned')))
      .toContain('pinned=unknown');
  });

  it('marks a coordination claim with no journal row as unpinned drift', () => {
    const options = setup(Date.now());
    register(options, 'nova');
    postClaimable(options, 'w-drift');
    // A message-origin coordination claim whose journal row never landed:
    // resolution falls back to the bare id and says the pin is absent.
    expect(acquireCoordination({ root: options.root, origin: 'message', key: 'queue:w-drift',
      owner: 'nova', leaseMs: 60_000, leaseUntil: options.clock.now + 60_000,
      sourceId: 'w-drift:1:1', now: options.clock.now }).status).toBe('acquired');

    const result = readBusWorkMine('nova', options);
    if (result.status !== 'ok' || result.claims.status !== 'ok') throw new Error('unreachable');
    const claim = result.claims.claims.find(row => row.key === 'queue:w-drift');
    expect(claim!.message).toMatchObject({ status: 'resolved', id: 'w-drift', pinned: false });
    expect(formatBusWorkMine(result).find(text => text.includes('queue:w-drift')))
      .toContain('pinned=no');
  });

  it('degrades claim-message resolution when the bus store cannot be read', () => {
    const options = setup(Date.now());
    register(options, 'nova');
    postClaimable(options, 'w-blind');
    takeWork(options, 'w-blind', 'nova');
    writeFileSync(join(options.root, 'bus-inbox', 'messages.json'), '{invalid', { mode: 0o600 });

    const result = readBusWorkMine('nova', options);
    if (result.status !== 'ok' || result.claims.status !== 'ok') throw new Error('unreachable');
    const claim = result.claims.claims.find(row => row.key === 'queue:w-blind');
    expect(claim!.message).toEqual({ status: 'unavailable', id: 'w-blind' });
  });

  it('filters the digest to one job id across every section', async () => {
    const options = setup(Date.now());
    register(options, 'atlas', 'nova');
    registerAgentIdentity({ handle: 'atlas', runtime: { cli: 'claude', provider: 'claude', model: null } }, options);
    registerAgentIdentity({ handle: 'nova', runtime: { cli: 'codex', provider: 'codex-personal', model: null } }, options);

    // Two open feed jobs: nova announced RQ-J-1 to atlas, atlas announced RQ-J-2.
    await announce(options, 'nova', 'RQ-J-1', ['queue:RQ-J-1'], 'agent:atlas');
    await announce(options, 'atlas', 'RQ-J-2', ['queue:RQ-J-2']);
    // A job-threaded ask and a plain ask: only the job thread names RQ-J-1.
    expect(await sendDirectMessage({ from: 'nova', to: 'atlas', text: 'question on job one?',
      thread: 'job:RQ-J-1', id: 'ask-job' }, options)).toMatchObject({ status: 'posted' });
    expect(await sendDirectMessage({ from: 'nova', to: 'atlas', text: 'unrelated question?',
      thread: 't-plain', id: 'ask-plain' }, options)).toMatchObject({ status: 'posted' });
    // Handoffs for two different jobs; only RQ-J-1's survives the filter.
    expect(await sendHandoff({ from: 'nova', to: 'atlas', taskId: 'RQ-J-1',
      prompt: 'do job one', id: 'ho-j1' }, options)).toMatchObject({ status: 'posted' });
    expect(await sendHandoff({ from: 'nova', to: 'atlas', taskId: 'RQ-J-9',
      prompt: 'do another job', id: 'ho-j9' }, options)).toMatchObject({ status: 'posted' });
    // Claimable work names no job citation, so `next` is empty under --job.
    postClaimable(options, 'w-free');
    // A wake that names no job never matches the filter.
    expect(await sendWakeRequest({ from: 'nova', to: 'atlas', reason: 'ping', id: 'wk-plain' }, options))
      .toMatchObject({ status: 'posted' });
    // Claims: one overlapping RQ-J-1's declared key, one unrelated scope key,
    // and a message claim leasing the RQ-J-1 announcement itself.
    claim(options, 'queue:RQ-J-1', 'atlas', 'test:atlas-j1', options.clock.now);
    claim(options, 'repo:a/c', 'atlas', 'test:atlas-x', options.clock.now);
    takeWork(options, 'post-RQ-J-1', 'atlas');

    const result = readBusWorkMine('atlas', { ...options, job: 'RQ-J-1' });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('unreachable');
    expect(result.job).toBe('RQ-J-1');
    expect(formatBusWorkMine(result)[0]).toContain('job=RQ-J-1');

    // Claims keep the declared-key overlap and the leased job-citing body;
    // the unrelated scope claim drops out.
    expect(result.claims.status).toBe('ok');
    if (result.claims.status !== 'ok') throw new Error('unreachable');
    expect(result.claims.claims.map(row => row.key).sort())
      .toEqual(['queue:RQ-J-1', 'queue:post-RQ-J-1']);
    const leased = result.claims.claims.find(row => row.key === 'queue:post-RQ-J-1');
    expect(leased!.message).toMatchObject({ status: 'resolved', jobIds: ['RQ-J-1'] });

    // Feed sections match by job id: only RQ-J-1 is open, and atlas announced
    // only RQ-J-2 so its announced view is empty under this filter.
    expect(result.jobs).toMatchObject({ status: 'ok', open: 1 });
    if (result.jobs.status !== 'ok') throw new Error('unreachable');
    expect(result.jobs.jobs.map(entry => entry.id)).toEqual(['RQ-J-1']);
    expect(result.announced).toMatchObject({ status: 'ok', matched: 0, items: [] });

    // next is empty — claimable receipts name no job.
    expect(result.next).toMatchObject({ status: 'ok', matched: 0, items: [] });
    // Only the RQ-J-1 handoff survives.
    expect(result.handoffs).toMatchObject({ status: 'ok', matched: 1 });
    if (result.handoffs.status !== 'ok') throw new Error('unreachable');
    expect(result.handoffs.items.map(item => item.id)).toEqual(['ho-j1']);

    // Two threads name RQ-J-1 and wait on atlas: the job:RQ-J-1 bucket (the
    // announcement and the job-threaded ask share it) and the RQ-J-1
    // handoff whose taskId is the job citation. The plain ask and the
    // RQ-J-9 handoff threads drop out.
    expect(result.threads).toMatchObject({ status: 'ok', matched: 2 });
    if (result.threads.status !== 'ok') throw new Error('unreachable');
    const byId = new Map(result.threads.items.map(item => [item.id, item]));
    expect([...byId.keys()].sort()).toEqual(['ho-j1', 'job:RQ-J-1']);
    expect(byId.get('job:RQ-J-1')).toMatchObject({ kind: 'ask', waitingOn: 'atlas' });
    expect(byId.get('ho-j1')).toMatchObject({ kind: 'handoff', waitingOn: 'atlas' });
    expect(result.awaiting).toMatchObject({ status: 'ok', matched: 0 });
    expect(result.blocked).toMatchObject({ status: 'ok', matched: 0 });

    // Only the wake hint whose referent names RQ-J-1 (the handoff) matches;
    // the job-less wake request stays out.
    expect(result.wakes).toMatchObject({ status: 'ok', matched: 1 });
    if (result.wakes.status !== 'ok') throw new Error('unreachable');
    expect(result.wakes.wakes.map(wake => wake.id)).toEqual(['ho-j1']);

    // Inbox keeps only mail naming RQ-J-1: the work.post announcement, the
    // job-threaded note and the RQ-J-1 handoff.
    expect(result.inbox.status).toBe('ok');
    if (result.inbox.status !== 'ok') throw new Error('unreachable');
    expect(result.inbox.matched).toBe(3);
    expect(result.inbox.messages.map(message => message.id).sort())
      .toEqual(['ask-job', 'ho-j1', 'post-RQ-J-1']);
  });

  it('rejects a job id outside the printable-label rule', () => {
    const options = setup();
    register(options, 'atlas');
    expect(readBusWorkMine('atlas', { ...options, job: 'bad job' }))
      .toEqual({ status: 'invalid', reason: 'invalid-job' });
    expect(readBusWorkMine('atlas', { ...options, job: '' }))
      .toEqual({ status: 'invalid', reason: 'invalid-job' });
  });
});

describe('mailbox section', () => {
  type Setup = BusWorkMineOptions & { clock: { now: number }; root: string; runsRoot: string };

  /** The legacy `phm bus` mailbox home: the fleet root's parent, as `mailboxHome` defaults it. */
  function mailbox(options: Setup) {
    return createBusMailbox(dirname(options.root), options.now);
  }

  function sendMail(options: Setup, id: string, to: string, changes: Partial<BusEnvelope> = {}): void {
    const envelope: BusEnvelope = { id, from: 'agent:nova', to, priority: 'P2', ttl: 120_000,
      body: { text: `legacy note ${id}` }, ...changes };
    expect(mailbox(options).send(envelope).replayed).toBe(false);
  }

  it('reports an absent store as verified empty and an unreadable one as unavailable', () => {
    const options = setup();
    register(options, 'atlas');
    const empty = readBusWorkMine('atlas', options);
    expect(empty.status).toBe('ok');
    if (empty.status !== 'ok') throw new Error('unreachable');
    expect(empty.mailbox).toEqual({ status: 'ok', agent: 'atlas', messages: [], matched: 0, truncated: false });

    // A non-directory at the store path is a storage fault, never an empty list.
    const base = dirname(options.root);
    writeFileSync(join(base, 'bus-mailbox'), 'not a directory', { mode: 0o600 });
    const broken = readBusWorkMine('atlas', options);
    expect(broken.status).toBe('ok');
    if (broken.status !== 'ok') throw new Error('unreachable');
    expect(broken.mailbox).toEqual({ status: 'unavailable', reason: 'mailbox-unreadable' });
  });

  it('lists pending legacy mail under every label of the identity in drain order', () => {
    const options = setup();
    expect(registerAgentIdentity({ handle: 'atlas', aliases: ['atlas-alias'] }, options).status).toBe('created');
    register(options, 'nova');
    const id = stableAgentId('atlas');
    sendMail(options, 'm-alias', 'atlas-alias', { priority: 'P1' });
    sendMail(options, 'm-address', 'agent:atlas');
    sendMail(options, 'm-bare', 'atlas');
    sendMail(options, 'm-id', id);
    sendMail(options, 'm-other', 'agent:nova', { priority: 'P0' });
    // Acknowledged and expired rows are not pending.
    sendMail(options, 'm-acked', 'atlas');
    expect(mailbox(options).ack('m-acked', 'atlas').acknowledged).toBe(true);
    sendMail(options, 'm-expired', 'atlas', { ttl: 1 });
    options.clock.now += 10_000;

    for (const ref of ['atlas', 'agent:atlas', 'atlas-alias', id]) {
      const result = readBusWorkMine(ref, options);
      expect(result.status).toBe('ok');
      if (result.status !== 'ok' || result.mailbox.status !== 'ok') throw new Error('unreachable');
      expect(result.mailbox.matched).toBe(4);
      expect(result.mailbox.truncated).toBe(false);
      // P1 alias mail drains before the P2 rows; same priority keeps acceptance order.
      expect(result.mailbox.messages.map(message => message.id))
        .toEqual(['m-alias', 'm-address', 'm-bare', 'm-id']);
      const first = result.mailbox.messages[0]!;
      expect(first).toMatchObject({ to: 'atlas-alias', from: 'agent:nova', priority: 'P1' });
      expect(first.ts).toBe(new Date(options.clock.now - 10_000).toISOString());
      expect(first.expiresAt).toBe(new Date(options.clock.now - 10_000 + 120_000).toISOString());
      expect(first.summary.length).toBeGreaterThan(0);
    }
  });

  it('narrows to the literal ref when the registry is unreadable or the agent is unregistered', () => {
    const options = setup();
    expect(registerAgentIdentity({ handle: 'atlas', aliases: ['atlas-alias'] }, options).status).toBe('created');
    sendMail(options, 'm-address', 'agent:atlas');
    sendMail(options, 'm-alias', 'atlas-alias');
    sendMail(options, 'm-bare', 'atlas');

    // Corrupt registry: identity state is unknown, so only the literal ref matches.
    writeFileSync(join(options.root, 'agent-identities', 'registry.json'), '{invalid', { mode: 0o600 });
    const narrowed = readBusWorkMine('agent:atlas', options);
    expect(narrowed.status).toBe('ok');
    if (narrowed.status !== 'ok' || narrowed.mailbox.status !== 'ok') throw new Error('unreachable');
    expect(narrowed.mailbox.matched).toBe(1);
    expect(narrowed.mailbox.messages[0]).toMatchObject({ id: 'm-address', to: 'agent:atlas' });

    // An unregistered ref likewise matches only its literal label.
    sendMail(options, 'm-ghost', 'ghost');
    const literal = readBusWorkMine('ghost', options);
    expect(literal.status).toBe('ok');
    if (literal.status !== 'ok' || literal.mailbox.status !== 'ok') throw new Error('unreachable');
    expect(literal.mailbox.matched).toBe(1);
    expect(literal.mailbox.messages[0]).toMatchObject({ id: 'm-ghost', to: 'ghost' });
  });

  it('caps shown mail at twenty with the true matched total', () => {
    const options = setup();
    register(options, 'atlas');
    for (let i = 0; i < 21; i++) sendMail(options, `m-cap-${String(i).padStart(2, '0')}`, 'atlas');
    const result = readBusWorkMine('atlas', options);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok' || result.mailbox.status !== 'ok') throw new Error('unreachable');
    expect(result.mailbox).toMatchObject({ matched: 21, truncated: true });
    expect(result.mailbox.messages).toHaveLength(20);
  });

  it('filters pending mail by the same job citation the unified inbox applies', () => {
    const options = setup();
    register(options, 'atlas');
    sendMail(options, 'm-job-thread', 'atlas',
      { body: { kind: 'note', thread: 'job:RQ-M-1', text: 'job one note' } });
    sendMail(options, 'm-job-handoff', 'atlas',
      { body: { kind: 'worker-handoff', taskId: 'RQ-M-1', prompt: 'job one handoff' } });
    sendMail(options, 'm-other-job', 'atlas',
      { body: { kind: 'note', thread: 'job:RQ-M-2', text: 'job two note' } });
    sendMail(options, 'm-plain', 'atlas');

    const result = readBusWorkMine('atlas', { ...options, job: 'RQ-M-1' });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok' || result.mailbox.status !== 'ok') throw new Error('unreachable');
    expect(result.mailbox).toMatchObject({ matched: 2, truncated: false });
    expect(result.mailbox.messages.map(message => message.id).sort())
      .toEqual(['m-job-handoff', 'm-job-thread']);
  });
});

describe('board section', () => {
  type Setup = BusWorkMineOptions & { clock: { now: number }; root: string; runsRoot: string };

  /** The shared task board at the paths `boardSection` derives from the fleet root. */
  function board(options: Setup) {
    return new BusBoard({ root: join(dirname(options.root), 'bus'),
      fleet: new SharedStore(join(options.root, 'bus-queue'), 60_000),
      cfg: { foundry: {} } as AshlrConfig });
  }

  function section(result: ReturnType<typeof readBusWorkMine>) {
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('unreachable');
    return result.board;
  }

  it('reports an absent board as verified empty without creating its store', () => {
    const options = setup();
    register(options, 'atlas');
    expect(section(readBusWorkMine('atlas', options))).toEqual({
      status: 'ok', peers: [], claims: 'readable', threads: [],
      deliveries: { matched: 0, items: [], truncated: false },
      tasks: { matched: 0, items: [], truncated: false } });
    // Read-only: the digest never creates the board directory or lock file.
    expect(existsSync(join(dirname(options.root), 'bus'))).toBe(false);
    expect(existsSync(join(options.root, 'bus-queue'))).toBe(false);
  });

  it('lists unacknowledged deliveries and tasks under every board label', async () => {
    const options = setup();
    register(options, 'atlas');
    const store = board(options);
    const threadId = store.createThread('nova', 'Release coordination').id;
    store.joinThread('atlas', threadId);
    store.joinThread('agent:atlas', threadId);
    await store.post('nova', threadId, 'ping atlas');
    await store.post('nova', threadId, 'second ping');
    store.createTask('nova', threadId, 'item-review', 'Review the patch');

    const boardSection = section(readBusWorkMine('atlas', options));
    expect(boardSection.status).toBe('ok');
    if (boardSection.status !== 'ok') throw new Error('unreachable');
    // The board knows the agent under its bare handle and agent: address —
    // never its stable id, which is not a member: matching never widens.
    expect(boardSection.peers.sort()).toEqual(['agent:atlas', 'atlas']);
    expect(boardSection.threads).toHaveLength(1);
    expect(boardSection.threads[0]).toMatchObject({ id: threadId, pendingDeliveries: 4 });
    // Two posts snapshot three members each; the agent's two labels match four deliveries.
    expect(boardSection.deliveries).toMatchObject({ matched: 4, truncated: false });
    expect(boardSection.deliveries.items.map(row => row.recipient).sort())
      .toEqual(['agent:atlas', 'agent:atlas', 'atlas', 'atlas']);
    const first = boardSection.deliveries.items.find(row => row.recipient === 'atlas')!;
    expect(first).toMatchObject({ id: expect.any(String), threadId, sender: 'nova', recipient: 'atlas' });
    expect(first.summary).toBe('ping atlas');
    expect(first.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(boardSection.tasks).toMatchObject({ matched: 1, truncated: false });
    expect(boardSection.tasks.items[0]).toMatchObject({ id: expect.any(String), threadId,
      itemId: 'item-review', title: 'Review the patch', claimed: false, hold: 'open', owner: null });
  });

  it('annotates board task hold state from the live fleet queue', async () => {
    const options = setup();
    register(options, 'atlas');
    const store = board(options);
    const threadId = store.createThread('nova', 'Claims').id;
    store.joinThread('atlas', threadId);
    const open = store.createTask('nova', threadId, 'item-open', 'Open task');
    const held = store.createTask('nova', threadId, 'item-held', 'Held task');
    store.claimTask('nova', held.id);

    const boardSection = section(readBusWorkMine('atlas', options));
    expect(boardSection.status).toBe('ok');
    if (boardSection.status !== 'ok') throw new Error('unreachable');
    const byItem = new Map(boardSection.tasks.items.map(row => [row.itemId, row]));
    expect(byItem.get('item-open')).toMatchObject({ hold: 'open', claimed: false, owner: null });
    expect(byItem.get('item-held')).toMatchObject({ hold: 'held', claimed: true });
    expect(byItem.get('item-held')!.owner).toMatchObject({ peerId: 'nova' });
    expect(boardSection.threads[0]!.tasks).toEqual({ open: 1, held: 1, ambiguous: 0, unknown: 0 });
    expect(open.id).not.toBe(held.id);
  });

  it('narrows board matching to the literal ref when the registry is unreadable', async () => {
    const options = setup();
    register(options, 'atlas');
    const store = board(options);
    const threadId = store.createThread('nova', 'Narrow').id;
    store.joinThread('atlas', threadId);
    await store.post('nova', threadId, 'bare label mail');

    writeFileSync(join(options.root, 'agent-identities', 'registry.json'), '{invalid', { mode: 0o600 });
    // 'agent:atlas' is not a board member — only the bare 'atlas' label is.
    const narrowed = section(readBusWorkMine('agent:atlas', options));
    expect(narrowed.status).toBe('ok');
    if (narrowed.status !== 'ok') throw new Error('unreachable');
    expect(narrowed.peers).toEqual([]);
    expect(narrowed.deliveries.matched).toBe(0);
    const literal = section(readBusWorkMine('atlas', options));
    expect(literal.status).toBe('ok');
    if (literal.status !== 'ok') throw new Error('unreachable');
    expect(literal.peers).toEqual(['atlas']);
    expect(literal.deliveries.matched).toBe(1);
    expect(literal.deliveries.items[0]!.summary).toBe('bare label mail');
  });

  it('reports an unreadable board and an unreadable queue honestly', async () => {
    const options = setup();
    register(options, 'atlas');
    const store = board(options);
    const threadId = store.createThread('nova', 'Faults').id;
    store.joinThread('atlas', threadId);
    store.createTask('nova', threadId, 'item-x', 'Task');

    // Corrupt board state: the section reports unavailable, never an empty list.
    writeFileSync(join(dirname(options.root), 'bus', 'state.json'), '{broken', { mode: 0o600 });
    expect(section(readBusWorkMine('atlas', options))).toEqual({ status: 'unavailable', reason: 'board-unreadable' });
  });

  it('marks every task hold unknown when the shared queue cannot be read', async () => {
    const options = setup();
    register(options, 'atlas');
    const store = board(options);
    const threadId = store.createThread('nova', 'Queue fault').id;
    store.joinThread('atlas', threadId);
    store.createTask('nova', threadId, 'item-x', 'Task');

    mkdirSync(join(options.root, 'bus-queue'), { recursive: true });
    writeFileSync(join(options.root, 'bus-queue', 'ashlr-fleet-queue.json'), '{broken', { mode: 0o600 });
    const boardSection = section(readBusWorkMine('atlas', options));
    expect(boardSection.status).toBe('ok');
    if (boardSection.status !== 'ok') throw new Error('unreachable');
    expect(boardSection.claims).toBe('unreadable');
    expect(boardSection.tasks.items[0]).toMatchObject({ hold: 'unknown', owner: null });
    expect(boardSection.threads[0]!.tasks).toEqual({ open: 0, held: 0, ambiguous: 0, unknown: 1 });
  });

  it('derives board paths from a configured shared queue', async () => {
    const options = setup();
    register(options, 'atlas');
    const sharedDir = join(dirname(options.root), 'shared-queue');
    const store = new BusBoard({ root: join(sharedDir, 'bus'),
      fleet: new SharedStore(sharedDir, 60_000), cfg: { foundry: {} } as AshlrConfig });
    const threadId = store.createThread('nova', 'Shared').id;
    store.joinThread('atlas', threadId);
    await store.post('nova', threadId, 'shared queue mail');

    const cfg = { foundry: {}, fleet: { sharedQueue: { mode: 'filesystem' as const,
      path: sharedDir, trustedCoherentStorage: true } } } as AshlrConfig;
    options.board = { config: cfg };
    const boardSection = section(readBusWorkMine('atlas', options));
    expect(boardSection.status).toBe('ok');
    if (boardSection.status !== 'ok') throw new Error('unreachable');
    expect(boardSection.deliveries.matched).toBe(1);
    expect(boardSection.deliveries.items[0]!.summary).toBe('shared queue mail');

    // A shared-queue config without the coherent-storage attestation is unavailable.
    options.board = { config: { foundry: {}, fleet: { sharedQueue: { mode: 'filesystem' as const,
      path: sharedDir } } } as AshlrConfig };
    expect(section(readBusWorkMine('atlas', options))).toEqual({ status: 'unavailable', reason: 'board-unreadable' });
  });

  it('scopes the digest to threads carrying a task for the job', async () => {
    const options = setup();
    register(options, 'atlas');
    const store = board(options);
    const jobThread = store.createThread('nova', 'Job one coordination').id;
    store.joinThread('atlas', jobThread);
    store.createTask('nova', jobThread, 'RQ-J-1', 'Job one task');
    store.createTask('nova', jobThread, 'RQ-J-2', 'Sibling job task');
    await store.post('nova', jobThread, 'job one ping');
    // A second thread with no task for RQ-J-1 stays out of the filtered digest.
    const otherThread = store.createThread('nova', 'Unrelated coordination').id;
    store.joinThread('atlas', otherThread);
    store.createTask('nova', otherThread, 'RQ-J-9', 'Unrelated task');
    await store.post('nova', otherThread, 'unrelated ping');

    const unfiltered = section(readBusWorkMine('atlas', options));
    expect(unfiltered.status).toBe('ok');
    if (unfiltered.status !== 'ok') throw new Error('unreachable');
    expect(unfiltered.tasks.matched).toBe(3);
    expect(unfiltered.threads).toHaveLength(2);

    const filtered = section(readBusWorkMine('atlas', { ...options, job: 'RQ-J-1' }));
    expect(filtered.status).toBe('ok');
    if (filtered.status !== 'ok') throw new Error('unreachable');
    // Only the job-carrying thread lists; its rollup counts the job's task alone.
    expect(filtered.threads).toHaveLength(1);
    expect(filtered.threads[0]).toMatchObject({ id: jobThread, pendingDeliveries: 1,
      tasks: { open: 1, held: 0, ambiguous: 0, unknown: 0 } });
    // Tasks list only on the per-item citation: the sibling job's task drops.
    expect(filtered.tasks).toMatchObject({ matched: 1, truncated: false });
    expect(filtered.tasks.items[0]).toMatchObject({ threadId: jobThread, itemId: 'RQ-J-1',
      title: 'Job one task' });
    // The thread's delivery to atlas rides along; the other thread's does not.
    expect(filtered.deliveries).toMatchObject({ matched: 1, truncated: false });
    expect(filtered.deliveries.items[0]).toMatchObject({ threadId: jobThread, summary: 'job one ping' });
    expect(filtered.peers).toEqual(['atlas']);
  });
});

describe('formatBusWorkMine', () => {
  it('renders every section with unknown states spelled out', async () => {
    const options = setup();
    register(options, 'atlas');
    registerAgentIdentity({ handle: 'atlas', runtime: { cli: 'claude', provider: 'claude', model: null } }, options);
    await announce(options, 'atlas', 'RQ-F-1', ['queue:RQ-F-1']);
    expect(createBusMailbox(dirname(options.root), options.now).send({ id: 'm-fmt', from: 'agent:nova',
      to: 'atlas', priority: 'P2', ttl: 120_000, body: { text: 'legacy ping' } }).replayed).toBe(false);
    const result = readBusWorkMine('atlas', options);
    const text = formatBusWorkMine(result).join('\n');
    expect(text).toContain('agent=atlas');
    expect(text).toContain('claims=0 source=missing');
    expect(text).toContain('jobs=1 shown=1 holds=complete');
    expect(text).toContain('RQ-F-1 queued "Job RQ-F-1" claimable=yes addressed=false announced=true');
    // The announced view lists the same live job with its feed citations.
    expect(text).toContain('announced=1 shown=1');
    expect(text).toContain('RQ-F-1 queued "Job RQ-F-1" owner=agent:atlas');
    expect(text).toContain('post=post-RQ-F-1');
    expect(text).toContain('next=0 shown=0 holds=complete');
    expect(text).toContain('handoffs=0 shown=0 holds=complete');
    expect(text).toContain('threads=0 shown=0');
    expect(text).toContain('blocked=0 shown=0');
    expect(text).toContain('wakes=0');
    expect(text).toContain('inbox=0');
    expect(text).toContain('mailbox=1 shown=1');
    expect(text).toContain('[P2 legacy id=m-fmt from agent:nova to atlas]');
    // A non-ok top-level result renders its status line only.
    expect(formatBusWorkMine({ status: 'invalid', reason: 'invalid-agent' })).toEqual(['invalid: invalid-agent']);
  });

  it('renders the announced dispatch spec on the jobs and announced lines', async () => {
    const options = setup();
    register(options, 'atlas');
    registerAgentIdentity({ handle: 'atlas', runtime: { cli: 'claude', provider: 'claude', model: null } }, options);
    const posted = await announceWork({ from: 'atlas', jobId: 'RQ-D-1', title: 'Dispatch job',
      repo: 'a/b', claimKeys: ['queue:RQ-D-1'], id: 'post-RQ-D-1',
      dispatch: { tier: 'mid', scope: 'the scope', acceptance: 'the check' } }, options);
    expect(posted.status).toBe('posted');
    const lines = formatBusWorkMine(readBusWorkMine('atlas', options));
    const tag = 'tier=mid scope="the scope" acceptance="the check"';
    const jobLines = lines.filter(line => line.includes('RQ-D-1 queued'));
    expect(jobLines).toHaveLength(2);
    for (const line of jobLines) expect(line).toContain(tag);
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
      announced: { status: 'ok', matched: 0, items: [], truncated: false },
      next: { status: 'ok', holds: 'complete', matched: 0, items: [], truncated: false },
      handoffs: { status: 'ok', holds: 'complete', matched: 0, items: [], truncated: false },
      threads: { status: 'ok', source: 'missing', matched: 0, items: [], truncated: false },
      wakes: { status: 'ok', wakes: [] },
      inbox: { status: 'ok', messages: [], truncated: false },
      mailbox: { status: 'ok', matched: 0, messages: [], truncated: false },
      seats: { status: 'ok', matched: 0, seats: [], truncated: false } });
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

  it('accepts --job and echoes the applied filter', async () => {
    const env = { PHM_AGENT_ID: 'atlas' };
    await run(['id', 'register', 'atlas', '--cli', 'claude'], env);
    const result = await run(['work', 'mine', '--job', 'RQ-X-1'], env);
    expect(result.code).toBe(0);
    expect(result.json).toMatchObject({ status: 'ok', job: 'RQ-X-1',
      jobs: { status: 'ok', open: 0, jobs: [] },
      handoffs: { status: 'ok', matched: 0 } });
    const bad = await run(['work', 'mine', '--job', 'bad job'], env);
    expect(bad.code).toBe(2);
    expect(bad.json).toMatchObject({ status: 'invalid', reason: 'invalid-job' });
  });
});

describe('seats section', () => {
  type Setup = ReturnType<typeof setup>;
  const botsDir = (home: string) => join(home, '.phantom', 'bots');
  const seatQuota = (now: number) => ({ status: 'measured' as const, usedPct: 30,
    asOf: new Date(now).toISOString(), resetAt: null, source: 'test' });
  const seatRecord = (id: string, participantId: string, nodeId?: string) => ({ id, kind: 'devin-bot',
    displayName: id, participantId, capabilities: ['code'], quota: { source: 'none' },
    ...(nodeId === undefined ? {} : { nodeId }) });
  const draining = (now: number) => ({ state: 'draining', since: new Date(now).toISOString(), exhaustedReset: null });

  function seatHome(): string {
    const home = mkdtempSync(join(tmpdir(), 'bus-work-mine-seat-'));
    dirs.push(home);
    return home;
  }
  function writeSeatStore(home: string, seats: unknown[], state?: unknown, journal: unknown[] = []): void {
    const dir = botsDir(home);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'seats.json'), JSON.stringify({ schema: 'phantom-bot-seats.v1', seats }));
    if (state !== undefined) writeFileSync(join(dir, 'seat-state.json'), JSON.stringify(state));
    if (journal.length > 0) writeFileSync(join(dir, 'handoffs.jsonl'),
      journal.map(row => JSON.stringify(row)).join('\n') + '\n');
  }
  function seatOptions(options: Setup, home: string): SeatOptions {
    return { home, fleetRoot: options.root, runs: options.runsRoot, now: () => options.clock.now,
      readQuota: async () => seatQuota(options.clock.now) };
  }
  const withSeats = (options: Setup, home: string): BusWorkMineOptions =>
    ({ ...options, seats: seatOptions(options, home) });

  it('leaves seats absent on the synchronous read and reports an empty roster as ok', async () => {
    const options = setup();
    register(options, 'atlas');
    const home = seatHome();
    writeSeatStore(home, []);

    const sync = readBusWorkMine('atlas', options);
    expect(sync.status).toBe('ok');
    if (sync.status !== 'ok') throw new Error('unreachable');
    expect(sync.seats).toBeUndefined();
    expect(formatBusWorkMine(sync).some(line => line.startsWith('seats='))).toBe(false);

    const seats = await readBusWorkMineSeats('atlas', withSeats(options, home));
    expect(seats).toEqual({ status: 'ok', matched: 0, seats: [], truncated: false });
  });

  it('lists pending seat handoffs only for seats the agent denotes', async () => {
    const options = setup();
    const home = seatHome();
    register(options, 'atlas', 'nova');
    writeSeatStore(home,
      [seatRecord('helper', 'atlas'), seatRecord('other', 'nova')],
      { helper: draining(options.clock.now), other: draining(options.clock.now) });
    claim(options, 'repo:a/b', 'atlas', 'test:atlas-1', options.clock.now);
    claim(options, 'repo:c/d', 'nova', 'test:nova-1', options.clock.now);

    const result = await readBusWorkMineWithSeats('atlas', withSeats(options, home));
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('unreachable');
    expect(result.seats).toMatchObject({ status: 'ok', matched: 1, truncated: false });
    const seats = result.seats?.status === 'ok' ? result.seats.seats : [];
    expect(seats).toHaveLength(1);
    expect(seats[0]).toMatchObject({ seatId: 'helper', participantId: 'atlas', state: 'draining' });
    expect(seats[0]!.handoffs).toHaveLength(1);
    expect(seats[0]!.handoffs[0]).toMatchObject({
      work: { kind: 'bus-claim', ref: 'repo:a/b' }, branch: null, pr: null });
    expect(seats[0]!.handoffs[0]!.handoffId).toMatch(/^[0-9a-f]{64}$/);

    const lines = formatBusWorkMine(result);
    expect(lines.some(line => line.startsWith('seats=1 '))).toBe(true);
    expect(lines.some(line => line.includes('seat=helper participant=atlas state=draining'))).toBe(true);

    // The same projection `phm bots handoffs` serves agrees on the pending set.
    const plan = await planSeatHandoffs(seatOptions(options, home));
    const pending = plan.seats.find(s => s.seatId === 'helper');
    expect(pending?.handoffs.map(h => h.work.ref)).toEqual(['repo:a/b']);
  });

  it('matches a seat by literal seat id when the ref resolves to no identity', async () => {
    const options = setup();
    const home = seatHome();
    register(options, 'atlas');
    writeSeatStore(home, [seatRecord('helper', 'atlas')], { helper: draining(options.clock.now) });
    claim(options, 'repo:a/b', 'atlas', 'test:atlas-1', options.clock.now);

    const result = await readBusWorkMineWithSeats('helper', withSeats(options, home));
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('unreachable');
    expect(result.seats).toMatchObject({ status: 'ok', matched: 1 });
    expect(result.seats?.status === 'ok' ? result.seats.seats[0]?.seatId : null).toBe('helper');
  });

  it('drops seat handoffs the journal already recorded', async () => {
    const options = setup();
    const home = seatHome();
    register(options, 'atlas');
    writeSeatStore(home, [seatRecord('helper', 'atlas')], { helper: draining(options.clock.now) });
    claim(options, 'repo:a/b', 'atlas', 'test:atlas-1', options.clock.now);

    const first = await readBusWorkMineWithSeats('atlas', withSeats(options, home));
    const handoffId = first.status === 'ok' && first.seats?.status === 'ok'
      ? first.seats.seats[0]?.handoffs[0]?.handoffId : undefined;
    expect(handoffId).toMatch(/^[0-9a-f]{64}$/);

    writeSeatStore(home, [seatRecord('helper', 'atlas')], { helper: draining(options.clock.now) },
      [{ schema: 'phantom-bot-handoff.v1', handoffId, seatId: 'helper',
        work: { kind: 'bus-claim', ref: 'repo:a/b' }, done: 'unknown', left: 'unknown',
        branch: null, pr: null, createdAt: new Date(options.clock.now).toISOString() }]);
    const second = await readBusWorkMineWithSeats('atlas', withSeats(options, home));
    expect(second.status).toBe('ok');
    if (second.status !== 'ok') throw new Error('unreachable');
    expect(second.seats).toEqual({ status: 'ok', matched: 0, seats: [], truncated: false });
  });

  it('reports the seats section unavailable when the seat store cannot be read', async () => {
    const options = setup();
    const home = seatHome();
    register(options, 'atlas');
    mkdirSync(botsDir(home), { recursive: true });
    writeFileSync(join(botsDir(home), 'seats.json'), '{not json');

    const result = await readBusWorkMineWithSeats('atlas', withSeats(options, home));
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('unreachable');
    expect(result.seats).toEqual({ status: 'unavailable', reason: 'seat-handoff-plan-unreadable' });
  });

  it('matches node-job handoff refs under --job and keeps claim keys out', async () => {
    const options = setup();
    const home = seatHome();
    register(options, 'atlas');
    writeSeatStore(home, [seatRecord('helper', 'atlas', 'n1')], { helper: draining(options.clock.now) });
    claim(options, 'repo:a/b', 'atlas', 'test:atlas-1', options.clock.now);

    const nodes = emptyState();
    nodes.jobs.push({ id: 'J-1', state: 'running',
      claim: { nodeId: 'n1', session: 1, jobId: 'J-1', token: 5, leaderToken: 2,
        expiresAt: options.clock.now + 60_000 } });
    const seats: SeatOptions = { ...seatOptions(options, home),
      nodesStore: { transaction: fn => fn(nodes, options.clock.now) } };

    const unfiltered = await readBusWorkMineSeats('atlas', { ...options, seats });
    expect(unfiltered).toMatchObject({ status: 'ok', matched: 1 });
    if (unfiltered.status !== 'ok') throw new Error('unreachable');
    expect(unfiltered.seats[0]!.handoffs.map(h => `${h.work.kind}:${h.work.ref}`).sort())
      .toEqual(['bus-claim:repo:a/b', 'node-job:J-1']);

    const filtered = await readBusWorkMineSeats('atlas', { ...options, seats, job: 'J-1' });
    expect(filtered).toMatchObject({ status: 'ok', matched: 1 });
    if (filtered.status !== 'ok') throw new Error('unreachable');
    expect(filtered.seats[0]!.handoffs.map(h => `${h.work.kind}:${h.work.ref}`)).toEqual(['node-job:J-1']);

    const missed = await readBusWorkMineSeats('atlas', { ...options, seats, job: 'J-404' });
    expect(missed).toEqual({ status: 'ok', matched: 0, seats: [], truncated: false });
  });

  it('busWorkMineSeatsFromPlan keeps only denoted eligible seats with pending records', () => {
    const handoff = (kind: 'node-job' | 'bus-claim', ref: string, id = `${kind}:${ref}`) => ({
      schema: 'phantom-bot-handoff.v1' as const, handoffId: id, seatId: 's',
      work: { kind, ref }, done: 'unknown', left: 'unknown', branch: null, pr: null, createdAt: 'x' });
    const plan: SeatHandoffsPlan = { schema: 'phantom-bot-handoffs-plan.v1', apply: false, seats: [
      { seatId: 's1', participantId: 'atlas', state: 'draining', eligible: true,
        handoffs: [handoff('bus-claim', 'repo:a/b'), handoff('node-job', 'J-1'), handoff('bus-claim', 'J-1', 'claim-J-1')] },
      { seatId: 's2', participantId: 'nova', state: 'draining', eligible: true, handoffs: [handoff('bus-claim', 'repo:c/d')] },
      { seatId: 's3', participantId: 'atlas', state: 'active', eligible: false, handoffs: [] },
      { seatId: 's4', participantId: 'atlas', state: 'idle', eligible: true, handoffs: [] },
    ] };
    const denotes = (seat: { seatId: string; participantId: string }) => seat.participantId === 'atlas';

    const all = busWorkMineSeatsFromPlan(plan, denotes);
    expect(all.status).toBe('ok');
    if (all.status !== 'ok') throw new Error('unreachable');
    expect(all.matched).toBe(1);
    expect(all.seats[0]).toMatchObject({ seatId: 's1', participantId: 'atlas', state: 'draining' });
    expect(all.seats[0]!.handoffs.map(h => `${h.work.kind}:${h.work.ref}`))
      .toEqual(['bus-claim:repo:a/b', 'node-job:J-1', 'bus-claim:J-1']);

    const byJob = busWorkMineSeatsFromPlan(plan, denotes, 'J-1');
    expect(byJob).toMatchObject({ status: 'ok', matched: 1, truncated: false });
    if (byJob.status !== 'ok') throw new Error('unreachable');
    expect(byJob.seats[0]!.handoffs.map(h => `${h.work.kind}:${h.work.ref}`)).toEqual(['node-job:J-1']);

    expect(busWorkMineSeatsFromPlan(plan, denotes, 'J-404'))
      .toEqual({ status: 'ok', matched: 0, seats: [], truncated: false });
  });

  it('caps shown seats while matched keeps the true total', () => {
    const handoff = (ref: string) => ({ schema: 'phantom-bot-handoff.v1' as const, handoffId: `h-${ref}`,
      seatId: 's', work: { kind: 'bus-claim' as const, ref }, done: 'unknown', left: 'unknown',
      branch: null, pr: null, createdAt: 'x' });
    const plan: SeatHandoffsPlan = { schema: 'phantom-bot-handoffs-plan.v1', apply: false,
      seats: Array.from({ length: 25 }, (_, i) => ({ seatId: `s${i}`, participantId: 'atlas',
        state: 'draining' as const, eligible: true, handoffs: [handoff(`k${i}`)] })) };
    const result = busWorkMineSeatsFromPlan(plan, () => true);
    expect(result).toMatchObject({ status: 'ok', matched: 25, truncated: true });
    if (result.status !== 'ok') throw new Error('unreachable');
    expect(result.seats).toHaveLength(20);
  });
});
