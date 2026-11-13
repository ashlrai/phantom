/**
 * RQ-PHX-EMPTYREASONSOWNERQUALIFY288S — cross-surface qualification evidence
 * for EXISTING owner PR #5346 (RQ-PHX-EMPTYREASONSORIGINAL256S). The backend
 * `readEmptyJobs` report gains a `reasons` block and the `fleet empty-why`
 * CLI shares one log classifier. This suite feeds ONE fixture through both
 * surfaces and asserts they agree over identical selected jobs, that a
 * private-looking prose sentinel in log content never reaches either
 * serialization, and that the 50-job backend reason cap is honoured without
 * demanding equal totals across different windows. Self-skips on trees
 * without the owner change (master before #5346 merges).
 */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetEmptyWhy, classifyEmptyLog, emptyJobs, FLEET_EMPTY_WHY_REASONS, summarizeEmptyWhy } from '../src/cli/fleet-empty-why.js';
import { classifyEmpty, readEmptyJobs } from '../src/core/fleet/empty-jobs.js';

const OWNER_TREE = existsSync(fileURLToPath(new URL('../src/core/fleet/empty-why-classify.ts', import.meta.url)));

const NOW = Date.parse('2026-11-13T00:00:00Z');
let dir: string;
let runs: string;
let wt: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'empty-reasons-owner-288-'));
  runs = join(dir, 'runs');
  wt = join(dir, 'wt');
  await mkdir(join(runs, 'metrics'), { recursive: true });
  await mkdir(wt, { recursive: true });
});
afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env.ASHLR_RUNS_DIR;
  await rm(dir, { recursive: true, force: true });
});

// Ledger order is chronological: first row oldest, last row newest.
const seed = (rows: Array<{ id: string; lane?: string; ageMin?: number }>) =>
  writeFile(join(runs, 'metrics/jobs.jsonl'), rows.map((r, i) => JSON.stringify({
    event: 'outcome', empty: true, job: r.id, lane: r.lane ?? 'claude',
    ts: new Date(NOW - (rows.length - i) * (r.ageMin ?? 1) * 60_000).toISOString(),
  })).join('\n'));
const log = (id: string, text: string) => writeFile(join(runs, `${id}.log`), text);
const notes = (id: string, text: string) => mkdir(join(wt, id), { recursive: true }).then(() => writeFile(join(wt, id, 'BRIDGE_NOTES.md'), text));

interface CliSide { report: ReturnType<typeof summarizeEmptyWhy>; idReason: Map<string, string> }

/** Run the CLI's pure path over the exact same ledger bytes and log files. */
async function cliSide(hours = 24): Promise<CliSide> {
  const ledger = await readFile(join(runs, 'metrics/jobs.jsonl'), 'utf8');
  const jobs = emptyJobs(ledger, NOW, hours);
  const logs = new Map<string, string | null>();
  await Promise.all(jobs.map(async j => {
    logs.set(j.id, await readFile(join(runs, `${j.id}.log`), 'utf8').catch(() => null));
  }));
  const report = summarizeEmptyWhy(jobs, logs, hours);
  const idReason = new Map<string, string>();
  for (const reason of FLEET_EMPTY_WHY_REASONS) for (const id of report.ids[reason]) idReason.set(id, reason);
  return { report, idReason };
}

describe.skipIf(!OWNER_TREE)('empty-why reasons cross-surface contract (PR #5346 head)', () => {
  it('tags all five reasons identically on backend and CLI over the same selected jobs', async () => {
    await seed([
      { id: 'A-lint', lane: 'claude' }, { id: 'B-int', lane: 'devin' }, { id: 'C-block', lane: 'claude' },
      { id: 'D-limit', lane: 'zai' }, { id: 'E-other' }, { id: 'F-missing' }, { id: 'G-mixed' },
    ]);
    await log('A-lint', 'ESLint crashed while loading the shared config');
    await log('B-int', 'worker exited code 130 after the restart');
    await log('C-block', 'the migration step is blocked on a missing table');
    await log('D-limit', 'you hit your usage limit for this window');
    await log('E-other', 'nothing notable happened during the run');
    // G-missing has no log file; G-mixed matches several rules at once.
    await log('G-mixed', 'eslint exploded; usage limit reached; exited code 130');

    const backend = await readEmptyJobs(24, runs, wt, NOW);
    const cli = await cliSide();

    const expected = { 'lint-env': 2, interrupted: 1, blocked: 1, limit: 1, other: 2 };
    expect(backend?.reasons?.by_reason).toEqual(expected);
    expect(cli.report.by_reason).toEqual(expected);
    expect(cli.report.total).toBe(backend?.total);

    // Per-id agreement: every backend recent entry matches the CLI id->reason map.
    for (const entry of backend?.reasons?.recent ?? []) {
      expect(cli.idReason.get(entry.id)).toBe(entry.reason);
    }
    expect(new Set(cli.idReason.keys())).toEqual(new Set(['A-lint', 'B-int', 'C-block', 'D-limit', 'E-other', 'F-missing', 'G-mixed']));
    // Mixed-match precedence is the shared first-match rule: lint-env wins.
    expect(cli.idReason.get('G-mixed')).toBe('lint-env');
    expect(backend?.reasons?.recent.find(j => j.id === 'G-mixed')?.reason).toBe('lint-env');
    // A missing log file classifies as other on both surfaces.
    expect(cli.idReason.get('F-missing')).toBe('other');
    expect(backend?.reasons?.recent.find(j => j.id === 'F-missing')?.reason).toBe('other');
  });

  it('keeps fixed reason labels and ids in both serializations without leaking log prose', async () => {
    const SENTINEL = 'the harbor lantern parade drifted past the old mill at dawn';
    await seed([{ id: 'S-private', lane: 'claude' }, { id: 'T-quiet' }]);
    await log('S-private', `usage limit reached\n${SENTINEL}\nmore private narration here`);
    await log('T-quiet', 'all quiet on the western front');

    const backend = await readEmptyJobs(24, runs, wt, NOW);
    const cli = await cliSide();
    const cliJson = JSON.stringify(cli.report);

    // Fixed vocabularies only: reason labels come from the closed set.
    expect(Object.keys(cli.report.by_reason).sort()).toEqual([...FLEET_EMPTY_WHY_REASONS].sort());
    for (const entry of backend?.reasons?.recent ?? []) {
      expect(FLEET_EMPTY_WHY_REASONS).toContain(entry.reason);
      expect(Object.keys(entry).sort()).toEqual(['id', 'lane', 'reason']);
    }

    // Neither serialization may carry unique prose from log content.
    for (const serialized of [JSON.stringify(backend), cliJson]) {
      expect(serialized).not.toContain(SENTINEL);
      expect(serialized).not.toContain('harbor lantern');
      expect(serialized).not.toContain('private narration');
    }

    // The printed CLI report is equally clean.
    process.env.ASHLR_RUNS_DIR = runs;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await cmdFleetEmptyWhy(['--json'], undefined, () => NOW)).toBe(0);
    const printed = logSpy.mock.calls.map(c => c[0]).join('\n');
    expect(printed).not.toContain(SENTINEL);
    expect(JSON.parse(printed).by_reason.limit).toBe(1);
  });

  it('preserves class, counts and topCauses semantics while reasons ride along', async () => {
    await seed([{ id: 'P-dup' }, { id: 'Q-timeout' }, { id: 'R-none' }, { id: 'S-limit' }]);
    await notes('P-dup', 'this is a duplicate of an earlier job, please close it');
    await log('P-dup', 'usage limit reached');
    await log('Q-timeout', 'the test suite timed out after the long run');
    // R-none has neither notes nor log; S-limit only carries a reason tag.
    await log('S-limit', 'rate limit hit by the provider');

    const backend = await readEmptyJobs(24, runs, wt, NOW);
    expect(backend?.schema).toBe('jobs.empty.v1');
    expect(backend?.total).toBe(4);
    expect(backend?.jobs.map(j => [j.id, j.class])).toEqual([
      ['P-dup', 'duplicate'], ['Q-timeout', 'tests-timeout'], ['R-none', 'other'], ['S-limit', 'blocked-by-env'],
    ]);
    expect(backend?.counts).toMatchObject({ duplicate: 1, 'tests-timeout': 1, 'blocked-by-env': 1, other: 1 });
    expect(backend?.topCauses.map(c => c.class)).toEqual(['duplicate', 'tests-timeout', 'blocked-by-env', 'other']);
    expect(backend?.topCauses[0]).toMatchObject({ class: 'duplicate', count: 1, exampleJob: 'P-dup' });

    // Reasons are log-tail tags only: notes text never feeds them, and the
    // class pipeline result is identical whether or not reasons is read.
    const cli = await cliSide();
    expect(cli.report.by_reason).toEqual({ 'lint-env': 0, interrupted: 0, blocked: 0, limit: 2, other: 2 });
    expect(cli.idReason.get('P-dup')).toBe('limit'); // notes 'duplicate' did not leak into reasons
    expect(cli.idReason.get('R-none')).toBe('other');
    for (const entry of backend?.reasons?.recent ?? []) {
      expect(cli.idReason.get(entry.id)).toBe(entry.reason);
    }
    // The class 'reason' strings stay the fixed EmptyClass descriptions.
    for (const job of backend?.jobs ?? []) {
      expect(typeof job.reason).toBe('string');
      expect(job.reason.length).toBeGreaterThan(0);
    }
  });

  it('caps backend reasons at the newest 50 selected jobs while the CLI counts the full window', async () => {
    const ids = Array.from({ length: 55 }, (_, i) => `J${String(i).padStart(2, '0')}`);
    await seed(ids.map(id => ({ id })));
    for (const [i, id] of ids.entries()) {
      await log(id, i < 10 ? 'nothing special in this run' : 'usage limit reached');
    }

    const backend = await readEmptyJobs(24, runs, wt, NOW);
    const cli = await cliSide();

    // CLI sees all 55 selected jobs: 45 limit, 10 other.
    expect(cli.report.total).toBe(55);
    expect(cli.report.by_reason).toEqual({ 'lint-env': 0, interrupted: 0, blocked: 0, limit: 45, other: 10 });
    // Backend reasons cover only the newest 50 (J05..J54): 5 other, 45 limit.
    expect(backend?.total).toBe(55);
    expect(backend?.reasons?.by_reason).toEqual({ 'lint-env': 0, interrupted: 0, blocked: 0, limit: 45, other: 5 });
    expect(backend?.reasons?.recent).toHaveLength(20);
    expect(backend?.reasons?.recent[0]).toEqual({ id: 'J54', lane: 'claude', reason: 'limit' });

    // Over the shared window the per-id tags still agree.
    const shared = new Set(ids.slice(5));
    for (const entry of backend?.reasons?.recent ?? []) {
      expect(shared.has(entry.id)).toBe(true);
      expect(cli.idReason.get(entry.id)).toBe(entry.reason);
    }
  });

  it('leaves ledger and log bytes untouched after both surfaces read them', async () => {
    await seed([{ id: 'U-one' }, { id: 'V-two' }]);
    await log('U-one', 'usage limit reached');
    await log('V-two', 'exited code 130');
    const before = new Map<string, Buffer>();
    for (const p of [join(runs, 'metrics/jobs.jsonl'), join(runs, 'U-one.log'), join(runs, 'V-two.log')]) {
      before.set(p, await readFile(p));
    }

    await readEmptyJobs(24, runs, wt, NOW);
    await cliSide();
    process.env.ASHLR_RUNS_DIR = runs;
    await cmdFleetEmptyWhy(['--json'], undefined, () => NOW);

    for (const [p, bytes] of before) {
      expect(await readFile(p)).toEqual(bytes);
    }
  });

  it('runs both surfaces on the same classifier implementation', async () => {
    // The owner moved the rules into empty-jobs.ts and re-exports them through
    // empty-why-classify.ts and the CLI module; verify the identity holds.
    const specifier: string = '../src/core/fleet/empty-why-classify.js';
    const mod = (await import(specifier)) as {
      classifyEmptyLog: typeof classifyEmptyLog;
      FLEET_EMPTY_WHY_REASONS: readonly string[];
      FLEET_EMPTY_WHY_LOG_LINES: number;
    };
    expect(mod.classifyEmptyLog).toBe(classifyEmptyLog);
    expect([...mod.FLEET_EMPTY_WHY_REASONS]).toEqual([...FLEET_EMPTY_WHY_REASONS]);
    // And the backend report reuses that same function for its tags.
    await seed([{ id: 'W-shared' }]);
    await log('W-shared', 'the task is blocked pending input');
    const backend = await readEmptyJobs(24, runs, wt, NOW);
    expect(backend?.reasons?.recent[0]?.reason).toBe(mod.classifyEmptyLog('the task is blocked pending input'));
    expect(classifyEmpty(null, null).class).toBe('other');
  });
});
