import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetMergePlan } from '../src/cli/fleet-merge-plan.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
import {
  diffMergePlans,
  failureCauses,
  parseMergePlanPrs,
  planMergePlan,
  reworkEdges,
  supersededOpenPrs,
  type MergePlanPr,
  type MergePlanReport,
} from '../src/core/fleet/merge-plan.js';

const NOW = new Date('2026-11-10T18:00:00Z');
const at = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

let rowId = 0;
function ghRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  rowId += 1;
  return {
    number: rowId,
    title: `bridge: RQ-JOB-${rowId}`,
    headRefName: `codex-bridge/RQ-JOB-${rowId}`,
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

async function run(args: string[], deps: Parameters<typeof cmdFleetMergePlan>[1] = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await cmdFleetMergePlan(args, {
    stdout: t => stdout.push(t), stderr: t => stderr.push(t),
    stdin: Readable.from([]), stdinIsTty: false,
    now: () => NOW,
    ...deps,
  });
  return { code, out: stdout.join(''), err: stderr.join('') };
}

afterEach(() => vi.restoreAllMocks());

it('parses a gh pr list page into open/merged/closed partitions', () => {
  const parsed = parseMergePlanPrs(rows([
    ghRow({ number: 1 }),
    ghRow({ number: 2, state: 'MERGED', mergedAt: at(2) }),
    ghRow({ number: 3, state: 'CLOSED', closedAt: at(3) }),
    ghRow({ number: 4, mergedAt: at(5), closedAt: at(5) }),
    { bogus: true },
  ]));
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  expect(parsed.prs.map(p => [p.number, p.state])).toEqual([[1, 'OPEN'], [2, 'MERGED'], [3, 'CLOSED'], [4, 'MERGED']]);
  expect(parsed.unreadable).toBe(1);
});

it('reports merges and closes per hour plus ttm inside the window only', () => {
  const parsed = parseMergePlanPrs(rows([
    ghRow({ number: 1 }),
    ghRow({ number: 2, state: 'MERGED', createdAt: at(3), mergedAt: at(1) }),
    ghRow({ number: 3, state: 'MERGED', createdAt: at(4), mergedAt: at(2) }),
    ghRow({ number: 4, state: 'MERGED', createdAt: '2026-10-01T00:00:00Z', mergedAt: '2026-10-01T01:00:00Z' }),
    ghRow({ number: 5, state: 'CLOSED', closedAt: at(6) }),
  ]));
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  const report = planMergePlan(parsed, { repo: 'ashlrai/phantom', hours: 24, now: NOW });
  expect(report.counts.open).toBe(1);
  expect(report.throughput).toMatchObject({ merges_in_window: 2, merges_per_hour: 0.08, closes_in_window: 1 });
  expect(report.throughput?.ttm_minutes?.n).toBe(2);
  expect(report.throughput?.oldest_merge_observed).toBe('2026-10-01T01:00:00Z');
});

it('leaves throughput null on an open-only page and states unknown without merge-state evidence', () => {
  const parsed = parseMergePlanPrs(rows([ghRow({ number: 1, mergeStateStatus: undefined }), ghRow({ number: 2, mergeStateStatus: undefined })]));
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  expect(parsed.hasStateEvidence).toBe(false);
  const report = planMergePlan(parsed, { repo: null, now: NOW });
  expect(report.throughput).toBeNull();
  expect(report.open.states_evidence).toBe('unknown');
  expect(report.actions.rebase_candidates.state).toBe('unknown');
});

it('ranks failure causes and names failing checks', () => {
  const prs = [
    { ...ghRow({ number: 1, mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }), state: 'OPEN', mergedAt: null, closedAt: null, body: '', hasBody: false, checks: [], autoMerge: null, headSha: null },
    { ...ghRow({ number: 2, mergeStateStatus: 'BEHIND' }), state: 'OPEN', mergedAt: null, closedAt: null, body: '', hasBody: false, checks: [{ name: 'Merge Gate', conclusion: 'FAILURE' }], autoMerge: null, headSha: null },
    { ...ghRow({ number: 3, mergeStateStatus: 'BLOCKED' }), state: 'OPEN', mergedAt: null, closedAt: null, body: '', hasBody: false, checks: [{ name: 'Merge Gate', conclusion: 'FAILURE' }, { name: 'CodeRabbit', conclusion: 'SUCCESS' }], autoMerge: null, headSha: null },
  ] as unknown as MergePlanPr[];
  const { causes, checks } = failureCauses(prs);
  const byName = Object.fromEntries(causes.map(c => [c.cause, c.prs]));
  expect(byName['conflict']).toBe(1);
  expect(byName['behind']).toBe(1);
  expect(byName['check-failure']).toBe(2);
  expect(checks[0]).toMatchObject({ cause: 'check-failure:Merge Gate', prs: 2 });
});

it('detects open-vs-open superseded duplicates from every evidence grammar', () => {
  const mk = (number: number, over: Partial<MergePlanPr> = {}): MergePlanPr => ({
    ...ghRow({ number, title: `bridge: X-${number}` }),
    state: 'OPEN', mergedAt: null, closedAt: null, body: '', hasBody: false,
    checks: [], autoMerge: null, headSha: null, files: [], url: null,
    ...over,
  } as unknown as MergePlanPr);
  const prs = [
    mk(100),
    mk(101, { title: 'bridge: RQ-FIX-PHANTOM-100' }),
    mk(102, { title: 'bridge: RQ-REBASE-PHANTOM-100' }),
    mk(103, { title: 'bridge: RQ-RECUT-PHANTOM-101-abcdef1' }),
    mk(104, { body: 'Supersedes #102 and recut handoff: PR #103', hasBody: true }),
    mk(105, { body: 'superseded by #104', hasBody: true }),
    mk(106, { isDraft: true, title: 'bridge: RQ-FIX-PHANTOM-105' }),
    mk(107, { body: 'I fetched pull/999 and compared #998 — incidental mentions', hasBody: true }),
  ];
  const { edges, closedRefs } = reworkEdges(prs, 'ashlrai/phantom');
  expect(edges.map(e => `${e.reworker}->${e.origin}:${e.evidence}`).sort()).toEqual([
    '101->100:title-fix', '102->100:title-rebase', '103->101:title-recut',
    '104->102:body-supersedes', '104->103:body-handoff', '104->105:body-superseded-by',
  ].sort());
  expect(closedRefs).toBe(0);
  const { proposals, families } = supersededOpenPrs(prs, 'ashlrai/phantom');
  expect(families).toBe(1);
  const byNumber = new Map(proposals.map(p => [p.number, p]));
  expect([...byNumber.keys()].sort((a, b) => a - b)).toEqual([100, 101, 102, 103, 105]);
  expect(byNumber.get(100)).toMatchObject({ supersededBy: 104, kind: 'origin' });
  expect(byNumber.get(101)).toMatchObject({ supersededBy: 104, kind: 'stale-rework' });
  expect(byNumber.get(103)).toMatchObject({ supersededBy: 104, kind: 'stale-rework' });
  expect(byNumber.get(105)).toMatchObject({ supersededBy: 104 });
  expect(byNumber.get(100)!.reason).toContain('#104');
});

it('keeps closed-origin references out of proposals', () => {
  const mk = (number: number, over: Partial<MergePlanPr> = {}): MergePlanPr => ({
    ...ghRow({ number }), state: 'OPEN', mergedAt: null, closedAt: null, body: '', hasBody: false,
    checks: [], autoMerge: null, headSha: null, files: [], url: null, ...over,
  } as unknown as MergePlanPr);
  const { closedRefs } = reworkEdges([mk(200, { title: 'bridge: RQ-FIX-PHANTOM-199' })], 'ashlrai/phantom');
  expect(closedRefs).toBe(1);
  expect(supersededOpenPrs([mk(200, { title: 'bridge: RQ-FIX-PHANTOM-199' })], 'ashlrai/phantom').proposals).toEqual([]);
});

it('CLI emits the scoreboard from a piped snapshot and honours --previous', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'merge-plan-'));
  try {
    const snapshot = join(dir, 'prs.json');
    await writeFile(snapshot, JSON.stringify(rows([
      ghRow({ number: 1, mergeStateStatus: 'BEHIND' }),
      ghRow({ number: 2, title: 'bridge: RQ-FIX-PHANTOM-1' }),
      ghRow({ number: 3, state: 'MERGED', createdAt: at(4), mergedAt: at(1) }),
    ])));
    const first = await run(['--input', snapshot, '--repo', 'ashlrai/phantom', '--json'], { prompts: async () => new Map() });
    expect(first.code).toBe(0);
    const report = JSON.parse(first.out) as MergePlanReport;
    expect(report.schema).toBe('fleet.merge-plan.v1');
    expect(report.counts.open).toBe(2);
    expect(report.throughput?.merges_in_window).toBe(1);
    expect(report.actions.superseded_open).toBe(1);
    expect(report.duplicates.proposals[0]).toMatchObject({ number: 1, supersededBy: 2, kind: 'origin' });
    expect(report.actions.rebase_candidates.count).toBe(1);
    expect(report.actions.batch_plan?.batches).toBeGreaterThanOrEqual(1);
    const previous = join(dir, 'prev.json');
    await writeFile(previous, JSON.stringify({ ...report, generatedAt: '2026-11-09T18:00:00Z', counts: { ...report.counts, open: 5 } }));
    const second = await run(['--input', snapshot, '--repo', 'ashlrai/phantom', '--previous', previous, '--json'], { prompts: async () => new Map() });
    expect(second.code).toBe(0);
    expect((JSON.parse(second.out).delta as Record<string, unknown>)['open']).toBe(-3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('CLI fails honestly on missing and malformed input', async () => {
  const missing = await run(['--input', '/nonexistent/prs.json', '--json']);
  expect(missing.code).toBe(1);
  expect(JSON.parse(missing.out).error).toContain('cannot read');
  const dir = await mkdtemp(join(tmpdir(), 'merge-plan-'));
  try {
    const bad = join(dir, 'bad.json');
    await writeFile(bad, '{nope:1');
    const malformed = await run(['--input', bad, '--json']);
    expect(malformed.code).toBe(1);
    expect(JSON.parse(malformed.out).input.state).toBe('malformed');
    const wrong = join(dir, 'wrong.json');
    await writeFile(wrong, '{"items":"nope"}');
    expect((await run(['--input', wrong, '--json'])).code).toBe(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  expect((await run(['--bogus'])).code).toBe(2);
  expect((await run(['--help'])).code).toBe(0);
});

it('diffMergePlans reports before/after deltas and ignores foreign schemas', () => {
  const parsed = parseMergePlanPrs(rows([ghRow({ number: 1 })]));
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  const report = planMergePlan(parsed, { repo: null, now: NOW });
  expect(diffMergePlans({ schema: 'other' }, report)).toBeNull();
  const delta = diffMergePlans({ schema: 'fleet.merge-plan.v1', generatedAt: 'x', counts: { open: 9 } }, report);
  expect(delta).toMatchObject({ open: -8, merges_per_hour: null });
});

it('is registered as a fleet subcommand', async () => {
  expect(typeof (await FLEET_SUBCOMMAND_LOADERS['merge-plan']!()).cmdFleetMergePlan).toBe('function');
});
