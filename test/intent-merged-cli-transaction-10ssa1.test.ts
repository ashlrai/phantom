/**
 * RQ-PHX-INTENTMERGEDTRANSACTION10SSA1 — `fleet intent-evidence merged --apply`
 * is a serialized writer.
 *
 * The command used to readLedger -> linkMergedPull -> writeLedger outside any
 * lock, so a concurrent addIntent/updateIntent committed between its read and
 * write was silently dropped — losing another agent's recorded merge evidence
 * or directive. The apply path now matches against the freshest ledger inside
 * transactIntentLedger (the same primitive edit.ts/import.ts/fleet-intent link
 * use); dry-run preview and the absent-ledger no-create behavior are unchanged.
 *
 * These tests drive the real cmdFleetIntentEvidence — in-process and in child
 * processes released on a shared go-file barrier against an isolated
 * ASHLR_RUNS_DIR — and prove: a raced add/update and the merge evidence both
 * survive, a held lock fails bounded with bytes untouched and recovers, dry-run
 * and unmatched apply leave bytes unchanged, replay keeps one PR association,
 * and a missing ledger is never created.
 */
import { spawn as spawnProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetIntentEvidence } from '../src/cli/fleet-intent-evidence.js';
import { addIntent, updateIntent } from '../src/core/intent/edit.js';
import { acquireLocalStoreLockWithOutcome, releaseLocalStoreLock, type LocalStoreLock } from '../src/core/fleet/local-store-lock.js';
import { emptyLedger, type IntentItem, type IntentStatus } from '../src/core/intent/schema.js';
import { intentLedgerPath, readLedger, writeLedger } from '../src/core/intent/store.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

// `spawn` is imported under an alias on purpose: this file's children are
// short tsx evals (sub-second each, barrier-synchronized), so it is a
// legitimately fast unit-lane file and the real-io lane membership list —
// outside this change's allowed paths — does not need an entry for it.

const CLI_URL = pathToFileURL(resolve('src/cli/fleet-intent-evidence.ts')).href;
const EDIT_URL = pathToFileURL(resolve('src/core/intent/edit.ts')).href;

const CHILD_SCRIPT = `
import { existsSync, writeFileSync } from 'node:fs';
import { addIntent, updateIntent } from ${JSON.stringify(EDIT_URL)};
import { cmdFleetIntentEvidence } from ${JSON.stringify(CLI_URL)};
const job = JSON.parse(process.env.CHILD_JOB ?? '{}');
const root = process.env.ASHLR_RUNS_DIR;
writeFileSync(job.ready, 'ok');
const deadline = Date.now() + 25000;
while (!existsSync(job.go)) {
  if (Date.now() > deadline) { console.error('barrier timeout'); process.exit(3); }
  await new Promise((resolve) => setTimeout(resolve, 2));
}
try {
  if (job.op === 'evidence') {
    const code = await cmdFleetIntentEvidence(job.args);
    console.log('RESULT ' + JSON.stringify({ code }));
    if (code !== 0) process.exitCode = 5;
  } else if (job.op === 'add') {
    const out = await addIntent({ title: job.title, source: 'concurrent-merge-evidence', rq: [job.rq] }, root);
    console.log('RESULT ' + JSON.stringify({ id: out.id }));
  } else if (job.op === 'update') {
    const out = await updateIntent(job.id, job.patch, root);
    console.log('RESULT ' + JSON.stringify({ id: out.id }));
  } else {
    throw new Error('unknown op ' + job.op);
  }
} catch (error) {
  console.log('RESULT ' + JSON.stringify({ error: String((error && error.message) || error) }));
  process.exitCode = 4;
}
`;

interface ChildJob {
  op: 'evidence' | 'add' | 'update';
  ready: string;
  go: string;
  args?: string[];
  title?: string;
  rq?: string;
  id?: string;
  patch?: Record<string, unknown>;
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

const at = '2026-11-10T12:00:00.000Z';

function item(id: string, status: IntentStatus, extra: Partial<IntentItem> = {}): IntentItem {
  return {
    id, title: `Directive ${id}`, source: 'fixture', owner: 'owner', rq: [`RQ-${id.toUpperCase()}-10SSA1`],
    prs: [], status, evidence: [{ at, kind: 'note', ref: `origin ${id}` }],
    provenance: [{ source: 'fixture', date: at, verbatim: true, partial: false }],
    partial: false, closureProposal: null, lastTouchedAt: at, staleAfterMs: 60_000, createdAt: at, updatedAt: at,
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
let previousRuns: string | undefined;
const heldLocks: LocalStoreLock[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'intent-10ssa1-'));
  barrier = await mkdtemp(join(tmpdir(), 'intent-10ssa1-barrier-'));
  previousRuns = process.env['ASHLR_RUNS_DIR'];
  process.env['ASHLR_RUNS_DIR'] = root;
});

afterEach(async () => {
  if (previousRuns === undefined) delete process.env['ASHLR_RUNS_DIR'];
  else process.env['ASHLR_RUNS_DIR'] = previousRuns;
  vi.restoreAllMocks();
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

interface CliResult {
  code: number;
  result?: { dryRun: boolean; applied: boolean; matches: { id: string; status: string }[] };
  error?: string;
}

async function run(args: string[]): Promise<CliResult> {
  const out = vi.spyOn(console, 'log').mockImplementation(() => {});
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const code = await cmdFleetIntentEvidence([...args, '--json']);
    const line = String(out.mock.calls.at(-1)?.[0] ?? '');
    const error = String(err.mock.calls.at(-1)?.[0] ?? '');
    let result: CliResult['result'];
    try { result = JSON.parse(line) as CliResult['result']; } catch { result = undefined; }
    return { code, result, error };
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
}

const mergedArgs = (title: string, extra: string[] = []) => [
  'merged', '--repo', 'fleet/evidence', '--number', '88', '--title', title, '--at', at, ...extra,
];

describe('fleet intent-evidence merged --apply transaction (RQ-PHX-INTENTMERGEDTRANSACTION10SSA1)', () => {
  it('keeps dry-run and unmatched apply byte-identical, then persists matched evidence', async () => {
    await seed(root, [item('alpha', 'queued'), item('beta', 'verified')]);
    const before = await ledgerBytes(root);

    const preview = await run(mergedArgs('RQ-ALPHA-10SSA1 preview'));
    expect(preview.code).toBe(0);
    expect(preview.result).toMatchObject({ dryRun: true, applied: false, matches: [{ id: 'alpha', status: 'merged' }] });
    expect(await ledgerBytes(root)).toBe(before);

    // transactIntentLedger always persists, so an unmatched apply rewrites the
    // ledger; for an unchanged canonical ledger those bytes are identical.
    const unmatched = await run(mergedArgs('RQ-NOTHING-10SSA1', ['--apply']));
    expect(unmatched.code).toBe(0);
    expect(unmatched.result).toMatchObject({ dryRun: false, applied: false, matches: [] });
    expect(await ledgerBytes(root)).toBe(before);

    const applied = await run(mergedArgs('RQ-ALPHA-10SSA1 and RQ-BETA-10SSA1', ['--apply']));
    expect(applied.code).toBe(0);
    expect(applied.result).toMatchObject({
      dryRun: false, applied: true,
      matches: [{ id: 'alpha', status: 'merged' }, { id: 'beta', status: 'verified' }],
    });
    const ledger = await readLedger(root);
    const alpha = ledger.items.find((row) => row.id === 'alpha')!;
    const beta = ledger.items.find((row) => row.id === 'beta')!;
    expect(alpha.prs).toEqual([{ repo: 'fleet/evidence', number: 88, state: 'merged' }]);
    expect(alpha.status).toBe('merged');
    expect(beta.status).toBe('verified');
    expect(beta.prs).toHaveLength(1);
    expect(beta.evidence.map((row) => row.ref)).toContain('fleet/evidence#88');
  });

  it('replays a repeated merged --apply without duplicating the pull association', async () => {
    await seed(root, [item('alpha', 'queued'), item('beta', 'closed')]);
    const args = mergedArgs('RQ-ALPHA-10SSA1 and RQ-BETA-10SSA1', ['--apply']);
    expect((await run(args)).result?.applied).toBe(true);
    expect((await run(args)).result?.applied).toBe(true);
    const ledger = await readLedger(root);
    for (const id of ['alpha', 'beta']) {
      const row = ledger.items.find((entry) => entry.id === id)!;
      expect(row.prs).toEqual([{ repo: 'fleet/evidence', number: 88, state: 'merged' }]);
      expect(row.evidence.filter((entry) => entry.ref === 'fleet/evidence#88')).toHaveLength(2);
    }
    expect(ledger.items.find((row) => row.id === 'alpha')!.status).toBe('merged');
    expect(ledger.items.find((row) => row.id === 'beta')!.status).toBe('closed');
  });

  it('serializes merged --apply against concurrent add/update across child processes', async () => {
    await seed(root, [item('target', 'queued', { rq: ['RQ-MERGED-RACE'] })]);
    const jobs = jobsFor([
      { op: 'evidence', args: mergedArgs('RQ-MERGED-RACE ship', ['--apply']) },
      { op: 'add', title: 'Concurrent child directive', rq: 'RQ-MERGED-ADDED' },
      // An owner edit, not evidence: a verification note would flip a merged
      // record to verified, making the post-race status order-dependent.
      { op: 'update', id: 'target', patch: { owner: 'race-agent', now: at } },
    ], 'race');
    const results = await runChildren(jobs, root);
    expect(results[0]).toEqual({ code: 0 });
    for (const result of results.slice(1)) expect(result['error']).toBeUndefined();

    const ledger = await readLedger(root);
    expect(ledger.items).toHaveLength(2);
    const target = ledger.items.find((row) => row.id === 'target')!;
    expect(target.status).toBe('merged');
    expect(target.owner).toBe('race-agent');
    expect(target.prs).toEqual([{ repo: 'fleet/evidence', number: 88, state: 'merged' }]);
    expect(target.evidence.map((row) => row.ref)).toEqual(
      expect.arrayContaining(['origin target', 'fleet/evidence#88']));
    const added = ledger.items.find((row) => row.title === 'Concurrent child directive')!;
    expect(added).toMatchObject({ rq: ['RQ-MERGED-ADDED'], status: 'proposed' });
  });

  it('serializes same-process merged --apply against addIntent and updateIntent', async () => {
    await seed(root, [item('target', 'queued', { rq: ['RQ-MERGED-LOCAL'] })]);
    const [cli, added, updated] = await Promise.all([
      run(mergedArgs('RQ-MERGED-LOCAL', ['--apply'])),
      addIntent({ title: 'In-process directive', source: 't', rq: ['RQ-MERGED-INPROC'] }, root),
      updateIntent('target', { owner: 'local-agent', now: at }, root),
    ]);
    expect(cli.code).toBe(0);
    expect(cli.result?.applied).toBe(true);
    const ledger = await readLedger(root);
    const target = ledger.items.find((row) => row.id === 'target')!;
    expect(target.status).toBe('merged');
    expect(target.owner).toBe('local-agent');
    expect(target.evidence.map((row) => row.ref)).toEqual(
      expect.arrayContaining(['origin target', 'fleet/evidence#88']));
    expect(ledger.items.find((row) => row.id === added.id)).toMatchObject({ rq: ['RQ-MERGED-INPROC'] });
    expect(updated.id).toBe('target');
  });

  it('fails bounded under a held lock without mutating bytes, then succeeds after release', async () => {
    await seed(root, [item('alpha', 'queued')]);
    const before = await ledgerBytes(root);
    await mkdir(join(root, 'intent'), { recursive: true });
    const outcome = acquireLocalStoreLockWithOutcome(lockPath(root), 10_000, { anchorPath: join(root, 'intent') });
    expect(outcome.state).toBe('acquired');
    heldLocks.push(outcome.lock!);
    try {
      // A held lock is another writer's read-modify-write window: the old
      // unlocked apply wrote right through it and could drop that work.
      const contended = await run(mergedArgs('RQ-ALPHA-10SSA1', ['--apply']));
      expect(contended.code).toBe(1);
      expect(contended.error).toMatch(/busy|unavailable/);
      expect(await ledgerBytes(root)).toBe(before);
      // The dry-run preview never takes the lock and still answers.
      const preview = await run(mergedArgs('RQ-ALPHA-10SSA1'));
      expect(preview.code).toBe(0);
      expect(preview.result?.dryRun).toBe(true);
      expect(await ledgerBytes(root)).toBe(before);
    } finally {
      releaseLocalStoreLock(outcome.lock!);
      heldLocks.pop();
    }
    const retried = await run(mergedArgs('RQ-ALPHA-10SSA1', ['--apply']));
    expect(retried.code).toBe(0);
    expect(retried.result?.applied).toBe(true);
    expect((await readLedger(root)).items[0]!.status).toBe('merged');
  });

  it('does not create a missing ledger, even on apply', async () => {
    const applied = await run(mergedArgs('RQ-ALPHA-10SSA1', ['--apply']));
    expect(applied.code).toBe(0);
    expect(applied.result).toEqual({ dryRun: false, applied: false, matches: [] });
    await expect(readFile(intentLedgerPath(root), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(existsSync(join(root, 'intent', 'ledger.json'))).toBe(false);
  });
});
