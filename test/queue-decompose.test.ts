import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseSpawn, planSpawn, SpawnRejection, SPAWN_LIMITS, type SpawnDocument, type SpawnJobInput, type SpawnResult,
} from '../src/core/queue/decompose.js';
import { createSpawnIngest, loadOrCreateIngestToken } from '../src/core/queue/ingest.js';
import { exportMarkdown, importMarkdown } from '../src/core/queue/markdown.js';
import { validateQueue, type QueueDocument, type QueueJob } from '../src/core/queue/schema.js';
import { QueueStore } from '../src/core/queue/store.js';
import { cmdQueue } from '../src/cli/queue.js';

const dirs: string[] = [];
async function store(): Promise<QueueStore> {
  const dir = await mkdtemp(join(tmpdir(), 'phantom-queue-spawn-'));
  dirs.push(dir);
  return new QueueStore(dir);
}
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

const job = (id: string, over: Partial<QueueJob> = {}): QueueJob => ({
  id, status: 'READY', priority: 'P3', pool: 'devin', tier: 'work', repo: 'phantom',
  deps: [], scope: 'Parent scope', acceptance: 'Tests pass', claims: [], ...over,
});
const claimed = (id = 'RQ-PARENT'): QueueJob => job(id, {
  status: 'CLAIMED', claims: [{ owner: 'worker-1', claimedAt: '2026-11-08T10:00:00Z' }],
});
const child = (over: Partial<SpawnJobInput> = {}): SpawnJobInput => ({
  scope: 'Implement the slice', acceptance: 'npm run test:ci passes', ...over,
});
const proposal = (parent = 'RQ-PARENT', jobs: SpawnJobInput[] = [child()], over: Partial<SpawnDocument> = {}): SpawnDocument => ({
  schema: 'spawn.v1', parent, owner: 'worker-1', jobs, ...over,
});
const doc = (jobs: QueueJob[]): QueueDocument => ({ schema: 'queue.v1', jobs });

async function claimedStore(): Promise<QueueStore> {
  const s = await store();
  await s.add(claimed());
  return s;
}
const code = (fn: () => unknown): string => {
  try { fn(); } catch (error) { return error instanceof SpawnRejection ? error.code : `unexpected: ${error}`; }
  return 'no-throw';
};
describe('spawn.v1 schema', () => {
  it('parses a minimal document and fills no defaults', () => {
    expect(parseSpawn(proposal())).toEqual({ schema: 'spawn.v1', parent: 'RQ-PARENT', owner: 'worker-1', jobs: [child()] });
  });
  it.each<[string, unknown]>([
    ['non-object', null],
    ['wrong schema', { schema: 'spawn.v2', parent: 'RQ-P', owner: 'w', jobs: [child()] }],
    ['extra key', { ...proposal(), extra: 1 }],
    ['missing owner', { schema: 'spawn.v1', parent: 'RQ-P', jobs: [child()] }],
    ['bad parent id', { ...proposal(), parent: 'not an id!' }],
    ['bad owner label', { ...proposal(), owner: 'has space' }],
    ['empty jobs', proposal('RQ-PARENT', [])],
    ['nine jobs', proposal('RQ-PARENT', Array.from({ length: 9 }, () => child()))],
    ['missing scope', proposal('RQ-PARENT', [{ acceptance: 'x' } as SpawnJobInput])],
    ['control char in scope', proposal('RQ-PARENT', [child({ scope: 'bad\u0007scope' })])],
    ['oversized scope', proposal('RQ-PARENT', [child({ scope: 'x'.repeat(4_001) })])],
    ['non-RQ child id', proposal('RQ-PARENT', [child({ id: 'PLAIN-1' })])],
    ['dup deps', proposal('RQ-PARENT', [child({ deps: ['RQ-A', 'RQ-A'] })])],
    ['self dep', proposal('RQ-PARENT', [child({ id: 'RQ-C1', deps: ['RQ-C1'] })])],
    ['unknown tier', proposal('RQ-PARENT', [child({ tier: 'standard' })])],
    ['bad priority', proposal('RQ-PARENT', [child({ priority: 'urgent' })])],
    ['unexpected job field', proposal('RQ-PARENT', [{ scope: 'x', acceptance: 'y', pool: 'codex-cmp' } as SpawnJobInput])],
  ])('rejects %s as invalid-document', (_name, value) => {
    expect(code(() => parseSpawn(value))).toBe('invalid-document');
  });
  it('refuses secret-shaped scope without echoing it', () => {
    const secret = ['ghp_AB', 'CDEFGH', 'IJKLMN', 'OPQRST', 'UVWXYZ', '012345', '6789'].join('');
    const err = (() => { try { parseSpawn(proposal('RQ-PARENT', [child({ scope: `use token ${secret} here` })])); } catch (e) { return e as SpawnRejection; } })();
    expect(err).toBeInstanceOf(SpawnRejection);
    expect(err.code).toBe('invalid-document');
    expect(err.message).not.toContain(secret);
    expect(err.message).not.toContain('ghp_');
  });
});

describe('planSpawn policy', () => {
  it('emits PROPOSED children carrying lineage and inherited routing', () => {
    const plan = planSpawn(doc([claimed()]), proposal('RQ-PARENT', [child({ id: 'RQ-C1' }), child({ id: 'RQ-C2' })]));
    expect(plan.duplicates).toEqual([]);
    expect(plan.jobs.map(j => [j.id, j.status, j.parent, j.depth, j.pool, j.repo])).toEqual([
      ['RQ-C1', 'PROPOSED', 'RQ-PARENT', 1, 'devin', 'phantom'],
      ['RQ-C2', 'PROPOSED', 'RQ-PARENT', 1, 'devin', 'phantom'],
    ]);
  });
  it('derives deterministic ids when omitted', () => {
    const plan = planSpawn(doc([claimed()]), proposal('RQ-PARENT', [child()]));
    expect(plan.jobs[0]!.id).toMatch(/^RQ-SUB-[a-f0-9]{24}$/);
    const replay = planSpawn(doc([claimed()]), proposal('RQ-PARENT', [child()]));
    expect(replay.jobs[0]!.id).toBe(plan.jobs[0]!.id);
  });
  it.each<[string, QueueJob[], SpawnDocument, string]>([
    ['unknown parent', [claimed()], proposal('RQ-MISSING'), 'unknown-parent'],
    ['parent READY without a claim', [job('RQ-PARENT')], proposal(), 'parent-not-active'],
    ['parent DONE', [job('RQ-PARENT', { status: 'DONE' })], proposal(), 'parent-not-active'],
    ['finished claim', [job('RQ-PARENT', { status: 'CLAIMED', claims: [{ owner: 'w', claimedAt: '2026-11-08T09:00:00Z', finishedAt: '2026-11-08T10:00:00Z' }] })], proposal(), 'parent-not-active'],
    ['owner mismatch', [claimed()], proposal('RQ-PARENT', [child()], { owner: 'worker-2' }), 'owner-mismatch'],
    ['tier escalation', [claimed()], proposal('RQ-PARENT', [child({ tier: 'frontier' })]), 'tier-escalation'],
    ['tier escalation mid>work', [claimed()], proposal('RQ-PARENT', [child({ tier: 'mid' })]), 'tier-escalation'],
    ['priority escalation', [claimed()], proposal('RQ-PARENT', [child({ priority: 'P1' })]), 'priority-escalation'],
    ['unknown dep', [claimed()], proposal('RQ-PARENT', [child({ deps: ['RQ-GHOST'] })]), 'unknown-dep'],
    ['pool routing: non-personal kind in codex-personal', [job('RQ-PARENT', { status: 'CLAIMED', pool: 'codex-personal', claims: [{ owner: 'worker-1', claimedAt: '2026-11-08T10:00:00Z' }] })], proposal('RQ-PARENT', [child({ id: 'RQ-C1' })]), 'pool-routing'],
    ['pool routing: cloud kind outside cloud pools', [job('RQ-PARENT', { status: 'CLAIMED', pool: 'claude', claims: [{ owner: 'worker-1', claimedAt: '2026-11-08T10:00:00Z' }] })], proposal('RQ-PARENT', [child({ id: 'RQ-GEN-X' })]), 'pool-routing'],
  ])('rejects %s', (_name, jobs, value, expected) => {
    expect(code(() => planSpawn(doc(jobs), value))).toBe(expected);
  });
  it('permits equal-or-lower tier and priority, sibling and parent deps', () => {
    const plan = planSpawn(doc([claimed()]), proposal('RQ-PARENT', [
      child({ id: 'RQ-C1', tier: 'fast', priority: 'P9' }),
      child({ id: 'RQ-C2', deps: ['RQ-C1', 'RQ-PARENT'] }),
    ]));
    expect(plan.jobs.map(j => [j.tier, j.priority])).toEqual([['fast', 'P9'], ['work', 'P3']]);
    expect(plan.jobs[1]!.deps).toEqual(['RQ-C1', 'RQ-PARENT']);
  });
  it('lets a PR-OPEN parent under an active claim decompose', () => {
    const parent = job('RQ-PARENT', { status: 'PR-OPEN', prUrl: 'https://github.com/ashlrai/phantom/pull/9',
      claims: [{ owner: 'worker-1', claimedAt: '2026-11-08T10:00:00Z' }] });
    expect(planSpawn(doc([parent]), proposal()).jobs).toHaveLength(1);
  });
  it('enforces the depth cap on stored depth and on the ancestor chain', () => {
    expect(code(() => planSpawn(doc([claimed()]), proposal()))).toBe('no-throw');
    const deep = job('RQ-PARENT', { status: 'CLAIMED', depth: 2, claims: [{ owner: 'worker-1', claimedAt: '2026-11-08T10:00:00Z' }] });
    expect(code(() => planSpawn(doc([deep]), proposal()))).toBe('depth-cap');
    // Lineage without a recorded depth still counts: grandparent -> parent -> child.
    const root = job('RQ-ROOT', { status: 'DONE' });
    const mid = job('RQ-MID', { status: 'DONE', parent: 'RQ-ROOT' });
    const leaf = job('RQ-PARENT', { status: 'CLAIMED', parent: 'RQ-MID', claims: [{ owner: 'worker-1', claimedAt: '2026-11-08T10:00:00Z' }] });
    expect(code(() => planSpawn(doc([root, mid, leaf]), proposal()))).toBe('depth-cap');
  });
  it('enforces the per-parent children cap', () => {
    const kids = Array.from({ length: SPAWN_LIMITS.childrenPerParent }, (_v, i) =>
      job(`RQ-K${i}`, { status: 'PROPOSED', parent: 'RQ-PARENT', depth: 1 }));
    expect(code(() => planSpawn(doc([claimed(), ...kids]), proposal()))).toBe('children-cap');
    const near = kids.slice(0, SPAWN_LIMITS.childrenPerParent - 1);
    expect(code(() => planSpawn(doc([claimed(), ...near]),
      proposal('RQ-PARENT', [child({ scope: 'a' }), child({ scope: 'b' })])))).toBe('children-cap');
    expect(planSpawn(doc([claimed(), ...near]), proposal()).jobs).toHaveLength(1);
  });
  it('enforces the per-parent proposal window', () => {
    expect(code(() => planSpawn(doc([claimed()]), proposal(), { proposalsInWindow: SPAWN_LIMITS.proposalsPerWindow }))).toBe('rate-limited');
    expect(code(() => planSpawn(doc([claimed()]), proposal(), { proposalsInWindow: SPAWN_LIMITS.proposalsPerWindow - 1 }))).toBe('no-throw');
  });
  it('dedups against in-flight, done and merged work and inside the proposal', () => {
    const existing = job('RQ-C1', { status: 'DONE' });
    const plan = planSpawn(doc([claimed(), existing]),
      proposal('RQ-PARENT', [child({ id: 'RQ-C1' }), child({ id: 'RQ-C2' }), child({ id: 'RQ-C2' }), child({ id: 'RQ-M' })]),
      { mergedIds: new Set(['RQ-M']) });
    expect(plan.duplicates.sort()).toEqual(['RQ-C1', 'RQ-C2', 'RQ-M']);
    expect(plan.jobs.map(j => j.id)).toEqual(['RQ-C2']);
  });
});

describe('QueueStore.propose', () => {
  it('applies children, journals metadata only, and replays dedupe', async () => {
    const s = await claimedStore();
    const result = await s.propose(proposal('RQ-PARENT', [child({ id: 'RQ-C1' })]));
    expect(result).toEqual({ schema: 'spawn-result.v1', parent: 'RQ-PARENT', applied: ['RQ-C1'], duplicates: [] });
    const stored = (await s.read()).jobs.find(j => j.id === 'RQ-C1')!;
    expect(stored).toMatchObject({ status: 'PROPOSED', parent: 'RQ-PARENT', depth: 1, pool: 'devin', tier: 'work' });
    const journal = (await readFile(s.spawnJournalPath, 'utf8')).trim().split('\n').map(l => JSON.parse(l));
    expect(journal).toEqual([{ v: 1, at: expect.any(String), parent: 'RQ-PARENT', owner: 'worker-1', proposed: 1, applied: 1, duplicates: 0 }]);
    // The journal must never carry prompt text.
    expect(await readFile(s.spawnJournalPath, 'utf8')).not.toContain('Implement the slice');
    const replay = await s.propose(proposal('RQ-PARENT', [child({ id: 'RQ-C1' })]));
    expect(replay).toMatchObject({ applied: [], duplicates: ['RQ-C1'] });
    expect((await s.read()).jobs).toHaveLength(2);
  });
  it('rate-limits per parent across proposals inside the window', async () => {
    const s = await claimedStore();
    for (let i = 0; i < SPAWN_LIMITS.proposalsPerWindow; i++) {
      expect((await s.propose(proposal('RQ-PARENT', [child({ scope: `slice ${i}` })]))).applied).toHaveLength(1);
    }
    await expect(s.propose(proposal('RQ-PARENT', [child({ scope: 'one more' })]))).rejects.toMatchObject({ code: 'rate-limited' });
    // A different parent is unaffected.
    await s.add(claimed('RQ-OTHER'));
    expect((await s.propose(proposal('RQ-OTHER'))).applied).toHaveLength(1);
  });
  it('honours injected now for the rate window', async () => {
    const s = await claimedStore();
    const t0 = Date.parse('2026-11-08T10:00:00Z');
    for (let i = 0; i < SPAWN_LIMITS.proposalsPerWindow; i++) {
      await s.propose(proposal('RQ-PARENT', [child({ scope: `slice ${i}` })]), { now: t0 + i });
    }
    // Entries older than the window are pruned and no longer count.
    const later = t0 + SPAWN_LIMITS.windowMs + 1;
    expect((await s.propose(proposal('RQ-PARENT', [child({ scope: 'fresh slice' })]), { now: later })).applied).toHaveLength(1);
  });
  it('dedups child ids against a merged ledger', async () => {
    const s = await claimedStore();
    const result = await s.propose(proposal('RQ-PARENT', [child({ id: 'RQ-LANDED' }), child({ id: 'RQ-NEW' })]),
      { mergedIds: new Set(['RQ-LANDED']) });
    expect(result).toMatchObject({ applied: ['RQ-NEW'], duplicates: ['RQ-LANDED'] });
  });
  it('fails closed on a corrupt journal', async () => {
    const s = await claimedStore();
    await writeFile(s.spawnJournalPath, 'not json\n', { mode: 0o600 });
    await expect(s.propose(proposal())).rejects.toThrow('Invalid spawn journal line');
  });
  it('stores surviving fields through validateQueue (lineage included)', async () => {
    const s = await claimedStore();
    await s.propose(proposal());
    const stored = (await s.read()).jobs.at(-1)!;
    expect(() => validateQueue({ schema: 'queue.v1', jobs: [stored] })).not.toThrow();
    for (const bad of [
      job('RQ-X', { parent: 'RQ-X' }),
      job('RQ-X', { parent: 'bad id!' }),
      job('RQ-X', { depth: -1 }),
      job('RQ-X', { depth: 65 }),
      job('RQ-X', { depth: 1.5 }),
    ]) expect(() => validateQueue({ schema: 'queue.v1', jobs: [bad] })).toThrow();
  });
  it('promote admits a PROPOSED child as READY, only once', async () => {
    const s = await claimedStore();
    await s.propose(proposal('RQ-PARENT', [child({ id: 'RQ-C1' })]));
    expect(await s.promote('RQ-C1')).toMatchObject({ id: 'RQ-C1', status: 'READY' });
    await expect(s.promote('RQ-C1')).rejects.toThrow('not PROPOSED');
    await expect(s.promote('RQ-PARENT')).rejects.toThrow('not PROPOSED');
    await expect(s.promote('RQ-MISSING')).rejects.toThrow('Unknown job');
  });
});

describe('spawn ingest API', () => {
  const token = 'a'.repeat(48);
  async function ingest(apply: (p: unknown) => Promise<SpawnResult>) {
    const handle = await createSpawnIngest({ token, port: 0, apply });
    return { handle, url: `http://127.0.0.1:${handle.port}` };
  }
  const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${url}/v1/spawn`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body) });
  it('binds loopback only', async () => {
    const { handle } = await ingest(async () => ({ schema: 'spawn-result.v1', parent: 'P', applied: [], duplicates: [] }));
    try { expect(handle.port).toBeGreaterThan(0); } finally { await handle.close(); }
  });
  it('answers health without auth and rejects everything else without it', async () => {
    const { handle, url } = await ingest(async () => { throw new Error('must not run'); });
    try {
      expect((await fetch(`${url}/v1/health`)).status).toBe(200);
      for (const attempt of [
        () => post(url, proposal()),
        () => post(url, proposal(), { authorization: 'Bearer wrong' }),
        () => fetch(`${url}/v1/spawn`),
        () => fetch(`${url}/nope`, { method: 'POST' }),
      ]) expect([401, 404]).toContain((await attempt()).status);
    } finally { await handle.close(); }
  });
  it('round-trips a proposal and returns a value-blind receipt', async () => {
    const s = await claimedStore();
    const handle = await createSpawnIngest({ token, port: 0, apply: p => s.propose(p) });
    try {
      const res = await post(`http://127.0.0.1:${handle.port}`, proposal('RQ-PARENT', [child({ id: 'RQ-C1' })]),
        { authorization: `Bearer ${token}` });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ schema: 'spawn-result.v1', parent: 'RQ-PARENT', applied: ['RQ-C1'], duplicates: [] });
      expect((await s.read()).jobs.at(-1)!.status).toBe('PROPOSED');
    } finally { await handle.close(); }
  });
  it('maps rejections to status codes without echoing proposal text', async () => {
    const s = await claimedStore();
    const handle = await createSpawnIngest({ token, port: 0, apply: p => s.propose(p) });
    const url = `http://127.0.0.1:${handle.port}`;
    const auth = { authorization: `Bearer ${token}` };
    try {
      const secret = ['xoxb-1', '234567', '890-ab', 'cdefgh', 'ijklmn'].join('');
      const scoped = await post(url, proposal('RQ-PARENT', [child({ scope: `leak ${secret} now` })]), auth);
      expect(scoped.status).toBe(400);
      const body = JSON.stringify(await scoped.json());
      expect(body).toContain('invalid-document');
      expect(body).not.toContain(secret);
      expect((await post(url, { schema: 'spawn.v1', parent: 'RQ-MISSING', owner: 'w', jobs: [child()] }, auth)).status).toBe(422);
      expect((await post(url, 'not json{', auth)).status).toBe(400);
      expect((await post(url, proposal(), { ...auth, 'content-type': 'text/plain' })).status).toBe(415);
      const big = await post(url, ' '.repeat(70 * 1024), auth);
      expect(big.status).toBe(413);
    } finally { await handle.close(); }
  });
  it('returns 500-shaped internal for unexpected apply failures', async () => {
    const { handle, url } = await ingest(async () => { throw new Error('boom'); });
    try {
      const res = await post(url, proposal(), { authorization: `Bearer ${token}` });
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'internal' });
    } finally { await handle.close(); }
  });
});

describe('spawn ingest token file', () => {
  it('creates a 0600 token, reuses it, and refuses loose permissions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'phantom-ingest-')); dirs.push(dir);
    const path = join(dir, 'spawn-ingest.token');
    const first = await loadOrCreateIngestToken(path);
    expect(first).toMatch(/^[a-f0-9]{48}$/);
    expect((await readFile(path, 'utf8')).trim()).toBe(first);
    expect(await loadOrCreateIngestToken(path)).toBe(first);
    await writeFile(join(dir, 'loose.token'), `${'b'.repeat(48)}\n`, { mode: 0o644 });
    await expect(loadOrCreateIngestToken(join(dir, 'loose.token'))).rejects.toThrow('mode 0600');
    await writeFile(join(dir, 'bad.token'), 'too short\n', { mode: 0o600 });
    await expect(loadOrCreateIngestToken(join(dir, 'bad.token'))).rejects.toThrow('Invalid ingest token shape');
  });
});

describe('spawn lineage in markdown', () => {
  it('exports and re-imports parent/depth fields', () => {
    const document = doc([claimed(), job('RQ-C1', { status: 'PROPOSED', parent: 'RQ-PARENT', depth: 1 })]);
    const text = exportMarkdown(document);
    expect(text).toContain('parent=RQ-PARENT');
    expect(text).toContain('depth=1');
    const reimported = importMarkdown(text);
    const found = reimported.jobs.find(j => j.id === 'RQ-C1')!;
    expect(found.parent).toBe('RQ-PARENT');
    expect(found.depth).toBe(1);
  });
});

describe('phm queue spawn/serve CLI', () => {
  const run = (args: string[]) => cmdQueue(args);
  it('applies a proposal file end-to-end', async () => {
    const s = await claimedStore();
    const file = join(s.directory, 'spawn.json');
    await writeFile(file, JSON.stringify(proposal('RQ-PARENT', [child({ id: 'RQ-C1' })])));
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await run(['spawn', file, '--dir', s.directory, '--json'])).toBe(0);
    expect(JSON.parse(log.mock.calls.at(-1)![0] as string)).toMatchObject({ parent: 'RQ-PARENT', applied: ['RQ-C1'] });
    expect((await s.read()).jobs.at(-1)!.status).toBe('PROPOSED');
  });
  it('exits 1 on a rejected proposal', async () => {
    const s = await claimedStore();
    const file = join(s.directory, 'spawn.json');
    await writeFile(file, JSON.stringify(proposal('RQ-PARENT', [child({ tier: 'frontier' })])));
    expect(await run(['spawn', file, '--dir', s.directory, '--json'])).toBe(1);
    expect((await s.read()).jobs).toHaveLength(1);
  });
  it('exits 1 on invalid serve arguments without binding', async () => {
    const s = await store();
    expect(await run(['serve', '--port', 'notaport', '--dir', s.directory, '--json'])).toBe(1);
    expect(await run(['serve', '--port', '99999', '--dir', s.directory, '--json'])).toBe(1);
  });
  it('rejects unknown flags and missing operands', async () => {
    const s = await store();
    expect(await run(['spawn', '--dir', s.directory])).toBe(1);
    expect(await run(['spawn', 'x.json', '--bogus', '--dir', s.directory])).toBe(1);
  });
});

describe('merged ledger loader', () => {
  it('reads MERGED ids from metrics/jobs.jsonl and tolerates absence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'phantom-runs-')); dirs.push(root);
    await mkdir(join(root, 'metrics'), { recursive: true });
    await writeFile(join(root, 'metrics', 'jobs.jsonl'),
      `${JSON.stringify({ event: 'outcome', state: 'MERGED', job: 'RQ-LANDED' })}\n` +
      `${JSON.stringify({ event: 'outcome', state: 'FAILED', job: 'RQ-NO' })}\n` +
      'garbage\n');
    const { loadMergedJobIds } = await import('../src/core/queue/store.js');
    expect([...(await loadMergedJobIds(root))].sort()).toEqual(['RQ-LANDED']);
    const empty = await mkdtemp(join(tmpdir(), 'phantom-runs-empty-')); dirs.push(empty);
    expect([...(await loadMergedJobIds(empty))]).toEqual([]);
  });
});
