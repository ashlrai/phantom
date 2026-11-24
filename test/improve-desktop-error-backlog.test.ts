import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DESKTOP_ERROR_BACKLOG_MAX_ITEMS,
  DESKTOP_ERROR_MIN_UNITS,
  desktopErrorBacklogItems,
  foldDesktopErrorEvidence,
  parseDesktopErrorEntry,
  parseDesktopErrorLedger,
  type DesktopErrorRow,
} from '../src/core/improve/desktop-error-backlog.js';
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
  home = await mkdtemp(join(tmpdir(), 'improve-desktop-error-'));
  process.env.HOME = home;
});
afterEach(async () => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  await rm(home, { recursive: true, force: true });
});

const D1 = '2026-11-28';
const D2 = '2026-11-29';
const D3 = '2026-11-30';

const FP_QUEUE = '0123456789abcdef';
const FP_FLEET = 'fedcba9876543210';
const FP_ONCE = 'aaaaaaaabbbbbbbb';

const crash = (day: string, hour: number, over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    at: `${day}T${String(hour).padStart(2, '0')}:00:00.000Z`,
    surface: 'fleet.jobs',
    message: 'Cannot read properties of undefined (reading \'tier\')',
    stack: 'TypeError: Cannot read properties of undefined\n    at JobRow (src/web-ui/components/jobs/JobRow.tsx:41:12)',
    componentStack: '\n    at JobRow\n    at JobsPane',
    appVersion: '0.9.1',
    fingerprint: FP_QUEUE,
    ...over,
  });

/** Three records across three UTC days — past both recurring bars for one fingerprint. */
const recurring = (line: (day: string) => string): string[] => [line(D1), line(D2), line(D3)];

const desktopDirFor = async (name: string, files: Record<string, readonly string[]>): Promise<string> => {
  const dir = join(home, name);
  await mkdir(dir, { recursive: true });
  for (const [file, lines] of Object.entries(files)) {
    await writeFile(join(dir, file), lines.length === 0 ? '' : lines.join('\n') + '\n');
  }
  return dir;
};

const row = (day: string, hour: number, over: Partial<DesktopErrorRow> = {}): DesktopErrorRow => ({
  atMs: Date.parse(`${day}T${String(hour).padStart(2, '0')}:00:00.000Z`),
  utcDay: day,
  fingerprint: FP_QUEUE,
  surface: 'fleet.jobs',
  message: 'Cannot read properties of undefined (reading \'tier\')',
  appVersion: '0.9.1',
  stackFrame: 'at JobRow (src/web-ui/components/jobs/JobRow.tsx:41:12)',
  ...over,
});

describe('parseDesktopErrorEntry / parseDesktopErrorLedger', () => {
  it('accepts the writer contract and rejects off-contract rows', () => {
    const parsed = parseDesktopErrorEntry(JSON.parse(crash(D1, 8)));
    expect(parsed).not.toBeNull();
    expect(parsed).toMatchObject({
      surface: 'fleet.jobs',
      fingerprint: FP_QUEUE,
      appVersion: '0.9.1',
      utcDay: D1,
      stackFrame: 'at JobRow (src/web-ui/components/jobs/JobRow.tsx:41:12)',
    });
    // Optional fields may be absent entirely.
    const bare = JSON.parse(crash(D1, 8));
    delete bare['stack'];
    delete bare['componentStack'];
    delete bare['appVersion'];
    const parsedBare = parseDesktopErrorEntry(bare);
    expect(parsedBare).not.toBeNull();
    expect(parsedBare!.appVersion).toBeNull();
    expect(parsedBare!.stackFrame).toBe('');

    for (const bad of [
      null, 'x', [],
      { at: 'not-a-date', surface: 's', message: 'm', fingerprint: 'f' },
      { at: `${D1}T08:00:00.000Z`, surface: '', message: 'm', fingerprint: 'f' },
      { at: `${D1}T08:00:00.000Z`, surface: 's'.repeat(65), message: 'm', fingerprint: 'f' },
      { at: `${D1}T08:00:00.000Z`, surface: 's', message: '', fingerprint: 'f' },
      { at: `${D1}T08:00:00.000Z`, surface: 's', message: 'm' },
      { at: `${D1}T08:00:00.000Z`, surface: 's', message: 'm', fingerprint: '' },
      { at: `${D1}T08:00:00.000Z`, surface: 's', message: 'm', fingerprint: 'f'.repeat(65) },
      { at: `${D1}T08:00:00.000Z`, surface: 's', message: 'm', fingerprint: 'f', stack: 42 },
      { at: `${D1}T08:00:00.000Z`, surface: 's', message: 'm', fingerprint: 'f', appVersion: {} },
      { at: `${D1}T08:00:00.000Z`, surface: 's', message: 'm', fingerprint: 'f', componentStack: null },
    ]) {
      expect(parseDesktopErrorEntry(bad)).toBeNull();
    }
  });

  it('counts malformed and off-contract lines without guessing', () => {
    const { rows: parsed, invalidRows } = parseDesktopErrorLedger([
      'not json',
      '{"at":"2026-11-28T08:00:00.000Z"}',
      crash(D1, 8),
      '',
      crash(D2, 8, { fingerprint: FP_ONCE, message: '' }),
    ].join('\n'));
    expect(parsed).toHaveLength(1);
    expect(invalidRows).toBe(3);
  });
});

describe('foldDesktopErrorEvidence', () => {
  it('folds each recurring fingerprint and ignores rows outside the window', () => {
    const lines = [
      ...recurring((d) => crash(d, 8)),
      ...recurring((d) => crash(d, 9, { fingerprint: FP_FLEET, surface: 'fleet.status', message: 'status feed dropped' })),
      // A one-off fingerprint never reaches the days bar.
      ...[crash(D1, 10, { fingerprint: FP_ONCE, surface: 'chat.draft' })],
    ];
    const { rows: parsed } = parseDesktopErrorLedger(lines.join('\n'));
    const folded = foldDesktopErrorEvidence(parsed, { nowMs: NOW_MS });
    expect(folded.records).toBe(7);
    expect(folded.cells.map((c) => c.fingerprint).sort()).toEqual([FP_FLEET, FP_QUEUE].sort());
    const queue = folded.cells.find((c) => c.fingerprint === FP_QUEUE)!;
    expect(queue.units).toBe(DESKTOP_ERROR_MIN_UNITS);
    expect(queue.days.size).toBe(3);
    expect(queue.surface).toBe('fleet.jobs');
    expect(queue.appVersion).toBe('0.9.1');
    expect(queue.stackFrame).toContain('JobRow');
  });

  it('keeps the newest record\'s display fields when rows arrive out of order', () => {
    const rows = [
      row(D3, 9, { appVersion: '0.9.2', message: 'newer message', stackFrame: 'at Newer (x.tsx:1:1)' }),
      row(D1, 8),
      row(D2, 8),
    ];
    const folded = foldDesktopErrorEvidence(rows, { nowMs: NOW_MS });
    expect(folded.cells).toHaveLength(1);
    const cell = folded.cells[0]!;
    expect(cell.message).toBe('newer message');
    expect(cell.appVersion).toBe('0.9.2');
    expect(cell.stackFrame).toBe('at Newer (x.tsx:1:1)');
    expect(cell.firstAtMs).toBe(Date.parse(`${D1}T08:00:00.000Z`));
    expect(cell.lastAtMs).toBe(Date.parse(`${D3}T09:00:00.000Z`));
  });

  it('stays quiet below the recurring bars and outside the window', () => {
    // Three crashes on ONE UTC day only — a storm, not a recurrence.
    const oneDay = foldDesktopErrorEvidence(
      [row(D3, 8), row(D3, 9), row(D3, 10), row(D3, 11)],
      { nowMs: NOW_MS },
    );
    expect(oneDay.cells).toEqual([]);

    // Two records across two days — under the units bar.
    const two = foldDesktopErrorEvidence([row(D1, 8), row(D2, 8)], { nowMs: NOW_MS });
    expect(two.cells).toEqual([]);

    // Old records outside the 7-day window never count.
    const ancient = foldDesktopErrorEvidence(
      [row('2026-11-10', 8), row('2026-11-11', 8), row('2026-11-12', 8), row('2026-11-13', 8)],
      { nowMs: NOW_MS },
    );
    expect(ancient.records).toBe(0);
    expect(ancient.outsideWindow).toBe(4);
    expect(ancient.cells).toEqual([]);
  });
});

describe('desktopErrorBacklogItems', () => {
  it('emits one item per recurring fingerprint with stable ids, prompts and metadata', async () => {
    const dir = await desktopDirFor('desk-all', {
      'errors.1.jsonl': [crash(D1, 8), crash(D1, 9, { fingerprint: FP_FLEET, surface: 'fleet.status', message: 'status feed dropped' })],
      'errors.jsonl': [
        crash(D2, 8), crash(D2, 9, { fingerprint: FP_FLEET, surface: 'fleet.status', message: 'status feed dropped' }),
        crash(D3, 8), crash(D3, 9, { fingerprint: FP_FLEET, surface: 'fleet.status', message: 'status feed dropped' }),
        // A fingerprint below the bars never emits.
        crash(D3, 10, { fingerprint: FP_ONCE, surface: 'chat.draft', message: 'draft pane threw' }),
      ],
    });
    const items = await desktopErrorBacklogItems({ repo: 'ashlrai/phantom', desktopDir: dir, now: new Date(NOW_MS) });
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.priority === 3 && i.area === 'desktop-console' && i.repo === 'ashlrai/phantom')).toBe(true);
    expect(items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    expect(new Set(items.map((i) => i.id)).size).toBe(2);
    expect(items.every((i) => i.id.startsWith('desktop-error-') && i.id.length <= 120)).toBe(true);

    const queue = items.find((i) => i.title.includes('fleet.jobs'))!;
    const fleet = items.find((i) => i.title.includes('fleet.status'))!;
    expect(queue.prompt).toContain('fleet.jobs');
    expect(queue.prompt).toContain('Cannot read properties of undefined');
    expect(queue.prompt).toContain('JobRow.tsx');
    expect(queue.prompt).toContain('errors.jsonl');
    expect(queue.prompt).toContain('no-change');
    expect(queue.prompt).toContain('3 crash records across 3 UTC days');
    expect(fleet.prompt).toContain('status feed dropped');
  });

  it('emits nothing below the bars, on missing dirs, or for another repository', async () => {
    // Below the units bar: two records across two days.
    const few = await desktopDirFor('desk-few', {
      'errors.jsonl': [crash(D1, 8), crash(D2, 8)],
    });
    expect(await desktopErrorBacklogItems({ repo: 'ashlrai/phantom', desktopDir: few, now: new Date(NOW_MS) })).toEqual([]);

    // Below the days bar: four records on one UTC day.
    const oneDay = await desktopDirFor('desk-oneday', {
      'errors.jsonl': [crash(D3, 8), crash(D3, 9), crash(D3, 10), crash(D3, 11)],
    });
    expect(await desktopErrorBacklogItems({ repo: 'ashlrai/phantom', desktopDir: oneDay, now: new Date(NOW_MS) })).toEqual([]);

    // Missing dir, empty dir, and a file where the dir should be.
    expect(await desktopErrorBacklogItems({ repo: 'ashlrai/phantom', desktopDir: join(home, 'no-such'), now: new Date(NOW_MS) })).toEqual([]);
    const empty = await desktopDirFor('desk-empty', {});
    expect(await desktopErrorBacklogItems({ repo: 'ashlrai/phantom', desktopDir: empty, now: new Date(NOW_MS) })).toEqual([]);
    const file = join(home, 'desk-file');
    await writeFile(file, 'x');
    expect(await desktopErrorBacklogItems({ repo: 'ashlrai/phantom', desktopDir: file, now: new Date(NOW_MS) })).toEqual([]);

    // Garbage ledgers are not evidence.
    const junk = await desktopDirFor('desk-junk', { 'errors.jsonl': ['not json', '{"at":"x"}', ''], 'errors.1.jsonl': ['also not json'] });
    expect(await desktopErrorBacklogItems({ repo: 'ashlrai/phantom', desktopDir: junk, now: new Date(NOW_MS) })).toEqual([]);

    // Another repository never inherits this install's console evidence.
    const dir = await desktopDirFor('desk-repo', {
      'errors.jsonl': [crash(D1, 8), crash(D2, 8), crash(D3, 8)],
    });
    expect(await desktopErrorBacklogItems({ repo: 'ashlrai/other', desktopDir: dir, now: new Date(NOW_MS) })).toEqual([]);
    expect(await desktopErrorBacklogItems({ repo: 'AshlrAI/Phantom', desktopDir: dir, now: new Date(NOW_MS) })).toHaveLength(1);
  });

  it('resolves <runsDir>/desktop when given a runs dir and <home>/.ashlr-runs by default', async () => {
    const runs = await desktopDirFor('desk-runs', {});
    // desktopDirFor made <home>/desk-runs; the feed wants <runsDir>/desktop.
    const desktop = join(runs, 'desktop');
    await mkdir(desktop, { recursive: true });
    await writeFile(join(desktop, 'errors.jsonl'), [crash(D1, 8), crash(D2, 8), crash(D3, 8)].join('\n') + '\n');
    const viaRuns = await desktopErrorBacklogItems({ repo: 'ashlrai/phantom', runsDir: runs, now: new Date(NOW_MS) });
    expect(viaRuns).toHaveLength(1);

    // Default resolution: <home>/.ashlr-runs/desktop under the relocated HOME.
    const def = join(home, '.ashlr-runs', 'desktop');
    await mkdir(def, { recursive: true });
    await writeFile(join(def, 'errors.jsonl'), [crash(D1, 8), crash(D2, 8), crash(D3, 8)].join('\n') + '\n');
    const viaHome = await desktopErrorBacklogItems({ repo: 'ashlrai/phantom', homeDir: home, now: new Date(NOW_MS) });
    expect(viaHome).toHaveLength(1);
  });

  it('states truncated ledger tails as lower bounds and scrubs journal strings', async () => {
    // >3 MiB of retained rows in the live file: the bounded tail drops
    // the oldest bytes, so every count is a lower bound.
    const filler: string[] = [];
    for (let i = 0; i < 30000; i += 1) {
      filler.push(crash(D3, i % 24, { fingerprint: `pad${i}`, surface: 'pad.surface', message: `pad-${i}` }));
    }
    const dir = await desktopDirFor('desk-big', {
      // The recurring cell's D1/D2 rows live in the rotation; its D3
      // row sits at the live file's tail so the bounded read retains it.
      'errors.1.jsonl': [crash(D1, 8), crash(D2, 8)],
      'errors.jsonl': [...filler, crash(D3, 8)],
    });
    const items = await desktopErrorBacklogItems({ repo: 'ashlrai/phantom', desktopDir: dir, now: new Date(NOW_MS) });
    expect(items).toHaveLength(1);
    expect(items[0]!.prompt).toContain('lower bound');
  }, 30_000);

  it('scrubs secret-shaped text out of journal messages before it reaches a prompt', async () => {
    const token = '123456789:AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHJ';
    const dir = await desktopDirFor('desk-secret', {
      'errors.jsonl': recurring((d) => crash(d, 8, { message: `render failed ${token}` })),
    });
    const items = await desktopErrorBacklogItems({ repo: 'ashlrai/phantom', desktopDir: dir, now: new Date(NOW_MS) });
    expect(items).toHaveLength(1);
    expect(items[0]!.prompt).not.toContain(token);
    expect(items[0]!.prompt).toContain('[REDACTED]');
  });

  it('honours the item limit and derives stable ids across calls', async () => {
    const dir = await desktopDirFor('desk-stable', {
      'errors.jsonl': [
        ...recurring((d) => crash(d, 8)),
        ...recurring((d) => crash(d, 9, { fingerprint: FP_FLEET, surface: 'fleet.status', message: 'status feed dropped' })),
        ...recurring((d) => crash(d, 10, { fingerprint: '9999999999999999', surface: 'chat.draft', message: 'draft pane threw' })),
      ],
    });
    const opts = { repo: 'ashlrai/phantom', desktopDir: dir, now: new Date(NOW_MS) };
    const first = await desktopErrorBacklogItems(opts);
    const second = await desktopErrorBacklogItems(opts);
    expect(first).toHaveLength(3);
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
    const limited = await desktopErrorBacklogItems({ ...opts, limit: 2 });
    expect(limited).toHaveLength(2);
    expect(limited.length).toBeLessThanOrEqual(Math.min(DESKTOP_ERROR_BACKLOG_MAX_ITEMS, 25));
  });

  it('appends desktop-error items through discovery and dedupes on refresh', async () => {
    // discoverBacklog anchors the evidence window on the wall clock, so
    // the fixtures use days relative to real now — three distinct UTC
    // days inside the window, like the fixed-date fixtures above.
    const dayAgo = (days: number): string => new Date(Date.now() - days * DAY_MS).toISOString().slice(0, 10);
    const iso = (days: number): string => `${dayAgo(days)}T08:00:00.000Z`;
    const line = (days: number, fingerprint: string, surface: string, message: string): string =>
      JSON.stringify({ at: iso(days), surface, message, fingerprint });
    const desktop = join(home, '.ashlr-runs', 'desktop');
    await mkdir(desktop, { recursive: true });
    await writeFile(
      join(desktop, 'errors.jsonl'),
      [1, 2, 3].map((d) => [
        line(d, FP_QUEUE, 'fleet.jobs', 'Cannot read properties of undefined'),
        line(d, FP_FLEET, 'fleet.status', 'status feed dropped'),
      ].join('\n')).join('\n') + '\n',
    );
    const greenGh = async (args: string[]) => {
      const p = args[4] ?? '';
      if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
    };
    const first = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    const items = first.items.filter((i) => i.id.startsWith('desktop-error-'));
    expect(items).toHaveLength(2);
    expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    expect(appendUserBacklogItems(items)).toBe(2);
    const second = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('desktop-error-')))).toBe(0);
    expect(readUserBacklogItems().filter((i) => i.id.startsWith('desktop-error-'))).toHaveLength(2);
  });
});
