import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  REPAIR_HANDOFF_BACKLOG_MAX_ITEMS,
  REPAIR_HANDOFF_MIN_UNITS,
  foldRepairHandoffCells,
  parseRepairHandoffEntry,
  parseRepairHandoffLedger,
  repairHandoffBacklogItems,
  type RepairHandoffRow,
} from '../src/core/improve/repair-handoff-backlog.js';
import { discoverBacklog } from '../src/core/improve/discover.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';

const NOW_MS = Date.parse('2026-12-01T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

let home: string;
let repoPath: string;
let otherRepoPath: string;
let saved: Record<string, string | undefined>;
beforeEach(async () => {
  saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME, ASHLR_RUNS_DIR: process.env.ASHLR_RUNS_DIR };
  delete process.env.ASHLR_HOME;
  delete process.env.ASHLR_RUNS_DIR;
  home = await mkdtemp(join(tmpdir(), 'improve-repair-handoff-'));
  process.env.HOME = home;
  // The journal's repo field is the canonical absolute checkout path —
  // realpath the scratch home so fixture paths survive
  // canonicalDispatchRepoIdentity exactly as the writer records them.
  const realHome = await realpath(home);
  repoPath = join(realHome, 'phantom');
  otherRepoPath = join(realHome, 'other-project');
  await mkdir(repoPath, { recursive: true });
  await mkdir(otherRepoPath, { recursive: true });
});
afterEach(async () => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  await rm(home, { recursive: true, force: true });
});

const D1 = '2026-11-28';
const D2 = '2026-11-29';
const D3 = '2026-11-30';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);
const HASH_D = 'd'.repeat(64);

/** Apply record overrides; `drop` names keys to delete (for off-contract negatives). */
const applyOverrides = (row: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> => {
  const { drop, ...rest } = over;
  const merged = { ...row, ...rest };
  for (const key of (drop as readonly string[] | undefined) ?? []) delete merged[key];
  return merged;
};

/** A schemaVersion-2 reslice row — the writer's current shape, treatment metadata included. */
const reslice = (day: string, hour: number, item: string, over: Record<string, unknown> = {}): string =>
  JSON.stringify(applyOverrides({
    schemaVersion: 2,
    eventId: HASH_A,
    generationId: HASH_B,
    childItemId: 'phantom:proposal-repair-nodiff:0123456789ab',
    ts: `${day}T${String(hour).padStart(2, '0')}:00:00.000Z`,
    kind: 'no-diff-reslice',
    repo: repoPath,
    parentItemId: item,
    parentOutcome: 'empty-diff',
    parentAttemptId: 'run:job-1',
    parentRunId: 'job-1',
    parentTrajectoryId: 'run:job-1',
    parentSource: 'self',
    parentBackend: 'codex',
    parentTier: 'frontier',
    parentObjectiveHash: HASH_C,
    repairTreatmentUnitId: HASH_D,
    repairTreatment: 'baseline-reslice',
    diffFiles: 0,
    diffLines: 0,
  }, over));

/** A schemaVersion-2 capture-repair row — no treatment metadata on this kind. */
const capture = (
  day: string,
  hour: number,
  item: string,
  outcome: 'proposal-capture-error' | 'gate-blocked',
  over: Record<string, unknown> = {},
): string =>
  JSON.stringify(applyOverrides({
    schemaVersion: 2,
    eventId: HASH_A,
    generationId: HASH_B,
    childItemId: 'phantom:proposal-repair-capture:0123456789ab',
    ts: `${day}T${String(hour).padStart(2, '0')}:00:00.000Z`,
    kind: 'capture-repair',
    repo: repoPath,
    parentItemId: item,
    parentOutcome: outcome,
    parentAttemptId: 'run:job-1',
    parentRunId: 'job-1',
    parentTrajectoryId: 'run:job-1',
    parentSource: 'goal',
    parentBackend: 'claude',
    parentTier: 'mid',
    parentObjectiveHash: HASH_C,
  }, over));

/** A legacy schemaVersion-1 row — provenance optional, no attempt-consistency rule. */
const legacy = (day: string, hour: number, item: string, over: Record<string, unknown> = {}): string =>
  JSON.stringify(applyOverrides({
    schemaVersion: 1,
    eventId: HASH_A,
    generationId: HASH_B,
    childItemId: 'phantom:proposal-repair-capture:0123456789ab',
    ts: `${day}T${String(hour).padStart(2, '0')}:00:00.000Z`,
    kind: 'capture-repair',
    repo: repoPath,
    parentItemId: item,
    parentOutcome: 'gate-blocked',
    parentAttemptId: 'attempt-1',
  }, over));

/** Three distinct parent items across three UTC days — past both recurring bars for one cell. */
const recurringReslice = (backend = 'codex', prefix = 'parent'): string[] => [
  reslice(D1, 8, `phantom:self:${prefix}-a`, { parentBackend: backend }),
  reslice(D2, 9, `phantom:self:${prefix}-b`, { parentBackend: backend }),
  reslice(D3, 10, `phantom:self:${prefix}-c`, { parentBackend: backend }),
];

const fleetDirFor = async (name: string, files: Record<string, readonly string[]>): Promise<string> => {
  const dir = join(home, name);
  await mkdir(dir, { recursive: true });
  for (const [file, lines] of Object.entries(files)) {
    await writeFile(join(dir, file), lines.length === 0 ? '' : lines.join('\n') + '\n');
  }
  return dir;
};

const row = (day: string, hour: number, over: Partial<RepairHandoffRow> = {}): RepairHandoffRow => ({
  atMs: Date.parse(`${day}T${String(hour).padStart(2, '0')}:00:00.000Z`),
  utcDay: day,
  kind: 'no-diff-reslice',
  repoName: 'phantom',
  parentItemId: 'phantom:self:parent-a',
  parentOutcome: 'empty-diff',
  backend: 'codex',
  tier: 'frontier',
  source: 'self',
  schemaVersion: 2,
  ...over,
});

describe('parseRepairHandoffEntry / parseRepairHandoffLedger', () => {
  it('accepts the v1 and v2 writer contracts and rejects off-contract rows', () => {
    const v2 = parseRepairHandoffEntry(JSON.parse(reslice(D1, 8, 'phantom:self:parent-a')));
    expect(v2).not.toBeNull();
    expect(v2).toMatchObject({
      kind: 'no-diff-reslice',
      parentOutcome: 'empty-diff',
      repoName: 'phantom',
      backend: 'codex',
      tier: 'frontier',
      source: 'self',
      schemaVersion: 2,
      utcDay: D1,
    });

    const v1 = parseRepairHandoffEntry(JSON.parse(legacy(D1, 8, 'phantom:self:parent-a')));
    expect(v1).not.toBeNull();
    expect(v1).toMatchObject({ kind: 'capture-repair', parentOutcome: 'gate-blocked', backend: null, schemaVersion: 1 });

    // A v2 capture-repair with null backend/tier provenance still parses — unreported stays null.
    const nullProv = parseRepairHandoffEntry(JSON.parse(capture(D1, 8, 'i', 'proposal-capture-error', {
      parentBackend: null, parentTier: null,
    })));
    expect(nullProv).not.toBeNull();
    expect(nullProv!.backend).toBeNull();

    for (const bad of [
      null, 'x', [],
      // schemaVersion outside {1,2}
      JSON.parse(reslice(D1, 8, 'i', { schemaVersion: 3 })),
      // missing/wrong-shaped identity fields
      JSON.parse(reslice(D1, 8, 'i', { eventId: 'not-a-hash' })),
      JSON.parse(reslice(D1, 8, 'i', { generationId: 'x'.repeat(63) })),
      JSON.parse(reslice(D1, 8, 'i', { childItemId: '' })),
      // unparseable ts
      JSON.parse(reslice(D1, 8, 'i', { ts: 'not-a-date' })),
      // kind/outcome vocabulary and pairing
      JSON.parse(reslice(D1, 8, 'i', { kind: 'bogus' })),
      JSON.parse(reslice(D1, 8, 'i', { parentOutcome: 'merged' })),
      JSON.parse(reslice(D1, 8, 'i', { kind: 'capture-repair' })), // capture-repair + empty-diff
      JSON.parse(capture(D1, 8, 'i', 'proposal-capture-error', { kind: 'no-diff-reslice' })),
      // repo must be the canonical absolute identity
      JSON.parse(reslice(D1, 8, 'i', { repo: 'phantom' })),
      JSON.parse(reslice(D1, 8, 'i', { repo: `${repoPath}/` })),
      // item/attempt identity bounds
      JSON.parse(reslice(D1, 8, 'i', { parentItemId: '' })),
      JSON.parse(reslice(D1, 8, 'i', { parentItemId: 'x'.repeat(181) })),
      JSON.parse(reslice(D1, 8, 'i', { parentAttemptId: 'bad id!' })),
      // optional fields with wrong shapes
      JSON.parse(reslice(D1, 8, 'i', { parentRunId: 42 })),
      JSON.parse(reslice(D1, 8, 'i', { diffFiles: -1 })),
      JSON.parse(reslice(D1, 8, 'i', { diffLines: 1.5 })),
      // treatment metadata on the wrong kind / wrong vocab
      JSON.parse(capture(D1, 8, 'i', 'gate-blocked', { repairTreatment: 'baseline-reslice', repairTreatmentUnitId: HASH_D })),
      JSON.parse(reslice(D1, 8, 'i', { repairTreatment: 'bogus' })),
      // v2 reslice without treatment metadata
      JSON.parse(reslice(D1, 8, 'i', { drop: ['repairTreatmentUnitId', 'repairTreatment'] })),
      // provenance all-or-none
      JSON.parse(reslice(D1, 8, 'i', { drop: ['parentBackend'] })),
      JSON.parse(reslice(D1, 8, 'i', { parentBackend: 'not-an-engine' })),
      JSON.parse(reslice(D1, 8, 'i', { parentTier: 'warp' })),
      JSON.parse(reslice(D1, 8, 'i', { parentSource: 'vibes' })),
      // objective hash requires full provenance; v2 requires both
      JSON.parse(legacy(D1, 8, 'i', { parentObjectiveHash: HASH_C })),
      JSON.parse(capture(D1, 8, 'i', 'gate-blocked', { drop: ['parentObjectiveHash'] })),
      JSON.parse(capture(D1, 8, 'i', 'gate-blocked', { drop: ['parentSource', 'parentBackend', 'parentTier', 'parentObjectiveHash'] })),
      // v2 attempt consistency: parentAttemptId must be trajectory-or-run
      JSON.parse(reslice(D1, 8, 'i', { parentAttemptId: 'run:other' })),
      JSON.parse(reslice(D1, 8, 'i', { drop: ['parentRunId', 'parentTrajectoryId'] })),
      JSON.parse(reslice(D1, 8, 'i', { parentTrajectoryId: 'run:job-2' })),
    ]) {
      expect(parseRepairHandoffEntry(bad)).toBeNull();
    }
  });

  it('counts malformed and off-contract lines without guessing', () => {
    const { rows: parsed, invalidRows } = parseRepairHandoffLedger([
      'not json',
      '{"schemaVersion":2}',
      reslice(D1, 8, 'phantom:self:parent-a'),
      '',
      legacy(D2, 8, 'phantom:self:parent-b'),
      reslice(D3, 8, 'phantom:self:parent-c', { parentBackend: 'nope' }),
    ].join('\n'));
    expect(parsed).toHaveLength(2);
    expect(invalidRows).toBe(3);
  });
});

describe('foldRepairHandoffCells', () => {
  it('folds recurring (repo, outcome, backend) cells and ignores rows outside the window', () => {
    const lines = [
      ...recurringReslice(),
      // A second backend on the same outcome is its own cell.
      reslice(D1, 11, 'phantom:self:parent-d', { parentBackend: 'claude' }),
      reslice(D2, 11, 'phantom:self:parent-e', { parentBackend: 'claude' }),
      reslice(D3, 11, 'phantom:self:parent-f', { parentBackend: 'claude' }),
      // Rows for another checkout basename never join the phantom cell.
      reslice(D1, 12, 'other:self:x', { repo: otherRepoPath }),
      reslice(D2, 12, 'other:self:y', { repo: otherRepoPath }),
      reslice(D3, 12, 'other:self:z', { repo: otherRepoPath }),
      // Outside the 7-day window.
      reslice('2026-11-10', 8, 'phantom:self:old-a'),
      reslice('2026-11-11', 8, 'phantom:self:old-b'),
      reslice('2026-11-12', 8, 'phantom:self:old-c'),
    ];
    const { rows: parsed } = parseRepairHandoffLedger(lines.join('\n'));
    const folded = foldRepairHandoffCells(parsed, { nowMs: NOW_MS, repoName: 'phantom' });
    expect(folded).toHaveLength(2);
    const codex = folded.find((c) => c.backend === 'codex')!;
    expect(codex.units).toBe(REPAIR_HANDOFF_MIN_UNITS);
    expect(codex.rows).toBe(REPAIR_HANDOFF_MIN_UNITS);
    expect(codex.days.size).toBe(3);
    expect(codex.kind).toBe('no-diff-reslice');
    expect(codex.parentOutcome).toBe('empty-diff');
    expect(codex.tiers.map((t) => t.text)).toEqual(['frontier']);
    expect(codex.sources.map((s) => s.text)).toEqual(['self']);
    expect(codex.examples).toHaveLength(3);
    const claude = folded.find((c) => c.backend === 'claude')!;
    expect(claude.units).toBe(3);
  });

  it('groups rows without provenance under unrecorded and dedupes units by parentItemId', () => {
    const lines = [
      // v1 rows carry no provenance: backend folds as 'unrecorded'.
      legacy(D1, 8, 'phantom:self:parent-a'),
      legacy(D2, 8, 'phantom:self:parent-b'),
      legacy(D3, 8, 'phantom:self:parent-c'),
      // A second handoff for the same parent is a row, not a new unit.
      legacy(D3, 9, 'phantom:self:parent-a'),
      // v2 rows with explicit null backend land in the same cell.
      capture(D1, 10, 'phantom:goal:parent-d', 'proposal-capture-error', { parentBackend: null, parentTier: null }),
    ];
    const { rows: parsed } = parseRepairHandoffLedger(lines.join('\n'));
    const folded = foldRepairHandoffCells(parsed, { nowMs: NOW_MS, repoName: 'phantom' });
    const gate = folded.find((c) => c.parentOutcome === 'gate-blocked')!;
    expect(gate.backend).toBe('unrecorded');
    expect(gate.units).toBe(3);
    expect(gate.rows).toBe(4);
    expect(gate.kind).toBe('capture-repair');
    const captureCell = folded.find((c) => c.parentOutcome === 'proposal-capture-error')!;
    expect(captureCell.backend).toBe('unrecorded');
    expect(captureCell.units).toBe(1);
  });

  it('folds cells below the recurring bars with their unit/day tallies', () => {
    // Three rows for ONE parent item — a retry storm, not recurrence.
    const oneItem = foldRepairHandoffCells(
      [row(D1, 8), row(D2, 8), row(D3, 8)],
      { nowMs: NOW_MS, repoName: 'phantom' },
    );
    expect(oneItem).toHaveLength(1);
    expect(oneItem[0]!.units).toBe(1);
    expect(oneItem[0]!.rows).toBe(3);

    // Distinct items but a single UTC day.
    const oneDay = foldRepairHandoffCells(
      [row(D3, 8, { parentItemId: 'a' }), row(D3, 9, { parentItemId: 'b' }), row(D3, 10, { parentItemId: 'c' })],
      { nowMs: NOW_MS, repoName: 'phantom' },
    );
    expect(oneDay[0]!.units).toBe(3);
    expect(oneDay[0]!.days.size).toBe(1);

    // Below the units bar entirely: two distinct items.
    const two = foldRepairHandoffCells(
      [row(D1, 8, { parentItemId: 'a' }), row(D2, 8, { parentItemId: 'b' })],
      { nowMs: NOW_MS, repoName: 'phantom' },
    );
    expect(two[0]!.units).toBe(2);
  });
});

describe('repairHandoffBacklogItems', () => {
  it('emits one item per recurring cell across both journal files with stable ids and prompts', async () => {
    const dir = await fleetDirFor('fleet-both', {
      // Two recurring v2 reslice cells (codex, claude) plus one legacy
      // v1 gate-blocked cell whose rows carry no provenance — the fold
      // merges both files before recurring is judged.
      'repair-handoffs-v2.jsonl': [
        ...recurringReslice('codex', 'codex'),
        ...recurringReslice('claude', 'claude'),
        // A one-off never emits.
        reslice(D3, 12, 'phantom:self:parent-once', { parentBackend: 'grok' }),
      ],
      'repair-handoffs.jsonl': [
        legacy(D1, 8, 'phantom:self:parent-e'),
        legacy(D2, 8, 'phantom:self:parent-f'),
        legacy(D3, 8, 'phantom:self:parent-g'),
        // A second handoff for an existing parent is a row, not a unit.
        legacy(D3, 9, 'phantom:self:parent-e'),
      ],
    });
    const items = await repairHandoffBacklogItems({ repo: 'ashlrai/phantom', fleetDir: dir, now: new Date(NOW_MS) });
    expect(items).toHaveLength(3);
    expect(items.every((i) => i.priority === 3 && i.area === 'repair-handoff' && i.repo === 'ashlrai/phantom')).toBe(true);
    expect(items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    expect(new Set(items.map((i) => i.id)).size).toBe(3);
    expect(items.every((i) => i.id.startsWith('fleet-repair-handoff-'))).toBe(true);

    const codex = items.find((i) => i.title.includes('codex'))!;
    expect(codex.prompt).toContain('3 distinct work items');
    expect(codex.prompt).toContain('no-diff reslice');
    expect(codex.prompt).toContain('repair-handoffs-v2.jsonl');
    expect(codex.prompt).toContain('phantom:self:codex-a');
    expect(codex.prompt).toContain('no-change');
    expect(codex.prompt).not.toContain(repoPath);

    const claudeReslice = items.find((i) => i.title.includes('claude'))!;
    expect(claudeReslice.prompt).toContain('3 distinct work items');

    const legacyGate = items.find((i) => i.prompt.includes('gate-blocked'))!;
    expect(legacyGate.prompt).toContain('unrecorded backend');
    expect(legacyGate.prompt).toContain('3 distinct work items');
    expect(legacyGate.prompt).toContain('4 handoff(s)');
  });

  it('emits capture-error and gate-blocked prompts for their own outcome cells', async () => {
    const dir = await fleetDirFor('fleet-outcomes', {
      'repair-handoffs-v2.jsonl': [
        capture(D1, 8, 'phantom:goal:cap-a', 'proposal-capture-error'),
        capture(D2, 8, 'phantom:goal:cap-b', 'proposal-capture-error'),
        capture(D3, 8, 'phantom:goal:cap-c', 'proposal-capture-error'),
        capture(D1, 9, 'phantom:goal:gate-a', 'gate-blocked'),
        capture(D2, 9, 'phantom:goal:gate-b', 'gate-blocked'),
        capture(D3, 9, 'phantom:goal:gate-c', 'gate-blocked'),
      ],
    });
    const items = await repairHandoffBacklogItems({ repo: 'ashlrai/phantom', fleetDir: dir, now: new Date(NOW_MS) });
    expect(items).toHaveLength(2);
    const cap = items.find((i) => i.prompt.includes('capture errored'))!;
    expect(cap.title).toContain('capture');
    expect(cap.prompt).toContain('proposal-capture-error');
    const gate = items.find((i) => i.prompt.includes('completeness/diff gate'))!;
    expect(gate.title).toContain('gate');
    expect(gate.prompt).toContain('gate-blocked');
  });

  it('emits nothing below the bars, on missing files, or for another repository', async () => {
    // Below the units bar: two distinct items across two days.
    const few = await fleetDirFor('fleet-few', {
      'repair-handoffs-v2.jsonl': [reslice(D1, 8, 'a'), reslice(D2, 8, 'b')],
    });
    expect(await repairHandoffBacklogItems({ repo: 'ashlrai/phantom', fleetDir: few, now: new Date(NOW_MS) })).toEqual([]);

    // Below the days bar: three items on one UTC day.
    const oneDay = await fleetDirFor('fleet-oneday', {
      'repair-handoffs-v2.jsonl': [reslice(D3, 8, 'a'), reslice(D3, 9, 'b'), reslice(D3, 10, 'c')],
    });
    expect(await repairHandoffBacklogItems({ repo: 'ashlrai/phantom', fleetDir: oneDay, now: new Date(NOW_MS) })).toEqual([]);

    // Missing dir and empty files are the writer's normal first-run state.
    expect(await repairHandoffBacklogItems({ repo: 'ashlrai/phantom', fleetDir: join(home, 'no-such'), now: new Date(NOW_MS) })).toEqual([]);
    const empty = await fleetDirFor('fleet-empty', { 'repair-handoffs.jsonl': [], 'repair-handoffs-v2.jsonl': [] });
    expect(await repairHandoffBacklogItems({ repo: 'ashlrai/phantom', fleetDir: empty, now: new Date(NOW_MS) })).toEqual([]);

    // Garbage ledgers are not evidence.
    const junk = await fleetDirFor('fleet-junk', {
      'repair-handoffs.jsonl': ['not json', '{"schemaVersion":2}', ''],
      'repair-handoffs-v2.jsonl': ['also not json'],
    });
    expect(await repairHandoffBacklogItems({ repo: 'ashlrai/phantom', fleetDir: junk, now: new Date(NOW_MS) })).toEqual([]);

    // Rows for another checkout basename never emit for this target.
    const other = await fleetDirFor('fleet-other', {
      'repair-handoffs-v2.jsonl': [
        reslice(D1, 8, 'x', { repo: otherRepoPath }),
        reslice(D2, 8, 'y', { repo: otherRepoPath }),
        reslice(D3, 8, 'z', { repo: otherRepoPath }),
      ],
    });
    expect(await repairHandoffBacklogItems({ repo: 'ashlrai/phantom', fleetDir: other, now: new Date(NOW_MS) })).toEqual([]);
    // The same rows DO emit when the target's repository name matches the basename.
    const matched = await repairHandoffBacklogItems({ repo: 'ashlrai/other-project', fleetDir: other, now: new Date(NOW_MS) });
    expect(matched).toHaveLength(1);
    // Repo matching is case-insensitive on the owner/name target.
    const dir = await fleetDirFor('fleet-case', { 'repair-handoffs-v2.jsonl': recurringReslice() });
    expect(await repairHandoffBacklogItems({ repo: 'AshlrAI/Phantom', fleetDir: dir, now: new Date(NOW_MS) })).toHaveLength(1);
  });

  it('resolves <home>/.ashlr/fleet by default — the writer\'s own homedir() resolution', async () => {
    const fleet = join(home, '.ashlr', 'fleet');
    await mkdir(fleet, { recursive: true });
    await writeFile(join(fleet, 'repair-handoffs-v2.jsonl'), recurringReslice().join('\n') + '\n');
    const viaHome = await repairHandoffBacklogItems({ repo: 'ashlrai/phantom', homeDir: home, now: new Date(NOW_MS) });
    expect(viaHome).toHaveLength(1);
    // fleetDir wins when both are given.
    const other = await fleetDirFor('fleet-override', { 'repair-handoffs-v2.jsonl': recurringReslice('claude') });
    const viaDir = await repairHandoffBacklogItems({ repo: 'ashlrai/phantom', homeDir: home, fleetDir: other, now: new Date(NOW_MS) });
    expect(viaDir).toHaveLength(1);
    expect(viaDir[0]!.title).toContain('claude');
  });

  it('counts malformed lines in the prompt and marks truncated tails as lower bounds', async () => {
    const dir = await fleetDirFor('fleet-mixed', {
      'repair-handoffs.jsonl': ['not json', '{"broken":true}', ...recurringReslice()],
      'repair-handoffs-v2.jsonl': [],
    });
    const items = await repairHandoffBacklogItems({ repo: 'ashlrai/phantom', fleetDir: dir, now: new Date(NOW_MS) });
    expect(items).toHaveLength(1);
    expect(items[0]!.prompt).toContain('2 malformed or off-contract lines dropped');
  });

  it('folds a truncated journal tail with lower-bound counts', async () => {
    // >4 MiB of retained rows pushes the recurring cell's earliest rows
    // out of the bounded tail — the fold keeps what it can see and the
    // prompt says the counts are a lower bound.
    const filler: string[] = [];
    for (let i = 0; i < 12000; i += 1) {
      filler.push(reslice(D3, i % 24, `phantom:self:pad-${i}`, { parentBackend: 'grok' }));
    }
    const dir = await fleetDirFor('fleet-big', {
      'repair-handoffs-v2.jsonl': [...filler, ...recurringReslice()],
    });
    const items = await repairHandoffBacklogItems({ repo: 'ashlrai/phantom', fleetDir: dir, now: new Date(NOW_MS) });
    expect(items.length).toBeGreaterThanOrEqual(1);
    const codex = items.find((i) => i.title.includes('codex'));
    expect(codex).toBeDefined();
    expect(codex!.prompt).toContain('lower bound');
  }, 30_000);

  it('scrubs secret-shaped parent item ids before they reach a prompt', async () => {
    const token = '123456789:AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHJ';
    const dir = await fleetDirFor('fleet-secret', {
      'repair-handoffs-v2.jsonl': [
        reslice(D1, 8, `phantom:self:${token}-a`),
        reslice(D2, 8, `phantom:self:${token}-b`),
        reslice(D3, 8, `phantom:self:${token}-c`),
      ],
    });
    const items = await repairHandoffBacklogItems({ repo: 'ashlrai/phantom', fleetDir: dir, now: new Date(NOW_MS) });
    expect(items).toHaveLength(1);
    expect(items[0]!.prompt).not.toContain(token);
    expect(items[0]!.prompt).toContain('[REDACTED]');
  });

  it('honours the item limit and derives stable ids across calls', async () => {
    const dir = await fleetDirFor('fleet-stable', {
      'repair-handoffs-v2.jsonl': [
        ...recurringReslice('codex'),
        ...recurringReslice('claude'),
        ...recurringReslice('grok'),
      ],
    });
    const opts = { repo: 'ashlrai/phantom', fleetDir: dir, now: new Date(NOW_MS) };
    const first = await repairHandoffBacklogItems(opts);
    const second = await repairHandoffBacklogItems(opts);
    expect(first).toHaveLength(3);
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
    const limited = await repairHandoffBacklogItems({ ...opts, limit: 2 });
    expect(limited).toHaveLength(2);
    expect(limited.length).toBeLessThanOrEqual(Math.min(REPAIR_HANDOFF_BACKLOG_MAX_ITEMS, 25));
  });

  it('appends repair-handoff items through discovery and dedupes on refresh', async () => {
    // discoverBacklog anchors the evidence window on the wall clock, so
    // the fixtures use days relative to real now — three distinct UTC
    // days inside the window.
    const dayAgo = (days: number): string => new Date(Date.now() - days * DAY_MS).toISOString().slice(0, 10);
    const iso = (days: number, hour: number): string => `${dayAgo(days)}T${String(hour).padStart(2, '0')}:00:00.000Z`;
    const fleet = join(home, '.ashlr', 'fleet');
    await mkdir(fleet, { recursive: true });
    const lines = [1, 2, 3].map((d) => [
      JSON.stringify({
        schemaVersion: 2, eventId: HASH_A, generationId: HASH_B,
        childItemId: 'phantom:proposal-repair-nodiff:0123456789ab', ts: iso(d, 8),
        kind: 'no-diff-reslice', repo: repoPath,
        parentItemId: `phantom:self:parent-${d}`, parentOutcome: 'empty-diff',
        parentAttemptId: 'run:job-1', parentRunId: 'job-1', parentTrajectoryId: 'run:job-1',
        parentSource: 'self', parentBackend: 'codex', parentTier: 'frontier',
        parentObjectiveHash: HASH_C, repairTreatmentUnitId: HASH_D, repairTreatment: 'baseline-reslice',
      }),
      JSON.stringify({
        schemaVersion: 2, eventId: HASH_A, generationId: HASH_B,
        childItemId: 'phantom:proposal-repair-capture:0123456789ab', ts: iso(d, 9),
        kind: 'capture-repair', repo: repoPath,
        parentItemId: `phantom:goal:parent-${d}`, parentOutcome: 'gate-blocked',
        parentAttemptId: 'run:job-1', parentRunId: 'job-1', parentTrajectoryId: 'run:job-1',
        parentSource: 'goal', parentBackend: 'claude', parentTier: 'mid',
        parentObjectiveHash: HASH_C,
      }),
    ]).flat();
    await writeFile(join(fleet, 'repair-handoffs-v2.jsonl'), lines.join('\n') + '\n');
    const greenGh = async (args: string[]) => {
      const p = args[4] ?? '';
      if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
    };
    const first = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    const items = first.items.filter((i) => i.id.startsWith('fleet-repair-handoff-'));
    expect(items).toHaveLength(2);
    expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    expect(appendUserBacklogItems(items)).toBe(2);
    const second = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('fleet-repair-handoff-')))).toBe(0);
    expect(readUserBacklogItems().filter((i) => i.id.startsWith('fleet-repair-handoff-'))).toHaveLength(2);
  });
});
