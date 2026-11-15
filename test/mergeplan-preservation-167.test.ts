/**
 * Preservation coverage for the merge-plan capability recovered from
 * ashlrai/phantom PR #5117 (original job RQ-PHX-RECUTCORES1C164, itself a
 * recut of #4797 / RQ-MERGE-THROUGHPUT-1).
 *
 * The recovered files are src/core/fleet/merge-plan.ts (pure planner,
 * schema fleet.merge-plan.v1) and src/cli/fleet-merge-plan.ts (thin handler,
 * export cmdFleetMergePlan — the name fleet-subcommand-resolve.ts derives for
 * the `merge-plan` verb). These tests pin the preserved semantics: the
 * convention dispatch path, deterministic ordering, honest unknowns, and a
 * strictly read-only plan (no merge, no close, no input mutation).
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleet } from '../src/cli/fleet.js';
import { cmdFleetMergePlan } from '../src/cli/fleet-merge-plan.js';
import { resolveFleetSubcommand } from '../src/cli/fleet-subcommand-resolve.js';
import {
  MERGE_PLAN_SCHEMA,
  parseMergePlanPrs,
  planMergePlan,
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
    files: [{ path: `src/${rowId}.ts` }],
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

it('resolves merge-plan through the convention dispatcher to the recovered export', async () => {
  const resolved = resolveFleetSubcommand('merge-plan');
  expect(resolved).toEqual({ module: './fleet-merge-plan.js', exportName: 'cmdFleetMergePlan' });
  const module = await import('../src/cli/fleet-merge-plan.js');
  expect(module.cmdFleetMergePlan).toBe(cmdFleetMergePlan);
});

it('dispatches `fleet merge-plan --help` through cmdFleet with a convention loader', async () => {
  const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const code = await cmdFleet(['merge-plan', '--help'], {
    'merge-plan': () => import('../src/cli/fleet-merge-plan.js'),
  });
  expect(code).toBe(0);
  const text = write.mock.calls.map(call => String(call[0])).join('');
  expect(text).toContain('Usage: phm fleet merge-plan');
  expect(text).toContain('Read-only');
});

it('plans deterministically from synthetic gh rows: ordering is stable and input is not mutated', async () => {
  const input = rows([
    ghRow({ number: 30, createdAt: at(50), title: 'bridge: RQ-FIX-PHANTOM-10' }),
    ghRow({ number: 10, createdAt: at(5) }),
    ghRow({ number: 20, createdAt: at(30), state: 'MERGED', mergedAt: at(2), closedAt: at(2) }),
    ghRow({ number: 40, createdAt: at(80), state: 'CLOSED', closedAt: at(40) }),
  ]);
  const before = JSON.stringify(input);
  const parsed = parseMergePlanPrs(input);
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  const first = planMergePlan(parsed, { repo: 'ashlrai/phantom', hours: 24, now: NOW });
  const reparsed = parseMergePlanPrs(input);
  expect(reparsed.ok).toBe(true);
  if (!reparsed.ok) return;
  const second = planMergePlan(reparsed, { repo: 'ashlrai/phantom', hours: 24, now: NOW });
  expect(second).toEqual(first);
  expect(JSON.stringify(input)).toBe(before);

  expect(first.schema).toBe(MERGE_PLAN_SCHEMA);
  expect(first.counts).toMatchObject({ rows: 4, open: 2, merged_rows: 1, closed_rows: 1 });
  // Oldest open PRs are ordered by creation time, oldest first.
  expect(first.open.oldest.map(pr => pr.number)).toEqual([30, 10]);
  // The rework title names origin #10; #30 is the newest family member and wins.
  expect(first.duplicates.proposals).toEqual([
    expect.objectContaining({ number: 10, supersededBy: 30, kind: 'origin' }),
  ]);
  expect(first.actions.superseded_open).toBe(1);
});

it('keeps missing evidence unknown rather than zero', () => {
  const parsed = parseMergePlanPrs(rows([
    ghRow({ number: 1, mergeStateStatus: undefined, mergeable: undefined }),
    ghRow({ number: 2, mergeStateStatus: undefined, mergeable: undefined }),
  ]));
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  expect(parsed.hasStateEvidence).toBe(false);
  expect(parsed.hasBodyEvidence).toBe(false);
  const report = planMergePlan(parsed, { repo: null, now: NOW });
  expect(report.throughput).toBeNull();
  expect(report.open.states_evidence).toBe('unknown');
  expect(report.actions.rebase_candidates).toEqual({ state: 'unknown', count: 0, prs: [] });
  expect(report.duplicates.state).toBe('no-body-evidence');
  expect(report.actions.superseded_merged).toEqual({ state: 'no-merged-rows', count: 0, prs: [] });
});

it('CLI emits the scoreboard end-to-end and exits 0 on a usable snapshot', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'merge-plan-preserve-'));
  try {
    const snapshot = join(dir, 'prs.json');
    const prompts = join(dir, 'prompts');
    await writeFile(snapshot, JSON.stringify(rows([
      ghRow({ number: 1, mergeStateStatus: 'BEHIND', autoMergeRequest: { mergeMethod: 'SQUASH' } }),
      ghRow({ number: 2, title: 'bridge: RQ-FIX-PHANTOM-1' }),
      ghRow({ number: 3, state: 'MERGED', createdAt: at(4), mergedAt: at(1) }),
    ])));
    const { code, out, err } = await run(
      ['--input', snapshot, '--repo', 'ashlrai/phantom', '--prompts-dir', prompts, '--json'],
      { prompts: async () => new Map() },
    );
    expect(err).toBe('');
    expect(code).toBe(0);
    const report = JSON.parse(out) as MergePlanReport & { input: Record<string, unknown> };
    expect(report.schema).toBe('fleet.merge-plan.v1');
    expect(report.input).toMatchObject({ kind: 'gh-pr-list', state: 'ok' });
    expect(report.counts.open).toBe(2);
    expect(report.throughput?.merges_in_window).toBe(1);
    expect(report.actions.superseded_open).toBe(1);
    expect(report.duplicates.proposals[0]).toMatchObject({ number: 1, supersededBy: 2, kind: 'origin' });
    expect(report.actions.rebase_candidates).toMatchObject({ state: 'ok', count: 1 });
    expect(report.actions.batch_plan?.batches).toBeGreaterThanOrEqual(1);
    expect(report.actions.superseded_merged).toEqual({ state: 'ok', count: 0, prs: [] });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('CLI fails honestly on missing, malformed and wrongly-shaped input without mutating it', async () => {
  const missing = await run(['--input', '/nonexistent/prs.json', '--json']);
  expect(missing.code).toBe(1);
  expect(JSON.parse(missing.out).error).toContain('cannot read');

  const dir = await mkdtemp(join(tmpdir(), 'merge-plan-preserve-'));
  try {
    const bad = join(dir, 'bad.json');
    await writeFile(bad, '{nope:1');
    const malformed = await run(['--input', bad, '--json']);
    expect(malformed.code).toBe(1);
    expect(JSON.parse(malformed.out).input.state).toBe('malformed');

    const wrong = join(dir, 'wrong.json');
    const wrongText = '{"items":"nope"}';
    await writeFile(wrong, wrongText);
    expect((await run(['--input', wrong, '--json'])).code).toBe(1);
    // Read-only: refused and accepted inputs are never rewritten.
    expect(await readFile(wrong, 'utf8')).toBe(wrongText);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  expect((await run(['--bogus'])).code).toBe(2);
  expect((await run(['--help'])).code).toBe(0);
});

it('plans but never merges or closes: proposals are data, exit stays 0', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'merge-plan-preserve-'));
  try {
    const snapshot = join(dir, 'prs.json');
    const prompts = join(dir, 'prompts');
    const snapshotText = JSON.stringify(rows([
      ghRow({ number: 100 }),
      ghRow({ number: 101, title: 'bridge: RQ-FIX-PHANTOM-100' }),
      ghRow({ number: 102, title: 'bridge: RQ-REBASE-PHANTOM-100' }),
    ]));
    await writeFile(snapshot, snapshotText);
    const { code, out } = await run(
      ['--input', snapshot, '--json', '--prompts-dir', prompts],
      { prompts: async () => new Map() },
    );
    expect(code).toBe(0);
    const report = JSON.parse(out) as MergePlanReport;
    // Every non-winner in the family is a close *proposal* with a named
    // replacement — the report carries no apply flag and calls no gh verb.
    expect(report.duplicates.proposals.length).toBe(2);
    for (const proposal of report.duplicates.proposals) {
      expect(proposal.supersededBy).toBe(102);
      expect(proposal.reason).toContain('#102');
    }
    expect(report.actions.superseded_open).toBe(2);
    expect(await readFile(snapshot, 'utf8')).toBe(snapshotText);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
