import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CATALOG_REFRESH_BACKLOG_MAX_ITEMS,
  catalogRefreshBacklogItems,
  foldCatalogRefreshEvidence,
  parseCatalogRefreshReport,
} from '../src/core/improve/catalog-refresh-backlog.js';
import { discoverBacklog } from '../src/core/improve/discover.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';

const NOW_MS = Date.parse('2026-12-01T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

let home: string;
let saved: Record<string, string | undefined>;
beforeEach(async () => {
  saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME };
  delete process.env.ASHLR_HOME;
  home = await mkdtemp(join(tmpdir(), 'improve-catrefresh-'));
  process.env.HOME = home;
});
afterEach(async () => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  await rm(home, { recursive: true, force: true });
});

const SOURCES_OK = [
  { id: 'claude', status: 'ok', models: ['claude-opus-4-1'] },
  { id: 'codex', status: 'ok', models: ['gpt-5.2-codex'] },
  { id: 'ollama', status: 'ok', models: [] },
];

const report = (at: string, over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    schema: 'router.catalog-refresh.v1',
    generatedAt: at,
    dryRun: true,
    sources: SOURCES_OK,
    additions: [],
    reappeared: [],
    unseen: [],
    deprecations: [],
    proposedRemovals: [],
    unknown: [],
    rejectedRules: [],
    ...over,
  });

const at = (day: string, hour = 8): string => `${day}T${String(hour).padStart(2, '0')}:00:00.000Z`;
const stamp = (iso: string): string => iso.replace(/[:.]/g, '-');
const D1 = '2026-11-28';
const D2 = '2026-11-29';
const D3 = '2026-11-30';

/** The writer's filename: catalog-refresh-<ISO stamp with : and . dashed>.json */
const fileName = (iso: string): string => `catalog-refresh-${stamp(iso)}.json`;

const writeReports = async (dir: string, entries: readonly [string, string][]): Promise<void> => {
  await mkdir(dir, { recursive: true });
  for (const [name, body] of entries) await writeFile(join(dir, name), body);
};

/** Reports across three distinct UTC days — past both recurring bars for one cell. `hour` keeps same-day fixtures in distinct files like real runs. */
const recurring = (make: (day: string) => string, hour = 8): [string, string][] =>
  [D1, D2, D3].map((d) => { const iso = at(d, hour); return [fileName(iso), make(iso)] as [string, string]; });

const sourceUnknown = (iso: string): string =>
  report(iso, {
    sources: [
      ...SOURCES_OK.slice(0, 1),
      { id: 'codex', status: 'unknown', models: [], reason: 'unavailable or unparseable source' },
      SOURCES_OK[2]!,
    ],
  });
const modelUnknown = (iso: string): string =>
  report(iso, { unknown: [{ model: 'mystery-model-9', reason: 'No owning source pattern' }] });

/** One report carrying every adverse kind at once — the shape a real report has. */
const adverseAll = (iso: string): string =>
  report(iso, {
    sources: [
      ...SOURCES_OK.slice(0, 1),
      { id: 'codex', status: 'unknown', models: [], reason: 'unavailable or unparseable source' },
      SOURCES_OK[2]!,
    ],
    unknown: [{ model: 'mystery-model-9', reason: 'No owning source pattern' }],
    rejectedRules: [{ rule: '^bad-pattern[$', reason: 'Invalid pattern or sources' }],
    proposedRemovals: [{ model: 'old-model-1', unseenSince: '2026-08-01T00:00:00.000Z' }],
  });

describe('parseCatalogRefreshReport', () => {
  it('accepts the writer contract and drops off-contract entries honestly', () => {
    const parsed = parseCatalogRefreshReport(JSON.parse(report(at(D1), {
      sources: [
        { id: 'claude', status: 'ok', models: ['m'] },
        { id: 'Bad Id!', status: 'ok', models: [] },
        { id: 'weird', status: 'exploded', models: [] },
        { id: 'dup', status: 'unknown', models: [], reason: 'first' },
        { id: 'dup', status: 'ok', models: [] },
        'junk',
      ],
      unknown: [
        { model: 'm1', reason: 'No owning source pattern' },
        { model: '', reason: 'x' },
        { model: 'm2' },
        'junk',
      ],
      rejectedRules: [
        { rule: '^x', reason: 'Invalid pattern or sources' },
        { rule: 42, reason: 'x' },
      ],
      proposedRemovals: [
        { model: 'old', unseenSince: '2026-08-01T00:00:00.000Z' },
        { model: 'nostamp' },
      ],
    })));
    expect(parsed).not.toBeNull();
    expect(parsed!.generatedAtMs).toBe(Date.parse(at(D1)));
    expect(parsed!.utcDay).toBe(D1);
    // 'weird' status 'exploded' and 'Bad Id!' are off-contract and dropped.
    expect([...parsed!.sources.entries()].sort()).toEqual([['claude', 'ok'], ['dup', 'unknown']]);
    // First 'dup' verdict wins.
    expect(parsed!.sourceReasons.get('dup')).toBe('first');
    expect([...parsed!.unknownModels.keys()]).toEqual(['m1']);
    expect([...parsed!.rejectedRules.keys()]).toEqual(['^x']);
    expect([...parsed!.proposedRemovals.entries()]).toEqual([['old', '2026-08-01T00:00:00.000Z']]);
  });

  it('rejects foreign shapes and missing collections', () => {
    for (const bad of [
      null, 'x', [],
      { ...JSON.parse(report(at(D1))), schema: 'other.v9' },
      { ...JSON.parse(report(at(D1))), generatedAt: 'not-a-date' },
      { ...JSON.parse(report(at(D1))), sources: {} },
      { ...JSON.parse(report(at(D1))), unknown: 'all' },
      { ...JSON.parse(report(at(D1))), rejectedRules: null },
      { ...JSON.parse(report(at(D1))), proposedRemovals: 7 },
    ]) {
      expect(parseCatalogRefreshReport(bad)).toBeNull();
    }
  });
});

describe('foldCatalogRefreshEvidence', () => {
  const reportsOf = (entries: readonly [string, string][]) =>
    entries
      .map(([, body]) => parseCatalogRefreshReport(JSON.parse(body)))
      .filter((r): r is NonNullable<typeof r> => r !== null);

  it('folds each adverse cell at the recurring bars and applies the still-adverse gate', () => {
    const folded = foldCatalogRefreshEvidence(reportsOf(recurring(adverseAll)));
    expect(folded.reports).toBe(3);
    expect(folded.cells.map((c) => `${c.kind}:${c.key}`).sort()).toEqual([
      'model-unknown:mystery-model-9',
      'removal-proposed:old-model-1',
      'rule-rejected:^bad-pattern[$',
      'source-unknown:codex',
    ]);
    const codex = folded.cells.find((c) => c.kind === 'source-unknown')!;
    expect(codex.reports).toBe(3);
    expect(codex.days.size).toBe(3);
    expect(codex.samples).toEqual(['unavailable or unparseable source']);
  });

  it('suppresses a cell the newest report shows resolved', () => {
    // codex unknown in the first two reports, healthy in the newest.
    const lines: [string, string][] = [
      [fileName(at(D1)), sourceUnknown(at(D1))],
      [fileName(at(D2)), sourceUnknown(at(D2))],
      [fileName(at(D3)), report(at(D3))],
    ];
    const folded = foldCatalogRefreshEvidence(reportsOf(lines));
    expect(folded.cells.filter((c) => c.kind === 'source-unknown')).toEqual([]);

    // Same for the list kinds: present in two reports, gone from the newest.
    const listLines: [string, string][] = [
      [fileName(at(D1)), modelUnknown(at(D1))],
      [fileName(at(D2)), modelUnknown(at(D2))],
      [fileName(at(D3)), report(at(D3))],
    ];
    const listFolded = foldCatalogRefreshEvidence(reportsOf(listLines));
    expect(listFolded.cells.filter((c) => c.kind === 'model-unknown')).toEqual([]);
  });

  it('keeps an opt-in source cell on its last recorded verdict when later reports omit it', () => {
    const seatsUnknown = (iso: string): string =>
      report(iso, {
        sources: [
          ...SOURCES_OK,
          { id: 'seats', status: 'unknown', models: [], reason: 'unavailable or unparseable source' },
        ],
      });
    const lines: [string, string][] = [
      [fileName(at(D1)), seatsUnknown(at(D1))],
      [fileName(at(D2)), seatsUnknown(at(D2))],
      // The newest scheduled report carries no seats probe at all.
      [fileName(at(D3)), report(at(D3))],
    ];
    const folded = foldCatalogRefreshEvidence(reportsOf(lines));
    const seats = folded.cells.find((c) => c.kind === 'source-unknown' && c.key === 'seats');
    expect(seats).toBeDefined();
    expect(seats!.reports).toBe(2);
  });

  it('stays quiet below the recurring bars', () => {
    // Two reports on ONE UTC day — under the days bar.
    const oneDay = foldCatalogRefreshEvidence(reportsOf([
      [fileName(at(D3, 8)), modelUnknown(at(D3, 8))],
      [fileName(at(D3, 20)), modelUnknown(at(D3, 20))],
    ]));
    expect(oneDay.cells).toEqual([]);

    // A single report carrying everything.
    const single = foldCatalogRefreshEvidence(reportsOf([[fileName(at(D1)), sourceUnknown(at(D1))]]));
    expect(single.cells).toEqual([]);
  });
});

describe('catalogRefreshBacklogItems', () => {
  it('emits one item per recurring cell with stable ids, prompts and metadata', async () => {
    const dir = join(home, 'catalog');
    await writeReports(dir, [
      ...recurring(adverseAll),
      // Foreign files and off-contract reports are not evidence.
      ['notes.txt', 'hello'],
      ['catalog-refresh-broken.json', 'not json'],
      ['catalog-refresh-foreign.json', JSON.stringify({ schema: 'other.v1' })],
    ]);
    const items = await catalogRefreshBacklogItems({ repo: 'ashlrai/phantom', catalogDir: dir, now: new Date(NOW_MS) });
    expect(items).toHaveLength(4);
    const ids = items.map((i) => i.id);
    expect(ids).toContain('catrefresh-source-codex');
    expect(ids.filter((id) => id !== 'catrefresh-source-codex').every((id) => /^catrefresh-(model|rule|removal)-[0-9a-f]{12}$/.test(id))).toBe(true);
    expect(new Set(ids).size).toBe(4);
    expect(items.every((i) => i.priority === 3 && i.area === 'router-catalog' && i.repo === 'ashlrai/phantom')).toBe(true);
    expect(items.every((i) => validBacklogItem(i) !== null)).toBe(true);

    const source = items.find((i) => i.id === 'catrefresh-source-codex')!;
    expect(source.prompt).toContain("source 'codex'");
    expect(source.prompt).toContain('unavailable or unparseable source');
    expect(source.prompt).toContain('catalog-refresh-');
    expect(source.prompt).toContain('catalogSchedule');
    const model = items.find((i) => i.id.startsWith('catrefresh-model-'))!;
    expect(model.prompt).toContain('mystery-model-9');
    expect(model.prompt).toContain('No owning source pattern');
    const rule = items.find((i) => i.id.startsWith('catrefresh-rule-'))!;
    expect(rule.prompt).toContain('^bad-pattern[$');
    const removal = items.find((i) => i.id.startsWith('catrefresh-removal-'))!;
    expect(removal.prompt).toContain('old-model-1');
    expect(removal.prompt).toContain('unseen since 2026-08-01T00:00:00.000Z');

    expect(items.length).toBeLessThanOrEqual(Math.min(CATALOG_REFRESH_BACKLOG_MAX_ITEMS, 25));
    const limited = await catalogRefreshBacklogItems({ repo: 'ashlrai/phantom', catalogDir: dir, now: new Date(NOW_MS), limit: 2 });
    expect(limited).toHaveLength(2);
  });

  it('emits nothing below the bars, on missing or empty dirs, or for another repository', async () => {
    // Below the bars: two reports on one UTC day.
    const few = join(home, 'catalog-few');
    await writeReports(few, [
      [fileName(at(D3, 8)), modelUnknown(at(D3, 8))],
      [fileName(at(D3, 20)), modelUnknown(at(D3, 20))],
    ]);
    expect(await catalogRefreshBacklogItems({ repo: 'ashlrai/phantom', catalogDir: few, now: new Date(NOW_MS) })).toEqual([]);

    // Missing dir.
    expect(await catalogRefreshBacklogItems({ repo: 'ashlrai/phantom', catalogDir: join(home, 'no-such'), now: new Date(NOW_MS) })).toEqual([]);

    // Only foreign files.
    const foreign = join(home, 'catalog-foreign');
    await writeReports(foreign, [['other.json', '{}'], ['catalog-refresh-x.json', '{"schema":"nope"}']]);
    expect(await catalogRefreshBacklogItems({ repo: 'ashlrai/phantom', catalogDir: foreign, now: new Date(NOW_MS) })).toEqual([]);

    // Reports outside the 28-day window never count.
    const stale = join(home, 'catalog-stale');
    await writeReports(stale, [
      [fileName(at('2026-10-20')), modelUnknown(at('2026-10-20'))],
      [fileName(at('2026-10-21')), modelUnknown(at('2026-10-21'))],
      [fileName(at('2026-10-22')), modelUnknown(at('2026-10-22'))],
    ]);
    expect(await catalogRefreshBacklogItems({ repo: 'ashlrai/phantom', catalogDir: stale, now: new Date(NOW_MS) })).toEqual([]);

    // Another repository never inherits this install's evidence.
    const dir = join(home, 'catalog-repo');
    await writeReports(dir, recurring(modelUnknown));
    expect(await catalogRefreshBacklogItems({ repo: 'ashlrai/other', catalogDir: dir, now: new Date(NOW_MS) })).toEqual([]);
    expect(await catalogRefreshBacklogItems({ repo: 'AshlrAI/Phantom', catalogDir: dir, now: new Date(NOW_MS) })).toHaveLength(1);
  });

  it('suppresses cells the newest in-window report shows resolved', async () => {
    const dir = join(home, 'catalog-resolved');
    await writeReports(dir, [
      [fileName(at(D1)), sourceUnknown(at(D1))],
      [fileName(at(D2)), sourceUnknown(at(D2))],
      [fileName(at(D3)), report(at(D3))],
    ]);
    expect(await catalogRefreshBacklogItems({ repo: 'ashlrai/phantom', catalogDir: dir, now: new Date(NOW_MS) })).toEqual([]);
  });

  it('derives stable ids so a refresh re-adds nothing, and scrubs journal strings', async () => {
    const token = '123456789:AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHJ';
    const dir = join(home, 'catalog-stable');
    const dirty = (iso: string): string =>
      report(iso, { rejectedRules: [{ rule: `bad-${token}`, reason: `saw ${token}` }] });
    await writeReports(dir, recurring(dirty));
    const opts = { repo: 'ashlrai/phantom', catalogDir: dir, now: new Date(NOW_MS) };
    const first = await catalogRefreshBacklogItems(opts);
    const second = await catalogRefreshBacklogItems(opts);
    expect(first).toHaveLength(1);
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
    expect(first[0]!.prompt).not.toContain(token);
    expect(first[0]!.prompt).toContain('[REDACTED]');
  });

  it('reads the default catalog dir under the account home', async () => {
    const dir = join(home, '.ashlr', 'router', 'catalog');
    await writeReports(dir, recurring(modelUnknown));
    const items = await catalogRefreshBacklogItems({ repo: 'ashlrai/phantom', now: new Date(NOW_MS) });
    expect(items).toHaveLength(1);
    expect(items[0]!.id.startsWith('catrefresh-model-')).toBe(true);
  });

  it('appends catalog-refresh items through discovery and dedupes on refresh', async () => {
    const dir = join(home, '.ashlr', 'router', 'catalog');
    // discoverBacklog anchors the evidence window on the wall clock, so
    // the fixtures use days relative to real now — three distinct UTC
    // days inside the 28-day window.
    const dayAgo = (days: number): string => new Date(Date.now() - days * DAY_MS).toISOString();
    const recent = (make: (iso: string) => string): [string, string][] =>
      [1, 2, 3].map((d) => { const iso = dayAgo(d); return [fileName(iso), make(iso)] as [string, string]; });
    await writeReports(dir, recent(adverseAll));
    const greenGh = async (args: string[]) => {
      const p = args[4] ?? '';
      if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
    };
    const first = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    const catItems = first.items.filter((i) => i.id.startsWith('catrefresh-'));
    expect(catItems).toHaveLength(4);
    expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    expect(appendUserBacklogItems(catItems)).toBe(4);
    const second = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('catrefresh-')))).toBe(0);
    expect(readUserBacklogItems().filter((i) => i.id.startsWith('catrefresh-'))).toHaveLength(4);
  });
});
