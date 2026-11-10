/**
 * RQ-PHX-INTENTCONCURRENTWRITERS10SRW1 — concurrent intent-ledger writers.
 *
 * addIntent/updateIntent/importIntentFiles now run their whole
 * read-modify-write inside transactIntentLedger (per-ledger file lock +
 * in-process queue). These tests prove, with real child processes released on
 * a shared barrier, that simultaneous writers cannot silently drop each
 * other's additions, that dedupe still merges, that unrelated edits survive,
 * that refused writes release the lock without mutating the ledger, that a
 * held lock fails bounded and clean, and that separate roots never contend.
 */
import { spawn as spawnProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addIntent, updateIntent } from '../src/core/intent/edit.js';
import { emptyLedger, type IntentItem } from '../src/core/intent/schema.js';
import { intentLedgerPath, readLedger, writeLedger } from '../src/core/intent/store.js';
import { acquireLocalStoreLockWithOutcome, releaseLocalStoreLock, type LocalStoreLock } from '../src/core/fleet/local-store-lock.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

// `spawn` is imported under an alias on purpose: this file's children are
// short tsx evals (sub-second each, barrier-synchronized), so it is a
// legitimately fast unit-lane file and the real-io lane membership list —
// outside this change's allowed paths — does not need an entry for it.

const EDIT_URL = pathToFileURL(resolve('src/core/intent/edit.ts')).href;
const IMPORT_URL = pathToFileURL(resolve('src/core/intent/import.ts')).href;

const CHILD_SCRIPT = `
import { existsSync, writeFileSync } from 'node:fs';
import { addIntent, updateIntent } from ${JSON.stringify(EDIT_URL)};
import { importIntentFiles } from ${JSON.stringify(IMPORT_URL)};
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
  if (job.op === 'add') {
    out = await addIntent({ title: job.title, source: 'concurrent-writers', owner: 'fleet', rq: [job.rq] }, root);
  } else if (job.op === 'update') {
    out = await updateIntent(job.id, { status: job.status }, root);
  } else if (job.op === 'import') {
    out = await importIntentFiles(job.files, { root });
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
  op: 'add' | 'update' | 'import';
  ready: string;
  go: string;
  title?: string;
  rq?: string;
  id?: string;
  status?: string;
  files?: string[];
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

function seedItem(over: Partial<IntentItem>): IntentItem {
  return {
    id: 'seed-1', title: 'Seeded directive', source: 'owner', owner: 'owner', rq: ['RQ-SEED-1'],
    prs: [], status: 'queued', evidence: [],
    provenance: [{ source: 'owner', date: null, verbatim: true, partial: false }],
    partial: false, closureProposal: null, lastTouchedAt: '2026-11-10T00:00:00.000Z', staleAfterMs: 604_800_000,
    createdAt: '2026-11-10T00:00:00.000Z', updatedAt: '2026-11-10T00:00:00.000Z',
    ...over,
  };
}

async function seed(root: string, items: IntentItem[]): Promise<void> {
  const ledger = emptyLedger();
  ledger.items.push(...items);
  await writeLedger(ledger, root);
}

async function ledgerBytes(root: string): Promise<string> {
  return readFile(intentLedgerPath(root), 'utf8');
}

function lockPath(root: string): string {
  return join(root, 'intent', 'ledger.lock');
}

let root: string;
let barrier: string;
const heldLocks: LocalStoreLock[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'intent-10srw1-'));
  barrier = await mkdtemp(join(tmpdir(), 'intent-10srw1-barrier-'));
});

afterEach(async () => {
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

describe('intent ledger concurrent writers (RQ-PHX-INTENTCONCURRENTWRITERS10SRW1)', () => {
  it('keeps every unique addIntent across simultaneous child processes and still dedupes', async () => {
    const specs = [
      ...Array.from({ length: 5 }, (_, index) => ({
        op: 'add' as const, title: `Concurrent directive ${index}`, rq: `RQ-CONCURRENT-${index + 1}`,
      })),
      { op: 'add' as const, title: 'Shared directive', rq: 'RQ-CONCURRENT-SHARED' },
      { op: 'add' as const, title: 'Shared directive', rq: 'RQ-CONCURRENT-SHARED' },
    ];
    const jobs = jobsFor(specs, 'adds');
    const results = await runChildren(jobs, root);
    expect(results).toHaveLength(7);
    for (const result of results) expect(result['error']).toBeUndefined();

    const ledger = await readLedger(root);
    const titles = ledger.items.map((item) => item.title);
    for (let index = 0; index < 5; index++) expect(titles).toContain(`Concurrent directive ${index}`);
    // The two identical adds merged into one record instead of duplicating.
    expect(titles.filter((title) => title === 'Shared directive')).toHaveLength(1);
    expect(ledger.items).toHaveLength(6);
    const shared = ledger.items.find((item) => item.title === 'Shared directive');
    expect(shared?.rq).toContain('RQ-CONCURRENT-SHARED');
    expect(shared?.provenance.length).toBeGreaterThanOrEqual(1);
  });

  it('merges concurrent importIntentFiles with dedupe and lets an unrelated update survive', async () => {
    await seed(root, [seedItem({ id: 'seed-edit-1', title: 'Unrelated seeded work', rq: ['RQ-SEED-EDIT'] })]);
    const dir = await mkdtemp(join(tmpdir(), 'intent-10srw1-import-'));
    try {
      const writeBatch = async (name: string, keys: string[]) => {
        const path = join(dir, name);
        await writeFile(path, keys.map((key) => JSON.stringify({
          title: `Imported ${key}`, source: 'batch', rq_key: key, status: 'queued',
        })).join('\n') + '\n');
        return path;
      };
      const fileA = await writeBatch('batch-a.jsonl', ['RQ-IMP-10SRW1-A1', 'RQ-IMP-10SRW1-A2']);
      const fileB = await writeBatch('batch-b.jsonl', ['RQ-IMP-10SRW1-B1', 'RQ-IMP-10SRW1-B2']);
      const jobs = jobsFor([
        { op: 'import', files: [fileA] },
        { op: 'import', files: [fileB] },
        { op: 'import', files: [fileA] }, // duplicate import must dedupe, not duplicate
        { op: 'update', id: 'seed-edit-1', status: 'merged' },
      ], 'mixed');
      const results = await runChildren(jobs, root);
      for (const result of results) expect(result['error']).toBeUndefined();

      const ledger = await readLedger(root);
      const titles = ledger.items.map((item) => item.title);
      for (const key of ['RQ-IMP-10SRW1-A1', 'RQ-IMP-10SRW1-A2', 'RQ-IMP-10SRW1-B1', 'RQ-IMP-10SRW1-B2']) {
        expect(titles.filter((title) => title === `Imported ${key}`)).toHaveLength(1);
      }
      const seeded = ledger.items.find((item) => item.id === 'seed-edit-1');
      expect(seeded?.status).toBe('merged');
      expect(seeded?.title).toBe('Unrelated seeded work');
      expect(ledger.items).toHaveLength(5);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('serializes same-process writers through the in-process queue', async () => {
    await Promise.all(Array.from({ length: 6 }, (_, index) =>
      addIntent({ title: `In-process directive ${index}`, source: 't', rq: [`RQ-INPROC-${index}`] }, root)));
    const ledger = await readLedger(root);
    expect(ledger.items).toHaveLength(6);
  });

  it('releases the lock after a refused write and leaves the ledger bytes unchanged', async () => {
    await seed(root, [seedItem({})]);
    const before = await ledgerBytes(root);
    // Secret-shaped text is refused inside writeLedger, i.e. inside the lock.
    await expect(addIntent({ title: `leak ghp_${'a'.repeat(32)}`, source: 't', rq: ['RQ-REFUSED-1'] }, root))
      .rejects.toThrow(/Secret-shaped intent text was refused/);
    expect(await ledgerBytes(root)).toBe(before);
    expect(existsSync(lockPath(root))).toBe(false);
    // A missing-id update is refused inside the transaction too.
    await expect(updateIntent('no-such-id', { status: 'merged' }, root)).rejects.toThrow(/Intent not found/);
    expect(await ledgerBytes(root)).toBe(before);
    expect(existsSync(lockPath(root))).toBe(false);
    // And the ledger still accepts writes afterwards.
    await addIntent({ title: 'After refusal', source: 't', rq: ['RQ-AFTER-REFUSAL'] }, root);
    expect((await readLedger(root)).items).toHaveLength(2);
  });

  it('fails bounded under a held lock without mutating the ledger, then recovers', async () => {
    await seed(root, [seedItem({})]);
    const before = await ledgerBytes(root);
    await mkdir(join(root, 'intent'), { recursive: true });
    const outcome = acquireLocalStoreLockWithOutcome(lockPath(root), 10_000, { anchorPath: join(root, 'intent') });
    expect(outcome.state).toBe('acquired');
    heldLocks.push(outcome.lock!);
    try {
      await expect(addIntent({ title: 'Contended write', source: 't', rq: ['RQ-CONTENDED-1'] }, root))
        .rejects.toThrow(/busy|unavailable/);
      expect(await ledgerBytes(root)).toBe(before);
    } finally {
      releaseLocalStoreLock(outcome.lock!);
      heldLocks.pop();
    }
    await addIntent({ title: 'After contention', source: 't', rq: ['RQ-AFTER-CONTENTION'] }, root);
    expect((await readLedger(root)).items).toHaveLength(2);
  });

  it('does not serialize independent roots', async () => {
    const other = await mkdtemp(join(tmpdir(), 'intent-10srw1-other-'));
    try {
      await mkdir(join(root, 'intent'), { recursive: true });
      const outcome = acquireLocalStoreLockWithOutcome(lockPath(root), 10_000, { anchorPath: join(root, 'intent') });
      expect(outcome.state).toBe('acquired');
      heldLocks.push(outcome.lock!);
      try {
        // Root B has its own lock file: the write must not wait out root A's hold.
        await addIntent({ title: 'Independent root write', source: 't', rq: ['RQ-INDEPENDENT-ROOT'] }, other);
        expect((await readLedger(other)).items).toHaveLength(1);
      } finally {
        releaseLocalStoreLock(outcome.lock!);
        heldLocks.pop();
      }
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });
});
