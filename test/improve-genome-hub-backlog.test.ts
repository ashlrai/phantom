import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  foldGenomeHubCells,
  genomeHubBacklogItems,
  GENOME_HUB_MIN_DAYS,
  GENOME_HUB_RECALL_BOUND,
  GENOME_HUB_RECURRING,
  parseGenomeHubLine,
  type GenomeHubRow,
} from '../src/core/improve/genome-hub-backlog.js';
import { discoverBacklog } from '../src/core/improve/discover.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';

const NOW = Date.now();
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const at = (msAgo: number): string => new Date(NOW - msAgo).toISOString();

let seq = 0;
const row = (over: Partial<GenomeHubRow> & { title: string; ts: string }): GenomeHubRow => ({
  id: `hub-entry-${(seq += 1)}`,
  project: null,
  text: 'learned something useful',
  tags: [],
  mergedCount: null,
  ...over,
  tsMs: Date.parse(over.ts),
});

const capture = (kind: 'run' | 'swarm', outcome: 'done' | 'failed' | 'aborted', title: string, msAgo: number, tags: string[] = []): GenomeHubRow =>
  row({
    title,
    ts: at(msAgo),
    tags: [kind, outcome, ...tags],
  });

describe('parseGenomeHubLine', () => {
  it('accepts the writer-contract shape and coerces optional fields', () => {
    const parsed = parseGenomeHubLine(JSON.stringify({
      id: 'a', project: 'phantom', source: 'hub', title: 'T', text: 'body', tags: ['run', 'failed', 7, 'x'], ts: at(DAY), mergedCount: 3,
    }));
    expect(parsed).not.toBeNull();
    expect(parsed).toMatchObject({ id: 'a', project: 'phantom', title: 'T', tags: ['run', 'failed', 'x'], mergedCount: 3 });
    expect(parsed!.tsMs).toBe(Date.parse(at(DAY)));
  });

  it('rejects malformed, non-object and missing-field lines the readers skip', () => {
    expect(parseGenomeHubLine('not json')).toBeNull();
    expect(parseGenomeHubLine('[1,2]')).toBeNull();
    expect(parseGenomeHubLine('null')).toBeNull();
    expect(parseGenomeHubLine(JSON.stringify({ id: 'a', title: 't' }))).toBeNull();
    expect(parseGenomeHubLine(JSON.stringify({ id: 'a', title: 't', text: 'x', ts: 5 }))).toBeNull();
    expect(parseGenomeHubLine('   ')).toBeNull();
  });

  it('keeps unparseable timestamps as recallable rows with null tsMs', () => {
    const parsed = parseGenomeHubLine(JSON.stringify({ id: 'a', title: 't', text: 'x', ts: 'not-a-date' }));
    expect(parsed).not.toBeNull();
    expect(parsed!.tsMs).toBeNull();
  });
});

describe('foldGenomeHubCells', () => {
  const base = { sinceMs: NOW - 7 * DAY, untilMs: NOW + 60_000, fileBytes: null };

  it('emits the duplicates cell at the recurring bar across distinct UTC days', () => {
    const cells = foldGenomeHubCells({
      ...base,
      tailLowerBound: false,
      countLowerBound: false,
      countRows: [],
      rows: [
        row({ title: 'Fix the flaky login test', ts: at(5 * DAY) }),
        row({ title: 'fix the flaky   LOGIN test!', ts: at(3 * DAY) }),
        row({ title: 'Fix the flaky login test', ts: at(DAY) }),
        row({ title: 'Different lesson entirely', ts: at(2 * DAY) }),
      ],
    });
    expect(cells.map((c) => c.key)).toEqual(['duplicates']);
    const cell = cells[0]!;
    expect(cell.count).toBe(3);
    expect(cell.clusters).toHaveLength(1);
    expect(cell.clusters[0]).toMatchObject({ count: 3, days: 3 });
    expect(cell.clusters[0]!.days).toBeGreaterThanOrEqual(GENOME_HUB_MIN_DAYS);
    expect(cell.lowerBound).toBe(false);
  });

  it('never emits below the row or day bars, or across projects', () => {
    expect(GENOME_HUB_RECURRING).toBe(3);
    expect(foldGenomeHubCells({
      ...base, tailLowerBound: false, countLowerBound: false, countRows: [],
      rows: [
        row({ title: 'Same lesson', ts: at(5 * DAY) }),
        row({ title: 'Same lesson', ts: at(3 * DAY) }),
      ],
    })).toEqual([]);
    // Three rows but all on one UTC day.
    expect(foldGenomeHubCells({
      ...base, tailLowerBound: false, countLowerBound: false, countRows: [],
      rows: [
        row({ title: 'Same lesson', ts: at(2 * DAY) }),
        row({ title: 'Same lesson', ts: at(2 * DAY + HOUR) }),
        row({ title: 'Same lesson', ts: at(2 * DAY + 2 * HOUR) }),
      ],
    })).toEqual([]);
    // Same title under different projects is a different lesson cluster.
    expect(foldGenomeHubCells({
      ...base, tailLowerBound: false, countLowerBound: false, countRows: [],
      rows: [
        row({ title: 'Same lesson', project: 'a', ts: at(5 * DAY) }),
        row({ title: 'Same lesson', project: 'b', ts: at(3 * DAY) }),
        row({ title: 'Same lesson', project: 'c', ts: at(DAY) }),
      ],
    })).toEqual([]);
  });

  it('emits the failures cell only for run/swarm rows carrying failed or aborted', () => {
    const cells = foldGenomeHubCells({
      ...base, tailLowerBound: false, countLowerBound: false, countRows: [],
      rows: [
        capture('run', 'failed', 'Fix the parser', 5 * DAY),
        capture('swarm', 'aborted', 'Migrate the store', 3 * DAY),
        capture('run', 'failed', 'Fix the parser', DAY),
        capture('run', 'done', 'Successful run', 2 * DAY),
        row({ title: 'manual note', ts: at(HOUR), tags: ['failed'] }),
        row({ title: 'manual note 2', ts: at(HOUR), tags: ['run'] }),
      ],
    });
    expect(cells.map((c) => c.key)).toEqual(['failures']);
    const cell = cells[0]!;
    expect(cell.count).toBe(3);
    expect(cell.byKind).toEqual([
      { kind: 'run', count: 2 },
      { kind: 'swarm', count: 1 },
    ]);
    expect(cell.examples).toContain('Fix the parser');
  });

  it('ignores rows outside the window, past skew, and with unplaceable stamps', () => {
    const cells = foldGenomeHubCells({
      ...base, tailLowerBound: false, countLowerBound: false, countRows: [],
      rows: [
        capture('run', 'failed', 'old one', 8 * DAY),
        capture('run', 'failed', 'old two', 9 * DAY),
        capture('run', 'failed', 'old three', 10 * DAY),
        capture('run', 'failed', 'future one', -2 * 60 * 1000),
        capture('run', 'failed', 'future two', -3 * 60 * 1000),
        capture('run', 'failed', 'future three', -4 * 60 * 1000),
        { ...capture('run', 'failed', 'bad stamp', DAY), ts: 'not-a-date', tsMs: null },
        capture('run', 'failed', 'in one', 2 * DAY),
        capture('run', 'failed', 'in two', DAY),
      ],
    });
    expect(cells).toEqual([]);
    // Inside the one-minute skew the stamp still counts as same-host drift.
    const skewed = foldGenomeHubCells({
      ...base, tailLowerBound: false, countLowerBound: false, countRows: [],
      rows: [
        capture('run', 'failed', 's1', -30 * 1000),
        capture('run', 'failed', 's2', -20 * 1000),
        capture('run', 'failed', 's3', 2 * DAY - 30 * 1000),
      ],
    });
    expect(skewed.map((c) => c.key)).toEqual(['failures']);
  });

  it('emits oversized only past the recall bound and marks truncated counts as floors', () => {
    const quiet = foldGenomeHubCells({
      ...base, tailLowerBound: false, countLowerBound: false,
      countRows: Array.from({ length: GENOME_HUB_RECALL_BOUND }, (_, i) => row({ title: `t${i}`, ts: at(i * HOUR) })),
      rows: [],
    });
    expect(quiet).toEqual([]);
    const over = foldGenomeHubCells({
      ...base, tailLowerBound: true, countLowerBound: true,
      countRows: Array.from({ length: GENOME_HUB_RECALL_BOUND + 1 }, (_, i) => row({ title: `t${i}`, ts: at(i * HOUR) })),
      rows: [],
      fileBytes: 12 * 1024 * 1024,
    });
    expect(over.map((c) => c.key)).toEqual(['oversized']);
    expect(over[0]).toMatchObject({ count: GENOME_HUB_RECALL_BOUND + 1, lowerBound: true, fileBytes: 12 * 1024 * 1024 });
    // countRows null (unreadable head) never emits oversized.
    expect(foldGenomeHubCells({
      ...base, tailLowerBound: true, countLowerBound: true, countRows: null, rows: [],
    })).toEqual([]);
  });

  it('carries consolidation provenance as context, never as a cell', () => {
    const cells = foldGenomeHubCells({
      ...base, tailLowerBound: false, countLowerBound: false, countRows: [],
      rows: [
        { ...capture('run', 'failed', 'merged lesson', 5 * DAY), mergedCount: 4 },
        capture('run', 'failed', 'plain one', 3 * DAY),
        capture('run', 'failed', 'plain two', DAY),
      ],
    });
    expect(cells.map((c) => c.key)).toEqual(['failures']);
    expect(cells[0]!.consolidatedRows).toBe(1);
  });
});

describe('genomeHubBacklogItems', () => {
  let home: string;
  let saved: { HOME?: string; ASHLR_HOME?: string };

  beforeEach(async () => {
    saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME };
    delete process.env.ASHLR_HOME;
    home = await mkdtemp(join(tmpdir(), 'genome-hub-backlog-'));
    process.env.HOME = home;
  });
  afterEach(async () => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    vi.restoreAllMocks();
    await rm(home, { recursive: true, force: true });
  });

  const hubPath = (): string => join(home, '.ashlr', 'genome', 'hub.jsonl');

  const writeHub = async (lines: readonly string[]): Promise<void> => {
    await mkdir(join(home, '.ashlr', 'genome'), { recursive: true });
    await writeFile(hubPath(), `${lines.join('\n')}\n`);
  };

  const line = (r: GenomeHubRow): string => JSON.stringify({
    id: r.id, project: r.project, source: 'hub', title: r.title, text: r.text,
    tags: r.tags, ts: r.ts, ...(r.mergedCount !== null ? { mergedCount: r.mergedCount, firstTs: r.ts, lastTs: r.ts } : {}),
  });

  it('emits duplicates and failures items for recurring evidence and validates them', async () => {
    await writeHub([
      // duplicates cluster: same normalized title three times across days
      line(row({ title: 'Fix the flaky login test', ts: at(5 * DAY) })),
      line(row({ title: 'fix the flaky   LOGIN test!', ts: at(3 * DAY) })),
      line(row({ title: 'Fix the flaky login test', ts: at(DAY) })),
      // failures: three failed captures across days
      line(capture('run', 'failed', 'Fix the parser', 4 * DAY)),
      line(capture('swarm', 'aborted', 'Migrate the store', 2 * DAY)),
      line(capture('run', 'failed', 'Fix the parser', HOUR)),
      'not json at all',
      JSON.stringify({ id: 'partial' }),
    ]);
    const items = await genomeHubBacklogItems({ repo: 'ashlrai/phantom', now: new Date(NOW) });
    expect(items).toHaveLength(2);
    expect(items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    const byKey = Object.fromEntries(items.map((i) => [i.prompt.includes('re-recording') ? 'duplicates' : 'failures', i]));
    expect(byKey['duplicates']!.title).toContain('re-recording');
    expect(byKey['duplicates']!.prompt).toContain('hub.jsonl');
    expect(byKey['duplicates']!.prompt).toContain('appendHubEntry');
    expect(byKey['duplicates']!.prompt).toContain('consolidateGenome');
    expect(byKey['duplicates']!.prompt).toContain('no-change');
    expect(byKey['duplicates']!.prompt).toContain('Fix the flaky login test');
    expect(byKey['failures']!.prompt).toContain("'failed' or 'aborted'");
    expect(byKey['failures']!.prompt).toContain('captureFromRun');
    expect(byKey['failures']!.prompt).toContain('recall-eligible');
    expect(byKey['failures']!.prompt).toContain('Fix the parser');
    expect(items.every((i) => i.repo === 'ashlrai/phantom' && i.priority === 3 && i.area === 'genome-hub')).toBe(true);
    expect(new Set(items.map((i) => i.id)).size).toBe(2);
  });

  it('emits nothing below the bars, for a missing journal, quiet window, or another repository', async () => {
    // Below the recurring bar.
    await writeHub([
      line(row({ title: 'Same lesson', ts: at(5 * DAY) })),
      line(row({ title: 'Same lesson', ts: at(3 * DAY) })),
      line(capture('run', 'failed', 'One failure', 2 * DAY)),
      line(capture('run', 'failed', 'Another failure', DAY)),
    ]);
    expect(await genomeHubBacklogItems({ repo: 'ashlrai/phantom', now: new Date(NOW) })).toEqual([]);

    // Same-day duplicates never recur across days.
    await writeHub([
      line(row({ title: 'Same lesson', ts: at(2 * DAY) })),
      line(row({ title: 'Same lesson', ts: at(2 * DAY + HOUR) })),
      line(row({ title: 'Same lesson', ts: at(2 * DAY + 2 * HOUR) })),
    ]);
    expect(await genomeHubBacklogItems({ repo: 'ashlrai/phantom', now: new Date(NOW) })).toEqual([]);

    // Done captures are not failures.
    await writeHub([
      line(capture('run', 'done', 'ok one', 5 * DAY)),
      line(capture('run', 'done', 'ok two', 3 * DAY)),
      line(capture('swarm', 'done', 'ok three', DAY)),
    ]);
    expect(await genomeHubBacklogItems({ repo: 'ashlrai/phantom', now: new Date(NOW) })).toEqual([]);

    // Missing journal file.
    await rm(hubPath(), { force: true });
    expect(await genomeHubBacklogItems({ repo: 'ashlrai/phantom', now: new Date(NOW) })).toEqual([]);

    // Another repository inherits nothing — hub rows carry no repo coordinate.
    await writeHub([
      line(row({ title: 'Same lesson', ts: at(5 * DAY) })),
      line(row({ title: 'Same lesson', ts: at(3 * DAY) })),
      line(row({ title: 'Same lesson', ts: at(DAY) })),
    ]);
    expect(await genomeHubBacklogItems({ repo: 'ashlrai/other', now: new Date(NOW) })).toEqual([]);
    expect(await genomeHubBacklogItems({ repo: 'AshlrAI/Phantom', now: new Date(NOW) })).toHaveLength(1);
  });

  it('emits the oversized item past the recall bound with an exact count on a small file', async () => {
    const lines: string[] = [];
    for (let i = 0; i < GENOME_HUB_RECALL_BOUND + 1; i += 1) {
      lines.push(line(row({ title: `lesson ${i}`, ts: at(i * 1000) })));
    }
    await writeHub(lines);
    const items = await genomeHubBacklogItems({ repo: 'ashlrai/phantom', now: new Date(NOW) });
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toMatch(/^genome-hub-[0-9a-f]{16}$/);
    expect(items[0]!.prompt).toContain(`${GENOME_HUB_RECALL_BOUND + 1} recallable entries`);
    expect(items[0]!.prompt).toContain('loadHubEntries');
    expect(items[0]!.prompt).toContain('phm genome consolidate');
    expect(items[0]!.prompt).not.toContain('lower bound');
    expect(validBacklogItem(items[0])).not.toBeNull();
  });

  it('derives stable ids so a refresh re-adds nothing and honours the limit', async () => {
    await writeHub([
      line(row({ title: 'Fix the flaky login test', ts: at(5 * DAY) })),
      line(row({ title: 'fix the flaky   LOGIN test!', ts: at(3 * DAY) })),
      line(row({ title: 'Fix the flaky login test', ts: at(DAY) })),
      line(capture('run', 'failed', 'Fix the parser', 4 * DAY)),
      line(capture('swarm', 'aborted', 'Migrate the store', 2 * DAY)),
      line(capture('run', 'failed', 'Fix the parser', HOUR)),
    ]);
    const opts = { repo: 'ashlrai/phantom', now: new Date(NOW) };
    const first = await genomeHubBacklogItems(opts);
    const second = await genomeHubBacklogItems(opts);
    expect(first.map((i) => i.id)).toEqual(second.map((i) => i.id));
    expect(first).toHaveLength(2);
    expect(await genomeHubBacklogItems({ ...opts, limit: 1 })).toHaveLength(1);
  });

  it('appends the genome-hub items through discovery and dedupes on refresh', async () => {
    await writeHub([
      line(row({ title: 'Fix the flaky login test', ts: at(5 * DAY) })),
      line(row({ title: 'fix the flaky   LOGIN test!', ts: at(3 * DAY) })),
      line(row({ title: 'Fix the flaky login test', ts: at(DAY) })),
      line(capture('run', 'failed', 'Fix the parser', 4 * DAY)),
      line(capture('swarm', 'aborted', 'Migrate the store', 2 * DAY)),
      line(capture('run', 'failed', 'Fix the parser', HOUR)),
    ]);
    const greenGh = async (args: string[]) => {
      const p = args[4] ?? '';
      if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
    };
    const first = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    const hubItems = first.items.filter((i) => i.id.startsWith('genome-hub-'));
    expect(hubItems).toHaveLength(2);
    expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    expect(appendUserBacklogItems(hubItems)).toBe(2);
    const second = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('genome-hub-')))).toBe(0);
    expect(readUserBacklogItems().filter((i) => i.id.startsWith('genome-hub-'))).toHaveLength(2);
  });
});
