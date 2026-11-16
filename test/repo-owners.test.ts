import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { acquireCoordination, listCoordination } from '../src/core/agents/claim-store.js';
import { participantSchema } from '../src/core/agents/bus-v2-schema.js';
import { appendBusInbox, listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import * as bus from '../src/core/fleet/bus-inbox.js';
import { planRepoOrphans, readyOwnerItems, repoOwnersSchema, sweepRepoOrphans } from '../src/core/fleet/repo-owners.js';
import { runRepoOrphanSweep } from '../scripts/repo-orphan-sweep.js';

let root: string;
const now = 1_800_000_000_000;
const seed = JSON.parse(readFileSync(resolve('fleet/repo-owners.json'), 'utf8'));
const registry = repoOwnersSchema.parse(seed);
const integrationRegistry = { ...registry, owners: registry.owners.slice(0, 1) };
const pr = { repo: 'ashlrai/phantom', number: 12 };
const prs = { version: 1, complete: true, observedAt: now, prs: [pr], leases: [] };
const ready = 'RQ-ONE\tphantom\tcodex-personal\twork\t/private/prompt\n';
const sweep = (apply = false, overrides: Partial<Parameters<typeof sweepRepoOrphans>[0]> = {}) =>
  sweepRepoOrphans({ registry: integrationRegistry, prs, ready, root, now, apply, ...overrides });
const claim = (key: string, leaseUntil = now + 1000, owner = 'busy-worker') =>
  acquireCoordination({ root, origin: 'resource', key, sourceId: key, owner, leaseMs: 1000, leaseUntil, now });
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'repo-owners-')); });
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

describe('repository owner registry and orphan planning', () => {
  it('covers the seven fleet repositories exactly once with valid idle participant roles', () => {
    for (const name of ['phantom', 'phantom-secrets', 'locus', 'lexicon', 'ashlr-md', 'ashlr-stack', 'ashlr-plugin']) {
      expect(registry.owners.filter(row => row.repo === `ashlrai/${name}`)).toHaveLength(1);
    }
    for (const row of registry.owners) expect(participantSchema.parse(row.participant).status).toBe('idle');
    expect(() => repoOwnersSchema.parse({ ...seed, owners: [...seed.owners, seed.owners[0]] })).toThrow();
    expect(() => repoOwnersSchema.parse({ ...seed, owners: [seed.owners[0], { ...seed.owners[0], repo: 'ASHLRAI/PHANTOM' }] })).toThrow();
  });
  it('treats lanes as hints, ignores comments and both parked formats, and rejects malformed ready rows', () => {
    expect(readyOwnerItems(`# comment\n${ready}PARKED-DEP\tRQ-PARKED\nRQ-PARKED\tphantom\tPARKED-DEP.claude\twork\tx\n`))
      .toEqual([{ key: 'queue:RQ-ONE', repo: 'ashlrai/phantom', jobId: 'RQ-ONE' }]);
    expect(() => readyOwnerItems('RQ-BAD\tphantom\tclaude\tstandard\tx')).toThrow();
    expect(() => readyOwnerItems('RQ-BAD\t../../private\tclaude\twork\tx')).toThrow();
  });
  it('deduplicates identical items and refuses the same queue id in different repositories', () => {
    expect(sweep(false, { ready: ready + ready }).rows).toHaveLength(2);
    expect(() => sweep(false, { ready: ready + ready.replace('phantom', 'locus') })).toThrow('conflicting-item');
  });
  it('discovers additional repositories deterministically', () => {
    const extra = { key: 'pr:ashlrai/new-repo#1', repo: 'ashlrai/new-repo', jobId: 'extra' };
    const first = planRepoOrphans(registry, [extra], [], now);
    expect(first.registry.owners).toHaveLength(registry.owners.length + 1);
    expect(planRepoOrphans(registry, [extra], [], now)).toEqual(first);
    expect(first.rows[0]).toMatchObject({ disposition: 'proposed', assignedTo: expect.stringMatching(/^repo-owner\./) });
  });
  it('preserves owners and live leases, expires at the boundary, and keeps queue IDs case sensitive', () => {
    const items = readyOwnerItems(ready);
    const lease = { key: 'queue:RQ-ONE', owner: 'worker', leaseUntil: now + 1 };
    expect(planRepoOrphans(registry, items, [lease], now).rows[0]?.disposition).toBe('leased');
    expect(planRepoOrphans(registry, items, [{ ...lease, leaseUntil: now }], now).rows[0]?.disposition).toBe('proposed');
    expect(planRepoOrphans(registry, items, [{ ...lease, key: 'queue:rq-one' }], now).rows[0]?.disposition).toBe('proposed');
    expect(planRepoOrphans(registry, [{ ...items[0]!, owner: 'existing' }], [], now).rows[0]?.assignedTo).toBe('existing');
    expect(planRepoOrphans(registry, items, [{ ...lease, key: 'repo:ASHLRAI/PHANTOM' }], now).rows[0]?.disposition).toBe('leased');
  });
});

describe('durable local sweep', () => {
  it('dry runs without creating files and reports actual and proposed counts separately', () => {
    const report = sweep();
    expect(report).toMatchObject({ dryRun: true, orphansFound: 2, assigned: 0, executionAuthorized: false });
    expect(readdirSync(root)).toEqual([]);
  });
  it('registers owners and assigns through the existing bus, persists discovery, and replays without duplicates', () => {
    const extra = { ...prs, prs: [...prs.prs, { repo: 'ashlrai/new-repo', number: 3 }] };
    const report = sweep(true, { prs: extra });
    expect(report).toMatchObject({ status: 'ok', assigned: 3, orphansFound: 3 });
    expect(report.registrations).toHaveLength(integrationRegistry.owners.length + 1);
    const page = listBusInboxAfter(0, 100, { root, now: () => now });
    expect(page.status).toBe('ok');
    if (page.status !== 'ok') throw new Error('missing bus');
    const posts = page.messages.filter(row => (row.envelope.body as { kind: string }).kind === 'work.post');
    expect(posts).toHaveLength(3);
    expect(posts.every(row => !Object.hasOwn(row.envelope.body as object, 'dispatch'))).toBe(true);
    expect(listCoordination(root, now).claims).toHaveLength(0);
    expect(sweep(true, { prs: extra })).toMatchObject({ orphansFound: 0, assigned: 0, status: 'ok' });
    expect(JSON.parse(readFileSync(join(root, 'repo-owners/registry.json'), 'utf8')).owners).toHaveLength(integrationRegistry.owners.length + 1);
  }, 60_000);
  it('never takes over active PR, queue, or repository leases and does not expose fencing material', () => {
    const lease = claim('pr:ASHLRAI/PHANTOM#12');
    claim('queue:RQ-ONE');
    expect(lease.status).toBe('acquired');
    const report = sweep(true);
    expect(report).toMatchObject({ assigned: 0, orphansFound: 0 });
    expect(report.rows.every(row => row.disposition === 'leased')).toBe(true);
    expect(JSON.stringify(report)).not.toContain(lease.token);
    expect(listCoordination(root, now).claims.filter(row => row.live)).toHaveLength(2);
  });
  it('uses the shared coordination table to refuse a concurrent sweep without overwriting its lease', () => {
    const key = 'queue:RQ-REPO-OWNERS-1:sweep';
    claim(key);
    expect(() => sweep(true)).toThrow('sweep-lease-unavailable');
    expect(existsSync(join(root, 'bus-inbox'))).toBe(false);
    expect(listCoordination(root, now).claims[0]?.owner).toBe('busy-worker');
  });
  it('does not infer ownership from an unreadable or corrupt claim store', () => {
    mkdirSync(join(root, 'coordination'), { mode: 0o700 });
    writeFileSync(join(root, 'coordination/claims.json'), '{broken', { mode: 0o600 });
    expect(() => sweep()).toThrow('leases-unavailable');
    expect(existsSync(join(root, 'bus-inbox'))).toBe(false);
  });
  it('refuses symlinked inputs and runtime registry instead of treating them as missing', () => {
    const source = join(root, 'source.json');
    writeFileSync(source, JSON.stringify(registry));
    mkdirSync(join(root, 'repo-owners'));
    symlinkSync(source, join(root, 'repo-owners/registry.json'));
    expect(() => sweep()).toThrow();
    const output: string[] = [];
    expect(runRepoOrphanSweep(['--prs', source, '--ready', join(root, 'missing')], line => output.push(line))).toBe(1);
    expect(JSON.parse(output[0]!)).toMatchObject({ status: 'blocked' });
  });
  it('blocks apply for partial, stale, or future PR evidence while allowing a labelled partial preview', () => {
    expect(sweep(false, { prs: { ...prs, complete: false } }).complete).toBe(false);
    for (const capture of [{ ...prs, complete: false }, { ...prs, observedAt: now - 900_001 }, { ...prs, observedAt: now + 1 }]) {
      expect(() => sweep(true, { prs: capture })).toThrow();
    }
    expect(readdirSync(root)).toEqual([]);
  });
  it('honors the local kill switch', () => {
    writeFileSync(join(root, 'KILL'), '');
    expect(() => sweep(true)).toThrow('kill-switch');
    expect(sweep().assigned).toBe(0);
  });
  it('refuses an unreadable bus without writes', () => {
    expect(appendBusInbox({ id: 'fill', from: 'a', to: 'b', priority: 'P2', ttl: 100_000,
      body: 'x'.repeat(60_000) }, { root, now: () => now }).status).toBe('posted');
    chmodSync(join(root, 'bus-inbox/messages.json'), 0o644);
    expect(() => sweep(true)).toThrow('bus-unavailable');
    expect(existsSync(join(root, 'repo-owners/registry.json'))).toBe(false);
  });
  it('reports partial bus failure, keeps accepted registrations, and safely retries', () => {
    const original = bus.appendBusInbox;
    const twoOwners = { ...registry, owners: registry.owners.slice(0, 2) };
    vi.spyOn(bus, 'appendBusInbox').mockImplementationOnce((...args) => original(...args)).mockReturnValueOnce({ status: 'full' });
    const report = sweep(true, { registry: twoOwners });
    expect(report).toMatchObject({ status: 'partial', assigned: 0 });
    expect(report.registrations.map(row => row.status)).toEqual(['posted', 'full']);
    vi.restoreAllMocks();
    expect(sweep(true, { registry: twoOwners })).toMatchObject({ status: 'ok', assigned: 2 });
  }, 60_000);
  it('rechecks leases acquired after planning before it assigns work', () => {
    const original = bus.appendBusInbox;
    vi.spyOn(bus, 'appendBusInbox').mockImplementationOnce((...args) => {
      claim('pr:ashlrai/phantom#12');
      return original(...args);
    });
    const report = sweep(true);
    expect(report.assigned).toBe(1);
    expect(report.rows.find(row => row.key === 'pr:ashlrai/phantom#12')?.disposition).toBe('leased');
  });
  it('preserves native dispatcher leases from an explicit metadata capture', () => {
    const report = sweep(false, { prs: { ...prs, leases: [{ key: 'queue:RQ-ONE', owner: 'native-worker', leaseUntil: now + 1 }] } });
    expect(report.rows.find(row => row.key === 'queue:RQ-ONE')).toMatchObject({ disposition: 'leased', assignedTo: 'native-worker' });
    expect(report.orphansFound).toBe(1);
  });
  it('the CLI emits one JSON report and rejects unknown or missing arguments', () => {
    const capture = join(root, 'prs.json'), queue = join(root, 'ready.tsv');
    writeFileSync(capture, JSON.stringify({ ...prs, observedAt: Date.now() }));
    writeFileSync(queue, ready);
    const output: string[] = [];
    expect(runRepoOrphanSweep(['--prs', capture, '--ready', queue, '--root', join(root, 'fresh')], line => output.push(line))).toBe(0);
    expect(JSON.parse(output[0]!)).toMatchObject({ orphansFound: 2, assigned: 0 });
    for (const args of [[], ['--unknown'], ['--prs', '--apply'], ['--apply', '--apply']]) {
      expect(runRepoOrphanSweep(args, () => undefined)).toBe(1);
    }
  });
  it('registers roles independently of an incomplete inventory and never assigns work in registration mode', () => {
    const report = sweep(true, { prs: { ...prs, complete: false }, registerOnly: true });
    expect(report).toMatchObject({ status: 'ok', mode: 'register', assigned: 0, candidates: 0, orphansFound: null, rows: [] });
    expect(report.registrations.map(row => row.status)).toEqual(['posted']);
  });
});
