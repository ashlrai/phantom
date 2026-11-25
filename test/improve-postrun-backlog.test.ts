import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { discoverBacklog } from '../src/core/improve/discover.js';
import {
  foldPostrunRows,
  noPrClass,
  parsePostrunLog,
  postrunBacklogItems,
} from '../src/core/improve/postrun-backlog.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';

let home: string;
let saved: { HOME?: string; ASHLR_HOME?: string; ASHLR_RUNS_DIR?: string };
beforeEach(() => {
  saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME, ASHLR_RUNS_DIR: process.env.ASHLR_RUNS_DIR };
  delete process.env.ASHLR_HOME;
  delete process.env.ASHLR_RUNS_DIR;
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'improve-postrun-')));
  process.env.HOME = home;
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(home, { recursive: true, force: true });
});

const NOW = new Date('2026-11-23T12:00:00Z');
const pad = (n: number): string => String(n).padStart(2, '0');
/** dispatchd.log's local timestamp `days` before NOW (fractional hours via `hours`). */
const stamp = (days: number, hours = 0): string => {
  const d = new Date(NOW.getTime() - days * 86400_000 + hours * 3600_000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

const REPO = 'ashlrai/phantom';
const JOB = 'RQ-DVL-TEST-1';

/** One dispatchd.log line at `days` before NOW. */
const line = (days: number, body: string, hours = 0): string => `${stamp(days, hours)} ${body}`;
const postrun = (days: number, action: string, job = JOB, rest = '', hours = 0): string =>
  line(days, `POSTRUN_PR ${action} ${job}${rest === '' ? '' : ` ${rest}`}`, hours);
const spawnErr = (days: number, job = JOB, exc = 'OSError', hours = 0): string =>
  line(days, `postrun_pr err ${job} ${exc}`, hours);

const logText = (lines: string[]): string => `${lines.join('\n')}\n`;

const writeLog = (content: string | string[]): string => {
  const dir = path.join(home, 'runs');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'dispatchd.log');
  fs.writeFileSync(file, Array.isArray(content) ? logText(content) : content);
  return file;
};

/** Three pr-lookup-failed skips for one job across three UTC days — burns its spawn budget. */
const lookupSkipRows = (job = JOB): string[] => [
  postrun(1, 'skip', job, 'pr-lookup-failed (nothing published)'),
  postrun(2, 'skip', job, 'pr-lookup-failed (nothing published)'),
  postrun(4, 'skip', job, 'pr-lookup-failed (nothing published)'),
];

describe('parsePostrunLog', () => {
  it('parses every documented outcome kind and drops malformed lines', () => {
    const rows = parsePostrunLog(logText([
      'not a stamped line',
      stamp(1) + ' tick heartbeat',
      stamp(1) + ' POSTRUN_PR bogus RQ-X-1',
      stamp(1) + ' POSTRUN_PR skip',
      stamp(1) + ' POSTRUN_PR skip !bad off-switch',
      stamp(1) + ' POSTRUN_PR skip RQ-X-1 off-switch',
      stamp(1) + ' POSTRUN_PR skip RQ-X-1 no-job-record',
      stamp(1) + ' POSTRUN_PR skip RQ-X-1 repo-not-allowlisted',
      stamp(1) + ' POSTRUN_PR skip RQ-X-1 pr-lookup-failed (nothing published)',
      stamp(1) + ' POSTRUN_PR skip RQ-X-1 some-future-reason detail here',
      stamp(1) + ' POSTRUN_PR exists RQ-X-1 https://github.com/ashlrai/phantom/pull/42 (not republished)',
      stamp(1) + ' POSTRUN_PR publish RQ-X-1 no PR for masonwyatt23:codex-bridge/RQ-X-1; running publish.sh',
      stamp(1) + ' POSTRUN_PR error RQ-X-1 publish.sh TimeoutExpired',
      stamp(1) + ' POSTRUN_PR published RQ-X-1 https://github.com/ashlrai/phantom/pull/42',
      stamp(1) + ' POSTRUN_PR no-pr RQ-X-1 RESULT ABORT secret-shape',
      stamp(1) + ' postrun_pr err RQ-X-1 OSError',
    ]));
    expect(rows.map((r) => r.kind)).toEqual([
      'skip-off', 'skip-no-record', 'skip-repo', 'skip-lookup', 'skip-other',
      'exists', 'publish', 'error', 'published', 'no-pr', 'spawn-error',
    ]);
    expect(rows.every((r) => r.job === 'RQ-X-1')).toBe(true);
    expect(rows[3]!.detail).toBe('pr-lookup-failed (nothing published)');
    expect(rows[7]!.detail).toBe('TimeoutExpired');
    expect(rows[9]!.detail).toBe('RESULT ABORT secret-shape');
    expect(rows[10]!.detail).toBe('OSError');
    expect(rows[0]!.atMs).toBe(rows[1]!.atMs);
  });

  it('drops rows with unparseable timestamps or invalid job ids', () => {
    const rows = parsePostrunLog(logText([
      '2026-13-40 99:99:99 POSTRUN_PR error RQ-X-1 publish.sh OSError',
      stamp(1) + ' POSTRUN_PR error ../evil publish.sh OSError',
      stamp(1) + ' POSTRUN_PR error ',
    ]));
    expect(rows).toEqual([]);
  });
});

describe('noPrClass', () => {
  it('classifies the recorded RESULT prefix', () => {
    expect(noPrClass('RESULT ABORT secret-shape')).toBe('abort-secret-shape');
    expect(noPrClass('RESULT ABORT git-unsafe extra tokens')).toBe('abort-git-unsafe');
    expect(noPrClass('RESULT ABORT')).toBe('abort');
    expect(noPrClass('RESULT EMPTY')).toBe('empty');
    expect(noPrClass('no RESULT line')).toBe('no-result');
    expect(noPrClass(null)).toBe('no-result');
    expect(noPrClass('RESULT SKIP waiting')).toBe('other-result');
    expect(noPrClass('garbage')).toBe('unclassified');
  });
});

describe('foldPostrunRows', () => {
  it('counts designed outcomes as context and adverse skips per job', () => {
    const fold = foldPostrunRows(parsePostrunLog(logText([
      postrun(1, 'skip', JOB, 'off-switch'),
      postrun(1, 'skip', JOB, 'repo-not-allowlisted'),
      postrun(1, 'exists', JOB, 'https://github.com/ashlrai/phantom/pull/1 (not republished)'),
      postrun(1, 'publish', JOB, 'no PR for x; running publish.sh'),
      postrun(1, 'published', JOB, 'https://github.com/ashlrai/phantom/pull/2'),
      postrun(1, 'skip', 'RQ-OTHER-9', 'pr-lookup-failed (nothing published)'),
      postrun(2, 'skip', 'RQ-OTHER-9', 'pr-lookup-failed (nothing published)'),
    ])), NOW.getTime());
    const t = fold.attempts.get(JOB)!;
    expect(t.adverseSkips).toBe(0);
    expect(t.publish).toBe(1);
    expect(t.published).toBe(1);
    expect(t.exists).toBe(1);
    expect(fold.attempts.get('RQ-OTHER-9')!.adverseSkips).toBe(2);
    expect(fold.lookupFailed.rows).toBe(2);
    expect(fold.lookupFailed.jobs.has('RQ-OTHER-9')).toBe(true);
  });
});

describe('postrunBacklogItems', () => {
  it('turns a job whose spawn budget burned on lookup failures into exhausted + lookup-failed items', async () => {
    const items = await postrunBacklogItems({
      repo: REPO, logPath: writeLog(lookupSkipRows()), now: NOW,
    });
    expect(items).toHaveLength(2);
    const [exhausted, lookup] = items;
    expect(exhausted!.id).toMatch(/^postrun-exhausted-[0-9a-f]{16}$/);
    expect(lookup!.id).toMatch(/^postrun-lookup-failed-[0-9a-f]{16}$/);
    for (const item of items) {
      expect(validBacklogItem(item)).not.toBeNull();
      expect(item).toMatchObject({ priority: 3, repo: REPO, area: 'postrun-publish' });
      expect(item.prompt).toContain('dispatchd.log');
      expect(item.prompt).toContain('postrun_pr.py');
      expect(item.prompt).toContain('no-change');
    }
    expect(exhausted!.title).toContain(JOB);
    expect(exhausted!.prompt).toContain('spawn-consuming non-terminal');
    expect(exhausted!.prompt).toContain('three attempts');
    expect(lookup!.prompt).toContain("'pr-lookup-failed' skip(s)");
    expect(lookup!.prompt).toContain('1 distinct job(s)');
  });

  it('does not emit exhausted when a terminal outcome exists for the job', async () => {
    const items = await postrunBacklogItems({
      repo: REPO, now: NOW,
      logPath: writeLog([
        postrun(1, 'skip', JOB, 'pr-lookup-failed (nothing published)'),
        postrun(2, 'skip', JOB, 'no-job-record'),
        postrun(4, 'skip', JOB, 'pr-lookup-failed (nothing published)'),
        postrun(3, 'error', JOB, 'publish.sh TimeoutExpired'),
      ]),
    });
    expect(items.filter((i) => i.id.startsWith('postrun-exhausted-'))).toEqual([]);
    // The single terminal row is below every global bar; the two lookup
    // skips are below the three-row bar too.
    expect(items).toEqual([]);
  });

  it('counts orphaned publish markers toward exhaustion', async () => {
    const items = await postrunBacklogItems({
      repo: REPO, now: NOW,
      logPath: writeLog([
        postrun(1, 'publish', JOB, 'no PR for x; running publish.sh'),
        postrun(2, 'skip', JOB, 'pr-lookup-failed (nothing published)'),
        spawnErr(3, JOB, 'TimeoutExpired'),
        postrun(4, 'skip', JOB, 'pr-lookup-failed (nothing published)'),
      ]),
    });
    // consumed = 1 orphan publish + 2 lookup skips + 1 spawn error = 4 ≥ 3, no terminal.
    expect(items.some((i) => i.id.startsWith('postrun-exhausted-'))).toBe(true);
  });

  it('keeps exhaustion quiet below three consumed attempts', async () => {
    const items = await postrunBacklogItems({
      repo: REPO, now: NOW,
      logPath: writeLog(lookupSkipRows().slice(0, 2)),
    });
    expect(items.filter((i) => i.id.startsWith('postrun-exhausted-'))).toEqual([]);
  });

  it('aggregates recurring publish.sh errors globally by exception type', async () => {
    const items = await postrunBacklogItems({
      repo: REPO, now: NOW,
      logPath: writeLog([
        postrun(1, 'publish', 'RQ-A-1', 'no PR for x; running publish.sh'),
        postrun(1, 'error', 'RQ-A-1', 'publish.sh TimeoutExpired'),
        postrun(2, 'publish', 'RQ-B-2', 'no PR for x; running publish.sh'),
        postrun(2, 'error', 'RQ-B-2', 'publish.sh TimeoutExpired'),
        postrun(4, 'publish', 'RQ-C-3', 'no PR for x; running publish.sh'),
        postrun(4, 'error', 'RQ-C-3', 'publish.sh TimeoutExpired'),
      ]),
    });
    const errs = items.filter((i) => i.id.startsWith('postrun-publish-error-'));
    expect(errs).toHaveLength(1);
    expect(errs[0]!.prompt).toContain("'timeoutexpired' is the recurring exception");
    expect(errs[0]!.prompt).toContain('3 distinct job(s)');
    expect(errs[0]!.prompt).toContain('TimeoutExpired');
  });

  it('aggregates recurring no-pr outcomes globally by RESULT class', async () => {
    const items = await postrunBacklogItems({
      repo: REPO, now: NOW,
      logPath: writeLog([
        postrun(1, 'publish', 'RQ-A-1', 'no PR for x; running publish.sh'),
        postrun(1, 'no-pr', 'RQ-A-1', 'RESULT ABORT secret-shape'),
        postrun(2, 'publish', 'RQ-B-2', 'no PR for x; running publish.sh'),
        postrun(2, 'no-pr', 'RQ-B-2', 'RESULT ABORT secret-shape'),
        postrun(4, 'publish', 'RQ-C-3', 'no PR for x; running publish.sh'),
        postrun(4, 'no-pr', 'RQ-C-3', 'RESULT EMPTY'),
        postrun(5, 'publish', 'RQ-D-4', 'no PR for x; running publish.sh'),
        postrun(5, 'no-pr', 'RQ-D-4', 'RESULT ABORT secret-shape'),
      ]),
    });
    const aborts = items.filter((i) => i.id.startsWith('postrun-no-pr-') && i.prompt.includes('abort-secret-shape'));
    const empties = items.filter((i) => i.id.startsWith('postrun-no-pr-') && i.prompt.includes("'empty'"));
    expect(aborts).toHaveLength(1);
    expect(aborts[0]!.prompt).toContain('RESULT ABORT');
    expect(aborts[0]!.prompt).toContain('safety gate');
    expect(empties).toHaveLength(0); // 'empty' has only one row — below the bar
  });

  it('folds recurring lookup-failed skips globally across distinct jobs', async () => {
    const items = await postrunBacklogItems({
      repo: REPO, now: NOW,
      logPath: writeLog([
        postrun(1, 'skip', 'RQ-A-1', 'pr-lookup-failed (nothing published)'),
        postrun(1, 'skip', 'RQ-B-2', 'pr-lookup-failed (nothing published)'),
        postrun(3, 'skip', 'RQ-C-3', 'pr-lookup-failed (nothing published)'),
      ]),
    });
    const lookup = items.filter((i) => i.id.startsWith('postrun-lookup-failed-'));
    expect(lookup).toHaveLength(1);
    expect(lookup[0]!.prompt).toContain('3 distinct job(s)');
    expect(lookup[0]!.prompt).toContain('gh api');
  });

  it('folds recurring spawn failures, missing records and unknown skips globally', async () => {
    const items = await postrunBacklogItems({
      repo: REPO, now: NOW,
      logPath: writeLog([
        spawnErr(1, 'RQ-A-1'), spawnErr(2, 'RQ-B-2'), spawnErr(4, 'RQ-C-3'),
        postrun(1, 'skip', 'RQ-D-4', 'no-job-record'), postrun(2, 'skip', 'RQ-E-5', 'no-job-record'), postrun(4, 'skip', 'RQ-F-6', 'no-job-record'),
        postrun(1, 'skip', 'RQ-G-7', 'brand-new-reason'), postrun(2, 'skip', 'RQ-H-8', 'brand-new-reason'), postrun(4, 'skip', 'RQ-I-9', 'brand-new-reason'),
      ]),
    });
    expect(items.filter((i) => i.id.startsWith('postrun-spawn-error-'))).toHaveLength(1);
    expect(items.filter((i) => i.id.startsWith('postrun-record-missing-'))).toHaveLength(1);
    expect(items.filter((i) => i.id.startsWith('postrun-skip-other-'))).toHaveLength(1);
    expect(items).toHaveLength(3);
  });

  it('keeps global cells quiet below the row or day bar', async () => {
    const few = await postrunBacklogItems({
      repo: REPO, now: NOW,
      logPath: writeLog([
        postrun(1, 'skip', 'RQ-A-1', 'pr-lookup-failed (nothing published)'),
        postrun(3, 'skip', 'RQ-B-2', 'pr-lookup-failed (nothing published)'),
      ]),
    });
    expect(few).toEqual([]);
    const oneDay = await postrunBacklogItems({
      repo: REPO, now: NOW,
      logPath: writeLog([
        postrun(1, 'skip', 'RQ-A-1', 'pr-lookup-failed (nothing published)'),
        postrun(1, 'skip', 'RQ-B-2', 'pr-lookup-failed (nothing published)', 2),
        postrun(1, 'skip', 'RQ-C-3', 'pr-lookup-failed (nothing published)', 4),
      ]),
    });
    expect(oneDay).toEqual([]);
  });

  it('ignores designed outcomes entirely', async () => {
    const items = await postrunBacklogItems({
      repo: REPO, now: NOW,
      logPath: writeLog([
        postrun(1, 'skip', JOB, 'off-switch'),
        postrun(1, 'skip', JOB, 'repo-not-allowlisted'),
        postrun(1, 'exists', JOB, 'https://github.com/ashlrai/phantom/pull/9 (not republished)'),
        postrun(1, 'publish', JOB, 'no PR for x; running publish.sh'),
        postrun(1, 'published', JOB, 'https://github.com/ashlrai/phantom/pull/9'),
        postrun(3, 'skip', 'RQ-B-2', 'off-switch'),
        postrun(3, 'exists', 'RQ-B-2', 'https://github.com/ashlrai/phantom/pull/10 (not republished)'),
      ]),
    });
    expect(items).toEqual([]);
  });

  it('drops rows outside the 7-day window', async () => {
    const old = [
      postrun(10, 'skip', JOB, 'pr-lookup-failed (nothing published)'),
      postrun(11, 'skip', JOB, 'pr-lookup-failed (nothing published)'),
      postrun(12, 'skip', JOB, 'pr-lookup-failed (nothing published)'),
    ];
    expect(await postrunBacklogItems({ repo: REPO, logPath: writeLog(old), now: NOW })).toEqual([]);
  });

  it('emits only for the fleet repository', async () => {
    const file = writeLog(lookupSkipRows());
    expect(await postrunBacklogItems({ repo: 'ashlrai/lexicon', logPath: file, now: NOW })).toEqual([]);
    expect(await postrunBacklogItems({ repo: '', logPath: file, now: NOW })).toEqual([]);
    const items = await postrunBacklogItems({ repo: 'AshlrAI/Phantom', logPath: file, now: NOW });
    expect(items.length).toBeGreaterThan(0);
    expect(items[0]).toMatchObject({ repo: 'AshlrAI/Phantom' });
  });

  it('yields nothing for a missing or unreadable log', async () => {
    expect(await postrunBacklogItems({ repo: REPO, logPath: path.join(home, 'no-such.log'), now: NOW })).toEqual([]);
    const dir = path.join(home, 'runs');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'dispatchd.log'), 'garbage\nnot stamped\n');
    expect(await postrunBacklogItems({ repo: REPO, now: NOW })).toEqual([]);
  });

  it('derives stable ids so a refresh re-adds nothing', async () => {
    const file = writeLog(lookupSkipRows());
    const first = await postrunBacklogItems({ repo: REPO, logPath: file, now: NOW });
    const second = await postrunBacklogItems({ repo: REPO, logPath: file, now: NOW });
    expect(first.length).toBeGreaterThan(0);
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
    const grown = writeLog([...lookupSkipRows(), postrun(5, 'skip', JOB, 'pr-lookup-failed (nothing published)')]);
    const third = await postrunBacklogItems({ repo: REPO, logPath: grown, now: NOW });
    expect(third.map((i) => i.id)).toEqual(first.map((i) => i.id));
  });

  it('scrubs secret-shaped text out of recorded details before it reaches a prompt', async () => {
    const token = `ghp_${'a'.repeat(36)}`;
    const items = await postrunBacklogItems({
      repo: REPO, now: NOW,
      logPath: writeLog([
        postrun(1, 'skip', 'RQ-A-1', `brand-new ${token}`),
        postrun(2, 'skip', 'RQ-B-2', `brand-new ${token}`),
        postrun(4, 'skip', 'RQ-C-3', 'brand-new other'),
      ]),
    });
    const other = items.filter((i) => i.id.startsWith('postrun-skip-other-'));
    expect(other).toHaveLength(1);
    expect(other[0]!.prompt).not.toContain(token);
    expect(other[0]!.prompt).toContain('[REDACTED]');
  });

  it('reads the default dispatchd.log under the runs dir', async () => {
    process.env.ASHLR_RUNS_DIR = path.join(home, 'runs');
    writeLog(lookupSkipRows());
    const items = await postrunBacklogItems({ repo: REPO, now: NOW });
    expect(items.length).toBeGreaterThan(0);
    expect(items.some((i) => i.id.startsWith('postrun-exhausted-'))).toBe(true);
  });

  it('honours the item limit', async () => {
    const rows: string[] = [
      ...lookupSkipRows(),
      spawnErr(1, 'RQ-A-1'), spawnErr(2, 'RQ-B-2'), spawnErr(4, 'RQ-C-3'),
      postrun(1, 'skip', 'RQ-D-4', 'no-job-record'), postrun(2, 'skip', 'RQ-E-5', 'no-job-record'), postrun(4, 'skip', 'RQ-F-6', 'no-job-record'),
      postrun(1, 'skip', 'RQ-G-7', 'brand-new'), postrun(2, 'skip', 'RQ-H-8', 'brand-new'), postrun(4, 'skip', 'RQ-I-9', 'brand-new'),
    ];
    const all = await postrunBacklogItems({ repo: REPO, logPath: writeLog(rows), now: NOW });
    expect(all.length).toBeGreaterThan(1);
    const one = await postrunBacklogItems({ repo: REPO, logPath: writeLog(rows), now: NOW, limit: 1 });
    expect(one).toHaveLength(1);
    expect(one[0]!.id).toBe(all[0]!.id);
  });

  it('appends postrun items through discovery and dedupes on refresh', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    try {
      process.env.ASHLR_RUNS_DIR = path.join(home, 'runs');
      writeLog(lookupSkipRows());
      const greenGh = async (args: string[]) => {
        const p = args[4] ?? '';
        if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
        return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
      };
      const first = await discoverBacklog(REPO, { gh: greenGh });
      const postrun = first.items.filter((i) => i.id.startsWith('postrun-'));
      expect(postrun.length).toBeGreaterThan(0);
      expect(postrun.some((i) => i.id.startsWith('postrun-exhausted-'))).toBe(true);
      expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
      expect(appendUserBacklogItems(postrun)).toBe(postrun.length);
      const second = await discoverBacklog(REPO, { gh: greenGh });
      expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('postrun-')))).toBe(0);
      expect(readUserBacklogItems().filter((i) => i.id.startsWith('postrun-'))).toHaveLength(postrun.length);
    } finally {
      vi.useRealTimers();
    }
  });
});
