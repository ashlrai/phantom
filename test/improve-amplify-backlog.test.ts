import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AMPLIFY_BACKLOG_MAX_ITEMS,
  amplifyBacklogItems,
  foldAmplifyCells,
  parseAmplifyActionEntry,
  parseAmplifyJournal,
  parseAmplifyTickEntry,
} from '../src/core/improve/amplify-backlog.js';
import { discoverBacklog } from '../src/core/improve/discover.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';

const NOW_MS = Date.parse('2026-12-01T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

let home: string;
let saved: Record<string, string | undefined>;
beforeEach(async () => {
  saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME, ASHLR_RUNS_DIR: process.env.ASHLR_RUNS_DIR };
  delete process.env.ASHLR_HOME;
  delete process.env.ASHLR_RUNS_DIR;
  home = await mkdtemp(join(tmpdir(), 'improve-amplify-'));
  process.env.HOME = home;
});
afterEach(async () => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  await rm(home, { recursive: true, force: true });
});

const action = (kind: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  kind,
  pool: null,
  priority: 80,
  recommendation: 'Recorded recommendation text.',
  ...over,
});

const tickRow = (at: string, actions: unknown[] = [], over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    schema: 'amplify.tick.v1',
    type: 'ADVISORY',
    advisory: true,
    at,
    objective: 'Maximize verified, durable engineering outcomes.',
    pools: [],
    vitals: { observed_at: null, load1: null, mem_free_pct: null, swap_gb: null, disk_free_gb: null },
    merge_velocity: { window_hours: 1, merged_per_hour: null },
    heartbeat: { stale: false, sources: [] },
    actions,
    sources: {},
    ...over,
  });

const D1 = '2026-11-28T08:00:00.000Z';
const D2 = '2026-11-29T08:00:00.000Z';
const D3 = '2026-11-30T08:00:00.000Z';

/** Three ticks recommending the same (kind, pool) across three UTC days — past the tick and day bars. */
const recurringTicks = (kind: string, pool: string | null = null, days = [D1, D2, D3]): string[] =>
  days.map((at) => tickRow(at, [action(kind, { pool, priority: 90 })]));

/** A runs dir holding the advisory journal under metrics/, matching the writer's own path. */
const runsDirWith = async (name: string, files: Record<string, string>): Promise<string> => {
  const dir = join(home, name);
  await mkdir(join(dir, 'metrics'), { recursive: true });
  for (const [file, text] of Object.entries(files)) await writeFile(join(dir, 'metrics', file), text);
  return dir;
};

describe('parseAmplifyActionEntry / parseAmplifyTickEntry / parseAmplifyJournal', () => {
  it('accepts the writer contract and drops off-contract entries and rows honestly', () => {
    const rec = parseAmplifyActionEntry(action('use-expiring-capacity', { pool: 'codex-personal', priority: 90 }));
    expect(rec).toEqual({ kind: 'use-expiring-capacity', pool: 'codex-personal', priority: 90 });
    expect(parseAmplifyActionEntry(action('check-heartbeat', { pool: null }))!.pool).toBeNull();

    // Every producer kind is inside the closed vocabulary.
    for (const kind of ['refresh-evidence', 'check-heartbeat', 'use-expiring-capacity', 'review-saturation', 'review-merge-flow']) {
      expect(parseAmplifyActionEntry(action(kind))).not.toBeNull();
    }

    // Whole-entry contract violations reject the record.
    for (const bad of [
      null, 'x', [],
      action('not-a-kind'),
      action('use-expiring-capacity', { pool: 'Bad Pool!' }),
      action('use-expiring-capacity', { pool: 'UPPER' }),
      action('use-expiring-capacity', { pool: 'has space' }),
      action('use-expiring-capacity', { pool: 'my-secret-pool' }),
      action('use-expiring-capacity', { pool: 'token-pool' }),
      action('use-expiring-capacity', { pool: 42 }),
      action('use-expiring-capacity', { priority: 'high' }),
      action('use-expiring-capacity', { priority: Number.NaN }),
      action('use-expiring-capacity', { recommendation: 7 }),
      { kind: 'check-heartbeat' }, // missing pool/priority/recommendation entirely
    ]) {
      expect(parseAmplifyActionEntry(bad)).toBeNull();
    }

    // A tick needs the journal schema, the ADVISORY markers, a parseable `at` and an actions array.
    const tick = parseAmplifyTickEntry(JSON.parse(tickRow(D1, [action('check-heartbeat')])));
    expect(tick).not.toBeNull();
    expect(tick!.atMs).toBe(Date.parse(D1));
    expect(tick!.utcDay).toBe('2026-11-28');
    expect(tick!.actions).toHaveLength(1);

    for (const bad of [
      null, 'x', [],
      { schema: 'amplify.status.v1', type: 'ADVISORY', advisory: true, at: D1, actions: [] }, // the snapshot's own schema is not the journal row
      JSON.parse(tickRow(D1, [], { type: 'RECORD' })),
      JSON.parse(tickRow(D1, [], { advisory: false })),
      JSON.parse(tickRow('not-a-date', [])),
      JSON.parse(tickRow(D1, { not: 'an array' })),
    ]) {
      expect(parseAmplifyTickEntry(bad)).toBeNull();
    }

    // Malformed action entries inside an otherwise-valid tick drop out, never guessed.
    const mixed = parseAmplifyTickEntry(JSON.parse(tickRow(D1, [action('check-heartbeat'), { kind: 'bogus' }, 'junk'])));
    expect(mixed!.actions).toHaveLength(1);
    expect(mixed!.actions[0]!.kind).toBe('check-heartbeat');
  });

  it('counts malformed and off-contract lines without guessing', () => {
    const { ticks, invalidRows } = parseAmplifyJournal([
      'not json',
      '{"schema":"amplify.status.v1"}',
      tickRow(D1, [action('check-heartbeat')]),
      '',
      tickRow(D2, [], { schema: 'other.v9' }),
      tickRow(D3, []),
    ].join('\n'));
    expect(ticks).toHaveLength(2);
    expect(invalidRows).toBe(3);
  });
});

describe('foldAmplifyCells', () => {
  const ticksOf = (lines: readonly string[]) => parseAmplifyJournal(lines.join('\n')).ticks;

  it('folds recommending ticks per (kind, pool) and ignores empty actions', () => {
    const folded = foldAmplifyCells(ticksOf([
      ...recurringTicks('check-heartbeat'),
      ...recurringTicks('use-expiring-capacity', 'codex-personal'),
      // A healthy tick with no actions contributes nothing.
      tickRow(D3, []),
      // A different pool is a different cell.
      tickRow(D1, [action('use-expiring-capacity', { pool: 'agy', priority: 90 })]),
    ]), { nowMs: NOW_MS });
    const heartbeat = folded.find((c) => c.kind === 'check-heartbeat')!;
    expect(heartbeat.pool).toBeNull();
    expect(heartbeat.ticks).toBe(3);
    expect(heartbeat.days).toBe(3);
    expect(heartbeat.maxPriority).toBe(90);
    const personal = folded.find((c) => c.kind === 'use-expiring-capacity' && c.pool === 'codex-personal')!;
    expect(personal.ticks).toBe(3);
    expect(personal.days).toBe(3);
    const agy = folded.find((c) => c.kind === 'use-expiring-capacity' && c.pool === 'agy')!;
    expect(agy.ticks).toBe(1);
    expect(agy.days).toBe(1);
    expect(folded).toHaveLength(3);
  });

  it('counts a tick recommending the same cell twice only once', () => {
    const folded = foldAmplifyCells(ticksOf([
      tickRow(D1, [action('review-saturation', { pool: 'claude' }), action('review-saturation', { pool: 'claude' })]),
      tickRow(D2, [action('review-saturation', { pool: 'claude' })]),
      tickRow(D3, [action('review-saturation', { pool: 'claude' })]),
    ]), { nowMs: NOW_MS });
    expect(folded).toHaveLength(1);
    expect(folded[0]!.ticks).toBe(3);
  });

  it('keeps sub-window and out-of-contract ticks out of cells while the items layer applies the bars', () => {
    // Ticks outside the 7-day window never count.
    const ancient = foldAmplifyCells(ticksOf([
      tickRow('2026-11-01T08:00:00.000Z', [action('check-heartbeat')]),
      tickRow('2026-11-02T08:00:00.000Z', [action('check-heartbeat')]),
      tickRow('2026-11-03T08:00:00.000Z', [action('check-heartbeat')]),
    ]), { nowMs: NOW_MS });
    expect(ancient).toEqual([]);

    // One UTC day only: a real cell, but under the days bar.
    const oneDay = foldAmplifyCells(ticksOf([
      tickRow(D3, [action('check-heartbeat')]),
      tickRow('2026-11-30T09:00:00.000Z', [action('check-heartbeat')]),
      tickRow('2026-11-30T10:00:00.000Z', [action('check-heartbeat')]),
    ]), { nowMs: NOW_MS });
    expect(oneDay).toHaveLength(1);
    expect(oneDay[0]!.ticks).toBe(3);
    expect(oneDay[0]!.days).toBe(1);

    // Future-skewed ticks inside the tolerance still count; far-future ones do not.
    const skewed = foldAmplifyCells(ticksOf([
      tickRow('2026-12-01T12:00:30.000Z', [action('check-heartbeat')]),
      tickRow(D1, [action('check-heartbeat')]),
      tickRow(D2, [action('check-heartbeat')]),
      tickRow('2027-01-01T00:00:00.000Z', [action('check-heartbeat')]),
    ]), { nowMs: NOW_MS });
    expect(skewed[0]!.ticks).toBe(3);
  });
});

describe('amplifyBacklogItems', () => {
  it('emits one item per recurring cell with stable ids, prompts and metadata', async () => {
    const dir = await runsDirWith('runs-all', {
      'amplify.jsonl': [
        ...recurringTicks('check-heartbeat'),
        ...recurringTicks('use-expiring-capacity', 'codex-personal'),
        ...recurringTicks('refresh-evidence', 'agy'),
        // Sub-bar cells that must not emit.
        tickRow(D1, [action('review-saturation', { pool: 'claude' })]),
        tickRow(D2, [action('review-saturation', { pool: 'claude' })]),
        // Healthy ticks with no actions.
        tickRow(D3, []),
        tickRow(D1, []),
      ].join('\n') + '\n',
    });
    const items = await amplifyBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW_MS) });
    expect(items.length).toBe(3);
    expect(items.length).toBeLessThanOrEqual(AMPLIFY_BACKLOG_MAX_ITEMS);
    for (const item of items) {
      expect(item.id).toMatch(/^amplify-[0-9a-f]{16}$/);
      expect(item.priority).toBe(3);
      expect(item.area).toBe('amplify');
      expect(item.repo).toBe('ashlrai/phantom');
      expect(validBacklogItem(item)).not.toBeNull();
      expect(item.prompt).toContain('amplify.jsonl');
      expect(item.prompt).toContain('no-change');
      // Recommendation text is template output and is never quoted.
      expect(item.prompt).not.toContain('Recorded recommendation text.');
    }
    const heartbeat = items.find((i) => i.title.includes('heartbeats'))!;
    expect(heartbeat.prompt).toContain("'check-heartbeat'");
    expect(heartbeat.prompt).toContain('fleet scope');
    const expiring = items.find((i) => i.title.includes('codex-personal'))!;
    expect(expiring.prompt).toContain('use-expiring-capacity');
    expect(expiring.prompt).toContain('10%');
    const evidence = items.find((i) => i.title.includes('agy'))!;
    expect(evidence.prompt).toContain('refresh-evidence');
    expect(evidence.prompt).toContain('resources-ledger');
    // The two-tick saturation cell never emits.
    expect(items.some((i) => i.title.includes('claude'))).toBe(false);
    const limited = await amplifyBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW_MS), limit: 1 });
    expect(limited).toHaveLength(1);
    // Stable ids across refreshes.
    const again = await amplifyBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW_MS) });
    expect(again.map((i) => i.id)).toEqual(items.map((i) => i.id));
  });

  it('emits nothing below the bars, on missing or unreadable journals, or for another repository', async () => {
    // Below the ticks bar: two recommending ticks.
    const few = await runsDirWith('runs-few', {
      'amplify.jsonl': recurringTicks('check-heartbeat', null, [D1, D2]).join('\n') + '\n',
    });
    expect(await amplifyBacklogItems({ repo: 'ashlrai/phantom', runsDir: few, now: new Date(NOW_MS) })).toEqual([]);

    // Below the days bar: three ticks on one UTC day.
    const oneDay = await runsDirWith('runs-oneday', {
      'amplify.jsonl': [
        tickRow(D3, [action('check-heartbeat')]),
        tickRow('2026-11-30T09:00:00.000Z', [action('check-heartbeat')]),
        tickRow('2026-11-30T10:00:00.000Z', [action('check-heartbeat')]),
      ].join('\n') + '\n',
    });
    expect(await amplifyBacklogItems({ repo: 'ashlrai/phantom', runsDir: oneDay, now: new Date(NOW_MS) })).toEqual([]);

    // Missing runs dir, missing metrics dir and missing file are the writer's normal states.
    const empty = await runsDirWith('runs-empty', {});
    expect(await amplifyBacklogItems({ repo: 'ashlrai/phantom', runsDir: empty, now: new Date(NOW_MS) })).toEqual([]);
    expect(await amplifyBacklogItems({ repo: 'ashlrai/phantom', runsDir: join(home, 'no-such'), now: new Date(NOW_MS) })).toEqual([]);

    // A directory where the journal should be is not a file.
    const dirAsFile = join(home, 'runs-dirfile');
    await mkdir(join(dirAsFile, 'metrics', 'amplify.jsonl'), { recursive: true });
    expect(await amplifyBacklogItems({ repo: 'ashlrai/phantom', runsDir: dirAsFile, now: new Date(NOW_MS) })).toEqual([]);

    // Garbage lines and healthy empty-action ticks are not evidence.
    const junk = await runsDirWith('runs-junk', {
      'amplify.jsonl': 'not json\n{"schema":"amplify.status.v1"}\n' + tickRow(D1, []) + '\n',
    });
    expect(await amplifyBacklogItems({ repo: 'ashlrai/phantom', runsDir: junk, now: new Date(NOW_MS) })).toEqual([]);

    // Another repository never inherits this install's evidence.
    const dir = await runsDirWith('runs-repo', { 'amplify.jsonl': recurringTicks('check-heartbeat').join('\n') + '\n' });
    expect(await amplifyBacklogItems({ repo: 'ashlrai/other', runsDir: dir, now: new Date(NOW_MS) })).toEqual([]);
    expect(await amplifyBacklogItems({ repo: 'not-a-repo', runsDir: dir, now: new Date(NOW_MS) })).toEqual([]);
  });

  it('states truncated tails as lower bounds and counts malformed lines in prompts', async () => {
    // >8 MiB of retained healthy ticks: the bounded tail drops the oldest bytes.
    // Empty actions keep every pad tick non-evidence, so only the recurring
    // fixture at the tail's end can emit — deterministically.
    const pad = 'x'.repeat(20_000);
    const filler: string[] = [];
    for (let i = 0; i < 430; i += 1) {
      filler.push(tickRow(`2026-11-${String(20 + (i % 8)).padStart(2, '0')}T${String(i % 24).padStart(2, '0')}:00:00.000Z`, [], { pad }));
    }
    const dir = await runsDirWith('runs-big', {
      'amplify.jsonl': [...filler, ...recurringTicks('check-heartbeat'), 'not json\n'].join('\n'),
    });
    const items = await amplifyBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW_MS) });
    expect(items).toHaveLength(1);
    expect(items[0]!.prompt).toContain('lower bound');
    expect(items[0]!.prompt).toContain('malformed or off-contract');
  }, 30_000);

  it('appends amplify items through discovery and dedupes on refresh', async () => {
    // discoverBacklog anchors the evidence window on the wall clock, so the
    // fixtures use days relative to real now — three distinct UTC days inside
    // the window, like the fixed-date fixtures above.
    const dayAgo = (days: number, hourOffset = 0): string =>
      new Date(Date.now() - days * DAY_MS + hourOffset * 3_600_000).toISOString();
    const recentRecurring = (kind: string, pool: string | null): string[] =>
      [4, 3, 2].map((d, i) => tickRow(dayAgo(d, i), [action(kind, { pool, priority: 100 })]));
    const runsDir = join(home, '.ashlr-runs');
    await mkdir(join(runsDir, 'metrics'), { recursive: true });
    await writeFile(join(runsDir, 'metrics', 'amplify.jsonl'), recentRecurring('check-heartbeat', null).join('\n') + '\n');
    const greenGh = async (args: string[]) => {
      const p = args[4] ?? '';
      if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
    };
    const first = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    const amplifyItems = first.items.filter((i) => i.id.startsWith('amplify-'));
    expect(amplifyItems).toHaveLength(1);
    expect(amplifyItems[0]!.title).toContain('heartbeats');
    expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    expect(appendUserBacklogItems(amplifyItems)).toBe(1);
    const second = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('amplify-')))).toBe(0);
    expect(readUserBacklogItems().filter((i) => i.id.startsWith('amplify-'))).toHaveLength(1);
  });
});
