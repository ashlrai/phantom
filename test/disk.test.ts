import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import {
  classifyWorktree,
  cmdDisk,
  formatDiskReport,
  parseJobLedger,
  readDiskReport,
  type DiskDeps,
} from '../src/cli/disk.js';

const NOW = Date.parse('2026-10-02T12:00:00Z');
const FIXTURE = join(__dirname, 'fixtures', 'disk');
const WT = join(FIXTURE, 'wt');
const RUNS = join(FIXTURE, 'runs');
const TMP = join(FIXTURE, 'tmp');

const jobsText = [
  { job: 'RQ-MERGED-A', event: 'finish', ts: '2026-10-01T00:00:00Z' },
  { job: 'RQ-MERGED-A', event: 'outcome', state: 'MERGED', ts: '2026-10-01T00:05:00Z' },
  { job: 'RQ-OPEN-B', event: 'outcome', state: 'OPEN', ts: '2026-10-01T01:00:00Z' },
  { job: 'RQ-EMPTY-E', event: 'finish', ts: '2026-10-01T00:00:00Z', empty: true },
  { job: 'RQ-KEPT-C', event: 'finish', ts: '2026-10-01T00:00:00Z' },
  { job: 'RQ-KEPT-C', event: 'outcome', state: 'MERGED', ts: '2026-10-01T00:05:00Z' },
  { job: 'RQ-FRESH-F', event: 'finish', ts: '2026-10-02T11:30:00Z' },
  { job: 'RQ-FRESH-F', event: 'outcome', state: 'MERGED', ts: '2026-10-02T11:31:00Z' },
].map(row => JSON.stringify(row)).join('\n') + '\n';

/** Injected dir listing: a missing key is ENOENT; 'THROW' is an unreadable root. */
const dirs = (map: Record<string, string[]>): NonNullable<DiskDeps['listDirs']> =>
  (path: string) => {
    if (map[path] === undefined) throw Object.assign(new Error(`missing ${path}`), { code: 'ENOENT' });
    if (map[path]!.includes('THROW')) throw new Error('unreadable');
    return map[path]!;
  };
const sizes = (map: Record<string, number>): NonNullable<DiskDeps['measure']> =>
  (dir: string) => ({ bytes: map[dir] ?? 0, complete: map[dir] !== undefined });
const healthyJobs = (text = jobsText): NonNullable<DiskDeps['readJobs']> =>
  () => ({ state: 'healthy', text });

const base = (extra: DiskDeps = {}): DiskDeps => ({
  now: NOW,
  wtRoot: '/wt',
  runsRoot: '/runs',
  tmpRoot: '/tmp-root',
  listDirs: dirs({
    '/wt': ['RQ-MERGED-A', 'RQ-OPEN-B', 'RQ-KEPT-C', 'guardian-x', '.hidden'],
    '/runs/wt': ['RQ-EMPTY-E', 'RQ-FRESH-F'],
    '/runs/quarantine': ['RQ-Q-1'],
    '/tmp-root': ['vwt-aa11bb', 'mwt-22cc33', 'scratch-notes'],
  }),
  measure: sizes({
    '/wt/RQ-MERGED-A': 3_000_000_000,
    '/wt/RQ-OPEN-B': 5_000_000_000,
    '/wt/RQ-KEPT-C': 1_000_000_000,
    '/runs/wt/RQ-EMPTY-E': 500_000_000,
    '/runs/wt/RQ-FRESH-F': 200_000_000,
    '/runs/quarantine/RQ-Q-1': 2_000_000_000,
    '/tmp-root/vwt-aa11bb': 400_000_000,
    '/tmp-root/mwt-22cc33': 200_000_000,
  }),
  readJobs: healthyJobs(),
  readPins: () => ({ paths: ['/wt/RQ-KEPT-C'], valid: true }),
  kept: (dir: string) => dir === '/wt/RQ-KEPT-C',
  freeBytes: () => 412_000_000_000,
  ...extra,
});

async function run(argv: string[], deps: DiskDeps) {
  const logs: string[] = [];
  const errors: string[] = [];
  const code = await cmdDisk(argv, { ...deps, output: { log: s => logs.push(s), error: s => errors.push(s) } });
  return { code, logs, errors };
}

describe('parseJobLedger', () => {
  it('keeps the last outcome and finish rows per job and skips torn lines', () => {
    const ledger = parseJobLedger(
      'not json\n' +
      '{"event":"outcome","job":"RQ-1","state":"OPEN"}\n' +
      '{"event":"outcome","job":"RQ-1","state":"MERGED"}\n' +
      '{"event":"finish","job_id":"RQ-1","ts":"2026-10-01T00:00:00Z"}\n' +
      '{"event":"publish","job":"RQ-2","state":"MERGED"}\n' +
      '{"event":"outcome","id":"RQ-3","outcome":"closed"}\n',
    );
    expect(ledger.get('RQ-1')).toEqual({ state: 'merged', finishMs: Date.parse('2026-10-01T00:00:00Z'), finishEmpty: false });
    expect(ledger.has('RQ-2')).toBe(false); // publish rows are not lifecycle rows
    expect(ledger.get('RQ-3')?.state).toBe('closed');
  });
});

describe('classifyWorktree', () => {
  it('matches wt-reap lifecycle words', () => {
    expect(classifyWorktree({ state: 'merged', finishEmpty: false })).toBe('merged');
    expect(classifyWorktree({ state: 'open', finishEmpty: false })).toBe('open');
    expect(classifyWorktree({ state: null, finishEmpty: true })).toBe('empty');
    expect(classifyWorktree({ state: 'closed', finishEmpty: false })).toBe('none');
    expect(classifyWorktree(undefined)).toBe('none');
  });
});

describe('readDiskReport', () => {
  it('marks merged and empty worktrees over an hour old reclaimable, never open, new, none or pinned', async () => {
    const r = await readDiskReport(base());
    const byName = new Map([...(r.worktrees ?? []), ...(r.runsWorktrees ?? [])].map(e => [e.name, e]));
    expect(byName.get('RQ-MERGED-A')).toMatchObject({ state: 'merged', ageHours: 36, reclaimable: true });
    expect(byName.get('RQ-EMPTY-E')).toMatchObject({ state: 'empty', ageHours: 36, reclaimable: true });
    expect(byName.get('RQ-FRESH-F')).toMatchObject({ state: 'merged', ageHours: 0.5, reclaimable: false });
    expect(byName.get('RQ-OPEN-B')).toMatchObject({ state: 'open', reclaimable: false });
    expect(byName.get('RQ-KEPT-C')).toMatchObject({ state: 'merged', kept: true, reclaimable: false });
    // Guardians and hidden folders are never listed.
    expect(byName.has('guardian-x')).toBe(false);
    expect(byName.has('.hidden')).toBe(false);
    expect(r.totals).toMatchObject({ worktrees: 5, reclaimable: 2, reclaimableBytes: 3_500_000_000, complete: true });
  });

  it('lists biggest first and never lets an unread ledger mark anything reclaimable', async () => {
    const r = await readDiskReport(base({ readJobs: () => ({ state: 'degraded', text: '' }) }));
    expect(r.jobsSource).toBe('degraded');
    expect(r.worktrees!.map(e => e.name)).toEqual(['RQ-OPEN-B', 'RQ-MERGED-A', 'RQ-KEPT-C']);
    expect(r.worktrees!.every(e => e.state === 'unknown' && !e.reclaimable)).toBe(true);
    expect(r.totals.reclaimable).toBe(0);
  });

  it('keeps every worktree when the pin file cannot be trusted', async () => {
    const r = await readDiskReport(base({
      readPins: () => ({ paths: [], valid: false }),
      kept: () => true, // isKeptWorktree fails closed the same way
    }));
    expect(r.pinsValid).toBe(false);
    expect(r.worktrees!.every(e => e.kept && !e.reclaimable)).toBe(true);
    expect(r.totals.reclaimable).toBe(0);
  });

  it('reports null for an unreadable root and empty for a missing one', async () => {
    const r = await readDiskReport(base({
      listDirs: dirs({ '/wt': ['THROW'], '/runs/wt': [], '/runs/quarantine': [], '/tmp-root': [] }),
    }));
    expect(r.worktrees).toBeNull();
    expect(r.runsWorktrees).toEqual([]);
    expect(r.totals.complete).toBe(false);
    expect(formatDiskReport(r).join('\n')).toContain('unknown (folder unreadable)');
  });

  it('flags partial sizes instead of faking an exact total', async () => {
    const r = await readDiskReport(base({ measure: () => ({ bytes: 100, complete: false }) }));
    expect(r.worktrees!.every(e => !e.complete)).toBe(true);
    expect(r.totals.complete).toBe(false);
    expect(formatDiskReport(r).join('\n')).toContain('measured so far');
  });

  it('counts quarantine and only temp-named leftovers', async () => {
    const r = await readDiskReport(base());
    expect(r.quarantine).toEqual({ bytes: 2_000_000_000, dirs: 1, complete: true });
    expect(r.temp).toEqual({ bytes: 600_000_000, dirs: 2, complete: true });
  });
});

describe('readDiskReport on the repo fixture', () => {
  it('runs the real lister, measurer and ledger reader end to end', async () => {
    const r = await readDiskReport({
      now: NOW,
      wtRoot: WT,
      runsRoot: RUNS,
      tmpRoot: TMP,
      readPins: () => ({ paths: [join(WT, 'RQ-KEPT-C')], valid: true }),
      freeBytes: () => 412_000_000_000,
    });
    const byName = new Map([...(r.worktrees ?? []), ...(r.runsWorktrees ?? [])].map(e => [e.name, e]));
    expect(byName.get('RQ-MERGED-A')).toMatchObject({ state: 'merged', complete: true, reclaimable: true });
    expect(byName.get('RQ-MERGED-A')!.bytes).toBeGreaterThan(0);
    expect(byName.get('RQ-OPEN-B')).toMatchObject({ state: 'open', reclaimable: false });
    expect(byName.get('RQ-KEPT-C')).toMatchObject({ kept: true, reclaimable: false });
    expect(byName.get('RQ-FRESH-F')).toMatchObject({ state: 'merged', reclaimable: false });
    expect(byName.get('RQ-EMPTY-E')).toMatchObject({ state: 'empty', reclaimable: true });
    expect(byName.has('guardian-x')).toBe(false);
    expect(r.quarantine).toMatchObject({ dirs: 1, complete: true });
    expect(r.temp).toMatchObject({ dirs: 2, complete: true });
    expect(r.totals.reclaimable).toBe(2);
  });
});

describe('formatDiskReport', () => {
  it('prints plain words and names the removal command once', async () => {
    const text = formatDiskReport(await readDiskReport(base()));
    expect(text[0]).toBe('disk report — reads only, deletes nothing');
    expect(text).toContain('free now: 412 GB');
    expect(text.join('\n')).toContain('RQ-MERGED-A: 3 GB — merged 36 hours ago — safe to clean up');
    expect(text.join('\n')).toContain('RQ-OPEN-B: 5 GB — still open, kept');
    expect(text.join('\n')).toContain('RQ-KEPT-C: 1 GB — merged 36 hours ago — pinned, kept');
    expect(text.join('\n')).toContain('RQ-FRESH-F: 0.2 GB — merged 0.5 hours ago — kept, too new');
    expect(text.join('\n')).toContain('safe to reclaim: 3.5 GB in 2 worktrees');
    expect(text.join('\n')).toContain('ashlr fleet worktree-stale --apply');
    expect(text.join('\n')).toContain('ashlr fleet wt-reap --apply');
  });
});

describe('cmdDisk', () => {
  it('--json prints one parseable sanitized report', async () => {
    const { code, logs } = await run(['--json'], base());
    expect(code).toBe(0);
    const report = JSON.parse(logs[0]!);
    expect(report.schema).toBe('disk.v1');
    expect(report.totals.reclaimableBytes).toBe(3_500_000_000);
    expect(report.pinsValid).toBe(true);
  });

  it('honors --wt-dir/--runs-dir/--tmp-dir overrides', async () => {
    const seen: string[] = [];
    const listDirs: DiskDeps['listDirs'] = p => { seen.push(p); return []; };
    const { code, logs } = await run(['--wt-dir', '/x', '--runs-dir', '/y', '--tmp-dir', '/z'], base({ listDirs }));
    expect(code).toBe(0);
    expect(seen).toEqual(['/x', '/y/wt', '/y/quarantine', '/z']);
    expect(logs.join('\n')).toContain('job worktrees under /x: none');
  });

  it('rejects bad arguments and prints help', async () => {
    expect((await run(['--nope'], base())).code).toBe(2);
    expect((await run(['--json', '--json'], base())).code).toBe(2);
    expect((await run(['extra'], base())).code).toBe(2);
    expect((await run(['--wt-dir', 'relative/path'], base())).code).toBe(2);
    expect((await run(['--wt-dir'], base())).code).toBe(2);
    const help = await run(['--help'], base());
    expect(help.code).toBe(0);
    expect(help.logs[0]).toContain('phm disk');
    expect(help.logs[0]).toContain('Deletes nothing');
  });

  it('always exits 0 for a report — a view, never a gate', async () => {
    const { code } = await run([], base({ readJobs: () => { throw new Error('boom'); } }));
    expect(code).toBe(0);
  });
});
