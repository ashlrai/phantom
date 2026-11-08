import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { cmdFleetMergeBatch, type FleetMergeBatchDeps } from '../src/cli/fleet-merge-batch.js';
import {
  MERGE_BATCH_SCHEMA,
  parseMergeBatchPrs,
  planMergeBatches,
  type MergeBatchPr,
} from '../src/core/fleet/merge-batch.js';

const NOW = new Date('2026-11-07T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

const pr = (number: number, overrides: Partial<MergeBatchPr> = {}): MergeBatchPr => ({
  number,
  title: `PR ${number}`,
  headRef: `bridge/job-${number}`,
  isDraft: false,
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  createdAt: hoursAgo(100 - number),
  updatedAt: hoursAgo(10),
  files: [],
  ...overrides,
});

const ghRow = (number: number, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  number,
  title: `PR ${number}`,
  url: `https://github.com/ashlrai/phantom/pull/${number}`,
  headRefName: `bridge/job-${number}`,
  isDraft: false,
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  createdAt: hoursAgo(100 - number),
  updatedAt: hoursAgo(10),
  files: [],
  ...overrides,
});

const plan = (prs: MergeBatchPr[]) => planMergeBatches({ prs, repo: 'ashlrai/phantom', now: NOW });

describe('parseMergeBatchPrs', () => {
  it('parses a raw gh pr list array and normalizes file paths', () => {
    const parsed = parseMergeBatchPrs([
      ghRow(1, { files: [{ path: 'src/a.ts' }, { path: './src/b.ts' }, { path: '../evil' }, 'junk'] }),
      ghRow(2),
    ]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.kind).toBe('gh-pr-list');
    expect(parsed.prs).toHaveLength(2);
    expect(parsed.prs[0]).toMatchObject({ number: 1, files: ['src/a.ts', 'src/b.ts'] });
  });

  it('parses a merge-backlog read envelope ({v:1, items})', () => {
    const parsed = parseMergeBatchPrs({
      v: 1, repo: 'ashlrai/phantom', generatedAt: NOW.toISOString(), source: 'ok',
      counts: { mergeState: {}, actions: {} },
      items: [
        { number: 7, title: 'x', headRef: 'b7', updatedAt: hoursAgo(2), mergeStateStatus: 'DIRTY', isDraft: false, files: ['src/x.ts'] },
        { number: 8, title: 'y', headRef: 'b8', updatedAt: hoursAgo(3), mergeStateStatus: 'CLEAN', isDraft: true, files: ['src/y.ts'] },
      ],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.kind).toBe('merge-backlog');
    expect(parsed.repo).toBe('ashlrai/phantom');
    expect(parsed.prs[0]).toMatchObject({ number: 7, mergeable: 'CONFLICTING', files: ['src/x.ts'] });
    expect(parsed.prs[1]).toMatchObject({ number: 8, isDraft: true });
  });

  it('carries the envelope upstream state so a failed read is not a fake-clean plan', () => {
    const failed = parseMergeBatchPrs({ v: 1, repo: 'ashlrai/phantom', source: 'gh-failed', items: [] });
    expect(failed).toMatchObject({ ok: true, upstream: 'gh-failed', prs: [] });
    const hygiene = parseMergeBatchPrs({ schema: 'fleet.pr-hygiene.v1', items: [], reads: { open: 'failed' } });
    expect(hygiene).toMatchObject({ ok: true, upstream: 'failed' });
  });

  it('parses a fleet.pr-hygiene.v1 report and reads its conflicted flag', () => {
    const parsed = parseMergeBatchPrs({
      schema: 'fleet.pr-hygiene.v1', v: 1, repo: 'ashlrai/phantom', generatedAt: NOW.toISOString(),
      items: [
        { number: 3, title: 'a', headRef: 'b3', isDraft: false, mergeStateStatus: 'DIRTY', createdAt: hoursAgo(9), updatedAt: hoursAgo(1), files: ['src/a.ts'], flags: ['conflicted'] },
        { number: 4, title: 'b', headRef: 'b4', isDraft: false, mergeStateStatus: 'BEHIND', createdAt: hoursAgo(8), updatedAt: hoursAgo(1), files: ['src/b.ts'], flags: ['behind'] },
      ],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.kind).toBe('pr-hygiene');
    expect(parsed.prs[0]!.mergeable).toBe('CONFLICTING');
    expect(parsed.prs[1]!.mergeable).toBe('UNKNOWN');
  });

  it('counts unreadable rows and collapses duplicate numbers to the first sighting', () => {
    const parsed = parseMergeBatchPrs([
      ghRow(5, { title: 'first' }),
      ghRow(5, { title: 'second' }),
      { number: 'x' },
      null,
      ghRow(6),
    ]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.unreadable).toBe(2);
    expect(parsed.duplicates).toBe(1);
    expect(parsed.prs.map(p => [p.number, p.title])).toEqual([[5, 'first'], [6, 'PR 6']]);
  });

  it.each([null, 42, 'x', {}, { items: 'no' }, { schema: 'x' }])('rejects a non-snapshot %j', raw => {
    const parsed = parseMergeBatchPrs(raw);
    expect(parsed.ok).toBe(false);
  });
});

describe('planMergeBatches', () => {
  it('puts disjoint PRs in independent batches that can merge in any order', () => {
    const result = plan([
      pr(1, { files: ['src/a.ts'] }),
      pr(2, { files: ['src/b.ts'] }),
      pr(3, { files: ['docs/c.md'] }),
    ]);
    expect(result.counts).toMatchObject({ open: 3, batches: 3, independent: 3, serial: 0, overlapEdges: 0, expectedRebases: 0 });
    expect(result.order).toEqual([1, 2, 3]);
    for (const batch of result.batches) {
      expect(batch.kind).toBe('independent');
      expect(batch.conflictRisk.level).toBe('low');
      expect(batch.prs[0]!.rebase).toBe('none');
    }
  });

  it('serializes a star: leaves merge clean, the hub pays one rebase', () => {
    // Hub touches f1,f2,f3; each leaf touches one of them plus its own file —
    // leaves share nothing with each other.
    const result = plan([
      pr(1, { files: ['f1.ts', 'f2.ts', 'f3.ts'], createdAt: hoursAgo(5) }),
      pr(2, { files: ['f1.ts', 'own2.ts'] }),
      pr(3, { files: ['f2.ts', 'own3.ts'] }),
      pr(4, { files: ['f3.ts', 'own4.ts'] }),
    ]);
    expect(result.counts).toMatchObject({ batches: 1, serial: 1, overlapEdges: 3, expectedRebases: 1 });
    const batch = result.batches[0]!;
    expect(batch.kind).toBe('serial');
    const hub = batch.prs.find(p => p.number === 1)!;
    expect(hub.wave).toBe('rebase');
    expect(hub.rebase).toBe('expected');
    expect(hub.overlaps).toEqual([2, 3, 4]);
    for (const n of [2, 3, 4]) {
      expect(batch.prs.find(p => p.number === n)!.wave).toBe('clean');
    }
    expect(batch.order).toEqual([2, 3, 4, 1]);
  });

  it('serializes a clique: only one PR merges clean, the rest rebase once each', () => {
    const result = plan([
      pr(1, { files: ['shared.ts', 'a.ts'] }),
      pr(2, { files: ['shared.ts', 'b.ts'] }),
      pr(3, { files: ['shared.ts', 'c.ts'] }),
    ]);
    expect(result.counts).toMatchObject({ overlapEdges: 3, expectedRebases: 2 });
    const batch = result.batches[0]!;
    expect(batch.order[0]).toBe(1); // FIFO: oldest PR keeps the clean slot on a tie
    expect(batch.order.slice(1).sort()).toEqual([2, 3]);
    expect(batch.prs.filter(p => p.wave === 'clean')).toHaveLength(1);
    expect(batch.conflictRisk.level).not.toBe('low');
  });

  it('never credits an already-conflicted or behind PR to the clean wave', () => {
    const result = plan([
      pr(1, { files: ['s.ts', 'a.ts'] }),
      pr(2, { files: ['s.ts', 'b.ts'] }),
      pr(3, { files: ['s.ts', 'c.ts'], mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }),
      pr(4, { files: ['s.ts', 'd.ts'], mergeStateStatus: 'BEHIND' }),
    ]);
    const batch = result.batches[0]!;
    expect(batch.prs.filter(p => p.wave === 'clean')).toHaveLength(1);
    expect(batch.prs.find(p => p.number === 3)).toMatchObject({ wave: 'rebase', rebase: 'already-required' });
    expect(batch.prs.find(p => p.number === 4)).toMatchObject({ wave: 'rebase', rebase: 'already-required' });
    // The conflicted PR orders after the clean rebase-wave member.
    expect(batch.order.indexOf(3)).toBeGreaterThan(batch.order.indexOf(2));
  });

  it('orders a draft last inside the rebase wave', () => {
    const result = plan([
      pr(1, { files: ['s.ts'] }),
      pr(2, { files: ['s.ts'] }),
      pr(3, { files: ['s.ts'], isDraft: true, mergeStateStatus: 'CLEAN' }),
    ]);
    const batch = result.batches[0]!;
    expect(batch.order[0]).toBe(1);
    expect(batch.order.at(-1)).toBe(3);
  });

  it('orders the clean wave FIFO by creation time', () => {
    const result = plan([
      pr(1, { files: ['hub1.ts', 'hub2.ts'], createdAt: hoursAgo(1) }),
      pr(2, { files: ['hub1.ts', 'x.ts'], createdAt: hoursAgo(50) }),
      pr(3, { files: ['hub2.ts', 'y.ts'], createdAt: hoursAgo(40) }),
    ]);
    const batch = result.batches[0]!;
    expect(batch.order).toEqual([2, 3, 1]);
  });

  it('marks a PR without file data as an unmeasured independent batch', () => {
    const result = plan([pr(1, { files: [] }), pr(2, { files: ['a.ts'] })]);
    const blind = result.batches.find(batch => batch.order[0] === 1)!;
    expect(blind.evidence).toBe('no-file-data');
    expect(blind.conflictRisk.reasons).toContain('no-file-data');
    expect(result.counts.withFileData).toBe(1);
  });

  it('reports shared and hot files inside a serial batch', () => {
    const result = plan([
      pr(1, { files: ['CHANGELOG.md', 'a.ts'] }),
      pr(2, { files: ['CHANGELOG.md', 'b.ts'] }),
      pr(3, { files: ['CHANGELOG.md', 'c.ts'] }),
    ]);
    const batch = result.batches[0]!;
    expect(batch.sharedFiles).toEqual(['CHANGELOG.md']);
    expect(batch.hotFiles).toEqual(['CHANGELOG.md']);
    expect(batch.conflictRisk.reasons).toContain('hot-file-fan-in:3');
  });

  it('scores a clique riskier than a same-size star', () => {
    const clique = plan([1, 2, 3].map(n => pr(n, { files: ['s.ts', `${n}.ts`] }))).batches[0]!;
    const star = plan([
      pr(1, { files: ['f1.ts', 'f2.ts'] }),
      pr(2, { files: ['f1.ts', 'a.ts'] }),
      pr(3, { files: ['f2.ts', 'b.ts'] }),
    ]).batches[0]!;
    expect(clique.conflictRisk.score).toBeGreaterThan(star.conflictRisk.score);
  });

  it('sorts batches safest first and flattens the global order', () => {
    const result = plan([
      pr(1, { files: ['s.ts', 'a.ts'] }),   // serial batch with 2
      pr(2, { files: ['s.ts', 'b.ts'] }),
      pr(3, { files: ['solo.ts'] }),        // independent
    ]);
    expect(result.batches[0]!.kind).toBe('independent');
    expect(result.batches[1]!.kind).toBe('serial');
    expect(result.order).toEqual([3, 1, 2]);
  });
});

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface RunResult { code: number; out: string; err: string }

async function run(
  args: string[],
  opts: { stdinText?: string | null; files?: Record<string, string> } = {},
): Promise<RunResult> {
  let out = '';
  let err = '';
  const deps: FleetMergeBatchDeps = {
    stdin: Readable.from(opts.stdinText === null || opts.stdinText === undefined ? [] : [opts.stdinText]),
    stdinIsTty: opts.stdinText === undefined || opts.stdinText === null,
    root: '/runs',
    now: () => NOW,
    stdout: text => { out += text; },
    stderr: text => { err += text; },
  };
  if (opts.files) {
    deps.readText = async (path: string) => {
      if (path in opts.files!) return opts.files![path]!;
      throw new Error('ENOENT');
    };
  } else {
    deps.readText = async () => { throw new Error('ENOENT'); };
  }
  const code = await cmdFleetMergeBatch(args, deps);
  return { code, out, err };
}

const OPEN_PRS = JSON.stringify([
  ghRow(1, { files: [{ path: 's.ts' }, { path: 'a.ts' }] }),
  ghRow(2, { files: [{ path: 's.ts' }, { path: 'b.ts' }] }),
  ghRow(3, { files: [{ path: 'solo.ts' }] }),
]);

describe('phm fleet merge-batch', () => {
  it('plans a piped gh pr list page on stdin', async () => {
    const result = await run(['--json'], { stdinText: OPEN_PRS });
    expect(result.code).toBe(0);
    const report = JSON.parse(result.out);
    expect(report.schema).toBe(MERGE_BATCH_SCHEMA);
    expect(report.input).toMatchObject({ kind: 'gh-pr-list', source: 'stdin', state: 'ok' });
    expect(report.counts).toMatchObject({ open: 3, batches: 2, serial: 1, independent: 1 });
    expect(report.order).toEqual([3, 1, 2]);
  });

  it('reads --input <file> ahead of stdin and the state file', async () => {
    const result = await run(['--json', '--input', '/tmp/prs.json'], {
      files: { '/tmp/prs.json': OPEN_PRS, '/runs/fleet/open-prs.json': '[]' },
    });
    expect(result.code).toBe(0);
    const report = JSON.parse(result.out);
    expect(report.input).toMatchObject({ source: 'input-file', path: '/tmp/prs.json' });
    expect(report.counts.open).toBe(3);
  });

  it('falls back to the <root>/fleet/open-prs.json state file on a TTY', async () => {
    const result = await run(['--json'], { stdinText: null, files: { '/runs/fleet/open-prs.json': OPEN_PRS } });
    expect(result.code).toBe(0);
    const report = JSON.parse(result.out);
    expect(report.input).toMatchObject({ source: 'state-file', path: '/runs/fleet/open-prs.json' });
  });

  it('exits 1 with an honest input.state when no snapshot exists', async () => {
    const result = await run(['--json'], { stdinText: null });
    expect(result.code).toBe(1);
    const report = JSON.parse(result.out);
    expect(report.schema).toBe(MERGE_BATCH_SCHEMA);
    expect(report.input.state).toBe('missing');
    expect(report.batches).toEqual([]);
    expect(report.error).toContain('open-prs.json');
  });

  it('exits 1 on malformed JSON and on a non-snapshot shape', async () => {
    const bad = await run(['--json'], { stdinText: 'not json{' });
    expect(bad.code).toBe(1);
    expect(JSON.parse(bad.out).input.state).toBe('malformed');

    const wrong = await run(['--json'], { stdinText: '{"foo": 1}' });
    expect(wrong.code).toBe(1);
    expect(JSON.parse(wrong.out).input.state).toBe('malformed');
  });

  it('labels the plan with --repo when the snapshot has none', async () => {
    const result = await run(['--json', '--repo', 'ashlrai/phantom'], { stdinText: OPEN_PRS });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out).repo).toBe('ashlrai/phantom');
  });

  it('exits 1 when the snapshot envelope says its upstream read failed', async () => {
    const degraded = JSON.stringify({ v: 1, repo: 'ashlrai/phantom', source: 'gh-failed', items: [] });
    const result = await run(['--json'], { stdinText: degraded });
    expect(result.code).toBe(1);
    const report = JSON.parse(result.out);
    expect(report.input.upstream).toBe('gh-failed');
    expect(report.counts.open).toBe(0);
  });

  it('keeps an envelope repo over the --repo flag', async () => {
    const envelope = JSON.stringify({ v: 1, repo: 'ashlrai/other', items: [] });
    const result = await run(['--json', '--repo', 'ashlrai/phantom'], { stdinText: envelope });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out).repo).toBe('ashlrai/other');
  });

  it('prints a human-readable batch listing without --json', async () => {
    const result = await run([], { stdinText: OPEN_PRS });
    expect(result.code).toBe(0);
    expect(result.out).toContain('3 open PRs → 2 batch(es)');
    expect(result.out).toContain('B1');
    expect(result.out).toContain('#1');
  });

  it('exits 2 on bad usage and 0 on --help', async () => {
    expect((await run(['--bogus'], { stdinText: OPEN_PRS })).code).toBe(2);
    expect((await run(['--repo'], { stdinText: OPEN_PRS })).code).toBe(2);
    expect((await run(['--input'], { stdinText: OPEN_PRS })).code).toBe(2);
    const help = await run(['--help'], { stdinText: OPEN_PRS });
    expect(help.code).toBe(0);
    expect(help.out).toContain('Usage: phm fleet merge-batch');
  });
});
