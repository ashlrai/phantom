import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FRICTION_ITEM_MAX_ITEMS,
  FRICTION_ITEM_STALE_MS,
  foldFrictionItemCells,
  frictionItemBacklogItems,
} from '../src/core/improve/friction-item-backlog.js';
import { FRICTION_MAX_BYTES, type FrictionItem } from '../src/core/fleet/friction-ledger.js';
import { discoverBacklog } from '../src/core/improve/discover.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';

const NOW = Date.now();
const DAY = 24 * 60 * 60 * 1000;
const at = (msAgo: number): string => new Date(NOW - msAgo).toISOString();

const item = (over: Partial<FrictionItem> = {}): FrictionItem => ({
  id: 'noop-streak:RQ-A',
  title: 'Queue line RQ-A keeps retiring as DONE-NOOP',
  detail: '3 consecutive no-op retirements',
  score: 5,
  repo: 'phantom',
  source: 'noop-streak',
  status: 'open',
  openedAt: at(10 * DAY),
  ...over,
});

describe('foldFrictionItemCells', () => {
  it('groups open items by source and counts only horizon-aged rows as stale', () => {
    const cells = foldFrictionItemCells([
      item({ id: 'a', openedAt: at(9 * DAY) }),
      item({ id: 'b', openedAt: at(8 * DAY), score: 9 }),
      item({ id: 'c', openedAt: at(2 * DAY) }),       // fresh: open but not stale
      item({ id: 'd', status: 'closed', closedAt: at(DAY), closeReason: 'grader-7d' }),
      item({ id: 'e', source: 'other-writer', openedAt: at(30 * DAY), title: 'Other friction' }),
    ], NOW, FRICTION_ITEM_STALE_MS);
    expect(cells).toHaveLength(2);
    const main = cells.find((c) => c.source === 'noop-streak')!;
    expect(main.stale).toBe(2);
    expect(main.open).toBe(3);
    expect(main.maxScore).toBe(9);
    expect(main.oldestOpenedAt).toBe(at(9 * DAY));
    expect(main.newestOpenedAt).toBe(at(8 * DAY));
    expect(main.repos).toEqual(['phantom']);
    expect(main.examples.length).toBeGreaterThan(0);
    expect(cells[1]!.source).toBe('other-writer');
    expect(cells[1]!.stale).toBe(1);
  });

  it('flattens control characters out of the source key and titles', () => {
    const cells = foldFrictionItemCells([
      item({ source: 'bad\nsource\tname', title: 'line one\nline two' }),
    ], NOW, FRICTION_ITEM_STALE_MS);
    expect(cells).toHaveLength(1);
    expect(cells[0]!.source).toBe('bad source name');
    expect(cells[0]!.examples[0]).toBe('line one line two');
  });

  it('drops sources with no persisted items and sorts stale-desc then oldest-first', () => {
    const cells = foldFrictionItemCells([
      item({ id: 'x1', source: 'fresh-only', openedAt: at(DAY) }),
      item({ id: 'x2', source: 'small-stale', openedAt: at(8 * DAY) }),
      item({ id: 'x3', source: 'big-stale', openedAt: at(20 * DAY) }),
      item({ id: 'x4', source: 'big-stale', openedAt: at(9 * DAY) }),
    ], NOW, FRICTION_ITEM_STALE_MS);
    expect(cells.map((c) => c.source)).toEqual(['big-stale', 'small-stale']);
    expect(cells[0]!.stale).toBe(2);
    expect(cells[0]!.oldestOpenedAt).toBe(at(20 * DAY));
  });
});

describe('frictionItemBacklogItems', () => {
  let home: string;
  let saved: { HOME?: string; ASHLR_HOME?: string };
  let dir: string;

  beforeEach(async () => {
    saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME };
    delete process.env.ASHLR_HOME;
    home = await mkdtemp(join(tmpdir(), 'friction-item-backlog-'));
    process.env.HOME = home;
    dir = await mkdtemp(join(tmpdir(), 'friction-ledger-'));
  });
  afterEach(async () => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    vi.restoreAllMocks();
    await rm(home, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  });

  const ledgerPath = (): string => join(dir, 'friction-ledger.jsonl');
  const writeLedger = async (lines: readonly string[]): Promise<void> => {
    await writeFile(ledgerPath(), `${lines.join('\n')}\n`);
  };
  const row = (over: Partial<FrictionItem> = {}): string => JSON.stringify(item(over));
  const opts = () => ({ repo: 'ashlrai/phantom', ledgerPath: ledgerPath(), now: new Date(NOW) });

  it('emits nothing for a missing ledger, fresh items, closed items, or another repository', async () => {
    expect(await frictionItemBacklogItems(opts())).toEqual([]);

    await writeLedger([
      row({ id: 'fresh', openedAt: at(DAY) }),
      row({ id: 'closed', status: 'closed', closedAt: at(DAY), closeReason: 'grader-7d' }),
    ]);
    expect(await frictionItemBacklogItems(opts())).toEqual([]);

    await writeLedger([row({ openedAt: at(10 * DAY) })]);
    expect(await frictionItemBacklogItems({ ...opts(), repo: 'ashlrai/other' })).toEqual([]);
    // The bare fleet name is accepted shorthand: items emit without a repo field.
    const bare = await frictionItemBacklogItems({ ...opts(), repo: 'Phantom' });
    expect(bare).toHaveLength(1);
    expect(bare[0]!.repo).toBeUndefined();
  });

  it('emits one item per source with persisted open items and validates it', async () => {
    await writeLedger([
      row({ id: 'a', openedAt: at(9 * DAY), title: 'Stale one' }),
      row({ id: 'b', openedAt: at(8 * DAY), title: 'Stale two', score: 12 }),
      row({ id: 'c', openedAt: at(2 * DAY), title: 'Fresh sibling' }),
      row({ id: 'd', source: 'friction-2-tag', openedAt: at(30 * DAY), repo: 'lexicon', title: 'Old other-source item' }),
      'not json at all',
    ]);
    const items = await frictionItemBacklogItems(opts());
    // The malformed line also earns the rejected-rows integrity item.
    expect(items).toHaveLength(3);
    const stale = items.filter((i) => i.title.includes('noop-streak'));
    expect(stale).toHaveLength(1);
    const [main] = stale;
    expect(main).toMatchObject({ priority: 3, repo: 'ashlrai/phantom', area: 'friction-items' });
    expect(main!.id).toMatch(/^fleet-friction-items-[0-9a-f]{16}$/);
    expect(validBacklogItem(main)).not.toBeNull();
    expect(main!.prompt).toContain("source 'noop-streak'");
    expect(main!.prompt).toContain('2 of this source\'s 3 currently open item(s)');
    expect(main!.prompt).toContain('friction-ledger.jsonl');
    expect(main!.prompt).toContain('readFrictionLedger');
    expect(main!.prompt).toContain('upsertFrictionItems');
    expect(main!.prompt).toContain('absorbNoopChurn');
    expect(main!.prompt).toContain('runPickGrader');
    expect(main!.prompt).toContain('syncPickGrades');
    expect(main!.prompt).toContain('no-change');
    expect(main!.prompt).toContain('Stale one');
    expect(main!.prompt).toContain('Fresh sibling');
    // detail text is never quoted.
    expect(main!.prompt).not.toContain('3 consecutive no-op retirements');

    const other = items.find((i) => i.title.includes('friction-2-tag'))!;
    expect(other.prompt).toContain('Recorded repos: lexicon.');

    const rejected = items.find((i) => i.title.includes('refuses'))!;
    expect(rejected.prompt).toContain('1 row(s) the validated reader refused');
    expect(rejected.prompt).toContain('external append');
  });

  it('emits the oversize item when the file exceeds the reader bound and suppresses the rejected sentinel', async () => {
    // Enough valid rows with long fields to pass FRICTION_MAX_BYTES: the
    // writer bounds rows by count, never bytes — the fixture reproduces
    // the outgrown-ledger state the cell reports.
    const lines: string[] = [];
    for (let i = 0; i < 300; i++) {
      lines.push(JSON.stringify(item({
        id: `noop-streak:RQ-${i}`,
        title: `Queue line RQ-${i} keeps retiring as DONE-NOOP with a deliberately long title to fill the ledger row`,
        detail: 'd'.repeat(900),
        openedAt: at((i % 30 + 1) * DAY),
      })));
    }
    await writeLedger(lines);
    expect((await stat(ledgerPath())).size).toBeGreaterThan(FRICTION_MAX_BYTES);
    const items = await frictionItemBacklogItems(opts());
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toContain('read bound');
    expect(items[0]!.prompt).toContain('every reader sees an empty ledger');
    expect(items[0]!.prompt).toContain('never by bytes');
    // The oversize sentinel must not masquerade as a rejected-row count.
    expect(items[0]!.prompt).not.toContain('row(s) the validated reader refused');
  });

  it('derives stable ids so a refresh re-adds nothing and honours the limit', async () => {
    await writeLedger([
      row({ id: 'a', source: 'src-a', openedAt: at(9 * DAY) }),
      row({ id: 'b', source: 'src-b', openedAt: at(8 * DAY) }),
      row({ id: 'c', source: 'src-c', openedAt: at(10 * DAY) }),
    ]);
    const first = await frictionItemBacklogItems(opts());
    const second = await frictionItemBacklogItems(opts());
    expect(first.map((i) => i.id)).toEqual(second.map((i) => i.id));
    expect(first).toHaveLength(3);
    expect(await frictionItemBacklogItems({ ...opts(), limit: 2 })).toHaveLength(2);
    // The default cap bounds the fold the same way.
    const many = Array.from({ length: FRICTION_ITEM_MAX_ITEMS + 4 }, (_, i) =>
      row({ id: `m${i}`, source: `src-${i}`, openedAt: at((i + 8) * DAY) }));
    await writeLedger(many);
    expect(await frictionItemBacklogItems(opts())).toHaveLength(FRICTION_ITEM_MAX_ITEMS);
  });

  it('appends the friction-items backlog item through discovery and dedupes on refresh', async () => {
    const ashlarDir = join(home, '.ashlr');
    await mkdir(ashlarDir, { recursive: true });
    await writeFile(join(ashlarDir, 'friction-ledger.jsonl'), `${row({ openedAt: new Date(Date.now() - 9 * DAY).toISOString() })}\n`);
    const greenGh = async (args: string[]) => {
      const p = args[4] ?? '';
      if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
    };
    const first = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    const feedItems = first.items.filter((i) => i.id.startsWith('fleet-friction-items-'));
    expect(feedItems).toHaveLength(1);
    expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    expect(appendUserBacklogItems(feedItems)).toBe(1);
    const second = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('fleet-friction-items-')))).toBe(0);
    expect(readUserBacklogItems().filter((i) => i.id.startsWith('fleet-friction-items-'))).toHaveLength(1);
  });
});
