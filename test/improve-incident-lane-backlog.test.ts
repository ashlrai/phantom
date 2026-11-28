import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  INCIDENT_LANE_BACKLOG_MAX_ITEMS,
  INCIDENT_LANE_MIN_DAYS,
  INCIDENT_LANE_MIN_UNITS,
  foldIncidentLaneEvidence,
  incidentLaneBacklogItems,
  parseIncidentLaneJournal,
  parseIncidentLaneRow,
} from '../src/core/improve/incident-lane-backlog.js';
import { discoverBacklog } from '../src/core/improve/discover.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';

const NOW_MS = Date.parse('2026-12-01T12:00:00.000Z');
const JOURNAL = join('ledger', 'incident-lane.jsonl');
const DAY_MS = 24 * 60 * 60 * 1000;

let home: string;
let saved: Record<string, string | undefined>;
beforeEach(async () => {
  saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME, ASHLR_RUNS_DIR: process.env.ASHLR_RUNS_DIR };
  delete process.env.ASHLR_HOME;
  delete process.env.ASHLR_RUNS_DIR;
  home = await mkdtemp(join(tmpdir(), 'improve-incidentlane-'));
  process.env.HOME = home;
});
afterEach(async () => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  await rm(home, { recursive: true, force: true });
});

const D1 = '2026-11-28';
const D2 = '2026-11-29';
const at = (day: string, hour = 8): string => `${day}T${String(hour).padStart(2, '0')}:00:00.000Z`;

const KEY_B = 'b-exit-ai-ashlr-reader1-1-f0931f4a';
const KEY_D = 'd-claude-e36ccd03';
const KEY_E = 'e-load-27c06532';
const KEY_G = 'g-v3-30-74-audit-absent-will-look-again-6a882771';
const KEY_A = 'a-phantom-v3-30-88-9771ca4a';

const row = (ts: string, key: string, event: string, detail = ''): string =>
  JSON.stringify({ ts, key, event, detail });

const endedEmpty = (day: string, key = KEY_B, hour = 8): string => row(at(day, hour), key, 'ended', 'EMPTY');
const endedSilent = (day: string, key: string, hour = 8): string => row(at(day, hour), key, 'ended', '');
const endedOther = (day: string, key: string, token: string, hour = 8): string => row(at(day, hour), key, 'ended', token);
const requeued = (day: string, key: string, hour = 8): string => row(at(day, hour), key, 'requeued', '');
const reopened = (day: string, key: string, hour = 8): string => row(at(day, hour), key, 'queued', 'reopened');
const lifecycle = (day: string, key: string, hour = 8): string[] => [
  row(at(day, hour), key, 'launched', 'codex-personal'),
  row(at(day, hour + 1), key, 'done', 'pr'),
  row(at(day, hour + 2), key, 'closed', 'resolved'),
  row(at(day, hour + 3), key, 'report', 'DETECTED'),
  row(at(day, hour + 4), key, 'queued', ''),
];

/** Two rows on two distinct UTC days — past both recurring bars for one cell. */
const recurring = (make: (day: string) => string): string[] => [make(D1), make(D2)];

const runsDir = async (name: string, lines: readonly string[]): Promise<string> => {
  const dir = join(home, name);
  await mkdir(join(dir, 'ledger'), { recursive: true });
  await writeFile(join(dir, JOURNAL), lines.join('\n') + '\n');
  return dir;
};

describe('parseIncidentLaneRow / parseIncidentLaneJournal', () => {
  it('accepts the writer contract and rejects off-contract rows honestly', () => {
    const parsed = parseIncidentLaneRow(JSON.parse(row(at(D1), KEY_B, 'ended', 'EMPTY')));
    expect(parsed).not.toBeNull();
    expect(parsed!.prefix).toBe('b');
    expect(parsed!.utcDay).toBe(D1);
    expect(parsed!.event).toBe('ended');
    expect(parsed!.detail).toBe('EMPTY');

    const invalid = [
      null, 'x', [],
      { ts: at(D1), key: KEY_B, event: 'ended' },
      { ts: at(D1), key: KEY_B, event: 'ended', detail: 7 },
      { ts: 'not-a-date', key: KEY_B, event: 'ended', detail: '' },
      { ts: at(D1), key: 'BAD KEY!', event: 'ended', detail: '' },
      { ts: at(D1), key: 'x-load-27c06532', event: 'ended', detail: '' },
      { ts: at(D1), key: 'e-load', event: 'ended', detail: '' },
      { ts: at(D1), key: KEY_B, event: 'exploded', detail: '' },
    ];
    for (const bad of invalid) {
      expect(parseIncidentLaneRow(bad)).toBeNull();
    }
    // Extra fields do not violate the contract — the writer's four fields must hold.
    expect(parseIncidentLaneRow({ ts: at(D1), key: KEY_B, event: 'ended', detail: '', extra: 1 })).not.toBeNull();
  });

  it('counts malformed and off-contract lines without guessing', () => {
    const { rows, invalidRows } = parseIncidentLaneJournal([
      'not json',
      '{"ts":"2026-11-28T08:00:00.000Z","key":"e-load"}',
      row(at(D1), KEY_B, 'ended', 'EMPTY'),
      '',
      row(at(D2), KEY_B, 'bogus-event', ''),
    ].join('\n'));
    expect(rows).toHaveLength(1);
    expect(invalidRows).toBe(3);
  });
});

describe('foldIncidentLaneEvidence', () => {
  const rowsOf = (lines: readonly string[]) => parseIncidentLaneJournal(lines.join('\n')).rows;

  it('folds each adverse cell at the recurring bars and treats designed outcomes as context', () => {
    const lines = [
      ...recurring((d) => endedEmpty(d, KEY_B)),
      ...recurring((d) => endedEmpty(d, KEY_G)),
      ...recurring((d) => endedSilent(d, KEY_D)),
      ...recurring((d) => endedSilent(d, KEY_A)),   // second prefix folds into the same aggregate
      ...recurring((d) => requeued(d, KEY_E)),
      ...recurring((d) => reopened(d, KEY_E)),
      ...recurring((d) => endedOther(d, KEY_A, 'BLOCKED')),
      // Designed outcomes: launches, PRs, closes, reports, first-time queues — never cells.
      ...lifecycle(D1, KEY_B),
      ...lifecycle(D2, KEY_D),
    ];
    const folded = foldIncidentLaneEvidence(rowsOf(lines), { nowMs: NOW_MS });
    expect(folded.records).toBe(24);
    expect(folded.cells.map((c) => `${c.kind}:${c.prefix}`).sort()).toEqual([
      'ended-empty:b',
      'ended-empty:g',
      'ended-other:a',
      'ended-silent:all',
      'reopened:e',
      'requeued:e',
    ]);
    const silent = folded.cells.find((c) => c.kind === 'ended-silent')!;
    expect(silent.units).toBe(4); // two prefixes × two days
    expect(silent.days.size).toBe(2);
    const emptyB = folded.cells.find((c) => c.kind === 'ended-empty' && c.prefix === 'b')!;
    expect(emptyB.units).toBe(INCIDENT_LANE_MIN_UNITS);
    expect(emptyB.days.size).toBe(INCIDENT_LANE_MIN_DAYS);
    const other = folded.cells.find((c) => c.kind === 'ended-other')!;
    expect(other.samples).toEqual(['BLOCKED']);
    // Context tallies: launches and done(PR) land on the prefix, never as cells.
    expect(folded.prefixes.get('b')?.launches).toBe(1);
    expect(folded.prefixes.get('b')?.done).toBe(1);
    expect(folded.prefixes.get('b')?.closed).toBe(1);
  });

  it('stays quiet below the recurring bars and outside the window', () => {
    // One row on one day — under both bars.
    const one = foldIncidentLaneEvidence(rowsOf([endedEmpty(D1, KEY_B)]), { nowMs: NOW_MS });
    expect(one.cells).toEqual([]);

    // Two rows on ONE UTC day — units met, days not.
    const sameDay = foldIncidentLaneEvidence(rowsOf([
      endedEmpty('2026-11-30', KEY_B, 8), endedEmpty('2026-11-30', KEY_B, 20),
    ]), { nowMs: NOW_MS });
    expect(sameDay.cells).toEqual([]);

    // Rows outside the 7-day window never count.
    const stale = foldIncidentLaneEvidence(rowsOf([
      endedEmpty('2026-11-20', KEY_B), endedEmpty('2026-11-21', KEY_B),
      endedEmpty('2026-11-22', KEY_B), endedEmpty('2026-11-23', KEY_B),
    ]), { nowMs: NOW_MS });
    expect(stale.records).toBe(0);
    expect(stale.outsideWindow).toBe(4);
    expect(stale.cells).toEqual([]);
  });
});

describe('incidentLaneBacklogItems', () => {
  it('emits one item per recurring cell with stable ids, prompts and metadata', async () => {
    const lines = [
      ...recurring((d) => endedEmpty(d, KEY_B)),
      ...recurring((d) => endedSilent(d, KEY_D)),
      ...recurring((d) => requeued(d, KEY_E)),
      ...recurring((d) => reopened(d, KEY_E)),
      ...lifecycle(D1, KEY_B),
    ];
    const dir = await runsDir('runs-all', lines);
    const items = await incidentLaneBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW_MS) });
    expect(items.map((i) => i.id).sort()).toEqual([
      'incidentlane-ended-empty-b',
      'incidentlane-ended-silent-all',
      'incidentlane-reopened-e',
      'incidentlane-requeued-e',
    ]);
    expect(items.every((i) => i.priority === 3 && i.area === 'fleet-incident-lane' && i.repo === 'ashlrai/phantom')).toBe(true);
    expect(items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    const empty = items.find((i) => i.id === 'incidentlane-ended-empty-b')!;
    expect(empty.prompt).toContain('ledger/incident-lane.jsonl');
    expect(empty.prompt).toContain("detector 'b'");
    expect(empty.prompt).toContain('RESULT EMPTY');
    expect(empty.prompt).toContain('src/core/autofix');
    const silent = items.find((i) => i.id === 'incidentlane-ended-silent-all')!;
    expect(silent.prompt).toContain('no RESULT line');
    expect(silent.prompt).toContain('metrics/jobs.jsonl');
    const req = items.find((i) => i.id === 'incidentlane-requeued-e')!;
    expect(req.prompt).toContain('requeued');
    expect(req.prompt).toContain("detector 'e'");
    const reo = items.find((i) => i.id === 'incidentlane-reopened-e')!;
    expect(reo.prompt).toContain('reopened');
    // Context tallies reach the prompts: prefix b saw one launch and one PR.
    expect(empty.prompt).toContain('1 launch(es)');
    expect(empty.prompt).toContain('1 done(PR)');
    // Deterministic cap respected.
    expect(items.length).toBeLessThanOrEqual(Math.min(INCIDENT_LANE_BACKLOG_MAX_ITEMS, 25));
    const limited = await incidentLaneBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW_MS), limit: 2 });
    expect(limited).toHaveLength(2);
  });

  it('emits nothing below the bars, on missing or unreadable journals, or for another repository', async () => {
    // Below the bars: a single ended-EMPTY on one day.
    const few = await runsDir('runs-few', [endedEmpty(D1, KEY_B)]);
    expect(await incidentLaneBacklogItems({ repo: 'ashlrai/phantom', runsDir: few, now: new Date(NOW_MS) })).toEqual([]);

    // Missing runs dir and missing journal.
    const empty = await runsDir('runs-empty', []);
    await rm(join(empty, JOURNAL));
    expect(await incidentLaneBacklogItems({ repo: 'ashlrai/phantom', runsDir: empty, now: new Date(NOW_MS) })).toEqual([]);
    expect(await incidentLaneBacklogItems({ repo: 'ashlrai/phantom', runsDir: join(home, 'no-such'), now: new Date(NOW_MS) })).toEqual([]);

    // A directory where the journal should be is not a file.
    const dirAsFile = join(home, 'runs-dirfile');
    await mkdir(join(dirAsFile, 'ledger', 'incident-lane.jsonl'), { recursive: true });
    expect(await incidentLaneBacklogItems({ repo: 'ashlrai/phantom', runsDir: dirAsFile, now: new Date(NOW_MS) })).toEqual([]);

    // Garbage lines are not evidence.
    const junk = await runsDir('runs-junk', ['not json', '{"ts":"x"}', '']);
    expect(await incidentLaneBacklogItems({ repo: 'ashlrai/phantom', runsDir: junk, now: new Date(NOW_MS) })).toEqual([]);

    // Another repository never inherits this install's evidence.
    const dir = await runsDir('runs-repo', recurring((d) => endedEmpty(d, KEY_B)));
    expect(await incidentLaneBacklogItems({ repo: 'ashlrai/other', runsDir: dir, now: new Date(NOW_MS) })).toEqual([]);
    expect(await incidentLaneBacklogItems({ repo: 'AshlrAI/Phantom', runsDir: dir, now: new Date(NOW_MS) })).toHaveLength(1);
  });

  it('states truncated tails as lower bounds and scrubs journal strings in prompts', async () => {
    // >1 MiB of retained rows: the bounded tail drops the oldest bytes.
    const filler: string[] = [];
    for (let i = 0; i < 12000; i += 1) {
      filler.push(row(at(D1, i % 24), KEY_B, 'closed', `pad-${i}`));
    }
    const dir = await runsDir('runs-big', [...filler, ...recurring((d) => endedEmpty(d, KEY_B))]);
    const items = await incidentLaneBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW_MS) });
    expect(items.length).toBeGreaterThan(0);
    expect(items.some((i) => i.prompt.includes('lower bound'))).toBe(true);
  }, 30_000);

  it('scrubs secret-shaped text out of journal details before it reaches a prompt', async () => {
    const token = '123456789:AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHJ';
    const dir = await runsDir('runs-secret', recurring((d) => endedOther(d, KEY_A, `BLOCKED ${token}`)));
    const items = await incidentLaneBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW_MS) });
    expect(items).toHaveLength(1);
    expect(items[0]!.prompt).not.toContain(token);
    expect(items[0]!.prompt).toContain('[REDACTED]');
  });

  it('derives stable ids so a refresh re-adds nothing', async () => {
    const dir = await runsDir('runs-stable', [
      ...recurring((d) => endedEmpty(d, KEY_B)),
      ...recurring((d) => requeued(d, KEY_E)),
    ]);
    const opts = { repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW_MS) };
    const first = await incidentLaneBacklogItems(opts);
    const second = await incidentLaneBacklogItems(opts);
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
  });

  it('appends incident-lane items through discovery and dedupes on refresh', async () => {
    const runs = join(home, '.ashlr-runs');
    await mkdir(join(runs, 'ledger'), { recursive: true });
    // discoverBacklog anchors the evidence window on the wall clock, so
    // the fixtures use days relative to real now — two distinct UTC days
    // inside the window, like the fixed-date fixtures above.
    const dayAgo = (days: number): string => new Date(Date.now() - days * DAY_MS).toISOString().slice(0, 10);
    const recent = (make: (day: string) => string): string[] => [1, 2].map((d) => make(`${dayAgo(d)}T08:00:00.000Z`));
    const lines = [
      ...recent((iso) => row(iso, KEY_B, 'ended', 'EMPTY')),
      ...recent((iso) => row(iso, KEY_D, 'ended', '')),
    ];
    await writeFile(join(runs, JOURNAL), lines.join('\n') + '\n');
    const greenGh = async (args: string[]) => {
      const p = args[4] ?? '';
      if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
    };
    const first = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    const laneItems = first.items.filter((i) => i.id.startsWith('incidentlane-'));
    expect(laneItems.map((i) => i.id).sort()).toEqual(['incidentlane-ended-empty-b', 'incidentlane-ended-silent-all']);
    expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    expect(appendUserBacklogItems(laneItems)).toBe(2);
    const second = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('incidentlane-')))).toBe(0);
    expect(readUserBacklogItems().filter((i) => i.id.startsWith('incidentlane-'))).toHaveLength(2);
  });
});
