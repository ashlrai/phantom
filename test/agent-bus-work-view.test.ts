import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAgentChannel, registerAgentIdentity, stableAgentId } from '../src/core/agents/bus-identity.js';
import {
  postChannelMessage, sendDirectMessage, sendHandoff, type UnifiedBusOptions,
} from '../src/core/agents/bus-unified.js';
import { readAgentWorkView } from '../src/core/agents/bus-work-view.js';
import { acquireCoordination } from '../src/core/agents/claim-store.js';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function setup(at = 1_000): UnifiedBusOptions & { clock: { now: number } } {
  const base = mkdtempSync(join(tmpdir(), 'agent-bus-work-view-'));
  dirs.push(base);
  const clock = { now: at };
  return { root: join(base, 'fleet'), runsRoot: join(base, 'runs'), now: () => clock.now, clock };
}

function register(options: UnifiedBusOptions, handle: string, aliases: string[] = []): void {
  expect(registerAgentIdentity({ handle, aliases }, options).status).toBe('created');
}

const workPost = (jobId: string, from: string, claimKeys: string[] = [`queue:${jobId}`], tag = '') => ({
  id: `post-${jobId}${tag}`, from, to: 'leaders', priority: 'P2' as const, ttl: 60_000,
  body: { kind: 'work.post', jobId, title: `Job ${jobId}`, repo: 'a/b', claimKeys, provider: 'claude' },
});

describe('agent work view', () => {
  it('joins inbox, owned jobs with holds, held claims and wakes in one read', async () => {
    const options = setup();
    register(options, 'atlas', ['lane-x']);
    register(options, 'nova');

    // Directed traffic and a channel post addressed to atlas.
    expect((await sendDirectMessage({ from: 'nova', to: 'atlas', text: 'ping', priority: 'P0' }, options)).status).toBe('posted');
    expect((await sendHandoff({ from: 'nova', to: 'atlas', taskId: 'RQ-WV-1', prompt: 'take over' }, options)).status).toBe('posted');
    expect(createAgentChannel({ name: 'release', createdBy: 'atlas', members: ['nova'] }, options).status).toBe('created');
    expect((await postChannelMessage({ from: 'nova', channel: 'release', text: 'ship it' }, options)).status).toBe('posted');

    // One job atlas owns, one nova owns; a live lease on atlas's job key held by nova.
    expect(appendBusInbox(workPost('job-atlas', 'agent:atlas', ['queue:job-atlas', 'path:a/b:src/**']), options).status).toBe('posted');
    expect(appendBusInbox(workPost('job-nova', 'agent:nova'), options).status).toBe('posted');
    expect(acquireCoordination({ root: options.root, now: options.clock.now, origin: 'resource',
      key: 'queue:job-atlas', owner: 'agent:nova', leaseMs: 60_000,
      leaseUntil: options.clock.now + 60_000, sourceId: 'hold-1' }).status).toBe('acquired');
    // atlas's own live claim on an unrelated key.
    expect(acquireCoordination({ root: options.root, now: options.clock.now, origin: 'resource',
      key: 'queue:job-atlas-extra', owner: 'lane-x', leaseMs: 60_000,
      leaseUntil: options.clock.now + 60_000, sourceId: 'mine-1' }).status).toBe('acquired');

    const view = readAgentWorkView('atlas', {}, options);
    expect(view.status).toBe('ok');
    if (view.status !== 'ok') throw new Error('view refused');
    expect(view.agent).toBe('atlas');
    expect(view.identity).toBe(stableAgentId('atlas'));
    expect(view.labels).toEqual(['agent:atlas', 'lane-x']);

    expect(view.inbox.status).toBe('ok');
    if (view.inbox.status === 'ok') {
      // Priority order: P0 dm, P1 handoff, P2 channel post.
      expect(view.inbox.messages.map(m => m.kind)).toEqual(['dm', 'handoff', 'channel']);
    }

    expect(view.jobs.status).toBe('ok');
    if (view.jobs.status === 'ok') {
      expect(view.jobs.jobs.map(j => j.id)).toEqual(['job-atlas']);
      expect(view.jobs.jobs[0]).toMatchObject({ owner: 'agent:atlas', provider: 'claude', status: 'queued' });
      expect(view.jobs.holds).toHaveLength(1);
      expect(view.jobs.holds[0]).toMatchObject({ jobId: 'job-atlas', claimKey: 'queue:job-atlas', owner: 'agent:nova' });
      expect(view.jobs.claims.source).toBe('available');
    }

    expect(view.claims.source).toBe('available');
    expect(view.claims.claims.map(c => `${c.key}:${c.owner}`)).toEqual(['queue:job-atlas-extra:lane-x']);

    expect(view.wakes.status).toBe('ok');
    if (view.wakes.status === 'ok') {
      // The P0 DM and the P1 handoff woke atlas; the P2 channel post did not.
      expect(view.wakes.wakes).toHaveLength(2);
      expect(view.wakes.wakes.every(w => w.to === 'agent:atlas')).toBe(true);
    }

    // Page params reach their sections: limit caps the inbox, since filters wakes.
    const paged = readAgentWorkView('atlas', { limit: 1 }, options);
    expect(paged.status).toBe('ok');
    if (paged.status === 'ok' && paged.inbox.status === 'ok') {
      expect(paged.inbox.messages).toHaveLength(1);
      expect(paged.inbox.nextCursor).toBeGreaterThan(0);
    }
    const future = readAgentWorkView('atlas', { since: Date.now() + 60_000 }, options);
    expect(future.status).toBe('ok');
    if (future.status === 'ok' && future.wakes.status === 'ok') expect(future.wakes.wakes).toEqual([]);
  });

  it('matches owners through aliases and stable ids, never through other identities', async () => {
    const options = setup();
    register(options, 'atlas', ['lane-x']);
    register(options, 'orion', ['dot-main']);
    register(options, 'nova');

    // Posted under orion's alias: the job belongs to orion, not atlas or nova.
    expect(appendBusInbox(workPost('job-alias', 'dot-main'), options).status).toBe('posted');
    // Posted under atlas's stable id.
    expect(appendBusInbox(workPost('job-id', stableAgentId('atlas')), options).status).toBe('posted');
    // An unregistered owner label matches nobody.
    expect(appendBusInbox(workPost('job-ghost', 'peer:ghost'), options).status).toBe('posted');

    const orion = readAgentWorkView('orion', {}, options);
    expect(orion.status).toBe('ok');
    if (orion.status === 'ok' && orion.jobs.status === 'ok') {
      expect(orion.jobs.jobs.map(j => j.id)).toEqual(['job-alias']);
    }
    const atlas = readAgentWorkView('agent:atlas', {}, options);
    expect(atlas.status).toBe('ok');
    if (atlas.status === 'ok' && atlas.jobs.status === 'ok') {
      expect(atlas.jobs.jobs.map(j => j.id)).toEqual(['job-id']);
    }
    const nova = readAgentWorkView('nova', {}, options);
    expect(nova.status).toBe('ok');
    if (nova.status === 'ok' && nova.jobs.status === 'ok') {
      expect(nova.jobs.jobs).toEqual([]);
    }
  });

  it('reports unknown-agent for an unregistered ref and unavailable for a damaged registry', () => {
    const options = setup();
    register(options, 'atlas');
    expect(readAgentWorkView('ghost', {}, options)).toMatchObject({ status: 'unknown-agent' });
    const file = join(options.root!, 'agent-identities', 'registry.json');
    writeFileSync(file, 'not json', { mode: 0o600 });
    chmodSync(file, 0o600);
    expect(readAgentWorkView('atlas', {}, options)).toMatchObject({ status: 'unavailable' });
  });

  it('keeps section honesty: a refused feed does not hide inbox, claims or wakes', async () => {
    const options = setup();
    register(options, 'atlas');
    register(options, 'nova');
    // Duplicate jobId makes the whole feed projection refuse.
    expect(appendBusInbox(workPost('job-dup', 'agent:atlas', undefined, '-a'), options).status).toBe('posted');
    expect(appendBusInbox(workPost('job-dup', 'agent:atlas', undefined, '-b'), options).status).toBe('posted');
    expect((await sendDirectMessage({ from: 'nova', to: 'atlas', text: 'hi', priority: 'P1' }, options)).status).toBe('posted');

    const view = readAgentWorkView('atlas', {}, options);
    expect(view.status).toBe('ok');
    if (view.status !== 'ok') throw new Error('view refused');
    expect(view.jobs).toMatchObject({ status: 'refused', reason: 'duplicate-job' });
    expect(view.inbox.status).toBe('ok');
    expect(view.claims.source).toBe('missing');
    expect(view.wakes.status).toBe('ok');
  });

  it('reports missing claim tables as missing, never as held work', async () => {
    const options = setup();
    register(options, 'atlas');
    expect(appendBusInbox(workPost('job-1', 'agent:atlas'), options).status).toBe('posted');
    const view = readAgentWorkView('atlas', {}, options);
    expect(view.status).toBe('ok');
    if (view.status !== 'ok') throw new Error('view refused');
    expect(view.claims).toEqual({ source: 'missing', claims: [] });
    if (view.jobs.status === 'ok') {
      expect(view.jobs.claims).toEqual({ source: 'missing', truncated: false });
      expect(view.jobs.holds).toEqual([]);
    } else throw new Error('jobs refused');
  });
});
