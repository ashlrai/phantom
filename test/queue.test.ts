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
    const fixture = await readFile(new URL('./fixtures/queue/router-queue.md', import.meta.url), 'utf8');
    for (const text of [fixture, fixture.replace(/\n/g, '\r\n'), fixture.trimEnd()]) {
      const doc = importMarkdown(text);
      expect(doc.jobs).toHaveLength(8);
      expect(doc.raw).toBeUndefined();
      const byId = new Map(doc.jobs.map(j => [j.id, j]));
      expect(byId.get('RQ-FIXTURE-READY')).toMatchObject({ status: 'READY', pool: 'codex-personal', tier: 'work', repo: 'phantom', priority: 'P2' });
      expect(byId.get('RQ-FIXTURE-READY')!.scope).toContain('EXTRA=keep-me');
      expect(byId.get('RQ-FIXTURE-CLAIMED')).toMatchObject({ status: 'CLAIMED', claims: [{ owner: 'fixture-worker', claimedAt: '2026-10-26T13:00:00Z' }] });
      expect(byId.get('RQ-FIXTURE-PR-OPEN')!.prUrl).toBe('https://github.com/ashlrai/phantom/pull/123');
      expect(byId.get('RQ-FIXTURE-BLOCKED')).toMatchObject({ status: 'BLOCKED', deps: ['RQ-FIXTURE-READY'], blockedReason: 'waiting for prerequisite' });
      expect(byId.get('RQ-FIXTURE-HOLD')).toMatchObject({ status: 'HOLD', blockedReason: 'owner hold' });
      expect(byId.get('RQ-FIXTURE-SPLIT-PARENT')).toMatchObject({ status: 'SPLIT-PARENT', deps: [] });
      expect(byId.get('RQ-FIXTURE-LAND')).toMatchObject({ status: 'LAND', prUrl: 'https://github.com/ashlrai/phantom/pull/124' });
      expect(exportMarkdown(doc)).toBe(text);
      const s = await store(); await s.import(doc);
      expect(exportMarkdown(await s.read())).toBe(text);
    }
  });
  it('imports a scrubbed live queue snapshot with zero failures and round-trips it', async () => {
    const snapshot = await readFile(new URL('./fixtures/queue/router-queue-live.md', import.meta.url), 'utf8');
    const doc = importMarkdown(snapshot);
    expect(doc.raw).toBeUndefined();
    expect(doc.warnings).toBeUndefined();
    expect(doc.jobs).toHaveLength(21);
    expect(new Set(doc.jobs.map(j => j.status))).toEqual(new Set(['READY', 'CLAIMED', 'PR-OPEN', 'BLOCKED', 'HOLD', 'PROPOSED', 'FIXUP', 'LAND', 'SPLIT-PARENT', 'DONE', 'RETIRED', 'DROPPED']));
    const byId = new Map(doc.jobs.map(j => [j.id, j]));
    expect(byId.get('RQ-ALPHA')!.deps).toEqual(['RQ-BETA', 'RQ-GAMMA']);
    expect(byId.get('RQ-BETA')!.deps).toEqual(['RQ-ALPHA']);
    expect(byId.get('RQ-GAMMA')!.pool).toBe('codex-personal');
    expect(byId.get('RQ-EPSILON')!.prUrl).toBe('https://github.com/ashlrai/phantom/pull/1001');
    expect(byId.get('RQ-ETA')!.blockedReason).toBe('12:23 publish ABORT missing-env');
    expect(byId.get('RQ-THETA')!.deps).toEqual(['RQ-ALPHA']);
    expect(byId.get('RQ-OMICRON')!.deps).toEqual(['RQ-XI']);
    expect(byId.get('RQ-NU')!.prUrl).toBe('https://github.com/ashlrai/phantom/pull/1004');
    expect(byId.get('RQ-RHO')!.pool).toBe('unspecified');
    expect(exportMarkdown(doc)).toBe(snapshot);
    // Reimport stays semantically stable: identical jobs, still zero failures.
    const reimported = importMarkdown(exportMarkdown(doc));
    expect(reimported.raw).toBeUndefined();
    expect(reimported.jobs).toEqual(doc.jobs);
    expect(exportMarkdown(reimported)).toBe(snapshot);
  });
  it.each([
    '- CLAIMED 14:26 dispatchd codex-personal RQ-A (P0, pool=x): t. Acceptance: a.',
    '- PR-OPEN (https://github.com/ashlrai/phantom/pull/1014, bridge 12:23, EO 12:40) RQ-B (P1): t. Acceptance: a.',
    '- BLOCKED 12:23 publish ABORT missing-env RQ-C: t. Acceptance: a.',
    '- DONE (https://github.com/ashlrai/phantom/pull/1015, landed 09:12) RQ-D: t.',
    '- READY RQ-E (P1 (nested), pool=p): t. Acceptance: a.',
    '- RETIRED RQ-F (P2): retired scope.',
    '- FIXUP RQ-G (P0 DRIVER): fixup scope. Acceptance: green.',
    '- SPLIT-PARENT RQ-H (P0): children=RQ-I,RQ-J Acceptance: kids.',
    '- LAND RQ-K (P0): PR=https://github.com/ashlrai/phantom/pull/1 BASE_OVERRIDE=x',
    '- DROPPED RQ-L: dropped scope.',
  ])('parses the live line shape: %s', line => {
    const doc = importMarkdown(`${line}\n`);
    expect(doc.raw).toBeUndefined();
    expect(doc.jobs).toHaveLength(1);
    expect(exportMarkdown(doc)).toBe(`${line}\n`);
  });
  it('keeps unparsed job-shaped lines as raw records with warnings and never throws', () => {
    const text = [
      '# queue',
      '- READY RQ-OK (P0): fine. Acceptance: ok.',
      '- MYSTERY RQ-UNKNOWN (P0): unknown status.',
      '- HOLD no-identifier-here just prose in a bullet',
      '- READY RQ-OK (P0): duplicate id.',
      'prose notes stay prose, not raw records',
    ].join('\n');
    const doc = importMarkdown(text);
    expect(doc.jobs.map(j => j.id)).toEqual(['RQ-OK']);
    expect(doc.raw).toHaveLength(3);
    expect(doc.raw![0]).toMatchObject({ line: 3, text: '- MYSTERY RQ-UNKNOWN (P0): unknown status.' });
    expect(doc.raw![0].warning).toContain('unknown status "MYSTERY"');
    expect(doc.raw![1].warning).toContain('job id not found');
    expect(doc.raw![2].warning).toContain('duplicate job id "RQ-OK"');
    expect(doc.warnings).toHaveLength(3);
    expect(exportMarkdown(doc)).toBe(text);
    // Status changes on the parsed job leave raw lines byte-exact.
    doc.jobs[0].status = 'CLAIMED';
    doc.jobs[0].claims.push({ owner: 'w', claimedAt: '2026-10-26T00:00:00Z' });
    const exported = exportMarkdown(doc);
    expect(exported).toContain('- CLAIMED RQ-OK (P0): fine.');
    expect(exported).toContain('- MYSTERY RQ-UNKNOWN (P0): unknown status.');
    expect(exported).toContain('- READY RQ-OK (P0): duplicate id.');
  });
  it('reports raw records and warnings through the CLI import without failing', async () => {
    const s = await store();
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const router = join(s.directory, 'router-queue.md');
    await writeFile(router, '- READY RQ-OK (P0): fine. Acceptance: ok.\n- WAT RQ-LATER: mystery status.\n');
    expect(await cmdQueue(['import', router, '--dir', s.directory, '--json'])).toBe(0);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('unknown status "WAT"'));
    const saved = await s.read();
    expect(saved.jobs.map(j => j.id)).toEqual(['RQ-OK']);
    expect(saved.raw![0].text).toBe('- WAT RQ-LATER: mystery status.');
  });
  it('warns on self-dependencies and unbalanced parens without failing', () => {
    const doc = importMarkdown('- READY RQ-A (deps=RQ-A|RQ-B): s.\n- READY RQ-B (P0, pool=x: unclosed tail\n');
    expect(doc.jobs).toHaveLength(2);
    expect(doc.jobs[0].deps).toEqual(['RQ-B']);
    expect(doc.warnings!.join(' ')).toMatch(/self-dependency/);
    expect(doc.warnings!.join(' ')).toMatch(/unbalanced parenthesis/);
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
    expect(() => validateQueue(importMarkdown('- READY RQ-BAD missing fields'))).not.toThrow();
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
    expect(await run('unknown')).toBe(1);
  });
});
