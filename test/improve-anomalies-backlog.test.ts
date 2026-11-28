import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ANOMALY_MAX_ITEMS,
  ANOMALY_MIN_DAYS,
  ANOMALY_MIN_JOBS,
  ANOMALY_MIN_ROWS,
  anomaliesBacklogItems,
  foldAnomalyRows,
  parseAnomalyRows,
  type AnomalyRow,
} from '../src/core/improve/anomalies-backlog.js';
import { discoverBacklog } from '../src/core/improve/discover.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const J = (o: Record<string, unknown>): string => JSON.stringify(o);
/** Fixed clock so UTC-day bucketing is deterministic in any host timezone. */
const NOW = Date.parse('2026-11-26T12:00:00.000Z');
const CUTOFF = NOW - 7 * DAY;
const pad = (n: number): string => String(n).padStart(2, '0');
/** The writer's own ts shape: host-local 'YYYY-MM-DD HH:MM:SS', no zone. */
const localTs = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};
const row = (job: string, kind: string, minAgo: number, detail?: string): string =>
  J({ ts: localTs(NOW - minAgo * 60_000), job, kind, ...(detail === undefined ? {} : { detail }) });
const anomaly = (job: string, kind: AnomalyRow['kind'], minAgo: number, detail: string | null = null): AnomalyRow => ({
  atMs: NOW - minAgo * 60_000,
  utcDay: new Date(NOW - minAgo * 60_000).toISOString().slice(0, 10),
  job,
  kind,
  detail,
  idleMinutes: detail !== null ? Number(/log idle (\d+)m/.exec(detail)?.[1] ?? NaN) || null : null,
});

describe('parseAnomalyRows', () => {
  it('keeps validated rows of every kind and skips everything else', () => {
    const text = [
      row('RQ-A1', 'no_progress', 60, 'log idle 130m'),
      row('RQ-A2', 'reap_rate', 120, '11 reaps in 1h'),
      row('RQ-A3', 'launch_rate', 180, '7 launches in 1h'),
      row('RQ-BAD', 'bogus_kind', 60),                                  // unknown kind
      row('bad id!', 'no_progress', 60),                                // id outside JID shape
      J({ ts: localTs(NOW - 60 * 60_000), job: 'RQ-NOTS' }),             // missing kind
      J({ job: 'RQ-NOKIND', kind: 'no_progress' }),                     // missing ts
      J({ ts: 'not a timestamp', job: 'RQ-BADTS', kind: 'no_progress' }),
      row('RQ-OLD', 'no_progress', 8 * 24 * 60),                        // outside window
      row('RQ-FUT', 'no_progress', -30),                                // future stamp
      'not json at all',
      '',
    ].join('\n');
    const parsed = parseAnomalyRows(text, CUTOFF, NOW);
    expect(parsed.map((r) => [r.job, r.kind])).toEqual([
      ['RQ-A1', 'no_progress'],
      ['RQ-A2', 'reap_rate'],
      ['RQ-A3', 'launch_rate'],
    ]);
    expect(parsed[0]!.detail).toBe('log idle 130m');
    expect(parsed[0]!.idleMinutes).toBe(130);
    expect(parsed[0]!.atMs).toBe(NOW - 60 * 60_000);
    expect(parsed[1]!.idleMinutes).toBeNull();
  });

  it('parses the writer\'s zone-less local timestamp as local time', () => {
    const ms = NOW - 2 * HOUR;
    const parsed = parseAnomalyRows(row('RQ-T1', 'no_progress', 120), CUTOFF, NOW);
    expect(parsed).toHaveLength(1);
    // localTs stripped milliseconds; the parse lands on the same second.
    expect(Math.abs(parsed[0]!.atMs - (ms - (ms % 1000)))).toBeLessThan(2000);
  });
});

describe('foldAnomalyRows', () => {
  it('tracks per-(kind, job) cells and per-kind fleet tallies inside the window', () => {
    const rows = [
      anomaly('RQ-J1', 'no_progress', 60, 'log idle 100m'),
      anomaly('RQ-J1', 'no_progress', 25 * 60, 'log idle 1600m'),
      anomaly('RQ-J2', 'no_progress', 30 * 60, 'log idle 200m'),
      anomaly('RQ-J1', 'reap_rate', 40 * 60, '12 reaps in 1h'),
      anomaly('RQ-J9', 'no_progress', 9 * 24 * 60),                     // outside window
    ];
    const fold = foldAnomalyRows(rows, NOW);
    expect(fold.jobs.size).toBe(3);
    const j1 = fold.jobs.get('no_progress|RQ-J1')!;
    expect(j1.rows).toBe(2);
    expect(j1.days.size).toBe(2);
    expect(j1.maxIdleMinutes).toBe(1600);
    const np = fold.kinds.get('no_progress')!;
    expect(np.jobs.size).toBe(2);
    expect(np.rows).toBe(3);
    const rr = fold.kinds.get('reap_rate')!;
    expect(rr.jobs.size).toBe(1);
    expect(fold.kinds.has('launch_rate')).toBe(false);
  });
});

describe('anomaliesBacklogItems', () => {
  let home: string;
  let saved: { HOME?: string; ASHLR_HOME?: string; ASHLR_RUNS_DIR?: string };

  beforeEach(async () => {
    saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME, ASHLR_RUNS_DIR: process.env.ASHLR_RUNS_DIR };
    delete process.env.ASHLR_HOME;
    delete process.env.ASHLR_RUNS_DIR;
    home = await mkdtemp(join(tmpdir(), 'anomalies-backlog-'));
    process.env.HOME = home;
  });
  afterEach(async () => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    vi.restoreAllMocks();
    await rm(home, { recursive: true, force: true });
  });

  /** A runs dir: the anomaly journal plus an optional jobs.jsonl. */
  async function runsDir(name: string, files: {
    anomalies?: string[];
    ledger?: string[];
  }): Promise<string> {
    const dir = join(home, name);
    await mkdir(join(dir, 'metrics'), { recursive: true });
    if (files.anomalies !== undefined) await writeFile(join(dir, 'metrics', 'anomalies.jsonl'), files.anomalies.join('\n') + '\n');
    if (files.ledger !== undefined) await writeFile(join(dir, 'metrics', 'jobs.jsonl'), files.ledger.join('\n') + '\n');
    return dir;
  }
  const launchRow = (job: string, minAgo: number, lane = 'devin', repo = 'phantom'): string =>
    J({ event: 'launch', job, lane, repo, ts: new Date(NOW - minAgo * 60_000).toISOString() });

  it('emits a job cell and a kind cell for recurring no_progress evidence', async () => {
    // RQ-J1: 3 rows across 3 UTC days → job cell. RQ-J2/RQ-J3: 2 rows each → kind cell only (3 distinct jobs).
    const dir = await runsDir('runs-np', {
      anomalies: [
        row('RQ-J1', 'no_progress', 60, 'log idle 130m'),
        row('RQ-J1', 'no_progress', 25 * 60, 'log idle 1600m'),
        row('RQ-J1', 'no_progress', 49 * 60, 'log idle 3000m'),
        row('RQ-J2', 'no_progress', 30 * 60, 'log idle 200m'),
        row('RQ-J2', 'no_progress', 54 * 60, 'log idle 900m'),
        row('RQ-J3', 'no_progress', 36 * 60, 'log idle 250m'),
        row('RQ-J3', 'no_progress', 60 * 60, 'log idle 950m'),
      ],
      ledger: [
        launchRow('RQ-J1', 70 * 60, 'devin'),
        launchRow('RQ-J2', 70 * 60, 'claude'),
        launchRow('RQ-J3', 70 * 60, 'devin'),
      ],
    });
    const items = await anomaliesBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW) });
    expect(items).toHaveLength(2);
    const kindItem = items.find((i) => i.id.includes('-fleet-'))!;
    const jobItem = items.find((i) => !i.id.includes('-fleet-'))!;
    expect(kindItem.title).toContain('3 fleet jobs');
    expect(kindItem.prompt).toContain("'no_progress'");
    expect(kindItem.prompt).toContain('RQ-J1');
    expect(jobItem.title).toContain('RQ-J1');
    expect(jobItem.title).toContain('log silence');
    expect(jobItem.prompt).toContain('3000 minutes');
    expect(jobItem.prompt).toContain('anomalies.jsonl');
    expect(jobItem.prompt).toContain('no-change');
    expect(jobItem.prompt).toContain('devin');
    expect(items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    expect(items.every((i) => i.priority === 3 && i.repo === 'ashlrai/phantom' && i.area === 'fleet-anomalies')).toBe(true);
  });

  it('emits a churn prompt for reap_rate and launch_rate job cells', async () => {
    const dir = await runsDir('runs-rate', {
      anomalies: [
        row('RQ-R1', 'reap_rate', 60, '12 reaps in 1h'),
        row('RQ-R1', 'reap_rate', 25 * 60, '15 reaps in 1h'),
        row('RQ-R1', 'reap_rate', 49 * 60, '11 reaps in 1h'),
        row('RQ-L1', 'launch_rate', 30 * 60, '8 launches in 1h'),
        row('RQ-L1', 'launch_rate', 54 * 60, '7 launches in 1h'),
        row('RQ-L1', 'launch_rate', 78 * 60, '9 launches in 1h'),
      ],
      ledger: [launchRow('RQ-R1', 80 * 60, 'codex-cmp'), launchRow('RQ-L1', 80 * 60, 'codex-cmp')],
    });
    const items = await anomaliesBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW) });
    // Two job cells + one kind cell (reap_rate has only 1 distinct job → no kind cell; launch_rate same).
    expect(items).toHaveLength(2);
    const reap = items.find((i) => i.title.includes('RQ-R1'))!;
    const launch = items.find((i) => i.title.includes('RQ-L1'))!;
    expect(reap.title).toContain('reap storms');
    expect(reap.prompt).toContain('breaker.json');
    expect(reap.prompt).toContain('12 reaps in 1h');
    expect(launch.title).toContain('launch storms');
    expect(launch.prompt).toContain('launches in 1h');
  });

  it('emits nothing below the recurring bars', async () => {
    // 3 rows but a single UTC day — the days bar fails.
    const sameDay = await runsDir('runs-sameday', {
      anomalies: [row('RQ-S1', 'no_progress', 60), row('RQ-S1', 'no_progress', 120), row('RQ-S1', 'no_progress', 180)],
    });
    expect(await anomaliesBacklogItems({ repo: 'ashlrai/phantom', runsDir: sameDay, now: new Date(NOW) })).toEqual([]);
    // 2 rows across 2 days — the rows bar fails.
    const thin = await runsDir('runs-thin', {
      anomalies: [row('RQ-S2', 'no_progress', 60), row('RQ-S2', 'no_progress', 25 * 60)],
    });
    expect(await anomaliesBacklogItems({ repo: 'ashlrai/phantom', runsDir: thin, now: new Date(NOW) })).toEqual([]);
    // Kind cell needs 3 distinct jobs; 2 jobs × 3 days stays silent.
    const pair = await runsDir('runs-pair', {
      anomalies: [
        row('RQ-P1', 'no_progress', 60), row('RQ-P1', 'no_progress', 25 * 60), row('RQ-P1', 'no_progress', 49 * 60),
        row('RQ-P2', 'no_progress', 30 * 60), row('RQ-P2', 'no_progress', 54 * 60), row('RQ-P2', 'no_progress', 78 * 60),
      ],
    });
    const items = await anomaliesBacklogItems({ repo: 'ashlrai/phantom', runsDir: pair, now: new Date(NOW) });
    expect(items).toHaveLength(2); // the two job cells, no kind cell
    expect(ANOMALY_MIN_ROWS).toBe(3);
    expect(ANOMALY_MIN_DAYS).toBe(2);
    expect(ANOMALY_MIN_JOBS).toBe(3);
  });

  it('emits nothing for missing journals, another repository, or empty evidence', async () => {
    const empty = await runsDir('runs-empty', {});
    expect(await anomaliesBacklogItems({ repo: 'ashlrai/phantom', runsDir: empty, now: new Date(NOW) })).toEqual([]);
    expect(await anomaliesBacklogItems({ repo: 'ashlrai/phantom', runsDir: join(home, 'no-such'), now: new Date(NOW) })).toEqual([]);

    const dir = await runsDir('runs-repo', {
      anomalies: [
        row('RQ-J1', 'no_progress', 60), row('RQ-J1', 'no_progress', 25 * 60), row('RQ-J1', 'no_progress', 49 * 60),
        row('RQ-J2', 'no_progress', 30 * 60), row('RQ-J2', 'no_progress', 54 * 60), row('RQ-J3', 'no_progress', 60 * 60),
      ],
    });
    expect(await anomaliesBacklogItems({ repo: 'ashlrai/other', runsDir: dir, now: new Date(NOW) })).toEqual([]);
    expect(await anomaliesBacklogItems({ repo: 'AshlrAI/Phantom', runsDir: dir, now: new Date(NOW) })).not.toEqual([]);
  });

  it('a missing jobs ledger leaves lanes unknown but never suppresses anomaly evidence', async () => {
    const dir = await runsDir('runs-nolanes', {
      anomalies: [
        row('RQ-J1', 'no_progress', 60), row('RQ-J1', 'no_progress', 25 * 60), row('RQ-J1', 'no_progress', 49 * 60),
      ],
    });
    const items = await anomaliesBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW) });
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toContain('RQ-J1');
    expect(items[0]!.prompt).toContain("'unknown'");
  });

  it('reads the journalPath override and attributes against its own runs dir', async () => {
    const dir = await runsDir('runs-override', {
      anomalies: [
        row('RQ-J1', 'no_progress', 60), row('RQ-J1', 'no_progress', 25 * 60), row('RQ-J1', 'no_progress', 49 * 60),
      ],
      ledger: [launchRow('RQ-J1', 70 * 60, 'agy')],
    });
    const journalPath = join(dir, 'metrics', 'anomalies.jsonl');
    const items = await anomaliesBacklogItems({ repo: 'ashlrai/phantom', journalPath, now: new Date(NOW) });
    expect(items).toHaveLength(1);
    expect(items[0]!.prompt).toContain('agy');
  });

  it('states truncation as a lower bound in the prompt', async () => {
    const dir = await runsDir('runs-trunc', {
      anomalies: [
        row('RQ-J1', 'no_progress', 60), row('RQ-J1', 'no_progress', 25 * 60), row('RQ-J1', 'no_progress', 49 * 60),
      ],
    });
    const padLine = 'x'.repeat(600 * 1024);
    const journal = join(dir, 'metrics', 'anomalies.jsonl');
    const { readFile } = await import('node:fs/promises');
    const existing = await readFile(journal, 'utf8');
    await writeFile(journal, padLine + '\n' + existing);
    const items = await anomaliesBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW) });
    expect(items).toHaveLength(1);
    expect(items[0]!.prompt).toContain('lower bound');
  });

  it('derives stable ids so a refresh re-adds nothing and honours the limit', async () => {
    const dir = await runsDir('runs-stable', {
      anomalies: [
        row('RQ-J1', 'no_progress', 60), row('RQ-J1', 'no_progress', 25 * 60), row('RQ-J1', 'no_progress', 49 * 60),
        row('RQ-J2', 'no_progress', 30 * 60), row('RQ-J2', 'no_progress', 54 * 60), row('RQ-J2', 'no_progress', 78 * 60),
        row('RQ-J3', 'no_progress', 36 * 60), row('RQ-J3', 'no_progress', 60 * 60), row('RQ-J3', 'no_progress', 84 * 60),
      ],
    });
    const opts = { repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW) };
    const first = await anomaliesBacklogItems(opts);
    const second = await anomaliesBacklogItems(opts);
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
    expect(first.length).toBeLessThanOrEqual(ANOMALY_MAX_ITEMS);
    expect(await anomaliesBacklogItems({ ...opts, limit: 1 })).toHaveLength(1);
  });

  it('appends anomaly items through discovery and dedupes on refresh', async () => {
    const runs = join(home, '.ashlr-runs');
    await mkdir(join(runs, 'metrics'), { recursive: true });
    await writeFile(join(runs, 'metrics', 'anomalies.jsonl'), [
      row('RQ-D1', 'no_progress', 60), row('RQ-D1', 'no_progress', 25 * 60), row('RQ-D1', 'no_progress', 49 * 60),
      row('RQ-D2', 'no_progress', 30 * 60), row('RQ-D2', 'no_progress', 54 * 60), row('RQ-D3', 'no_progress', 60 * 60),
    ].join('\n') + '\n');
    await writeFile(join(runs, 'metrics', 'jobs.jsonl'),
      [launchRow('RQ-D1', 70 * 60), launchRow('RQ-D2', 70 * 60), launchRow('RQ-D3', 70 * 60)].join('\n') + '\n');
    const greenGh = async (args: string[]) => {
      const p = args[4] ?? '';
      if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
    };
    const first = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    const anomalyItems = first.items.filter((i) => i.id.startsWith('fleet-anomaly-'));
    expect(anomalyItems.length).toBeGreaterThanOrEqual(1);
    expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    expect(appendUserBacklogItems(anomalyItems)).toBe(anomalyItems.length);
    const second = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('fleet-anomaly-')))).toBe(0);
    expect(readUserBacklogItems().filter((i) => i.id.startsWith('fleet-anomaly-'))).toHaveLength(anomalyItems.length);
  });
});
