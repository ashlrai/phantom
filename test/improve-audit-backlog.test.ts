import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AUDIT_BACKLOG_MAX_ITEMS,
  AUDIT_MIN_UNITS,
  auditBacklogItems,
  foldAuditEvidence,
  parseAuditEntry,
  parseAuditPartition,
  type AuditRow,
} from '../src/core/improve/audit-backlog.js';
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
  home = await mkdtemp(join(tmpdir(), 'improve-audit-'));
  process.env.HOME = home;
});
afterEach(async () => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  await rm(home, { recursive: true, force: true });
});

const D1 = '2026-11-28';
const D2 = '2026-11-29';
const D3 = '2026-11-30';

const entry = (day: string, hour: number, over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    ts: `${day}T${String(hour).padStart(2, '0')}:00:00.000Z`,
    action: 'inbox:auto-merge',
    repo: '/repos/phantom',
    sandboxId: null,
    summary: 'Gate 7 held: judge unavailable',
    result: 'refused',
    ...over,
  });

const refusedMerge = (day: string): string => entry(day, 8);
const errorVerify = (day: string): string =>
  entry(day, 9, { action: 'verify:command', summary: 'typecheck: tsc → timed out', result: 'error' });
const okTick = (day: string): string =>
  entry(day, 10, { action: 'daemon:tick', summary: 'tick skipped: daily budget exhausted', result: 'ok' });

/** Three records across three UTC days — past both recurring bars for one cell. */
const recurring = (line: (day: string) => string): string[] => [line(D1), line(D2), line(D3)];

const auditDirFor = async (name: string, files: Record<string, readonly string[]>): Promise<string> => {
  const dir = join(home, name);
  await mkdir(dir, { recursive: true });
  for (const [file, lines] of Object.entries(files)) {
    await writeFile(join(dir, file), lines.join('\n') + '\n');
  }
  return dir;
};

const row = (day: string, hour: number, over: Partial<AuditRow> = {}): AuditRow => ({
  atMs: Date.parse(`${day}T${String(hour).padStart(2, '0')}:00:00.000Z`),
  utcDay: day,
  action: 'inbox:auto-merge',
  result: 'refused',
  summary: 'Gate 7 held: judge unavailable',
  ...over,
});

describe('parseAuditEntry / parseAuditPartition', () => {
  it('accepts the writer contract and rejects off-contract rows', () => {
    const parsed = parseAuditEntry(JSON.parse(entry(D1, 8, { sandboxId: 'sbx-1' })));
    expect(parsed).not.toBeNull();
    expect(parsed).toMatchObject({ action: 'inbox:auto-merge', result: 'refused', utcDay: D1 });
    // 'ok' rows parse — they are valid records, just never evidence.
    expect(parseAuditEntry(JSON.parse(okTick(D1)))!.result).toBe('ok');
    // repo/sandboxId may be null or absent context.
    const bare = JSON.parse(entry(D1, 8));
    delete bare['repo'];
    delete bare['sandboxId'];
    expect(parseAuditEntry(bare)).not.toBeNull();

    for (const bad of [
      null, 'x', [],
      { ts: 'not-a-date', action: 'a', summary: 's', result: 'error' },
      { ts: `${D1}T08:00:00.000Z`, action: '', summary: 's', result: 'error' },
      { ts: `${D1}T08:00:00.000Z`, action: 'x'.repeat(201), summary: 's', result: 'error' },
      { ts: `${D1}T08:00:00.000Z`, action: 'a', summary: 42, result: 'error' },
      { ts: `${D1}T08:00:00.000Z`, action: 'a', summary: 's', result: 'maybe' },
      { ts: `${D1}T08:00:00.000Z`, action: 'a', summary: 's', result: 'error', repo: 7 },
      { ts: `${D1}T08:00:00.000Z`, action: 'a', summary: 's', result: 'error', sandboxId: {} },
    ]) {
      expect(parseAuditEntry(bad)).toBeNull();
    }
  });

  it('counts malformed and off-contract lines without guessing', () => {
    const { rows, invalidRows } = parseAuditPartition([
      'not json',
      '{"ts":"2026-11-28T08:00:00.000Z"}',
      entry(D1, 8),
      '',
      entry(D2, 8, { result: 'bogus' }),
    ].join('\n'));
    expect(rows).toHaveLength(1);
    expect(invalidRows).toBe(3);
  });
});

describe('foldAuditEvidence', () => {
  it('folds each adverse cell at the recurring bars and ignores ok rows', () => {
    const lines = [
      ...recurring(refusedMerge),
      ...recurring(errorVerify),
      // 'ok' rows — including deliberate-off vocabulary — never cells.
      ...recurring(okTick),
      entry(D1, 11, { action: 'daemon:tick', summary: 'tick production held', result: 'ok' }),
    ];
    const { rows: parsed } = parseAuditPartition(lines.join('\n'));
    const folded = foldAuditEvidence(parsed, { nowMs: NOW_MS });
    expect(folded.records).toBe(10);
    expect(folded.cells.map((c) => `${c.action}:${c.kind}`).sort()).toEqual([
      'inbox:auto-merge:refused',
      'verify:command:error',
    ]);
    const merge = folded.cells.find((c) => c.action === 'inbox:auto-merge')!;
    expect(merge.units).toBe(AUDIT_MIN_UNITS);
    expect(merge.days.size).toBe(3);
    expect(merge.samples).toEqual(['Gate 7 held: judge unavailable']);
  });

  it('keeps refused and error as separate cells for the same action', () => {
    const rows = [
      ...recurring((d) => row(d, 8)),
      ...recurring((d) => row(d, 9, { result: 'error', summary: 'push failed' })),
    ];
    const folded = foldAuditEvidence(rows, { nowMs: NOW_MS });
    expect(folded.cells.map((c) => c.kind).sort()).toEqual(['error', 'refused']);
  });

  it('stays quiet below the recurring bars and outside the window', () => {
    // Three refusals on ONE UTC day only.
    const oneDay = foldAuditEvidence(
      [row('2026-11-30', 8), row('2026-11-30', 9), row('2026-11-30', 10)],
      { nowMs: NOW_MS },
    );
    expect(oneDay.cells).toEqual([]);

    // Two records across two days — under the units bar.
    const two = foldAuditEvidence([row(D1, 8), row(D2, 8)], { nowMs: NOW_MS });
    expect(two.cells).toEqual([]);

    // Old records outside the 7-day window never count.
    const ancient = foldAuditEvidence(
      [row('2026-11-10', 8), row('2026-11-11', 8), row('2026-11-12', 8), row('2026-11-13', 8)],
      { nowMs: NOW_MS },
    );
    expect(ancient.records).toBe(0);
    expect(ancient.outsideWindow).toBe(4);
    expect(ancient.cells).toEqual([]);
  });
});

describe('auditBacklogItems', () => {
  it('emits one item per recurring cell with stable ids, prompts and metadata', async () => {
    const dir = await auditDirFor('audit-all', {
      [`${D1}.jsonl`]: [refusedMerge(D1), errorVerify(D1), okTick(D1)],
      [`${D2}.jsonl`]: [refusedMerge(D2), errorVerify(D2)],
      [`${D3}.jsonl`]: [refusedMerge(D3), errorVerify(D3)],
      // Partitions outside the window and non-partition names are ignored.
      'notes.txt': ['ignored'],
      '2026-10-01.jsonl': [refusedMerge('2026-10-01'), refusedMerge('2026-10-01'), refusedMerge('2026-10-01')],
    });
    const items = await auditBacklogItems({ repo: 'ashlrai/phantom', auditDirPath: dir, now: new Date(NOW_MS) });
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.priority === 3 && i.area === 'audit-trail' && i.repo === 'ashlrai/phantom')).toBe(true);
    expect(items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    expect(new Set(items.map((i) => i.id)).size).toBe(2);
    expect(items.every((i) => i.id.startsWith('audit-') && i.id.length <= 120)).toBe(true);

    const refused = items.find((i) => i.prompt.includes("'refused'"))!;
    const errored = items.find((i) => i.prompt.includes("'error'"))!;
    expect(refused.title).toContain('inbox:auto-merge');
    expect(refused.title).toContain('refused');
    expect(refused.prompt).toContain('inbox:auto-merge');
    expect(refused.prompt).toContain('Gate 7 held: judge unavailable');
    expect(refused.prompt).toContain('~/.ashlr/audit');
    expect(refused.prompt).toContain('no-change');
    expect(errored.title).toContain('verify:command');
    expect(errored.prompt).toContain('verify:command');
    expect(errored.prompt).toContain('timed out');
  });

  it('emits nothing below the bars, on missing dirs, or for another repository', async () => {
    // Below the units bar: two records across two days.
    const few = await auditDirFor('audit-few', {
      [`${D1}.jsonl`]: [refusedMerge(D1)],
      [`${D2}.jsonl`]: [refusedMerge(D2)],
    });
    expect(await auditBacklogItems({ repo: 'ashlrai/phantom', auditDirPath: few, now: new Date(NOW_MS) })).toEqual([]);

    // Below the days bar: three records on one UTC day.
    const oneDay = await auditDirFor('audit-oneday', {
      [`${D3}.jsonl`]: [refusedMerge(D3), refusedMerge(D3), refusedMerge(D3)],
    });
    expect(await auditBacklogItems({ repo: 'ashlrai/phantom', auditDirPath: oneDay, now: new Date(NOW_MS) })).toEqual([]);

    // Missing dir, empty dir, and a file where the dir should be.
    expect(await auditBacklogItems({ repo: 'ashlrai/phantom', auditDirPath: join(home, 'no-such'), now: new Date(NOW_MS) })).toEqual([]);
    const empty = await auditDirFor('audit-empty', {});
    expect(await auditBacklogItems({ repo: 'ashlrai/phantom', auditDirPath: empty, now: new Date(NOW_MS) })).toEqual([]);
    const file = join(home, 'audit-file');
    await writeFile(file, 'x');
    expect(await auditBacklogItems({ repo: 'ashlrai/phantom', auditDirPath: file, now: new Date(NOW_MS) })).toEqual([]);

    // Garbage partitions are not evidence.
    const junk = await auditDirFor('audit-junk', { [`${D1}.jsonl`]: ['not json', '{"ts":"x"}'], [`${D2}.jsonl`]: ['also not json'] });
    expect(await auditBacklogItems({ repo: 'ashlrai/phantom', auditDirPath: junk, now: new Date(NOW_MS) })).toEqual([]);

    // Another repository never inherits this install's evidence.
    const dir = await auditDirFor('audit-repo', {
      [`${D1}.jsonl`]: [refusedMerge(D1)],
      [`${D2}.jsonl`]: [refusedMerge(D2)],
      [`${D3}.jsonl`]: [refusedMerge(D3)],
    });
    expect(await auditBacklogItems({ repo: 'ashlrai/other', auditDirPath: dir, now: new Date(NOW_MS) })).toEqual([]);
    expect(await auditBacklogItems({ repo: 'AshlrAI/Phantom', auditDirPath: dir, now: new Date(NOW_MS) })).toHaveLength(1);
  });

  it('reads the writer-resolved auditDir under the relocated home when no override is given', async () => {
    // auditDir() resolves realHome()/.ashlr/audit — the worker's
    // relocated HOME under Vitest — so fixtures land beside ASHLR_HOME.
    const dir = join(home, '.ashlr', 'audit');
    await mkdir(dir, { recursive: true });
    for (const d of [D1, D2, D3]) {
      await writeFile(join(dir, `${d}.jsonl`), [refusedMerge(d)].join('\n') + '\n');
    }
    const items = await auditBacklogItems({ repo: 'ashlrai/phantom', now: new Date(NOW_MS) });
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toContain('inbox:auto-merge');
  });

  it('honours the item limit and derives stable ids across calls', async () => {
    const dir = await auditDirFor('audit-stable', {
      [`${D1}.jsonl`]: [refusedMerge(D1), errorVerify(D1), entry(D1, 11, { action: 'plugin:load', result: 'error', summary: 'load failed' })],
      [`${D2}.jsonl`]: [refusedMerge(D2), errorVerify(D2), entry(D2, 11, { action: 'plugin:load', result: 'error', summary: 'load failed' })],
      [`${D3}.jsonl`]: [refusedMerge(D3), errorVerify(D3), entry(D3, 11, { action: 'plugin:load', result: 'error', summary: 'load failed' })],
    });
    const opts = { repo: 'ashlrai/phantom', auditDirPath: dir, now: new Date(NOW_MS) };
    const first = await auditBacklogItems(opts);
    const second = await auditBacklogItems(opts);
    expect(first).toHaveLength(3);
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
    const limited = await auditBacklogItems({ ...opts, limit: 2 });
    expect(limited).toHaveLength(2);
    expect(limited.length).toBeLessThanOrEqual(Math.min(AUDIT_BACKLOG_MAX_ITEMS, 25));
  });

  it('states truncated partition tails as lower bounds and scrubs journal strings', async () => {
    // >1 MiB of retained rows in one partition: the bounded tail drops
    // the oldest bytes, so every count is a lower bound.
    const filler: string[] = [];
    for (let i = 0; i < 12000; i += 1) {
      filler.push(entry(D1, i % 24, { action: 'daemon:tick', summary: `pad-${i}`, result: i % 7 === 0 ? 'error' : 'ok' }));
    }
    const dir = await auditDirFor('audit-big', {
      // The recurring cell's D1 row sits at the file's tail so the
      // bounded read retains it while dropping the oldest filler.
      [`${D1}.jsonl`]: [...filler, refusedMerge(D1)],
      [`${D2}.jsonl`]: [refusedMerge(D2)],
      [`${D3}.jsonl`]: [refusedMerge(D3)],
    });
    const items = await auditBacklogItems({ repo: 'ashlrai/phantom', auditDirPath: dir, now: new Date(NOW_MS) });
    expect(items).toHaveLength(1);
    expect(items[0]!.prompt).toContain('lower bound');
  }, 30_000);

  it('scrubs secret-shaped text out of journal summaries before it reaches a prompt', async () => {
    const token = '123456789:AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHJ';
    const dir = await auditDirFor('audit-secret', {
      [`${D1}.jsonl`]: [entry(D1, 8, { summary: `fetch failed ${token}` })],
      [`${D2}.jsonl`]: [entry(D2, 8, { summary: `fetch failed ${token}` })],
      [`${D3}.jsonl`]: [entry(D3, 8, { summary: `fetch failed ${token}` })],
    });
    const items = await auditBacklogItems({ repo: 'ashlrai/phantom', auditDirPath: dir, now: new Date(NOW_MS) });
    expect(items).toHaveLength(1);
    expect(items[0]!.prompt).not.toContain(token);
    expect(items[0]!.prompt).toContain('[REDACTED]');
  });

  it('appends audit items through discovery and dedupes on refresh', async () => {
    // discoverBacklog anchors the evidence window on the wall clock, so
    // the fixtures use days relative to real now — three distinct UTC
    // days inside the window, like the fixed-date fixtures above.
    const dayAgo = (days: number): string => new Date(Date.now() - days * DAY_MS).toISOString().slice(0, 10);
    const refused = (iso: string): string => JSON.stringify({ ts: iso, action: 'inbox:auto-merge', repo: null, sandboxId: null, summary: 'Gate 7 held', result: 'refused' });
    const errored = (iso: string): string => JSON.stringify({ ts: iso, action: 'verify:command', repo: null, sandboxId: null, summary: 'tsc timed out', result: 'error' });
    const dir = join(home, '.ashlr', 'audit');
    await mkdir(dir, { recursive: true });
    for (const d of [1, 2, 3]) {
      const iso = `${dayAgo(d)}T08:00:00.000Z`;
      await writeFile(join(dir, `${dayAgo(d)}.jsonl`), [refused(iso), errored(iso)].join('\n') + '\n');
    }
    const greenGh = async (args: string[]) => {
      const p = args[4] ?? '';
      if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
    };
    const first = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    const auditItems = first.items.filter((i) => i.id.startsWith('audit-'));
    expect(auditItems).toHaveLength(2);
    expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    expect(appendUserBacklogItems(auditItems)).toBe(2);
    const second = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('audit-')))).toBe(0);
    expect(readUserBacklogItems().filter((i) => i.id.startsWith('audit-'))).toHaveLength(2);
  });
});
