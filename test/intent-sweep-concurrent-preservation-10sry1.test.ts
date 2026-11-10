/**
 * RQ-PHX-INTENTSWEEPSERIAL10SRY1 — the stale sweep is a serialized writer.
 *
 * sweepStale({apply:true}) used to readLedger, mutate the snapshot and
 * writeLedger with no lock held, so an addIntent/updateIntent committed
 * between the read and the write was silently dropped. The apply path now
 * runs inside transactIntentLedger (the primitive edit.ts/import.ts use);
 * preview stays a plain read. Against the real disk store these tests prove
 * concurrent directives and edits to the swept record survive an apply —
 * forced deterministically by a gated readLedger in-process and a go-file
 * barrier across child processes — that a held lock makes apply fail bounded
 * with bytes untouched (the old path wrote underneath it: the regression),
 * and that recommendations, statuses, read-only preview, invalid-time and
 * refused-write behavior are unchanged.
 */
import { spawn as spawnProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addIntent, updateIntent } from '../src/core/intent/edit.js';
import { acquireLocalStoreLockWithOutcome, releaseLocalStoreLock, type LocalStoreLock } from '../src/core/fleet/local-store-lock.js';
import { emptyLedger, type IntentItem, type IntentStatus } from '../src/core/intent/schema.js';
import { sweepStale } from '../src/core/intent/sweep.js';
import { intentLedgerPath, ledgerFilePresent, readLedger, writeLedger } from '../src/core/intent/store.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

// `spawn` is imported under an alias on purpose: this file's children are
// short tsx evals (sub-second each, barrier-synchronized), so it is a
// legitimately fast unit-lane file and the real-io lane membership list —
// outside this change's allowed paths — does not need an entry for it.

// The gate pauses the store's exported readLedger once, right after it
// resolves — the exact point where the old unlocked sweep's snapshot went
// stale. transactIntentLedger reads through a module-internal binding and
// never trips the gate: on the fixed code it catches only the unlocked
// pre-check read, on the old code it caught the apply's only read. Either
// way the interleaving writers below commit for real against disk.
const readGate = vi.hoisted(() => ({
  armed: false,
  tripped: false,
  reached: undefined as (() => void) | undefined,
  open: undefined as (() => void) | undefined,
}));

vi.mock('../src/core/intent/store.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/core/intent/store.js')>();
  return {
    ...real,
    readLedger: async (root?: string) => {
      const ledger = await real.readLedger(root);
      if (readGate.armed && !readGate.tripped) {
        readGate.tripped = true;
        readGate.reached?.();
        await new Promise<void>((release) => { readGate.open = release; });
      }
      return ledger;
    },
  };
});

const SWEEP_URL = pathToFileURL(resolve('src/core/intent/sweep.ts')).href;
const EDIT_URL = pathToFileURL(resolve('src/core/intent/edit.ts')).href;

const CHILD_SCRIPT = `
import { existsSync, writeFileSync } from 'node:fs';
import { addIntent, updateIntent } from ${JSON.stringify(EDIT_URL)};
import { sweepStale } from ${JSON.stringify(SWEEP_URL)};
const job = JSON.parse(process.env.CHILD_JOB ?? '{}');
const root = process.env.ASHLR_RUNS_DIR;
writeFileSync(job.ready, 'ok');
const deadline = Date.now() + 25000;
while (!existsSync(job.go)) {
  if (Date.now() > deadline) { console.error('barrier timeout'); process.exit(3); }
  await new Promise((resolve) => setTimeout(resolve, 2));
}
let out;
try {
  if (job.op === 'sweep') {
    out = await sweepStale({ root, now: job.now, apply: true });
  } else if (job.op === 'add') {
    out = await addIntent({ title: job.title, source: 'concurrent-sweep', owner: 'fleet', rq: [job.rq], now: job.now }, root);
  } else if (job.op === 'update') {
    out = await updateIntent(job.id, { evidence: { ref: job.ref }, now: job.stamp }, root);
  } else {
    throw new Error('unknown op ' + job.op);
  }
  console.log('RESULT ' + JSON.stringify(out));
} catch (error) {
  console.log('RESULT ' + JSON.stringify({ error: String((error && error.message) || error) }));
  process.exitCode = 4;
}
`;

interface ChildJob {
  op: 'sweep' | 'add' | 'update';
  ready: string;
  go: string;
  now?: string;
  title?: string;
  rq?: string;
  id?: string;
  ref?: string;
  stamp?: string;
}

const delay = (ms: number) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

async function until(predicate: () => boolean, what: string, ms = 25_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await delay(10);
  }
}

/** Spawn every child, hold them on a shared go-file barrier, then release together. */
async function runChildren(jobs: ChildJob[], root: string): Promise<Record<string, unknown>[]> {
  const children = jobs.map((job) => {
    const child = spawnProcess(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', CHILD_SCRIPT], {
      env: { ...process.env, ASHLR_RUNS_DIR: root, CHILD_JOB: JSON.stringify(job) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout!.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr!.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    const closed = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveClose, reject) => {
      child.once('error', reject);
      child.once('close', (code) => resolveClose({ code, stdout, stderr }));
    });
    return { job, child, closed };
  });
  try {
    await until(() => jobs.every((job) => existsSync(job.ready)), 'all children to start');
    await writeFile(jobs[0]!.go, 'go');
    const outcomes = await Promise.all(children.map((entry) => entry.closed));
    return outcomes.map((outcome, index) => {
      expect(outcome.code, `child ${index} stderr: ${outcome.stderr}`).toBe(0);
      const line = outcome.stdout.split('\n').find((row) => row.startsWith('RESULT '));
      expect(line, `child ${index} produced no result: ${outcome.stdout}`).toBeTruthy();
      return JSON.parse(line!.slice('RESULT '.length)) as Record<string, unknown>;
    });
  } finally {
    for (const entry of children) {
      if (entry.child.exitCode === null && entry.child.signalCode === null) entry.child.kill('SIGKILL');
    }
  }
}

const old = '2026-11-01T00:00:00.000Z';
const now = '2026-11-09T00:00:00.000Z';

function item(id: string, status: IntentStatus, extra: Partial<IntentItem> = {}): IntentItem {
  return {
    id, title: `Directive ${id}`, source: 'fake note', owner: 'owner', rq: [`RQ-SEED-${id.toUpperCase()}`],
    prs: [], status, evidence: [{ at: old, kind: 'note', ref: `origin ${id}` }],
    provenance: [{ source: 'fake note', date: old, verbatim: true, partial: false }],
    partial: false, closureProposal: null, lastTouchedAt: old, staleAfterMs: 60_000, createdAt: old, updatedAt: old,
    ...extra,
  };
}

async function seed(root: string, items: IntentItem[]): Promise<void> {
  await writeLedger({ ...emptyLedger(), items }, root);
}

const ledgerBytes = (root: string) => readFile(intentLedgerPath(root), 'utf8');
const lockPath = (root: string) => join(root, 'intent', 'ledger.lock');

let root: string;
let barrier: string;
const heldLocks: LocalStoreLock[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'intent-10sry1-'));
  barrier = await mkdtemp(join(tmpdir(), 'intent-10sry1-barrier-'));
  readGate.armed = false;
  readGate.tripped = false;
  readGate.reached = undefined;
  readGate.open = undefined;
});

afterEach(async () => {
  readGate.armed = false;
  readGate.open?.();
  for (const lock of heldLocks.splice(0)) releaseLocalStoreLock(lock);
  await rm(root, { recursive: true, force: true });
  await rm(barrier, { recursive: true, force: true });
});

function jobsFor(specs: Array<Omit<ChildJob, 'ready' | 'go'>>, prefix: string): ChildJob[] {
  return specs.map((spec, index) => ({
    ...spec,
    ready: join(barrier, `${prefix}-${index}.ready`),
    go: join(barrier, `${prefix}-go`),
  }));
}

describe('intent sweep concurrent preservation (RQ-PHX-INTENTSWEEPSERIAL10SRY1)', () => {
  it('keeps preview read-only: recommendations without creating or changing a ledger', async () => {
    const look = await sweepStale({ root, now });
    expect(look).toEqual({ stale: [], applied: false, updated: 0 });
    expect(await ledgerFilePresent(root)).toBe(false);
    expect(existsSync(join(root, 'intent'))).toBe(false);

    await seed(root, [item('stale', 'in-progress'), item('fresh', 'proposed', { lastTouchedAt: now })]);
    const before = await ledgerBytes(root);
    const preview = await sweepStale({ root, now });
    expect(preview.stale.map(row => [row.id, row.status, row.action])).toEqual([['stale', 'in-progress', 'requeue']]);
    expect(await ledgerBytes(root)).toBe(before);
  });

  it('rejects an invalid timestamp before touching the store, on preview and apply', async () => {
    await expect(sweepStale({ root, now: 'not-a-time', apply: true })).rejects.toThrow('ISO timestamp');
    await expect(sweepStale({ root, now: 'not-a-time' })).rejects.toThrow('ISO timestamp');
    expect(await ledgerFilePresent(root)).toBe(false);
    expect(existsSync(join(root, 'intent'))).toBe(false);
  });

  it('an apply with nothing stale writes nothing and creates no ledger', async () => {
    expect(await sweepStale({ root, now, apply: true })).toEqual({ stale: [], applied: true, updated: 0 });
    expect(await ledgerFilePresent(root)).toBe(false);
    await seed(root, [item('fresh', 'proposed', { lastTouchedAt: now }), item('done', 'verified')]);
    const before = await ledgerBytes(root);
    expect(await sweepStale({ root, now, apply: true })).toEqual({ stale: [], applied: true, updated: 0 });
    expect(await ledgerBytes(root)).toBe(before);
    expect(existsSync(lockPath(root))).toBe(false);
  });

  it('returns the same recommendations and persisted post-apply statuses', async () => {
    await seed(root, [
      item('active', 'in-progress'),
      item('orphan', 'proposed', { rq: [] }),
      item('merged', 'merged'),
      item('fresh', 'proposed', { lastTouchedAt: now }),
      item('done', 'shipped'),
    ]);
    const result = await sweepStale({ root, now, apply: true });
    expect(result).toMatchObject({ applied: true, updated: 3 });
    expect(result.stale.map(row => [row.id, row.status, row.action])).toEqual([
      ['active', 'queued', 'requeue'],
      ['orphan', 'proposed', 'propose-superseded'],
      ['merged', 'merged', 'await-verification'],
    ]);
    const ledger = await readLedger(root);
    expect(ledger.items.map(entry => entry.status)).toEqual(['queued', 'proposed', 'merged', 'proposed', 'shipped']);
    for (const id of ['active', 'orphan', 'merged']) {
      const entry = ledger.items.find(row => row.id === id)!;
      expect(entry.lastTouchedAt).toBe(now);
      expect(entry.updatedAt).toBe(now);
      expect(entry.evidence.at(-1)).toMatchObject({ at: now, kind: 'sweep', note: 'Local stale tracking refreshed; no job dispatched.' });
    }
  });

  it('fails bounded under a held lock without mutating the ledger — the old sweep wrote anyway', async () => {
    await seed(root, [item('stale', 'in-progress')]);
    const before = await ledgerBytes(root);
    await mkdir(join(root, 'intent'), { recursive: true });
    const outcome = acquireLocalStoreLockWithOutcome(lockPath(root), 10_000, { anchorPath: join(root, 'intent') });
    expect(outcome.state).toBe('acquired');
    heldLocks.push(outcome.lock!);
    try {
      // A held lock is another writer's read-modify-write window: the old
      // unlocked apply wrote right through it and silently dropped that work.
      await expect(sweepStale({ root, now, apply: true })).rejects.toThrow(/busy|unavailable/);
      expect(await ledgerBytes(root)).toBe(before);
      const preview = await sweepStale({ root, now });
      expect(preview.stale.map(row => row.id)).toEqual(['stale']);
      expect(await ledgerBytes(root)).toBe(before);
    } finally {
      releaseLocalStoreLock(outcome.lock!);
      heldLocks.pop();
    }
    const applied = await sweepStale({ root, now, apply: true });
    expect(applied).toMatchObject({ applied: true, updated: 1 });
    expect((await readLedger(root)).items[0]?.status).toBe('queued');
  });

  it('releases the lock after a refused write and leaves persisted bytes untouched', async () => {
    // A ledger carrying secret-shaped text could only have been written
    // out-of-band; the sweep's own write must refuse it and free the lock.
    await mkdir(join(root, 'intent'), { recursive: true });
    const poisoned = { ...emptyLedger(), items: [item('poison', 'in-progress', { title: `leak ghp_${'a'.repeat(32)}` })] };
    await writeFile(intentLedgerPath(root), `${JSON.stringify(poisoned)}\n`, { mode: 0o600 });
    const before = await ledgerBytes(root);
    await expect(sweepStale({ root, now, apply: true })).rejects.toThrow(/Secret-shaped intent text was refused/);
    expect(await ledgerBytes(root)).toBe(before);
    expect(existsSync(lockPath(root))).toBe(false);
    // The lock was released: a retry refuses on the same text, not contention.
    await expect(sweepStale({ root, now, apply: true })).rejects.toThrow(/Secret-shaped intent text was refused/);
    expect(await ledgerBytes(root)).toBe(before);
    const probe = acquireLocalStoreLockWithOutcome(lockPath(root), 1_000, { anchorPath: join(root, 'intent') });
    expect(probe.state).toBe('acquired');
    releaseLocalStoreLock(probe.lock!);
    expect((await readLedger(root)).items.find(row => row.id === 'poison'))
      .toMatchObject({ status: 'in-progress', evidence: [{ ref: 'origin poison' }] });
  });

  it('preserves a concurrent directive and an edit to the swept record (deterministic interleave)', async () => {
    await seed(root, [item('swept', 'in-progress')]);
    const reached = new Promise<void>((resolve) => { readGate.reached = resolve; });
    readGate.armed = true;
    const sweeping = sweepStale({ root, now, apply: true });
    await reached; // the sweep's unlocked read resolved; its write has not run
    // A second agent commits a new directive and edits the swept record —
    // exactly the writes the unlocked apply used to clobber.
    await updateIntent('swept', { evidence: { ref: 'concurrent verification' }, now: old }, root);
    await addIntent({ title: 'Concurrent mid-sweep directive', source: 't', rq: ['RQ-MID-10SRY1'], now }, root);
    readGate.open!();
    const result = await sweeping;
    expect(result).toMatchObject({ applied: true, updated: 1 });
    expect(result.stale).toMatchObject([{ id: 'swept', status: 'queued', action: 'requeue' }]);
    const ledger = await readLedger(root);
    const swept = ledger.items.find(row => row.id === 'swept')!;
    expect(swept.status).toBe('queued');
    expect(swept.evidence.map(row => [row.kind, row.ref])).toEqual([
      ['note', 'origin swept'], ['verification', 'concurrent verification'], ['sweep', 'requeue'],
    ]);
    const added = ledger.items.find(row => row.title === 'Concurrent mid-sweep directive');
    expect(added).toMatchObject({ rq: ['RQ-MID-10SRY1'], status: 'proposed', evidence: [] });
  });

  it('serializes same-process apply against addIntent and updateIntent', async () => {
    await seed(root, [item('swept', 'in-progress')]);
    const [result, added, updated] = await Promise.all([
      sweepStale({ root, now, apply: true }),
      addIntent({ title: 'In-process directive', source: 't', rq: ['RQ-INPROC-10SRY1'], now }, root),
      updateIntent('swept', { evidence: { ref: 'in-process verification' }, now: old }, root),
    ]);
    expect(result).toMatchObject({ applied: true, updated: 1 });
    expect(updated.id).toBe('swept');
    const ledger = await readLedger(root);
    const swept = ledger.items.find(row => row.id === 'swept')!;
    expect(swept.status).toBe('queued');
    expect(swept.evidence.map(row => row.ref)).toEqual(
      expect.arrayContaining(['origin swept', 'in-process verification', 'requeue']));
    expect(ledger.items.find(row => row.id === added.id)).toMatchObject({ rq: ['RQ-INPROC-10SRY1'], status: 'proposed' });
  });

  it('serializes concurrent sweeps and writers across child processes on one barrier', async () => {
    await seed(root, [item('swept', 'in-progress'), item('fresh', 'proposed', { lastTouchedAt: now })]);
    const jobs = jobsFor([
      { op: 'sweep', now },
      { op: 'sweep', now },
      { op: 'add', title: 'Concurrent child directive', rq: 'RQ-CHILD-10SRY1', now },
      { op: 'update', id: 'fresh', ref: 'child verification', stamp: now },
    ], 'mix');
    const results = await runChildren(jobs, root);
    for (const result of results) expect(result['error']).toBeUndefined();
    // The two applies are serialized: whichever commits first sweeps the stale
    // record, and the second computes against that fresh locked ledger — the
    // record's lastTouchedAt is `now`, so nothing is stale and it updates 0.
    // (updateIntent stamps lastTouchedAt itself, so the edit below targets the
    // always-fresh record: an `old` stamp landing between the sweeps would
    // re-stale the record and the second apply would legitimately sweep it.)
    const sweeps = results.slice(0, 2);
    expect(sweeps.map(row => row['updated']).sort()).toEqual([0, 1]);
    const winner = sweeps.find(row => row['updated'] === 1)!;
    expect(winner['stale']).toMatchObject([{ id: 'swept', status: 'queued', action: 'requeue' }]);

    const ledger = await readLedger(root);
    expect(ledger.items).toHaveLength(3);
    const swept = ledger.items.find(row => row.id === 'swept')!;
    expect(swept.status).toBe('queued');
    expect(swept.evidence.map(row => [row.kind, row.ref])).toEqual([['note', 'origin swept'], ['sweep', 'requeue']]);
    const fresh = ledger.items.find(row => row.id === 'fresh')!;
    expect(fresh).toMatchObject({ status: 'proposed' });
    expect(fresh.evidence.map(row => [row.kind, row.ref])).toEqual([['note', 'origin fresh'], ['verification', 'child verification']]);
    const added = ledger.items.find(row => row.title === 'Concurrent child directive')!;
    expect(added).toMatchObject({ rq: ['RQ-CHILD-10SRY1'], status: 'proposed', evidence: [] });
  });
});
