import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  classifyEmptyCause, emptyCauseLine, emptyFinishes, EMPTY_CAUSE_TAIL_LINES, readEmptyCauses, summarizeEmptyCauses, topEmptyCauses,
  type EmptyCause,
} from '../src/core/fleet/empty-cause.js';
import { cmdFleetEmpties } from '../src/cli/fleet-empties.js';
import { readHostVitals } from '../src/cli/fleet-vitals.js';

// Short fake worker logs; values are plainly fake.
const LOGS: Array<[string, EmptyCause]> = [
  ['$ gh pr list\nfailed to read configuration: open /fake/home/.config/gh/config.yml: operation not permitted\nEMPTY', 'sandbox_denied'],
  ['gh not logged in; cannot check open PRs.\nNo changes made.', 'sandbox_denied'],
  ['You are not logged into any GitHub hosts. To log in, run: gh auth login', 'sandbox_denied'],
  ['Checked master.\nNO CANDIDATE: the fix is already on master (abc1234).', 'no_candidate'],
  ['The requested change is already on origin/master; nothing to do.', 'no_candidate'],
  ['PARKED RQ-FAKE-1 [precheck code=13 reason=landed]', 'precheck_skip'],
  ['bash: tsgo: command not found', 'tool_missing'],
  ['Error: spawn rg ENOENT', 'tool_missing'],
  ['worker step timed out after 1800s', 'timeout'],
  ['API Error: 529 overloaded', 'model_error'],
  ["You've hit your usage limit. Try again later.", 'model_error'],
  ['Done. Summary written.', 'unknown'],
  ['', 'unknown'],
];

describe('classifyEmptyCause', () => {
  it.each(LOGS)('tags %j as %s', (log, cause) => expect(classifyEmptyCause(log)).toBe(cause));

  it('keeps a missing log unknown, but trusts the dispatcher timeout marker', () => {
    expect(classifyEmptyCause(null)).toBe('unknown');
    expect(classifyEmptyCause(null, true)).toBe('timeout');
    expect(classifyEmptyCause('NO CANDIDATE', true)).toBe('timeout');
  });

  it('reads only the final lines, so an echoed prompt cannot decide the cause', () => {
    const prompt = 'Task: classify sandbox_denied (operation not permitted) and NO CANDIDATE\n';
    const filler = Array.from({ length: EMPTY_CAUSE_TAIL_LINES }, (_, i) => `step ${i}`).join('\n');
    expect(classifyEmptyCause(`${prompt}${filler}`)).toBe('unknown');
    expect(classifyEmptyCause(`${prompt}${filler}\nNO CANDIDATE`)).toBe('no_candidate');
  });

  it('ranks a sandbox denial above the no-candidate verdict it often causes', () => {
    expect(classifyEmptyCause('gh: operation not permitted\nNO CANDIDATE')).toBe('sandbox_denied');
  });
});

const NOW = Date.parse('2026-11-16T12:00:00Z');
const ts = (hoursAgo: number) => new Date(NOW - hoursAgo * 3_600_000).toISOString();
const finish = (job: string, lane: string, wall_s: number, hoursAgo = 1, empty = true) =>
  JSON.stringify({ event: 'finish', job, lane, wall_s, empty, ts: ts(hoursAgo) });

describe('emptyFinishes', () => {
  it('keeps empty finish and outcome rows in the window, once per job, and refuses unsafe ids', () => {
    const ledger = [
      finish('RQ-A1', 'claude', 100), JSON.stringify({ event: 'outcome', job: 'RQ-A1', empty: true, ts: ts(1) }),
      finish('RQ-B1', 'codex', 50, 1, false), finish('RQ-OLD1', 'claude', 10, 25), finish('../etc', 'claude', 1),
      JSON.stringify({ event: 'outcome', job: 'RQ-C1', empty: true, ts: ts(2) }), '{torn',
    ].join('\n');
    expect(emptyFinishes(ledger, NOW, 24)).toEqual([
      { id: 'RQ-A1', lane: 'claude', wallSeconds: 100 },
      { id: 'RQ-C1', lane: 'unknown', wallSeconds: null },
    ]);
  });

  it('reads the jobs-ledger field dialect: alias stamps, job_id ids, pool lanes', () => {
    const ledger = [
      JSON.stringify({ event: 'finish', job_id: 'RQ-D1', pool: 'claude', wall_s: 40, empty: true, timestamp: ts(1) }),
      JSON.stringify({ event: 'finish', jobId: 'RQ-D2', lane: 'codex', wall_s: 30, empty: true, recordedAt: ts(2) }),
      // A terminal row stamped only by mergedAt still lands in the window.
      JSON.stringify({ event: 'outcome', job: 'RQ-D3', state: 'MERGED', empty: true, mergedAt: ts(1) }),
      JSON.stringify({ event: 'outcome', job: 'RQ-D4', outcome: 'EMPTY_DONE', updatedAt: ts(3) }),
    ].join('\n');
    expect(emptyFinishes(ledger, NOW, 24)).toEqual([
      { id: 'RQ-D1', lane: 'claude', wallSeconds: 40 },
      { id: 'RQ-D2', lane: 'codex', wallSeconds: 30 },
      { id: 'RQ-D3', lane: 'unknown', wallSeconds: null },
      { id: 'RQ-D4', lane: 'unknown', wallSeconds: null },
    ]);
  });
});

describe('summarizeEmptyCauses', () => {
  it('groups by lane, cause and prefix with two examples and the median wall', () => {
    const jobs = [
      { id: 'RQ-GH1', lane: 'claude', wallSeconds: 30 }, { id: 'RQ-GH2', lane: 'claude', wallSeconds: 90 },
      { id: 'RQ-GH3', lane: 'claude', wallSeconds: 60 }, { id: 'RQ-OTHER1', lane: 'claude', wallSeconds: null },
      { id: 'RQ-X1', lane: 'gemini', wallSeconds: 5 },
    ];
    const denied = { log: 'operation not permitted', timedOut: false };
    const summary = summarizeEmptyCauses(jobs, new Map([['RQ-GH1', denied], ['RQ-GH2', denied], ['RQ-GH3', denied], ['RQ-OTHER1', denied]]));
    expect(summary.total).toBe(5);
    expect(summary.logs_missing).toBe(1);
    expect(summary.by_cause).toMatchObject({ sandbox_denied: 4, unknown: 1 });
    expect(summary.groups[0]).toEqual({ lane: 'claude', cause: 'sandbox_denied', prefix: 'RQ-GH', count: 3, examples: ['RQ-GH1', 'RQ-GH2'], median_wall_seconds: 60 });
    expect(summary.groups).toContainEqual({ lane: 'claude', cause: 'sandbox_denied', prefix: 'RQ-OTHER', count: 1, examples: ['RQ-OTHER1'], median_wall_seconds: null });
    expect(summary.top.map(t => t.line)).toEqual([
      'claude: 4 jobs ended empty because gh or a file was blocked in the sandbox',
      'gemini: 1 job ended empty because of a cause not recognised in the final log lines',
    ]);
    expect(topEmptyCauses(summary)).toEqual([{ cause: 'sandbox_denied', count: 4 }, { cause: 'unknown', count: 1 }]);
  });

  it('has a plain line for every cause', () => {
    for (const [, cause] of LOGS) expect(emptyCauseLine('lane', cause, 2)).toMatch(/^lane: 2 jobs ended empty because \S/);
  });
});

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(r => rm(r, { recursive: true, force: true }))); });
async function runsDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'empty-cause-')); roots.push(root);
  await mkdir(join(root, 'metrics')); await mkdir(join(root, 'queue', 'run'), { recursive: true });
  const jobs = LOGS.map(([, cause], i) => [`RQ-FAKE-${i}`, cause] as const);
  await writeFile(join(root, 'metrics', 'jobs.jsonl'), [...jobs.map(([id], i) => finish(id, i < 3 ? 'claude' : 'codex-cmp', 60 + i)),
    finish('RQ-SLOW1', 'gemini', 1800), finish('RQ-NOLOG1', 'gemini', 20), finish('RQ-LINK1', 'gemini', 20)].join('\n'));
  await Promise.all(jobs.map(([id], i) => writeFile(join(root, `${id}.log`), LOGS[i]![0])));
  await writeFile(join(root, 'queue', 'run', 'RQ-SLOW1.timeout'), '');
  await writeFile(join(root, 'secret.txt'), 'operation not permitted');
  await symlink(join(root, 'secret.txt'), join(root, 'RQ-LINK1.log'));
  return root;
}

describe('readEmptyCauses, fleet empties and fleet vitals', () => {
  it('reads logs beside the runs dir and never follows a symlinked log', async () => {
    const summary = await readEmptyCauses(await runsDir(), NOW, 24);
    expect(summary.total).toBe(LOGS.length + 3);
    expect(summary.by_cause).toEqual({ sandbox_denied: 3, no_candidate: 2, precheck_skip: 1, tool_missing: 2, timeout: 2, model_error: 2, unknown: 4 });
    expect(summary.logs_missing).toBe(3);
    expect(summary.top[0]!.line).toBe('claude: 3 jobs ended empty because gh or a file was blocked in the sandbox');
  });

  it('reports an unreadable ledger as unknown rather than zero', async () => {
    const root = await mkdtemp(join(tmpdir(), 'empty-cause-')); roots.push(root);
    expect(await readEmptyCauses(root, NOW, 24)).toMatchObject({ total: null, groups: [], top: [] });
  });

  it('prints JSON and plain lines from one command', async () => {
    const root = await runsDir();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleetEmpties(['--since', '24h', '--runs-dir', root, '--json'], undefined, NOW)).toBe(0);
    const json = JSON.parse(String(log.mock.calls.at(-1)![0]));
    expect(json).toMatchObject({ schema: 'fleet.empties.v2', known: true, total: LOGS.length + 3 });
    expect(json.byCause).toMatchObject({ unknown: LOGS.length + 1, 'too-fast-to-have-worked': 2 }); // Logs are not cause evidence.
    log.mockClear();
    expect(await cmdFleetEmpties(['--runs-dir', root, '--human'], undefined, NOW)).toBe(0);
    const text = String(log.mock.calls[0]![0]).split('\n');
    expect(text[0]).toContain(`${LOGS.length + 3} empty finishes; empty rate`);
    expect(text[1]).toBe('Skipped 0 malformed rows; 0 result notes unavailable.');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdFleetEmpties(['--runs-dir'], undefined, NOW)).toBe(2);
    expect(await cmdFleetEmpties(['--runs-dir', root, '--runs-dir', root], undefined, NOW)).toBe(2);
  });

  it('adds the top three causes to fleet vitals', async () => {
    const root = await runsDir();
    const host = await readHostVitals(root, NOW);
    expect(host.emptyCauses).toEqual({ window_hours: 24, total: LOGS.length + 3,
      top: [{ cause: 'unknown', count: 4 }, { cause: 'sandbox_denied', count: 3 }, { cause: 'no_candidate', count: 2 }] });
  });
});
