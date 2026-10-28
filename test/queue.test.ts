import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importMarkdown, exportMarkdown } from '../src/core/queue/markdown.js';
import { validateQueue, type QueueJob } from '../src/core/queue/schema.js';
import { QueueStore } from '../src/core/queue/store.js';
import { cmdQueue } from '../src/cli/queue.js';
const dirs: string[] = [];
async function store(): Promise<QueueStore> {
  const dir = await mkdtemp(join(tmpdir(), 'phantom-queue-')); dirs.push(dir); return new QueueStore(dir);
}
const job = (id = 'RQ-TEST'): QueueJob => ({ id, status: 'READY', priority: 'P0', pool: 'codex-personal', tier: 'frontier', repo: 'phantom', deps: [], scope: 'Own the queue', acceptance: 'Tests pass', claims: [] });
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
describe('queue.v1', () => {
  it('round trips router fixture byte-for-byte including CRLF and absent final newline', async () => {
    const fixture = await readFile(new URL('./fixtures/queue/router-queue-import.md', import.meta.url), 'utf8');
    for (const text of [fixture, fixture.replace(/\n/g, '\r\n'), fixture.trimEnd()]) {
      const doc = importMarkdown(text);
      expect(doc.jobs).toHaveLength(7);
      expect(doc.jobs[1]).toMatchObject({ priority: 'P0', deps: ['RQ-MEMORY'], acceptance: 'round-trip fixture; concurrent claims; validation.' });
      expect(exportMarkdown(doc)).toBe(text);
      const s = await store(); await s.import(doc);
      expect(exportMarkdown(await s.read())).toBe(text);
    }
  });
  it('serializes concurrent claims through independent store instances', async () => {
    const s = await store(); await s.add(job());
    const outcomes = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => new QueueStore(s.directory).claim('RQ-TEST', `worker-${i}`)));
    expect(outcomes.filter(o => o.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter(o => o.status === 'rejected')).toHaveLength(19);
    const saved = (await s.read()).jobs[0];
    expect(saved.status).toBe('CLAIMED'); expect(saved.claims).toHaveLength(1);
    expect(Number.isFinite(Date.parse(saved.claims[0].claimedAt))).toBe(true);
    expect(await readdir(s.directory)).toEqual(['queue.v1.json']);
  });
  it('does not lose concurrent additions', async () => {
    const s = await store();
    await Promise.all(Array.from({ length: 12 }, (_, i) => new QueueStore(s.directory).add(job(`RQ-${i}`))));
    expect((await s.read()).jobs).toHaveLength(12);
  });
  it('fails closed on held locks without stealing or changing data', async () => {
    const s = await store(); await s.add(job());
    await writeFile(join(s.directory, 'queue.v1.lock'), 'held');
    await expect(new QueueStore(s.directory, 20).claim('RQ-TEST', 'worker')).rejects.toThrow('lock busy');
    expect((await s.read()).jobs[0].status).toBe('READY');
    expect(await readFile(join(s.directory, 'queue.v1.lock'), 'utf8')).toBe('held');
  });
  it('requires dependencies DONE and enforces claim ownership through PR-OPEN to DONE', async () => {
    const s = await store(); await s.add({ ...job(), deps: ['RQ-DEP'] });
    await expect(s.claim('RQ-TEST', 'a')).rejects.toThrow('Dependencies');
    await s.add(job('RQ-DEP')); await s.claim('RQ-DEP', 'a');
    await expect(s.claim('RQ-TEST', 'a')).rejects.toThrow('Dependencies');
    await s.finish('RQ-DEP', 'a'); await s.claim('RQ-TEST', 'a');
    await expect(s.finish('RQ-TEST', 'b')).rejects.toThrow('active claim');
    expect((await s.finish('RQ-TEST', 'a', { prUrl: 'https://github.com/ashlrai/phantom/pull/1' })).status).toBe('PR-OPEN');
    const done = await s.finish('RQ-TEST', 'a');
    expect(done.status).toBe('DONE'); expect(done.claims[0].finishedAt).toBeDefined();
    const mirror = exportMarkdown(await s.read());
    expect(mirror).toContain('https://github.com/ashlrai/phantom/pull/1');
    expect(mirror).toContain('finishedAt');
    await expect(s.claim('RQ-TEST', 'b')).rejects.toThrow('not READY');
  });
  it('records blocks and refuses duplicate additions or destructive reimports', async () => {
    const s = await store(); await s.add(job()); await s.claim('RQ-TEST', 'a');
    expect((await s.finish('RQ-TEST', 'a', { reason: 'Waiting for owner' })).status).toBe('BLOCKED');
    await expect(s.add(job())).rejects.toThrow('Duplicate');
    await expect(s.import({ schema: 'queue.v1', jobs: [] })).rejects.toThrow('empty queue');
    expect((await s.read()).jobs[0].blockedReason).toBe('Waiting for owner');
  });
  it.each([
    { status: 'RUNNING' }, { id: '../escape' }, { deps: ['RQ-TEST'] }, { deps: [1] },
    { priority: '' }, { claims: [{ owner: 'a', claimedAt: 'yesterday' }] },
    { prUrl: 'http://example.com/pr/1' }, { prUrl: ['https://', 'user', ':', 'TEST', '@', 'example.com/pr/1'].join('') },
    { acceptance: null }, { scope: '' },
  ])('rejects invalid schema without persisting: %j', async patch => {
    const s = await store();
    await expect(s.add({ ...job(), ...patch } as QueueJob)).rejects.toThrow();
    expect((await s.read()).jobs).toEqual([]);
  });
  it('rejects malformed documents and never treats corrupt data as an empty store', async () => {
    expect(() => validateQueue({ schema: 'queue.v2', jobs: [] })).toThrow();
    expect(() => importMarkdown('- READY RQ-BAD missing fields')).toThrow('Malformed');
    const s = await store(); await writeFile(s.path, '{broken');
    await expect(s.add(job())).rejects.toThrow();
    expect(await readFile(s.path, 'utf8')).toBe('{broken');
  });
  it('writes a read-only mirror without touching the router file and retains unknown fields after claims', async () => {
    const s = await store();
    const text = '- READY RQ-TEST (P0, pool=local, tier=local, repo=phantom, EO 13:45): Work. Acceptance: pass.\n';
    const router = join(s.directory, 'router-queue.md'); await writeFile(router, text);
    await s.import(importMarkdown(text)); await s.claim('RQ-TEST', 'worker');
    const path = await s.mirror(); const mirror = await readFile(path, 'utf8');
    expect(mirror).toContain('- CLAIMED RQ-TEST'); expect(mirror).toContain('EO 13:45');
    expect(mirror).toContain('worker'); expect(await readFile(router, 'utf8')).toBe(text);
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o444);
  });
  it('imports JSON backups, exports complete snapshots, and keeps help read-only', async () => {
    const s = await store();
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    const dir = join(s.directory, 'new-store');
    expect(await cmdQueue(['add', '--help', '--dir', dir])).toBe(0);
    await expect(stat(dir)).rejects.toMatchObject({ code: 'ENOENT' });
    const backup = join(s.directory, 'backup.json');
    await writeFile(backup, JSON.stringify({ schema: 'queue.v1', jobs: [job()] }));
    expect(await cmdQueue(['import', backup, '--dir', dir, '--json'])).toBe(0);
    expect(await cmdQueue(['export', '--dir', dir, '--json'])).toBe(0);
    expect(JSON.parse(output.mock.calls.at(-1)![0]).jobs).toEqual([job()]);
  });
  it('extracts a PR URL without changing imported prose', () => {
    const text = '- PR-OPEN RQ-PR (P1, pool=local, tier=local, repo=phantom): Review https://github.com/ashlrai/phantom/pull/123. Acceptance: merge.\n';
    const doc = importMarkdown(text);
    expect(doc.jobs[0].prUrl).toBe('https://github.com/ashlrai/phantom/pull/123');
    expect(exportMarkdown(doc)).toBe(text);
  });
  it('runs CLI lifecycle with JSON and rejects irrelevant flags before mutation', async () => {
    const s = await store(); const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    const run = (...args: string[]) => cmdQueue([...args, '--dir', s.directory, '--json']);
    expect(await run('add', 'RQ-TEST', '--priority', 'P0', '--pool', 'local', '--tier', 'local', '--repo', 'phantom', '--scope', 'work', '--acceptance', 'pass')).toBe(0);
    expect(await run('claim', 'RQ-TEST', '--owner', 'a', '--md')).toBe(1);
    expect((await s.read()).jobs[0].status).toBe('READY');
    expect(await run('claim', 'RQ-TEST', '--owner', 'a')).toBe(0);
    expect(await run('done', 'RQ-TEST', '--owner', 'a')).toBe(0);
    expect(await run('list')).toBe(0);
    expect(JSON.parse(output.mock.calls.at(-1)![0]).jobs[0].status).toBe('DONE');
    expect(await run('export', '--md')).toBe(0);
    expect(await run('unknown')).toBe(2);
  });
});
