import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { discoverBacklog } from '../src/core/improve/discover.js';
import {
  foldLiveConfigAuditRows,
  liveConfigBacklogItems,
  parseLiveConfigAuditJournal,
} from '../src/core/improve/live-config-backlog.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';

let home: string;
let saved: { HOME?: string; ASHLR_HOME?: string; ASHLR_RUNS_DIR?: string };
beforeEach(() => {
  saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME, ASHLR_RUNS_DIR: process.env.ASHLR_RUNS_DIR };
  delete process.env.ASHLR_HOME;
  delete process.env.ASHLR_RUNS_DIR;
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'improve-liveconfig-')));
  process.env.HOME = home;
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(home, { recursive: true, force: true });
});

const NOW = new Date('2026-11-23T12:00:00Z');
/** ISO timestamp `days` before NOW (fractional hours allowed via `hours`). */
const at = (days: number, hours = 0): string =>
  new Date(NOW.getTime() - days * 86400_000 + hours * 3600_000).toISOString();

const REPO = 'ashlrai/phantom';

interface Row {
  v?: number;
  at?: string;
  op?: string;
  key?: string;
  from?: number | null;
  to?: number | null;
  by?: string;
  reason?: string;
}

const row = (key: string, op: 'set' | 'unset', days: number, to: number | null = 4, by = 'cli-actor', reason = 'tuning'): Row => ({
  v: 1, at: at(days), op, key, from: null, to, by, reason,
});

const journal = (rows: Array<Row | string>): string =>
  rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n';

const writeJournal = (rows: Array<Row | string> | string): string => {
  const dir = path.join(home, 'runs', 'queue');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'live-config-audit.jsonl');
  fs.writeFileSync(file, typeof rows === 'string' ? rows : journal(rows));
  return file;
};

/** Three changes on lanes.work.target across two UTC days — recurring lane-bound churn. */
const churnRows = (key = 'lanes.work.target'): Row[] => [
  row(key, 'set', 1, 6),
  row(key, 'set', 2, 8, 'leader'),
  row(key, 'unset', 4, null),
];

describe('parseLiveConfigAuditJournal', () => {
  it('validates rows against the writer contract and skips malformed lines', () => {
    const rows = parseLiveConfigAuditJournal(journal([
      'not json',
      '{"v":2,"at":"' + at(1) + '","op":"set","key":"hard_cap"}',
      '{"v":1,"at":"' + at(1) + '","op":"bogus","key":"hard_cap"}',
      '{"v":1,"at":"soon","op":"set","key":"hard_cap"}',
      '{"v":1,"at":"' + at(1) + '","op":"set"}',
      '{"v":1,"at":"' + at(1) + '","op":"set","key":"bad key!"}',
      { v: 1, at: at(1), op: 'set', key: 'hard_cap', to: 12, by: 'actor-a', reason: 'raise cap' },
      { v: 1, at: at(2), op: 'unset', key: 'autofill.off', to: null, by: 'actor-b', reason: 'stop autofill' },
    ]));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ op: 'set', key: 'hard_cap', to: 12, by: 'actor-a' });
    expect(rows[1]).toMatchObject({ op: 'unset', key: 'autofill.off', to: null, by: 'actor-b' });
  });

  it('marks well-formed rows with off-vocabulary keys as key null', () => {
    const rows = parseLiveConfigAuditJournal(journal([
      row('auth.token', 'set', 1, 1),
      row('lanes.Work.target', 'set', 1, 2),
      row('retired.old.key', 'unset', 1, null),
      row('lanes.work.target', 'set', 1, 4),
    ]));
    expect(rows).toHaveLength(4);
    expect(rows[0]!.key).toBeNull();
    expect(rows[1]!.key).toBeNull();
    expect(rows[2]!.key).toBeNull();
    expect(rows[3]!.key).toBe('lanes.work.target');
  });

  it('keeps the change when auxiliary fields are malformed but the envelope is sound', () => {
    const rows = parseLiveConfigAuditJournal(journal([
      { v: 1, at: at(1), op: 'set', key: 'hard_cap', to: 'lots', by: 42, reason: 'x' },
      { v: 1, at: at(1), op: 'unset', key: 'hard_cap' },
    ]));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ key: 'hard_cap', to: null, by: null });
    expect(rows[1]).toMatchObject({ key: 'hard_cap', op: 'unset', to: null });
  });
});

describe('foldLiveConfigAuditRows', () => {
  it('folds per-key churn with ops, actors, values and days; off-contract rows fold globally', () => {
    const fold = foldLiveConfigAuditRows(parseLiveConfigAuditJournal(journal([
      ...churnRows('lanes.work.target'),
      row('hard_cap', 'set', 1, 24),
      row('auth.token', 'set', 1, 1),
      row('auth.token', 'unset', 3, null),
    ])), NOW.getTime());
    const work = fold.churn.get('lanes.work.target');
    expect(work?.rows).toBe(3);
    expect(work?.sets).toBe(2);
    expect(work?.unsets).toBe(1);
    expect(work?.days.size).toBe(3);
    expect(work?.actors.size).toBe(2);
    expect([...work!.values].sort((a, b) => a - b)).toEqual([6, 8]);
    expect(fold.churn.get('hard_cap')?.rows).toBe(1);
    expect(fold.offContract.rows).toBe(2);
    expect(fold.offContract.days.size).toBe(2);
  });

  it('drops rows outside the 7-day window', () => {
    const stale = churnRows().map((r) => ({ ...r, at: at(10) }));
    const fold = foldLiveConfigAuditRows(parseLiveConfigAuditJournal(journal(stale)), NOW.getTime());
    expect(fold.churn.size).toBe(0);
    expect(fold.offContract.rows).toBe(0);
  });
});

describe('liveConfigBacklogItems', () => {
  it('turns recurring lane-bound churn into a valid priority-3 backlog item', async () => {
    const items = await liveConfigBacklogItems({ repo: REPO, journalPath: writeJournal(churnRows()), now: NOW });
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(item.id).toMatch(/^live-config-churn-[0-9a-f]{16}$/);
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item).toMatchObject({ priority: 3, repo: REPO, area: 'live-config' });
    expect(item.title).toContain('lanes.work.target');
    expect(item.prompt).toContain('3 change row(s) for `lanes.work.target` across 3 distinct UTC day(s)');
    expect(item.prompt).toContain("2 'set' and 1 'unset' op(s)");
    expect(item.prompt).toContain('2 distinct recorded actor(s)');
    expect(item.prompt).toContain('live-config-audit.jsonl');
    expect(item.prompt).toContain('fleet-config.ts');
    expect(item.prompt).toContain('lane-adapt');
    expect(item.prompt).toContain('no-change');
  });

  it('keeps churn quiet below the row or day bar', async () => {
    const few = await liveConfigBacklogItems({
      repo: REPO, now: NOW,
      journalPath: writeJournal([row('hard_cap', 'set', 1, 24), row('hard_cap', 'set', 3, 24)]),
    });
    expect(few).toEqual([]);
    const oneDay = await liveConfigBacklogItems({
      repo: REPO, now: NOW,
      journalPath: writeJournal([
        row('hard_cap', 'set', 1, 24), row('hard_cap', 'set', 1, 30, 'leader'), row('hard_cap', 'unset', 1, null),
      ]),
    });
    expect(oneDay).toEqual([]);
  });

  it('tailors kill-switch and fleet-cap prompts to the key class', async () => {
    const kill = await liveConfigBacklogItems({
      repo: REPO, now: NOW,
      journalPath: writeJournal([
        row('autofill.off', 'set', 1, 1), row('autofill.off', 'unset', 2, null), row('autofill.off', 'set', 4, 1),
      ]),
    });
    expect(kill).toHaveLength(1);
    expect(kill[0]!.prompt).toContain('kill switch');
    expect(kill[0]!.prompt).toContain('stops self-tick from filling starved lanes');
    expect(kill[0]!.prompt).toContain('alternate between writing and removing');
    const cap = await liveConfigBacklogItems({
      repo: REPO, now: NOW,
      journalPath: writeJournal(churnRows('hard_cap')),
    });
    expect(cap).toHaveLength(1);
    expect(cap[0]!.prompt).toContain('fleet-wide slot cap');
  });

  it('folds recurring off-contract rows into one global item', async () => {
    const items = await liveConfigBacklogItems({
      repo: REPO, now: NOW,
      journalPath: writeJournal([
        row('auth.token', 'set', 1, 1),
        row('retired.old.key', 'set', 2, 2, 'other-actor'),
        row('auth.token', 'unset', 4, null),
      ]),
    });
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(item.id).toMatch(/^live-config-off-contract-[0-9a-f]{16}$/);
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item.prompt).toContain('3 off-contract change row(s)');
    expect(item.prompt).toContain('outside the writer\'s current mutable vocabulary');
    expect(item.prompt).not.toContain('auth.token');
  });

  it('keeps off-contract rows quiet below the recurring bar', async () => {
    const items = await liveConfigBacklogItems({
      repo: REPO, now: NOW,
      journalPath: writeJournal([row('auth.token', 'set', 1, 1), row('auth.token', 'set', 3, 2)]),
    });
    expect(items).toEqual([]);
  });

  it('emits churn and off-contract items in a fixed order and honours the limit', async () => {
    const rows: Row[] = [
      ...churnRows('lanes.work.target'),
      ...churnRows('hard_cap'),
      row('auth.token', 'set', 1, 1), row('auth.token', 'set', 2, 2), row('auth.token', 'unset', 4, null),
    ];
    const items = await liveConfigBacklogItems({ repo: REPO, journalPath: writeJournal(rows), now: NOW });
    expect(items).toHaveLength(3);
    expect(items[0]!.id).toMatch(/^live-config-off-contract-/);
    expect(items.map((i) => i.id).slice(1).every((id) => id.startsWith('live-config-churn-'))).toBe(true);
    const one = await liveConfigBacklogItems({ repo: REPO, journalPath: writeJournal(rows), now: NOW, limit: 1 });
    expect(one).toHaveLength(1);
    expect(one[0]!.id).toBe(items[0]!.id);
  });

  it('emits only for the fleet repository', async () => {
    const file = writeJournal(churnRows());
    expect(await liveConfigBacklogItems({ repo: 'ashlrai/lexicon', journalPath: file, now: NOW })).toEqual([]);
    expect(await liveConfigBacklogItems({ repo: '', journalPath: file, now: NOW })).toEqual([]);
    expect(await liveConfigBacklogItems({ repo: 'not-a-repo', journalPath: file, now: NOW })).toEqual([]);
    const items = await liveConfigBacklogItems({ repo: 'AshlrAI/Phantom', journalPath: file, now: NOW });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ repo: 'AshlrAI/Phantom' });
  });

  it('yields nothing for a missing or malformed journal', async () => {
    expect(await liveConfigBacklogItems({ repo: REPO, journalPath: path.join(home, 'no-such.jsonl'), now: NOW })).toEqual([]);
    const file = writeJournal([
      'not json',
      '{"v":1,"at":"' + at(1) + '","op":"set","key":"hard_cap"}',
      '{"v":1,"at":"' + at(1) + '","op":"set","key":"bad key!"}',
    ]);
    expect(await liveConfigBacklogItems({ repo: REPO, journalPath: file, now: NOW })).toEqual([]);
  });

  it('derives stable ids so a refresh re-adds nothing', async () => {
    const file = writeJournal(churnRows());
    const first = await liveConfigBacklogItems({ repo: REPO, journalPath: file, now: NOW });
    const second = await liveConfigBacklogItems({ repo: REPO, journalPath: file, now: NOW });
    expect(first).toHaveLength(1);
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
    const grown = writeJournal([...churnRows(), row('lanes.work.target', 'set', 5, 9, 'third-actor')]);
    const third = await liveConfigBacklogItems({ repo: REPO, journalPath: grown, now: NOW });
    expect(third.map((i) => i.id)).toEqual(first.map((i) => i.id));
  });

  it('never emits actor or reason text, even when it is secret-shaped', async () => {
    const token = `ghp_${'a'.repeat(36)}`;
    const actor = `actor-${token}`;
    const items = await liveConfigBacklogItems({
      repo: REPO, now: NOW,
      journalPath: writeJournal([
        { v: 1, at: at(1), op: 'set', key: 'hard_cap', to: 8, by: actor, reason: `because ${token}` },
        { v: 1, at: at(2), op: 'set', key: 'hard_cap', to: 9, by: actor, reason: `still ${token}` },
        { v: 1, at: at(4), op: 'unset', key: 'hard_cap', to: null, by: 'plain-actor', reason: 'done' },
      ]),
    });
    expect(items).toHaveLength(1);
    expect(items[0]!.prompt).not.toContain(token);
    expect(items[0]!.prompt).not.toContain(actor);
    expect(items[0]!.prompt).not.toContain('because');
    expect(items[0]!.prompt).toContain('2 distinct recorded actor(s)');
  });

  it('reads the default journal path under the runs dir', async () => {
    process.env.ASHLR_RUNS_DIR = path.join(home, 'runs');
    writeJournal(churnRows());
    const items = await liveConfigBacklogItems({ repo: REPO, now: NOW });
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toMatch(/^live-config-churn-/);
  });

  it('appends live-config items through discovery and dedupes on refresh', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    try {
      process.env.ASHLR_RUNS_DIR = path.join(home, 'runs');
      writeJournal(churnRows());
      const greenGh = async (args: string[]) => {
        const p = args[4] ?? '';
        if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
        return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
      };
      const first = await discoverBacklog(REPO, { gh: greenGh });
      const live = first.items.filter((i) => i.id.startsWith('live-config-'));
      expect(live).toHaveLength(1);
      expect(live[0]!.id).toMatch(/^live-config-churn-/);
      expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
      expect(appendUserBacklogItems(live)).toBe(live.length);
      const second = await discoverBacklog(REPO, { gh: greenGh });
      expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('live-config-')))).toBe(0);
      expect(readUserBacklogItems().filter((i) => i.id.startsWith('live-config-'))).toHaveLength(live.length);
    } finally {
      vi.useRealTimers();
    }
  });
});
