import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerAgentIdentity, stableAgentId } from '../src/core/agents/bus-identity.js';
import { acquireCoordination } from '../src/core/agents/claim-store.js';
import { announceWork, sendWakeRequest, updateWorkStatus } from '../src/core/agents/bus-unified.js';
import { busWorkMineJobAnnotation, formatBusWorkMine, readBusWorkMine,
  type BusWorkMineOptions } from '../src/core/agents/bus-work-mine.js';
import type { WorkJob } from '../src/core/agents/bus-v2-schema.js';
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
    // Wakes need a registered identity: unknown, never an empty list.
    expect(result.wakes.status).toBe('unknown-agent');
  });

  it('rejects an invalid agent ref before reading anything', () => {
    expect(readBusWorkMine('bad agent!', setup())).toEqual({ status: 'invalid', reason: 'invalid-agent' });
    expect(readBusWorkMine('', setup())).toEqual({ status: 'invalid', reason: 'invalid-agent' });
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
    expect(text).toContain('wakes=0');
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
      wakes: { status: 'ok', wakes: [] } });
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
