/**
 * red-pr-fix-job.test.ts — the red-PR fix join: selection guards, fix-id shape
 * and spent-attempt bookkeeping, prompt contract (validateDropJob, Supersedes
 * marker, secret redaction, the 8 KB cap) and the write-once behaviour of
 * runRedPrFix. Hermetic: a fake argv-only gh plus a fresh mkdtemp runs dir;
 * nothing touches HOME or GitHub.
 */
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Gh } from '../autopilot/github.js';
import {
  DROP_JOB_ID,
  DROP_JOB_MAX_FILE_BYTES,
  DROP_JOB_QUEUE_LIMIT,
  validateDropJob,
} from './drop-job-writer.js';
import { runRedPrFix } from './red-pr-fix-job.js';

const REPO = 'ashlrai/phantom';
const SHA = 'a'.repeat(40);
const NOW = Date.parse('2026-11-01T12:00:00Z');
const RUN = 91011;
const JOB = 424242;
const PR = 2563;
const JOB_ID = 'RQ-PHX-REDPRFIXJOB01';
/** Private in the module; the same composition lets the test name spent ids. */
const fixId = (jobId: string, pr: number, attempt: number): string =>
  `${jobId.slice(7, 30)}${createHash('sha256').update(`${jobId}:${pr}`).digest('hex').slice(0, 10).toUpperCase()}FIX${attempt}`;
const FIX1 = fixId(JOB_ID, PR, 1);
const FIX2 = fixId(JOB_ID, PR, 2);

type PrRow = { number: number; title: string; headRefOid: string; mergeable: string; isDraft: boolean };

const prRow = (over: Record<string, unknown> = {}): PrRow => ({
  number: PR, title: `bridge: ${JOB_ID}`, headRefOid: SHA, mergeable: 'MERGEABLE', isDraft: false, ...over,
} as PrRow);

const apiRun = (over: Record<string, unknown> = {}) => ({
  id: RUN, name: 'CI', event: 'pull_request', head_branch: 'codex-bridge/x',
  pull_requests: [{ number: PR }], status: 'completed', conclusion: 'failure',
  created_at: '2026-11-01T10:00:00Z', updated_at: '2026-11-01T10:30:00Z',
  html_url: `https://github.com/${REPO}/actions/runs/${RUN}`, ...over,
});

/** Classification shape: a failed job with a failed step => failureClass 'code'. */
const apiJob = (over: Record<string, unknown> = {}) => ({
  id: JOB, name: 'Quick typecheck', status: 'completed', conclusion: 'failure',
  html_url: `https://github.com/${REPO}/actions/runs/${RUN}/job/${JOB}`,
  steps: [{ name: 'Install', conclusion: 'success' }, { name: 'Quick typecheck', conclusion: 'failure' }],
  ...over,
});

const evidenceJob = (over: Record<string, unknown> = {}) => ({
  id: JOB, run_id: RUN, name: 'Quick typecheck', head_sha: SHA, conclusion: 'failure',
  steps: [{ name: 'Install', conclusion: 'success' }, { name: 'Quick typecheck', conclusion: 'failure' }],
  ...over,
});

const LOG = "src/core/fleet/x.ts(1,1): error TS2304: Cannot find name 'x'.\n";

function fakeGh(
  prs: unknown[] = [prRow()],
  runs: unknown[] = [apiRun()],
  jobs: unknown[] = [apiJob()],
): Gh {
  return vi.fn(async (args: string[]) => {
    const last = args[args.length - 1]!;
    if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify(prs);
    if (last.startsWith(`repos/${REPO}/actions/runs?`)) return JSON.stringify({ workflow_runs: runs });
    if (/^repos\/[^/]+\/[^/]+\/actions\/runs\/\d+\/jobs\?per_page=100(&page=\d+)?$/.test(last)) return JSON.stringify({ jobs });
    const evidenceMatch = /^repos\/[^/]+\/[^/]+\/actions\/runs\/(\d+)\/jobs\?filter=all&per_page=100$/.exec(last);
    if (evidenceMatch) {
      const runId = Number(evidenceMatch[1]);
      const rows = jobs.map(j => ({ ...evidenceJob(), run_id: runId, ...(j as Record<string, unknown>) }));
      return JSON.stringify([{ total_count: rows.length, jobs: rows }]);
    }
    if (/^repos\/[^/]+\/[^/]+\/actions\/jobs\/\d+\/logs$/.test(last)) return LOG;
    throw new Error(`unexpected gh call: ${args.join(' ')}`);
  });
}

let runsDir: string;
beforeEach(async () => { runsDir = await realpath(await mkdtemp(join(tmpdir(), 'redfix-'))); });
afterEach(async () => { await rm(runsDir, { recursive: true, force: true }); });

const dropDir = () => join(runsDir, 'leader', 'drop', 'claude');
const runOpts = (write: boolean, gh: Gh = fakeGh()) => ({ repo: REPO, hours: 24, write, runsDir, gh, now: () => NOW });

// ---------------------------------------------------------------------------
// candidate selection (inline guards inside runRedPrFix)
// ---------------------------------------------------------------------------

describe('runRedPrFix selection guards', () => {
  it('selects a MERGEABLE bridge PR whose newest run is a completed code failure', async () => {
    const report = await runRedPrFix(runOpts(false));
    expect(report.reason).toBeNull();
    expect(report.candidates).toEqual([
      { number: PR, jobId: JOB_ID, head: SHA, run: RUN, fixId: FIX1, written: false, skipped: null },
    ]);
  });

  it.each<[string, { prs?: unknown[]; runs?: unknown[]; jobs?: unknown[] }]>([
    ['bind-artifact failure', { jobs: [apiJob({ steps: [{ name: 'Bind candidate source', conclusion: 'failure' }] })] }],
    ['unclassified failure', { jobs: [] }],
    ['DIRTY PR', { prs: [prRow({ mergeable: 'CONFLICTING' })] }],
    ['unknown mergeability', { prs: [prRow({ mergeable: 'UNKNOWN' })] }],
    ['draft PR', { prs: [prRow({ isDraft: true })] }],
    ['non-bridge title', { prs: [prRow({ title: 'fix the thing' })] }],
    ['bridge title with suffix', { prs: [prRow({ title: `bridge: ${JOB_ID} v2` })] }],
    ['in-progress newest run', { runs: [apiRun({ status: 'in_progress', conclusion: null })] }],
    ['queued newest run', { runs: [apiRun({ status: 'queued', conclusion: null })] }],
    ['green newest run', { runs: [apiRun({ conclusion: 'success' })] }],
    ['run of another PR', { runs: [apiRun({ pull_requests: [{ number: 99 }] })] }],
    ['no run at all', { runs: [] }],
  ])('excludes %s', async (_name, over) => {
    const report = await runRedPrFix(runOpts(true, fakeGh(over.prs, over.runs, over.jobs)));
    expect(report.candidates).toEqual([]);
    expect(await readdir(runsDir)).toEqual([]);
  });

  it('flags a malformed PR row instead of silently skipping it', async () => {
    const report = await runRedPrFix(runOpts(true, fakeGh([{ number: PR }])));
    expect(report.candidates).toEqual([]);
    expect(report.reason).toBe('invalid PR facts');
  });

  it('judges the newest row only: in-progress newest beats an older failure', async () => {
    const inProgress = apiRun({ id: RUN + 1, status: 'in_progress', conclusion: null, created_at: '2026-11-01T11:00:00Z' });
    const newerFailure = apiRun({ id: RUN + 2, created_at: '2026-11-01T11:30:00Z' });
    let report = await runRedPrFix(runOpts(true, fakeGh([prRow()], [inProgress, apiRun()])));
    expect(report.candidates).toEqual([]);
    report = await runRedPrFix(runOpts(true, fakeGh([prRow()], [inProgress, newerFailure])));
    expect(report.candidates).toHaveLength(1);
    expect(report.candidates[0]?.run).toBe(RUN + 2);
  });

  it('dedupes repeated PR numbers', async () => {
    const report = await runRedPrFix(runOpts(false, fakeGh([prRow(), prRow()])));
    expect(report.candidates).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// fix-id shape
// ---------------------------------------------------------------------------

describe('fix id composition', () => {
  it('is deterministic, sha-bound and always satisfies DROP_JOB_ID', () => {
    expect(FIX1).toBe('REDPRFIXJOB01B8D37D259DFIX1');
    expect(FIX1).toMatch(DROP_JOB_ID);
    expect(FIX2).toMatch(DROP_JOB_ID);
    expect(FIX1).not.toBe(FIX2);
    for (let attempt = 1; attempt <= 5; attempt++) expect(fixId(JOB_ID, PR, attempt)).toMatch(DROP_JOB_ID);
    const long = fixId(`RQ-PHX-${'A'.repeat(50)}`, PR, 3);
    expect(long).toMatch(DROP_JOB_ID);
    expect(long.startsWith('A'.repeat(23))).toBe(true); // jobId.slice(7, 30) caps the stem
  });
});

// ---------------------------------------------------------------------------
// prompt contract
// ---------------------------------------------------------------------------

describe('prompt contract', () => {
  const written = async (gh: Gh = fakeGh()) => {
    const report = await runRedPrFix(runOpts(true, gh));
    expect(report.candidates[0]?.written).toBe(true);
    return readFile(join(dropDir(), `RQ-PHX-${FIX1}.md`), 'utf8');
  };

  it('passes validateDropJob and carries the fix contract', async () => {
    const content = await written();
    expect(content).toContain('#job repo=phantom lane=codex-personal tier=work');
    expect(content).toContain(`Fix CI for ashlrai/phantom PR #${PR}, job ${JOB_ID}, head ${SHA}`);
    expect(content).toContain(`Observed run: ${RUN}`);
    expect(content).toContain(`pull/${PR}/head`);
    expect(content).toContain('- Quick typecheck');
    expect(content).toContain('error TS2304');
    expect(content).toContain(`Supersedes #${PR}`);
    for (const denied of ['.github/', 'auth.json', 'CODEOWNERS', '/.codex']) {
      expect(content).not.toContain(denied);
    }
    const body = content.split('\n\n', 2)[1]!;
    expect(validateDropJob({ id: FIX1, lane: 'codex-personal', tier: 'work', body })).toEqual({ ok: true });
  });

  it('redacts a planted secret-shaped token from evidence', async () => {
    const fake = 'FAKE4fakeTOKEN1234567890ab'; // 26-char token run, obviously fake
    const gh = fakeGh([prRow()], [apiRun()], [apiJob()]);
    const wrapped: Gh = async (args) => {
      if (args[args.length - 1] === `repos/${REPO}/actions/jobs/${JOB}/logs`) {
        return `error: leaked ${fake} here\n`;
      }
      return gh(args);
    };
    const content = await written(wrapped);
    expect(content).not.toContain(fake);
    expect(content).toContain('[REDACTED]');
  });

  it('drops denied-token evidence lines and stays under the file cap', async () => {
    const gh = fakeGh([prRow()], [apiRun()], [apiJob()]);
    const wrapped: Gh = async (args) => {
      if (args[args.length - 1] === `repos/${REPO}/actions/jobs/${JOB}/logs`) {
        return Array.from({ length: 50 }, (_, i) => `error ${i}: ${'x'.repeat(380)}`)
          .concat(['error: see .github/workflows/leak.yml'])
          .join('\n') + '\n';
      }
      return gh(args);
    };
    const content = await written(wrapped);
    expect(content).not.toContain('.github/');
    expect(Buffer.byteLength(content, 'utf8')).toBeLessThanOrEqual(DROP_JOB_MAX_FILE_BYTES);
  });
});

// ---------------------------------------------------------------------------
// write-once behaviour and degraded paths
// ---------------------------------------------------------------------------

describe('write-once bookkeeping', () => {
  it('writes RQ-PHX-<fixId>.md once, then reports already-dropped', async () => {
    const first = await runRedPrFix(runOpts(true));
    expect(first.reason).toBeNull();
    expect(first.candidates).toEqual([
      { number: PR, jobId: JOB_ID, head: SHA, run: RUN, fixId: FIX1, written: true, skipped: null },
    ]);
    expect(await readdir(dropDir())).toEqual([`RQ-PHX-${FIX1}.md`]);

    const second = await runRedPrFix(runOpts(true));
    expect(second.candidates).toEqual([
      { number: PR, jobId: JOB_ID, head: SHA, run: RUN, fixId: FIX1, written: false, skipped: 'already-dropped' },
    ]);
    expect(await readdir(dropDir())).toEqual([`RQ-PHX-${FIX1}.md`]);
  });

  it('dry run reads everything and writes nothing', async () => {
    const report = await runRedPrFix(runOpts(false));
    expect(report.candidates).toEqual([
      { number: PR, jobId: JOB_ID, head: SHA, run: RUN, fixId: FIX1, written: false, skipped: null },
    ]);
    expect(await readdir(runsDir)).toEqual([]);
  });

  it('a spent id sitting in queue/prompts also counts as used', async () => {
    await mkdir(join(runsDir, 'queue', 'prompts'), { recursive: true });
    await writeFile(join(runsDir, 'queue', 'prompts', `RQ-PHX-${FIX1}.md`), `Observed run: ${RUN}\n`);
    const report = await runRedPrFix(runOpts(true));
    expect(report.candidates[0]).toMatchObject({ fixId: FIX1, written: false, skipped: 'already-dropped' });
  });

  it('skips attempts-exhausted when all five fix ids exist', async () => {
    await mkdir(dropDir(), { recursive: true });
    for (let i = 1; i <= 5; i++) {
      await writeFile(join(dropDir(), `RQ-PHX-${fixId(JOB_ID, PR, i)}.md`), '#job repo=phantom lane=codex-personal tier=work\n\nolder run\n');
    }
    const report = await runRedPrFix(runOpts(true));
    expect(report.candidates[0]).toMatchObject({ fixId: '', written: false, skipped: 'attempts-exhausted' });
  });

  it('moves to the next free attempt when an older run was fixed', async () => {
    await mkdir(dropDir(), { recursive: true });
    await writeFile(join(dropDir(), `RQ-PHX-${FIX1}.md`), '#job repo=phantom lane=codex-personal tier=work\n\nObserved run: 1\n');
    const report = await runRedPrFix(runOpts(true));
    expect(report.candidates[0]).toMatchObject({ fixId: FIX2, written: true });
    await expect(readFile(join(dropDir(), `RQ-PHX-${FIX2}.md`), 'utf8')).resolves.toContain(`Observed run: ${RUN}`);
  });

  it('marks candidates queue-full instead of writing past the queue limit', async () => {
    const prompts = join(runsDir, 'queue', 'prompts');
    await mkdir(prompts, { recursive: true });
    for (let i = 0; i < DROP_JOB_QUEUE_LIMIT; i++) {
      await writeFile(join(prompts, `RQ-PHX-QUEUE${String(i).padStart(2, '0')}.md`), 'x');
    }
    const report = await runRedPrFix(runOpts(true));
    expect(report.candidates[0]).toMatchObject({ fixId: FIX1, written: false, skipped: 'queue-full' });
  });

  it('skips evidence-unavailable-or-stale when the observed job sha moved', async () => {
    const jobs = [apiJob()];
    const gh = fakeGh([prRow()], [apiRun()], jobs);
    const wrapped: Gh = async (args) => {
      const last = args[args.length - 1]!;
      if (last === `repos/${REPO}/actions/runs/${RUN}/jobs?filter=all&per_page=100`) {
        return JSON.stringify([{ total_count: 1, jobs: [evidenceJob({ head_sha: 'b'.repeat(40) })] }]);
      }
      return gh(args);
    };
    const report = await runRedPrFix(runOpts(true, wrapped));
    expect(report.candidates[0]).toMatchObject({ skipped: 'evidence-unavailable-or-stale' });
    expect(await readdir(runsDir)).toEqual([]);
  });

  it('skips collection-or-write-failed when the jobs read throws', async () => {
    const gh = fakeGh([prRow()], [apiRun()], [apiJob()]);
    const wrapped: Gh = async (args) => {
      const last = args[args.length - 1]!;
      if (last === `repos/${REPO}/actions/runs/${RUN}/jobs?per_page=100`) throw new Error('gh offline');
      return gh(args);
    };
    const report = await runRedPrFix(runOpts(true, wrapped));
    expect(report.candidates[0]).toMatchObject({ skipped: 'collection-or-write-failed' });
  });

  it('never throws: a failing gh yields empty candidates with a reason', async () => {
    const gh: Gh = async () => { throw new Error('gh offline'); };
    const report = await runRedPrFix(runOpts(true, gh));
    expect(report.candidates).toEqual([]);
    expect(report.reason).toBe('open PR list unavailable or incomplete');
  });

  it('never throws: malformed gh output yields empty candidates with a reason', async () => {
    const gh: Gh = async () => 'not json';
    const report = await runRedPrFix(runOpts(true, gh));
    expect(report.candidates).toEqual([]);
    expect(report.reason).toBe('open PR list unavailable or incomplete');
  });

  it('never throws: a full PR page (100 rows) is treated as incomplete', async () => {
    const prs = Array.from({ length: 100 }, (_, i) => prRow({ number: i + 1 }));
    const report = await runRedPrFix(runOpts(true, fakeGh(prs)));
    expect(report.candidates).toEqual([]);
    expect(report.reason).toBe('open PR list unavailable or incomplete');
  });

  it('never throws: unreadable CI facts degrade the whole report', async () => {
    const gh = fakeGh();
    const wrapped: Gh = async (args) => {
      const last = args[args.length - 1]!;
      if (last.startsWith(`repos/${REPO}/actions/runs?`)) throw new Error('actions api down');
      return gh(args);
    };
    const report = await runRedPrFix(runOpts(true, wrapped));
    expect(report.candidates).toEqual([]);
    expect(report.reason).toBe('GitHub Actions facts could not be read completely.');
  });

  it.each<[string, { repo?: string; hours?: number; runsDir?: string }]>([
    ['non-phantom repo', { repo: 'owner/name' }],
    ['malformed repo', { repo: 'not a repo' }],
    ['zero hours', { hours: 0 }],
    ['hours over 168', { hours: 169 }],
    ['relative runs dir', { runsDir: 'relative/dir' }],
  ])('rejects %s with invalid arguments', async (_name, over) => {
    const opts = { repo: REPO, hours: 24, write: true, runsDir, gh: fakeGh(), ...over };
    const report = await runRedPrFix(opts);
    expect(report).toEqual({ candidates: [], reason: 'invalid arguments' });
  });
});
