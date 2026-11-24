/**
 * Recovery of the org-membership bus outbox from PR #5809 (head 57bd29084a9359e13cad8a55db44fa43cb8aa2bd).
 * Drives the exported CLI against a real temporary private store and a real temporary bus inbox.
 * No real home, provider, or network access; the write gate is injected.
 */
import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cmdFleetOrgSync } from '../src/cli/fleet-org-sync.js';
import { orgMembershipBodySchema } from '../src/core/org/agent-plane-outbox.js';
import { listBusInboxAfter, appendBusInbox } from '../src/core/fleet/bus-inbox.js';
import { acquireLocalStoreLock, releaseLocalStoreLock } from '../src/core/fleet/local-store-lock.js';

const STORE_ID = '3f1c6a8e-2b7d-4e9a-8c51-0d2f7a9b6e10';
const leader = {
  id: 'leader', title: 'Leader', charter: 'Board-facing strategy.', tier: 'LEADER', reportsTo: null, status: 'active',
  scope: 'research', needs: [], laneAffinities: [], budget: { tokens: 100, sessions: 4, maxCostClass: 'included' },
  sizing: { batchDepth: 100, fanOut: 0 }, sessionId: null,
};
const engineering = { ...leader, id: 'engineering', title: 'Engineering', tier: 'ORCHESTRATOR', reportsTo: 'leader', scope: 'engineering', needs: ['git'] };
const janitor = { ...engineering, id: 'janitor', title: 'Janitor', scope: 'janitor' };
const row = (revision: number, delivered: boolean, edits: unknown[]) => ({
  revision, at: `2026-11-0${revision}T00:00:00.000Z`, applied: true, busDelivered: delivered, edits,
  proposal: { actor: 'leader', reason: `Change ${revision}.`, expectedRevision: revision - 1, change: { kind: 'retire', id: 'engineering' } },
});
const store = () => ({
  schema: 'org.agents.v1', storeId: STORE_ID, revision: 3, agents: [leader, engineering],
  ledger: [row(1, true, [{ before: null, after: engineering }]), row(2, false, [{ before: null, after: janitor }]),
    row(3, false, [{ before: engineering, after: { ...engineering, status: 'retired' } }])],
});

let root: string, bus: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'org-outbox-632s-')); bus = mkdtempSync(join(tmpdir(), 'org-outbox-bus-632s-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); rmSync(bus, { recursive: true, force: true }); });

function writeStore(body: string, base = root): string {
  const dir = join(base, 'org');
  mkdirSync(dir, { recursive: true, mode: 0o700 }); chmodSync(dir, 0o700);
  const file = join(dir, 'agents.json');
  writeFileSync(file, body, { mode: 0o600 }); chmodSync(file, 0o600);
  return file;
}
const readStore = () => JSON.parse(readFileSync(join(root, 'org', 'agents.json'), 'utf8'));
const digest = (dir: string): string[] => readdirSync(dir, { withFileTypes: true, recursive: true })
  .map(entry => join(entry.parentPath, entry.name)).sort().map(path => `${path} ${lstatSync(path).isFile() ? createHash('sha256').update(readFileSync(path)).digest('hex') : 'dir'}`);
const busIds = () => { const page = listBusInboxAfter(0, 100, { root: bus }); return page.status === 'ok' ? page.messages.map(m => m.envelope.id) : []; };

async function run(args: string[], deps: Parameters<typeof cmdFleetOrgSync>[1] = {}) {
  const out: string[] = [], err: string[] = [];
  const code = await cmdFleetOrgSync(args, { out: l => out.push(l), err: l => err.push(l), busRoot: bus, gate: () => null, ...deps });
  return { code, out: out.join('\n'), err: err.join('\n') };
}
const ids = { r2: `org-${STORE_ID}-2-janitor`, r3: `org-${STORE_ID}-3-engineering` };

describe('fleet org-sync outbox', () => {
  it('previews planned events without touching the store or the bus', async () => {
    writeStore(JSON.stringify(store()));
    let posts = 0;
    const before = [...digest(root), ...digest(bus)];
    const result = await run(['--runs-dir', root, '--json'], { post: () => { posts++; return { status: 'unavailable' }; } });
    expect(result.code).toBe(0);
    const view = JSON.parse(result.out);
    expect(view).toMatchObject({ mode: 'preview', grantsExecutionAuthority: false, liveStaffing: 'unknown' });
    expect(view.events.map((e: { id: string; state: string }) => [e.id, e.state])).toEqual([[ids.r2, 'planned'], [ids.r3, 'planned']]);
    expect(posts).toBe(0);
    expect([...digest(root), ...digest(bus)]).toEqual(before);
  });

  it('applies in revision order with schema-valid stable events and changes only delivery flags', async () => {
    writeStore(JSON.stringify(store()));
    const original = readStore();
    const result = await run(['--runs-dir', root, '--apply', '--json']);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out).events.map((e: { state: string }) => e.state)).toEqual(['posted', 'posted']);
    expect(busIds()).toEqual([ids.r2, ids.r3]);
    const page = listBusInboxAfter(0, 100, { root: bus });
    if (page.status !== 'ok') throw new Error('bus unreadable');
    for (const message of page.messages) expect(orgMembershipBodySchema.safeParse(message.envelope.body).success).toBe(true);
    expect(page.messages[1]!.envelope.body).toMatchObject({ roleId: 'engineering', status: 'retired', grantsExecutionAuthority: false });
    const after = readStore();
    expect(after.ledger.map((r: { busDelivered: boolean }) => r.busDelivered)).toEqual([true, true, true]);
    for (const r of [...original.ledger, ...after.ledger]) delete r.busDelivered;
    expect(after).toEqual(original);
    expect((await run(['--runs-dir', root, '--apply'])).out).toContain('0 event(s)');
  });

  it('stops before later revisions when a post fails and leaves the failed entry undelivered', async () => {
    writeStore(JSON.stringify(store()));
    const posted: string[] = [];
    const post = (envelope: unknown) => { posted.push((envelope as { id: string }).id); return { status: 'retryable' as const }; };
    const result = await run(['--runs-dir', root, '--apply', '--json'], { post });
    expect(result.code).toBe(1);
    expect(posted).toEqual([ids.r2]);
    expect(JSON.parse(result.out).events.map((e: { state: string }) => e.state)).toEqual(['unknown']);
    expect(readStore().ledger.map((r: { busDelivered: boolean }) => r.busDelivered)).toEqual([true, false, false]);
    const rejected = await run(['--runs-dir', root, '--apply', '--json'], { post: () => ({ status: 'conflict' }) });
    expect(JSON.parse(rejected.out).events[0].state).toBe('blocked');
  });

  it('is duplicate-safe when the post succeeded but persistence failed', async () => {
    writeStore(JSON.stringify(store()));
    const before = readFileSync(join(root, 'org', 'agents.json'), 'utf8');
    const failed = await run(['--runs-dir', root, '--apply', '--json'], { write: () => { throw new Error('disk'); } });
    expect(failed.code).toBe(1);
    expect(JSON.parse(failed.out)).toMatchObject({ persisted: false, status: 'incomplete' });
    expect(readFileSync(join(root, 'org', 'agents.json'), 'utf8')).toBe(before);
    expect(busIds()).toEqual([ids.r2]);
    const retry = await run(['--runs-dir', root, '--apply', '--json']);
    expect(retry.code).toBe(0);
    expect(JSON.parse(retry.out).events.map((e: { state: string }) => e.state)).toEqual(['duplicate', 'posted']);
    expect(busIds()).toEqual([ids.r2, ids.r3]);
  });

  it('refuses absent, corrupt, symlinked and oversized storage without creating anything', async () => {
    expect((await run(['--runs-dir', root, '--apply'])).code).toBe(1);
    expect(readdirSync(root)).toEqual([]);
    const file = writeStore('{not json');
    expect((await run(['--runs-dir', root, '--apply', '--json'])).out).toContain('"status":"refused"');
    rmSync(file);
    const target = join(bus, 'elsewhere.json');
    writeFileSync(target, JSON.stringify(store()), { mode: 0o600 });
    symlinkSync(target, file);
    const linked = await run(['--runs-dir', root, '--apply']);
    expect(linked.code).toBe(1);
    expect(linked.err).toContain('unsafe file');
    expect(busIds()).toEqual([]);
    rmSync(file);
    writeStore(JSON.stringify({ ...store(), pad: 'x'.repeat(4 * 1024 * 1024) }));
    expect((await run(['--runs-dir', root])).err).toContain('too large');
  });

  it('leaves state intact on lock contention and paused writes', async () => {
    writeStore(JSON.stringify(store()));
    const before = digest(root);
    const lock = acquireLocalStoreLock(join(root, 'org', 'writer.lock'), 0, { anchorPath: root, exactPrivateStorage: true });
    expect(lock).not.toBeNull();
    try {
      const busy = await run(['--runs-dir', root, '--apply']);
      expect(busy.code).toBe(1);
      expect(busy.err).toContain('busy');
    } finally { releaseLocalStoreLock(lock); }
    const paused = await run(['--runs-dir', root, '--apply'], { gate: () => ({ status: 'refused' }) });
    expect(paused.code).toBe(1);
    expect(digest(root).filter(line => !line.includes('writer.lock'))).toEqual(before.filter(line => !line.includes('writer.lock')));
    expect(busIds()).toEqual([]);
    // A gate that trips after the first side effect stops with the event delivered but the flag unpersisted.
    let calls = 0;
    const late = await run(['--runs-dir', root, '--apply', '--json'], { gate: () => (++calls > 2 ? { status: 'refused' } : null) });
    expect(late.code).toBe(1);
    expect(readStore().ledger[1].busDelivered).toBe(false);
  });

  it('treats a pre-existing identical bus event as delivered and validates arguments strictly', async () => {
    writeStore(JSON.stringify(store()));
    const first = await run(['--runs-dir', root, '--apply']);
    expect(first.code).toBe(0);
    const post = appendBusInbox({ id: 'unrelated', from: 'a', to: 'b', priority: 'P3', ttl: 1000, body: { note: 'x' } }, { root: bus });
    expect(post.status).toBe('posted');
    for (const args of [['--bogus'], ['--runs-dir'], ['--apply', '--apply'], ['--runs-dir', root, '--runs-dir', root], ['stray']]) {
      const result = await run(args);
      expect(result.code).toBe(2);
      expect(result.err).toContain('Usage: phm fleet org-sync');
    }
    const help = await run(['--help']);
    expect(help.code).toBe(0);
    expect(help.out).toContain('Never initializes an org');
  });
});
