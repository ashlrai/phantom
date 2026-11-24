import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AUTOFIX_BACKLOG_MAX_ITEMS,
  autofixBacklogItems,
  foldAutofixActionCells,
  foldAutofixIncidentCells,
  parseAutofixActionEntry,
  parseAutofixActionJournal,
  parseAutofixIncidentEntry,
  parseAutofixIncidentJournal,
} from '../src/core/improve/autofix-backlog.js';
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
  home = await mkdtemp(join(tmpdir(), 'improve-autofix-'));
  process.env.HOME = home;
});
afterEach(async () => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  await rm(home, { recursive: true, force: true });
});

const actionRow = (ts: string, over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    ts,
    fixer: 'stuck-lane',
    target: 'devin-flash',
    action: 'restart-lane-pool',
    before: { running: 4, target: 2 },
    after: { restarted: true },
    result: 'failed',
    ...over,
  });

const incidentRow = (ts: string, over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    key: 'd_devin-flash',
    status: 'failed',
    reason: 'restart-lane-pool',
    ts,
    ...over,
  });

const at = (day: string, hour = 8): string => `${day}T${String(hour).padStart(2, '0')}:00:00.000Z`;
const D1 = '2026-11-28';
const D2 = '2026-11-29';
const D3 = '2026-11-30';

/** `n` failed rows for the same action cell spread across n distinct UTC days — past the row and day bars. */
const failingAction = (make: (day: string, n: number) => Record<string, unknown>): string[] =>
  [D1, D2, D3].map((day, i) => actionRow(at(day), make(day, i)));

const failingIncident = (make: (day: string, n: number) => Record<string, unknown>): string[] =>
  [D1, D2, D3].map((day, i) => incidentRow(at(day), make(day, i)));

/** A runs dir holding the two ledgers under ledger/, matching the writer's own paths. */
const runsDirWith = async (name: string, files: Record<string, string>): Promise<string> => {
  const dir = join(home, name);
  await mkdir(join(dir, 'ledger'), { recursive: true });
  for (const [file, text] of Object.entries(files)) await writeFile(join(dir, 'ledger', file), text);
  return dir;
};

describe('parseAutofixActionEntry / parseAutofixActionJournal', () => {
  it('accepts the writer contract and drops off-contract rows and entries honestly', () => {
    const parsed = parseAutofixActionEntry(JSON.parse(actionRow(at(D1), {
      fixer: 'outside-load',
      target: '12345',
      action: 'renice-20',
      result: 'refused_stale',
    })));
    expect(parsed).not.toBeNull();
    expect(parsed!.fixer).toBe('outside-load');
    expect(parsed!.result).toBe('refused_stale');
    expect(parsed!.utcDay).toBe(D1);

    // before/after stay unread — any JSON value is on-contract there.
    expect(parseAutofixActionEntry(JSON.parse(actionRow(at(D1), { before: 'x', after: [1, 2] })))).not.toBeNull();
    // The ledger-only pseudo-fixer is valid vocabulary.
    expect(parseAutofixActionEntry(JSON.parse(actionRow(at(D1), { fixer: 'pinned-hand-edit', action: 'security-report', result: 'detect-only' })))).not.toBeNull();

    // Whole-row contract violations reject the record.
    for (const bad of [
      null, 'x', [],
      { ...JSON.parse(actionRow(at(D1))), ts: 'not-a-date' },
      { ...JSON.parse(actionRow(at(D1))), ts: 42 },
      { ...JSON.parse(actionRow(at(D1))), fixer: 'bogus-fixer' },
      { ...JSON.parse(actionRow(at(D1))), fixer: 'autorun-hold' },
      { ...JSON.parse(actionRow(at(D1))), target: '' },
      { ...JSON.parse(actionRow(at(D1))), target: 'x'.repeat(201) },
      { ...JSON.parse(actionRow(at(D1))), target: 'bad\nname' },
      { ...JSON.parse(actionRow(at(D1))), action: '' },
      { ...JSON.parse(actionRow(at(D1))), action: 'x'.repeat(121) },
      { ...JSON.parse(actionRow(at(D1))), result: 'exploded' },
      { ...JSON.parse(actionRow(at(D1))), result: 7 },
    ]) {
      expect(parseAutofixActionEntry(bad)).toBeNull();
    }
  });

  it('counts malformed and off-contract lines without guessing', () => {
    const { rows, invalidRows } = parseAutofixActionJournal([
      'not json',
      '{"ts":"2026-11-28T08:00:00.000Z"}',
      actionRow(at(D1)),
      '',
      actionRow(at(D2), { result: 'bogus' }),
    ].join('\n'));
    expect(rows).toHaveLength(1);
    expect(invalidRows).toBe(3);
  });
});

describe('parseAutofixIncidentEntry / parseAutofixIncidentJournal', () => {
  it('accepts the writer contract, classes keys through the writer parser, and drops off-contract rows', () => {
    const parsed = parseAutofixIncidentEntry(JSON.parse(incidentRow(at(D1), { key: 'b_runs_ai.ashlr.local-runtime' })));
    expect(parsed).not.toBeNull();
    expect(parsed!.cls).toBe('launchd-crashloop');
    expect(parsed!.key).toBe('b_runs_ai.ashlr.local-runtime');
    expect(parsed!.utcDay).toBe(D1);

    // A prefix the fixer table does not know classes as unknown-prefix.
    const unknown = parseAutofixIncidentEntry(JSON.parse(incidentRow(at(D1), { key: 'z_mystery' })));
    expect(unknown!.cls).toBe('unknown-prefix');

    // Non-adverse statuses still parse — the fold filters them.
    for (const status of ['fixed', 'intentional', 'refused']) {
      expect(parseAutofixIncidentEntry(JSON.parse(incidentRow(at(D1), { status })))).not.toBeNull();
    }

    for (const bad of [
      null, 'x', [],
      { ...JSON.parse(incidentRow(at(D1))), ts: 'not-a-date' },
      { ...JSON.parse(incidentRow(at(D1))), key: 'Bad Key!' },
      { ...JSON.parse(incidentRow(at(D1))), key: '' },
      { ...JSON.parse(incidentRow(at(D1))), key: 'x'.repeat(97) },
      { ...JSON.parse(incidentRow(at(D1))), status: 'exploded' },
      { ...JSON.parse(incidentRow(at(D1))), reason: 42 },
    ]) {
      expect(parseAutofixIncidentEntry(bad)).toBeNull();
    }
  });

  it('counts malformed and off-contract lines without guessing', () => {
    const { rows, invalidRows } = parseAutofixIncidentJournal([
      'not json',
      '{"key":"d_x"}',
      incidentRow(at(D1)),
      '',
      incidentRow(at(D2), { status: 'bogus' }),
    ].join('\n'));
    expect(rows).toHaveLength(1);
    expect(invalidRows).toBe(3);
  });
});

describe('foldAutofixActionCells', () => {
  const rowsOf = (lines: readonly string[]) => parseAutofixActionJournal(lines.join('\n')).rows;

  it('folds adverse results per (fixer, action, result) and ignores non-adverse rows', () => {
    const lines = [
      ...failingAction(() => ({})),
      ...failingAction((d, n) => ({ action: 'renice-20', fixer: 'outside-load', target: String(20000 + n), result: 'failed' })),
      // Non-adverse results: valid records that never join a cell.
      ...[D1, D2, D3].map((d) => actionRow(at(d), { result: 'applied' })),
      ...[D1, D2, D3].map((d) => actionRow(at(d), { result: 'dry-run' })),
      ...[D1, D2, D3].map((d) => actionRow(at(d), { result: 'refused_operator', action: 'disable-keepalive' })),
      // A refusal variant folds under its own result.
      ...[D1, D2, D3].map((d, i) => actionRow(at(d), { fixer: 'launchd-crashloop', target: `ai.ashlr.job${i}`, action: 'disable-keepalive', result: 'refused_admitted' })),
    ];
    const folded = foldAutofixActionCells(rowsOf(lines), { nowMs: NOW_MS });
    expect(folded.map((c) => `${c.fixer}:${c.action}:${c.result}`).sort()).toEqual([
      'launchd-crashloop:disable-keepalive:refused_admitted',
      'outside-load:renice-20:failed',
      'stuck-lane:restart-lane-pool:failed',
    ]);
    const failed = folded.find((c) => c.action === 'restart-lane-pool')!;
    expect(failed.rows).toBe(3);
    expect(failed.units).toBe(1);
    expect(failed.days.size).toBe(3);
    expect(failed.examples).toEqual(['devin-flash']);
    const refused = folded.find((c) => c.result === 'refused_admitted')!;
    expect(refused.units).toBe(3);
  });

  it('keeps sub-bar cells visible to the fold while the items layer applies the recurring bars', () => {
    // Three rows on ONE UTC day: a real cell, but under the days bar.
    const oneDay = foldAutofixActionCells(rowsOf([
      actionRow(at('2026-11-30'), { target: 'a' }),
      actionRow(at('2026-11-30', 9), { target: 'b' }),
      actionRow(at('2026-11-30', 18), { target: 'c' }),
    ]), { nowMs: NOW_MS });
    expect(oneDay).toHaveLength(1);
    expect(oneDay[0]!.rows).toBe(3);
    expect(oneDay[0]!.days.size).toBe(1);

    // One target failing every pass: rows accumulate, units stays 1 — the persistent-failure signal.
    const stuck = foldAutofixActionCells(rowsOf(
      Array.from({ length: 30 }, (_, i) => actionRow(at(D1, i % 24), { target: 'same-lane' })),
    ), { nowMs: NOW_MS });
    expect(stuck).toHaveLength(1);
    expect(stuck[0]!.units).toBe(1);
    expect(stuck[0]!.rows).toBe(30);

    // Rows outside the 7-day window never count.
    const ancient = foldAutofixActionCells(rowsOf([
      actionRow(at('2026-11-01'), { target: 'a' }),
      actionRow(at('2026-11-02'), { target: 'b' }),
      actionRow(at('2026-11-03'), { target: 'c' }),
    ]), { nowMs: NOW_MS });
    expect(ancient).toEqual([]);
  });
});

describe('foldAutofixIncidentCells', () => {
  const rowsOf = (lines: readonly string[]) => parseAutofixIncidentJournal(lines.join('\n')).rows;

  it('folds adverse statuses per (class, status) and ignores fixed/intentional rows', () => {
    const lines = [
      // Three distinct stuck-lane keys failing across three days.
      ...[D1, D2, D3].map((d, i) => incidentRow(at(d), { key: `d_lane-${i}`, status: 'failed', reason: 'restart-lane-pool' })),
      // Three distinct crashloop keys refused across three days.
      ...[D1, D2, D3].map((d, i) => incidentRow(at(d), { key: `b_runs_ai.ashlr.job${i}`, status: 'refused', reason: 'refuse-stale-runs' })),
      // Non-adverse transitions never join a cell.
      ...[D1, D2, D3].map((d, i) => incidentRow(at(d), { key: `d_fixed-${i}`, status: 'fixed', reason: 'restart-lane-pool' })),
      ...[D1, D2, D3].map((d, i) => incidentRow(at(d), { key: `e_load-${i}`, status: 'intentional', reason: 'renice-20' })),
      // An unknown-prefix refusal classes under its own cell.
      ...[D1, D2, D3].map((d, i) => incidentRow(at(d), { key: `z_mystery_${i}`, status: 'refused', reason: 'unknown-prefix' })),
    ];
    const folded = foldAutofixIncidentCells(rowsOf(lines), { nowMs: NOW_MS });
    expect(folded.map((c) => `${c.cls}:${c.status}`).sort()).toEqual([
      'launchd-crashloop:refused',
      'stuck-lane:failed',
      'unknown-prefix:refused',
    ]);
    const failed = folded.find((c) => c.cls === 'stuck-lane')!;
    expect(failed.units).toBe(3);
    expect(failed.rows).toBe(3);
    expect(failed.days.size).toBe(3);
    expect(failed.reasons[0]!.text).toBe('restart-lane-pool');
    expect(failed.examples).toContain('d_lane-0');
  });

  it('keeps sub-bar cells visible to the fold while the items layer applies the recurring bars', () => {
    // One key's transition-deduped rows cannot show recurrence: three rows, one unit.
    const oneKey = foldAutofixIncidentCells(rowsOf([
      incidentRow(at(D1), { key: 'd_same', status: 'failed', reason: 'a' }),
      incidentRow(at(D2), { key: 'd_same', status: 'failed', reason: 'b' }),
      incidentRow(at(D3), { key: 'd_same', status: 'failed', reason: 'c' }),
    ]), { nowMs: NOW_MS });
    expect(oneKey).toHaveLength(1);
    expect(oneKey[0]!.units).toBe(1);
    expect(oneKey[0]!.rows).toBe(3);

    // Rows outside the 7-day window never count.
    const ancient = foldAutofixIncidentCells(rowsOf([
      incidentRow(at('2026-11-01'), { key: 'd_a' }),
      incidentRow(at('2026-11-02'), { key: 'd_b' }),
      incidentRow(at('2026-11-03'), { key: 'd_c' }),
    ]), { nowMs: NOW_MS });
    expect(ancient).toEqual([]);
  });
});

describe('autofixBacklogItems', () => {
  it('emits one item per recurring cell with stable ids, prompts and metadata', async () => {
    const dir = await runsDirWith('runs-all', {
      'autofix.jsonl': [
        ...failingAction((d, n) => ({ target: `lane-${n}` })),
        ...failingAction((d, n) => ({ fixer: 'outside-load', target: String(30000 + n), action: 'renice-20' })),
        ...[D1, D2, D3].map((d, i) => actionRow(at(d), { fixer: 'launchd-crashloop', target: `ai.ashlr.job${i}`, action: 'disable-keepalive', result: 'refused_admitted' })),
        // Non-adverse rows that must not emit.
        ...[D1, D2, D3].map((d) => actionRow(at(d), { result: 'applied' })),
        ...[D1, D2, D3].map((d) => actionRow(at(d), { result: 'refused_operator', action: 'disable-keepalive', fixer: 'launchd-crashloop', target: 'ai.ashlr.op' })),
      ].join('\n') + '\n',
      'incidents.jsonl': [
        ...[D1, D2, D3].map((d, i) => incidentRow(at(d), { key: `d_lane-${i}`, status: 'failed', reason: 'restart-lane-pool' })),
        ...[D1, D2, D3].map((d, i) => incidentRow(at(d), { key: `b_runs_ai.ashlr.job${i}`, status: 'refused', reason: 'refuse-stale-runs' })),
      ].join('\n') + '\n',
    });
    const items = await autofixBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW_MS) });
    expect(items).toHaveLength(5);
    for (const item of items) {
      expect(item.id).toMatch(/^autofix-(action|incident)-[0-9a-f]{16}$/);
      expect(item.priority).toBe(3);
      expect(item.area).toBe('autofix');
      expect(item.repo).toBe('ashlrai/phantom');
      expect(validBacklogItem(item)).not.toBeNull();
      expect(item.prompt).toContain('autofix.jsonl');
      expect(item.prompt).toContain('incidents.jsonl');
      expect(item.prompt).toContain('no-change');
    }
    const failed = items.find((i) => i.title.includes('restart-lane-pool'))!;
    expect(failed.prompt).toContain('lane-0');
    const incidentFailed = items.find((i) => i.title.includes("'stuck-lane' incidents keep failing"))!;
    expect(incidentFailed.prompt).toContain('d_lane-0');
    expect(incidentFailed.prompt).toContain('restart-lane-pool');
    const refusedIncident = items.find((i) => i.title.includes("'launchd-crashloop' incidents keep being refused"))!;
    expect(refusedIncident.prompt).toContain('refuse-stale-runs');
    expect(items.length).toBeLessThanOrEqual(Math.min(AUTOFIX_BACKLOG_MAX_ITEMS, 25));
    const limited = await autofixBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW_MS), limit: 2 });
    expect(limited).toHaveLength(2);
  });

  it('emits nothing below the bars, on missing or unreadable ledgers, or for another repository', async () => {
    // Below the rows bar: two failed rows across two days.
    const few = await runsDirWith('runs-few', {
      'autofix.jsonl': [actionRow(at(D1)), actionRow(at(D2), { target: 'other' })].join('\n') + '\n',
    });
    expect(await autofixBacklogItems({ repo: 'ashlrai/phantom', runsDir: few, now: new Date(NOW_MS) })).toEqual([]);

    // Below the days bar: three rows on one UTC day.
    const oneDay = await runsDirWith('runs-oneday', {
      'autofix.jsonl': [
        actionRow(at('2026-11-30'), { target: 'a' }),
        actionRow(at('2026-11-30', 9), { target: 'b' }),
        actionRow(at('2026-11-30', 18), { target: 'c' }),
      ].join('\n') + '\n',
    });
    expect(await autofixBacklogItems({ repo: 'ashlrai/phantom', runsDir: oneDay, now: new Date(NOW_MS) })).toEqual([]);

    // Below the incidents bar: two distinct keys.
    const fewKeys = await runsDirWith('runs-fewkeys', {
      'incidents.jsonl': [
        incidentRow(at(D1), { key: 'd_a' }),
        incidentRow(at(D2), { key: 'd_b' }),
        incidentRow(at(D3), { key: 'd_c', status: 'fixed' }),
      ].join('\n') + '\n',
    });
    expect(await autofixBacklogItems({ repo: 'ashlrai/phantom', runsDir: fewKeys, now: new Date(NOW_MS) })).toEqual([]);

    // Missing runs dir, missing ledger dir and missing files are the writer's normal states.
    const empty = await runsDirWith('runs-empty', {});
    expect(await autofixBacklogItems({ repo: 'ashlrai/phantom', runsDir: empty, now: new Date(NOW_MS) })).toEqual([]);
    expect(await autofixBacklogItems({ repo: 'ashlrai/phantom', runsDir: join(home, 'no-such'), now: new Date(NOW_MS) })).toEqual([]);

    // A directory where a ledger should be is not a file.
    const dirAsFile = join(home, 'runs-dirfile');
    await mkdir(join(dirAsFile, 'ledger', 'autofix.jsonl'), { recursive: true });
    expect(await autofixBacklogItems({ repo: 'ashlrai/phantom', runsDir: dirAsFile, now: new Date(NOW_MS) })).toEqual([]);

    // Garbage lines are not evidence.
    const junk = await runsDirWith('runs-junk', { 'autofix.jsonl': 'not json\n{"ts":"x"}\n' });
    expect(await autofixBacklogItems({ repo: 'ashlrai/phantom', runsDir: junk, now: new Date(NOW_MS) })).toEqual([]);

    // Another repository never inherits this install's evidence.
    const dir = await runsDirWith('runs-repo', { 'autofix.jsonl': failingAction(() => ({})).join('\n') + '\n' });
    expect(await autofixBacklogItems({ repo: 'ashlrai/other', runsDir: dir, now: new Date(NOW_MS) })).toEqual([]);
    expect(await autofixBacklogItems({ repo: 'not-a-repo', runsDir: dir, now: new Date(NOW_MS) })).toEqual([]);
  });

  it('states truncated tails as lower bounds and counts malformed lines in prompts', async () => {
    // >512 KiB of retained rows: the bounded tail drops the oldest bytes.
    const filler: string[] = [];
    for (let i = 0; i < 4000; i += 1) {
      filler.push(actionRow(at(D1, i % 24), {
        result: 'applied', target: `pad-${i}`, action: `pad-action-${'x'.repeat(60)}`,
        before: { pad: 'y'.repeat(120) }, after: { pad: 'z'.repeat(120) },
      }));
    }
    const dir = await runsDirWith('runs-big', {
      'autofix.jsonl': [...filler, ...failingAction((d, n) => ({ target: `lane-${n}` }))].join('\n') + '\nnot json\n',
    });
    const items = await autofixBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW_MS) });
    expect(items.length).toBeGreaterThan(0);
    expect(items.some((i) => i.prompt.includes('lower bound'))).toBe(true);
    expect(items.some((i) => i.prompt.includes('malformed or off-contract'))).toBe(true);
  }, 30_000);

  it('scrubs secret-shaped text out of ledger strings before it reaches a prompt', async () => {
    const token = '123456789:AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHJ';
    const dir = await runsDirWith('runs-secret', {
      'autofix.jsonl': failingAction(() => ({})).join('\n') + '\n',
      'incidents.jsonl': failingIncident((d, i) => ({
        key: `d_lane-${i}`, status: 'failed', reason: `restart failed ${token}`,
      })).join('\n') + '\n',
    });
    const items = await autofixBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW_MS) });
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.prompt).not.toContain(token);
    }
    expect(items.some((i) => i.prompt.includes('[REDACTED]'))).toBe(true);
  });

  it('derives stable ids so a refresh re-adds nothing', async () => {
    const dir = await runsDirWith('runs-stable', {
      'autofix.jsonl': failingAction((d, n) => ({ target: `lane-${n}` })).join('\n') + '\n',
      'incidents.jsonl': failingIncident((d, i) => ({ key: `d_lane-${i}` })).join('\n') + '\n',
    });
    const opts = { repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW_MS) };
    const first = await autofixBacklogItems(opts);
    const second = await autofixBacklogItems(opts);
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
  });

  it('appends autofix items through discovery and dedupes on refresh', async () => {
    // discoverBacklog anchors the evidence window on the wall clock, so
    // the fixtures use days relative to real now — three distinct UTC
    // days inside the window, like the fixed-date fixtures above.
    const dayAgo = (days: number): string => new Date(Date.now() - days * DAY_MS).toISOString().slice(0, 10);
    const recent = (make: (iso: string, n: number) => Record<string, unknown>): string[] =>
      [1, 2, 3].map((d, i) => actionRow(`${dayAgo(d)}T08:00:00.000Z`, make(`${dayAgo(d)}T08:00:00.000Z`, i)));
    const failedLines = recent((_iso, n) => ({ target: `lane-${n}` }));
    const runsDir = join(home, '.ashlr-runs');
    await mkdir(join(runsDir, 'ledger'), { recursive: true });
    await writeFile(join(runsDir, 'ledger', 'autofix.jsonl'), failedLines.join('\n') + '\n');
    await writeFile(join(runsDir, 'ledger', 'incidents.jsonl'), [
      ...[1, 2, 3].map((d, i) => incidentRow(`${dayAgo(d)}T08:00:00.000Z`, { key: `d_lane-${i}`, status: 'failed' })),
    ].join('\n') + '\n');
    const greenGh = async (args: string[]) => {
      const p = args[4] ?? '';
      if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
    };
    const first = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    const autofixItems = first.items.filter((i) => i.id.startsWith('autofix-'));
    expect(autofixItems).toHaveLength(2);
    expect(autofixItems.some((i) => i.id.startsWith('autofix-action-'))).toBe(true);
    expect(autofixItems.some((i) => i.id.startsWith('autofix-incident-'))).toBe(true);
    expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    expect(appendUserBacklogItems(autofixItems)).toBe(2);
    const second = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('autofix-')))).toBe(0);
    expect(readUserBacklogItems().filter((i) => i.id.startsWith('autofix-'))).toHaveLength(2);
  });
});
