import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  JOB_LATENCY_MAX_ITEMS,
  JOB_LATENCY_PHASE_MIN_MEASURED,
  JOB_LATENCY_PHASE_MIN_TOTAL_SECONDS,
  jobLatencyBacklogItems,
  selectJobLatencyPhases,
} from '../src/core/improve/job-latency-backlog.js';
import { discoverBacklog } from '../src/core/improve/discover.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';

const J = (o: Record<string, unknown>): string => JSON.stringify(o);
const BASE = Date.parse('2026-01-01T00:00:00.000Z');
const S = (sec: number): string => new Date(BASE + sec * 1000).toISOString();

/**
 * One job attempt's lifecycle boundary rows. Offsets (seconds from the
 * job's enqueue) are chosen so every phase clears both bars when ten
 * attempts are generated: queue_wait/checkout/model/publish_wait/ci/merge
 * each total 2400s per attempt and worker (launch→finish) totals 4800s.
 */
function jobRows(id: string, shiftSec: number): string[] {
  const at = (sec: number) => S(shiftSec + sec);
  return [
    J({ job: id, event: 'enqueue', ts: at(0) }),
    J({ job: id, event: 'launch', ts: at(2400) }),
    J({ job: id, event: 'checkout_complete', ts: at(4800) }),
    J({ job: id, event: 'finish', ts: at(7200) }),
    J({ job: id, event: 'publish', ts: at(9600) }),
    J({ job: id, event: 'ci_start', ts: at(9900) }),
    J({ job: id, event: 'ci_complete', ts: at(12300) }),
    J({ job: id, event: 'merged', ts: at(14700) }),
  ];
}

/** `count` attempts, each starting an hour after the previous (they overlap). */
function ledger(count: number): string {
  const rows: string[] = [];
  for (let i = 0; i < count; i++) rows.push(...jobRows(`RQ-JL-${i + 1}`, i * 3600));
  return rows.join('\n') + '\n';
}

describe('selectJobLatencyPhases', () => {
  const phase = (name: string, measured: number, total: number | null, missing = 0) => ({
    phase: name, measured_jobs: measured, missing_jobs: missing,
    total_seconds: total,
    fix_line: `fix ${name}`,
  });

  it('keeps only phases over both bars, sorted by recorded total wait', () => {
    const cells = selectJobLatencyPhases([
      phase('worker', 12, 50000),
      phase('model', 10, JOB_LATENCY_PHASE_MIN_TOTAL_SECONDS),
      phase('queue_wait', 10, JOB_LATENCY_PHASE_MIN_TOTAL_SECONDS - 1), // under total bar
      phase('ci', 9, 999999), // under measured bar
      phase('merge', 10, null), // unmeasured
      phase('checkout', 10, 30000),
    ]);
    expect(cells.map((c) => c.phase)).toEqual(['worker', 'checkout', 'model']);
    expect(cells[0]).toMatchObject({ measuredJobs: 12, totalSeconds: 50000, meanSeconds: 50000 / 12, fixLine: 'fix worker', lowerBound: false });
  });

  it('flags truncation as a lower bound', () => {
    const cells = selectJobLatencyPhases([phase('ci', 10, 40000)], true);
    expect(cells[0]!.lowerBound).toBe(true);
  });
});

describe('jobLatencyBacklogItems', () => {
  let home: string;
  let saved: { HOME?: string; ASHLR_HOME?: string; ASHLR_RUNS_DIR?: string };

  beforeEach(async () => {
    saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME, ASHLR_RUNS_DIR: process.env.ASHLR_RUNS_DIR };
    delete process.env.ASHLR_HOME;
    delete process.env.ASHLR_RUNS_DIR;
    home = await mkdtemp(join(tmpdir(), 'job-latency-backlog-'));
    process.env.HOME = home;
  });
  afterEach(async () => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    vi.restoreAllMocks();
    await rm(home, { recursive: true, force: true });
  });

  async function runsDir(name: string, text?: string): Promise<string> {
    const dir = join(home, name);
    await mkdir(join(dir, 'metrics'), { recursive: true });
    if (text !== undefined) await writeFile(join(dir, 'metrics', 'jobs.jsonl'), text);
    return dir;
  }

  it('emits one item per material phase and validates them', async () => {
    const dir = await runsDir('runs-full', ledger(JOB_LATENCY_PHASE_MIN_MEASURED));
    const items = await jobLatencyBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir });
    // worker totals 4800s/attempt; the other six total 2400s each.
    expect(items).toHaveLength(7);
    expect(items[0]!.id).toMatch(/^fleet-joblatency-worker-[0-9a-f]{16}$/);
    for (const item of items) {
      expect(validBacklogItem(item)).not.toBeNull();
      expect(item).toMatchObject({ priority: 3, repo: 'ashlrai/phantom', area: 'job-latency' });
      expect(item.id).toMatch(/^fleet-joblatency-[a-z_]+-[0-9a-f]{16}$/);
    }
    const phases = items.map((i) => i.id.split('-')[2]);
    expect(phases).toEqual(['worker', 'checkout', 'ci', 'merge', 'model', 'publish_wait', 'queue_wait']);
    const worker = items[0]!;
    expect(worker.title).toContain('worker slot');
    for (const s of [
      'worker', '13.3h', '10 measured job attempt', 'job-latency', 'no-change',
      'Profile the full worker slot',
    ]) expect(worker.prompt).toContain(s);
    const ci = items.find((i) => i.id.includes('ci-'))!;
    expect(ci.prompt).toContain('CI critical path');
  });

  it('emits nothing below the measured or total bars', async () => {
    // Fewer attempts than the measured bar.
    const few = await runsDir('runs-few', ledger(JOB_LATENCY_PHASE_MIN_MEASURED - 1));
    expect(await jobLatencyBacklogItems({ repo: 'ashlrai/phantom', runsDir: few })).toEqual([]);
    // Enough attempts but phases far under the total bar: shrink every span.
    const rows: string[] = [];
    for (let i = 0; i < 12; i++) {
      const b = i * 3600;
      rows.push(
        J({ job: `RQ-SMALL-${i}`, event: 'enqueue', ts: S(b) }),
        J({ job: `RQ-SMALL-${i}`, event: 'launch', ts: S(b + 30) }),
        J({ job: `RQ-SMALL-${i}`, event: 'finish', ts: S(b + 90) }),
        J({ job: `RQ-SMALL-${i}`, event: 'merged', ts: S(b + 120) }),
      );
    }
    const small = await runsDir('runs-small', rows.join('\n') + '\n');
    expect(await jobLatencyBacklogItems({ repo: 'ashlrai/phantom', runsDir: small })).toEqual([]);
  });

  it('emits nothing for a missing, empty or boundary-sparse ledger, or another repository', async () => {
    expect(await jobLatencyBacklogItems({ repo: 'ashlrai/phantom', runsDir: join(home, 'no-such') })).toEqual([]);
    const empty = await runsDir('runs-empty', '');
    expect(await jobLatencyBacklogItems({ repo: 'ashlrai/phantom', runsDir: empty })).toEqual([]);
    // One attempt only: measured_jobs=1 under the bar everywhere.
    const one = await runsDir('runs-one', ledger(1));
    expect(await jobLatencyBacklogItems({ repo: 'ashlrai/phantom', runsDir: one })).toEqual([]);

    const dir = await runsDir('runs-repo', ledger(JOB_LATENCY_PHASE_MIN_MEASURED));
    expect(await jobLatencyBacklogItems({ repo: 'ashlrai/other', runsDir: dir })).toEqual([]);
    expect(await jobLatencyBacklogItems({ repo: 'AshlrAI/Phantom', runsDir: dir })).toHaveLength(7);
  });

  it('states truncation as a lower bound in the prompt', async () => {
    const dir = await runsDir('runs-trunc');
    const pad = 'x'.repeat(17 * 1024 * 1024);
    await writeFile(join(dir, 'metrics', 'jobs.jsonl'), pad + '\n' + ledger(JOB_LATENCY_PHASE_MIN_MEASURED));
    const items = await jobLatencyBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir });
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => i.prompt.includes('lower bound'))).toBe(true);
  });

  it('honors the item limit', async () => {
    const dir = await runsDir('runs-limit', ledger(JOB_LATENCY_PHASE_MIN_MEASURED));
    const items = await jobLatencyBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, limit: 2 });
    expect(items).toHaveLength(2);
    expect(JOB_LATENCY_MAX_ITEMS).toBeGreaterThanOrEqual(7);
  });

  it('appends job-latency items through discovery and dedupes on refresh', async () => {
    const runs = join(home, '.ashlr-runs');
    await mkdir(join(runs, 'metrics'), { recursive: true });
    await writeFile(join(runs, 'metrics', 'jobs.jsonl'), ledger(JOB_LATENCY_PHASE_MIN_MEASURED));
    const savedRuns = process.env.ASHLR_RUNS_DIR;
    process.env.ASHLR_RUNS_DIR = runs;
    try {
      const greenGh = async (args: string[]) => {
        const p = args[4] ?? '';
        if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
        return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
      };
      const first = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
      const items = first.items.filter((i) => i.id.startsWith('fleet-joblatency-'));
      expect(items).toHaveLength(7);
      expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
      expect(appendUserBacklogItems(items)).toBe(7);
      const second = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
      expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('fleet-joblatency-')))).toBe(0);
      expect(readUserBacklogItems().filter((i) => i.id.startsWith('fleet-joblatency-'))).toHaveLength(7);
    } finally {
      if (savedRuns === undefined) delete process.env.ASHLR_RUNS_DIR;
      else process.env.ASHLR_RUNS_DIR = savedRuns;
    }
  });
});
