// RQ-PHX-RECUTCORES1C164: pins the behavior recovered by the recut of #4797
// (RQ-MERGE-THROUGHPUT-1): `phm fleet merge-plan`, the read-only
// merge-throughput scoreboard and drain plan fed by one gh pr list snapshot.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { cmdFleetMergePlan } from '../src/cli/fleet-merge-plan.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
import {
  diffMergePlans,
  parseMergePlanPrs,
  planMergePlan,
  supersededOpenPrs,
  type MergePlanPr,
  type MergePlanReport,
} from '../src/core/fleet/merge-plan.js';

const NOW = new Date('2026-11-10T18:00:00Z');
const at = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

function ghRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 1,
    title: 'bridge: RQ-JOB-1',
    headRefName: 'codex-bridge/RQ-JOB-1',
    isDraft: false,
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    createdAt: at(10),
    updatedAt: at(1),
    state: 'OPEN',
    ...over,
  };
}
const rows = (list: Record<string, unknown>[]) => JSON.parse(JSON.stringify(list)) as unknown[];

describe('recut #4797: fleet merge-plan scoreboard on fresh master', () => {
  it('partitions a gh pr list page and reports windowed throughput honestly', () => {
    const parsed = parseMergePlanPrs(rows([
      ghRow({ number: 1, mergeStateStatus: 'BEHIND' }),
      ghRow({ number: 2, state: 'MERGED', createdAt: at(4), mergedAt: at(1) }),
      ghRow({ number: 3, state: 'CLOSED', closedAt: at(2) }),
      ghRow({ number: 4, state: 'MERGED', createdAt: '2026-10-01T00:00:00Z', mergedAt: '2026-10-01T01:00:00Z' }),
    ]));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.prs.map(p => p.state)).toEqual(['OPEN', 'MERGED', 'CLOSED', 'MERGED']);
    const report = planMergePlan(parsed, { repo: 'ashlrai/phantom', hours: 24, now: NOW });
    expect(report.schema).toBe('fleet.merge-plan.v1');
    expect(report.counts).toMatchObject({ open: 1, merged_rows: 2, closed_rows: 1 });
    expect(report.throughput).toMatchObject({ merges_in_window: 1, closes_in_window: 1 });
    expect(report.throughput?.oldest_merge_observed).toBe('2026-10-01T01:00:00Z');
    expect(report.actions.rebase_candidates.count).toBe(1);
  });

  it('proposes closes only among open PRs via rework title grammar, drafts excluded', () => {
    const mk = (number: number, over: Partial<MergePlanPr> = {}): MergePlanPr => ({
      ...ghRow({ number }),
      state: 'OPEN', mergedAt: null, closedAt: null, body: '', hasBody: false,
      checks: [], autoMerge: null, headSha: null, files: [], url: null,
      ...over,
    } as unknown as MergePlanPr);
    const prs = [
      mk(10),
      mk(11, { title: 'bridge: RQ-FIX-PHANTOM-10' }),
      mk(12, { isDraft: true, title: 'bridge: RQ-REBASE-PHANTOM-10' }),
    ];
    const { proposals, families } = supersededOpenPrs(prs, 'ashlrai/phantom');
    expect(families).toBe(1);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ number: 10, supersededBy: 11, kind: 'origin' });
    expect(proposals[0]!.reason).toContain('#11');
  });

  it('diffMergePlans returns deltas only against a real previous report', () => {
    const parsed = parseMergePlanPrs(rows([ghRow({ number: 1 })]));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const report = planMergePlan(parsed, { repo: null, now: NOW });
    expect(diffMergePlans({ schema: 'other' }, report)).toBeNull();
    const delta = diffMergePlans({ schema: 'fleet.merge-plan.v1', generatedAt: 'x', counts: { open: 4 } }, report);
    expect(delta).toMatchObject({ open: -3, merges_per_hour: null });
  });

  it('runs the real CLI path over --input --json and fails honestly on bad input', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'recut-c164-merge-plan-'));
    try {
      const snapshot = join(dir, 'prs.json');
      await writeFile(snapshot, JSON.stringify(rows([
        ghRow({ number: 1, mergeStateStatus: 'BEHIND' }),
        ghRow({ number: 2, title: 'bridge: RQ-FIX-PHANTOM-1' }),
      ])));
      const stdout: string[] = [];
      const code = await cmdFleetMergePlan(['--input', snapshot, '--repo', 'ashlrai/phantom', '--json'], {
        stdout: t => stdout.push(t),
        stderr: () => {},
        stdin: Readable.from([]),
        stdinIsTty: false,
        now: () => NOW,
      });
      expect(code).toBe(0);
      const report = JSON.parse(stdout.join('')) as MergePlanReport;
      expect(report.schema).toBe('fleet.merge-plan.v1');
      expect(report.counts.open).toBe(2);
      expect(report.actions.superseded_open).toBe(1);
      const missing = await cmdFleetMergePlan(['--input', '/nonexistent/recut-c164.json', '--json'], {
        stdout: t => stdout.push(t), stderr: () => {},
        stdin: Readable.from([]), stdinIsTty: false, now: () => NOW,
      });
      expect(missing).toBe(1);
      expect(await cmdFleetMergePlan(['--bogus'], { stdout: () => {}, stderr: () => {} })).toBe(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('is registered as a fleet subcommand', async () => {
    const loader = FLEET_SUBCOMMAND_LOADERS['merge-plan'];
    expect(loader).toBeDefined();
    const mod = await loader!();
    expect(typeof mod.cmdFleetMergePlan).toBe('function');
  });
});
