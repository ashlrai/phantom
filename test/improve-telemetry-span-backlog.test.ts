import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverBacklog } from '../src/core/improve/discover.js';
import {
  foldTelemetrySpanCells,
  parseTelemetrySpanEntry,
  parseTelemetrySpanText,
  TELEMETRY_SPAN_BACKLOG_MAX_ITEMS,
  TELEMETRY_SPAN_MIN_DAYS,
  TELEMETRY_SPAN_MIN_ROWS,
  TELEMETRY_SPAN_WINDOW_MS,
  telemetrySpanBacklogItems,
  type TelemetrySpanRow,
} from '../src/core/improve/telemetry-span-backlog.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';

let home: string;
let saved: { HOME?: string; ASHLR_HOME?: string; ASHLR_RUNS_DIR?: string };
beforeEach(() => {
  saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME, ASHLR_RUNS_DIR: process.env.ASHLR_RUNS_DIR };
  delete process.env.ASHLR_HOME;
  delete process.env.ASHLR_RUNS_DIR;
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'improve-telspan-')));
  process.env.HOME = home;
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(home, { recursive: true, force: true });
});

const NOW = new Date('2026-11-23T12:00:00Z');
const NOW_MS = NOW.getTime();
/** ISO timestamp `days` before NOW (fractional via `hours`, which may be negative). */
const at = (days: number, hours = 0): string =>
  new Date(NOW_MS - days * 86400_000 + hours * 3600_000).toISOString();
/** The UTC date `days` before NOW — a daily file name the fold reads. */
const fileDate = (days: number): string => at(days).slice(0, 10);

const REPO = 'ashlrai/phantom';

interface JournalSpan {
  name?: string;
  runId?: string;
  model?: string;
  provider?: string;
  tier?: string;
  tokensIn?: number;
  tokensOut?: number;
  estCostUsd?: number | null;
  status?: string;
  startTs?: string;
  endTs?: string;
  [key: string]: unknown;
}

let seq = 0;
/** One GenAiSpan row under LocalFileSink's contract (spansFromRun/spansFromSwarm shape). */
const span = (status: string, daysAgo: number, over: JournalSpan = {}): JournalSpan => ({
  name: `task-${++seq}`, runId: `run-${seq}`, model: 'claude', provider: 'anthropic', tier: 'cloud',
  tokensIn: 1200, tokensOut: 300, estCostUsd: 0.0125, status,
  startTs: at(daysAgo, -1), endTs: at(daysAgo), ...over,
});

const journal = (rows: Array<JournalSpan | string>): string =>
  rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n';

/** Write one daily span file `daysAgo` before NOW inside the temp telemetry dir. */
const writeDay = (daysAgo: number, rows: Array<JournalSpan | string> | string): string => {
  const dir = path.join(home, '.ashlr', 'telemetry');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `telemetry-${fileDate(daysAgo)}.jsonl`);
  fs.writeFileSync(file, typeof rows === 'string' ? rows : journal(rows));
  return file;
};

const spanRow = (over: Partial<TelemetrySpanRow>): TelemetrySpanRow => ({
  runId: 'run-1', name: 'task-1', provider: 'anthropic', model: 'claude', tier: 'cloud',
  status: 'failed', atMs: NOW_MS - 3 * 86400_000, costUsd: 0.01, ...over,
});

describe('parseTelemetrySpanEntry / parseTelemetrySpanText', () => {
  it('keeps contract span rows and skips malformed or off-contract lines', () => {
    const good = span('failed', 3);
    const { spans, invalidRows } = parseTelemetrySpanText(journal([
      'not json',
      good,
      // off-contract rows:
      '{"name":"t"}',
      { ...span('done', 2), provider: '' },
      { ...span('done', 2), status: 42 },
      { ...span('done', 2), endTs: 'not-a-date', startTs: 'also-bad' },
      { ...span('done', 2), endTs: undefined, startTs: undefined },
      { ...span('done', 2), memory: { scope: 'job' }, tokenEvidence: { provenance: 'reported' } },
    ]));
    expect(invalidRows).toBe(6);
    expect(spans).toHaveLength(2);
    expect(spans[0]!.runId).toBe(good.runId);
    expect(spans[0]!.status).toBe('failed');
    expect(spans[0]!.costUsd).toBe(0.0125);
    // Extra metadata fields are tolerated.
    expect(spans[1]!.status).toBe('done');
  });

  it('parseTelemetrySpanEntry validates the writer contract field by field', () => {
    expect(parseTelemetrySpanEntry(null)).toBeNull();
    expect(parseTelemetrySpanEntry('x')).toBeNull();
    expect(parseTelemetrySpanEntry({})).toBeNull();
    const base = span('done', 1);
    expect(parseTelemetrySpanEntry(base)).not.toBeNull();
    for (const field of ['name', 'runId', 'provider', 'model', 'tier', 'status'] as const) {
      expect(parseTelemetrySpanEntry({ ...base, [field]: '' })).toBeNull();
      expect(parseTelemetrySpanEntry({ ...base, [field]: 7 })).toBeNull();
    }
    // endTs wins; startTs is the fallback clock.
    const row = parseTelemetrySpanEntry({ ...base, endTs: '2026-11-20T00:00:00.000Z', startTs: '2026-11-19T00:00:00.000Z' })!;
    expect(row.atMs).toBe(Date.parse('2026-11-20T00:00:00.000Z'));
    const fallback = parseTelemetrySpanEntry({ ...base, endTs: 'bogus', startTs: '2026-11-19T00:00:00.000Z' })!;
    expect(fallback.atMs).toBe(Date.parse('2026-11-19T00:00:00.000Z'));
    expect(parseTelemetrySpanEntry({ ...base, endTs: 'bogus', startTs: 'bogus' })).toBeNull();
  });

  it('keeps estCostUsd only when finite and non-negative', () => {
    const cases: Array<[unknown, number | null]> = [
      [0.5, 0.5], [0, 0], [-1, null], ['x', null], [null, null], [undefined, null], [NaN, null], [Infinity, null],
    ];
    for (const [value, expected] of cases) {
      const row = parseTelemetrySpanEntry({ ...span('failed', 1), estCostUsd: value })!;
      expect(row.costUsd).toBe(expected);
    }
  });
});

describe('foldTelemetrySpanCells', () => {
  it('counts failed and aborted spans as adverse; done, skipped, cancelled and unknown statuses are context', () => {
    const cells = foldFromRows([
      spanRow({ status: 'failed', atMs: NOW_MS - 5 * 86400_000, runId: 'run-1' }),
      spanRow({ status: 'aborted', atMs: NOW_MS - 4 * 86400_000, runId: 'run-2' }),
      spanRow({ status: 'failed', atMs: NOW_MS - 3 * 86400_000, runId: 'run-3' }),
      spanRow({ status: 'done', atMs: NOW_MS - 2 * 86400_000, runId: 'run-4' }),
      spanRow({ status: 'skipped', atMs: NOW_MS - 2 * 86400_000, runId: 'run-5' }),
      spanRow({ status: 'cancelled', atMs: NOW_MS - 2 * 86400_000, runId: 'run-6' }),
      spanRow({ status: 'mystery', atMs: NOW_MS - 2 * 86400_000, runId: 'run-7' }),
    ]);
    // Adverse spans: 3 across 3 days — a recurring cell; the rest is mix context.
    expect(cells).toHaveLength(1);
    const cell = cells[0]!;
    expect(cell.key).toBe('anthropic|claude|cloud');
    expect([cell.spans, cell.adverse, cell.done, cell.other]).toEqual([7, 3, 1, 3]);
    expect(cell.days.size).toBe(3);
    expect(cell.runs.size).toBe(3); // distinct run ids among the adverse spans only
  });

  it('emits nothing below the recurring bars of adverse rows and distinct days', () => {
    // Three adverse spans on a single UTC day — under the days bar.
    expect(foldFromRows([
      spanRow({ atMs: NOW_MS - 86400_000 - 3600_000 }),
      spanRow({ atMs: NOW_MS - 86400_000 - 7200_000 }),
      spanRow({ atMs: NOW_MS - 86400_000 - 3 * 3600_000 }),
    ])).toEqual([]);
    // Two adverse spans across two days — under the rows bar.
    expect(foldFromRows([
      spanRow({ atMs: NOW_MS - 5 * 86400_000 }),
      spanRow({ atMs: NOW_MS - 86400_000 }),
    ])).toEqual([]);
    // Non-adverse statuses never count toward the bars.
    expect(foldFromRows([
      spanRow({ status: 'done', atMs: NOW_MS - 5 * 86400_000 }),
      spanRow({ status: 'skipped', atMs: NOW_MS - 4 * 86400_000 }),
      spanRow({ status: 'cancelled', atMs: NOW_MS - 3 * 86400_000 }),
      spanRow({ status: 'done', atMs: NOW_MS - 2 * 86400_000 }),
    ])).toEqual([]);
    expect(TELEMETRY_SPAN_MIN_ROWS).toBe(3);
    expect(TELEMETRY_SPAN_MIN_DAYS).toBe(2);
    expect(TELEMETRY_SPAN_WINDOW_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('windows on the span clock and tolerates bounded future skew', () => {
    const cells = foldFromRows([
      spanRow({ atMs: NOW_MS - TELEMETRY_SPAN_WINDOW_MS - 1 }), // outside window
      spanRow({ atMs: NOW_MS - TELEMETRY_SPAN_WINDOW_MS + 1 }),
      spanRow({ atMs: NOW_MS - 4 * 86400_000 }),
      spanRow({ atMs: NOW_MS - 2 * 86400_000 }),
      spanRow({ atMs: NOW_MS + 30_000 }),  // inside skew — counts, lands today
      spanRow({ atMs: NOW_MS + 120_000 }), // beyond skew — dropped
    ]);
    // In-window adverse: 4 (window edge, -4d, -2d, +30s) across 4 days.
    expect(cells.map((c) => [c.adverse, c.days.size])).toEqual([[4, 4]]);
  });

  it('dedupes retried emits on runId+name+status+timestamp, first wins', () => {
    const dup = spanRow({ runId: 'run-x', name: 'task-x', atMs: NOW_MS - 3 * 86400_000, costUsd: 0.5 });
    const cells = foldFromRows([
      dup,
      { ...dup },                                            // identical — folds once
      spanRow({ runId: 'run-x', name: 'task-x', status: 'done', atMs: NOW_MS - 3 * 86400_000 }), // different status — separate span
      spanRow({ atMs: NOW_MS - 5 * 86400_000 }),
      spanRow({ atMs: NOW_MS - 86400_000 }),
    ]);
    expect(cells).toHaveLength(1);
    // Adverse rows: dup(1) + two others = 3; the 'done' same-key row is context.
    expect(cells[0]!.adverse).toBe(3);
    expect(cells[0]!.done).toBe(1);
    expect(cells[0]!.costUsd).toBeCloseTo(0.52, 5);
  });

  it('sums recorded adverse cost and counts cost-unknown spans separately', () => {
    const cells = foldFromRows([
      spanRow({ atMs: NOW_MS - 5 * 86400_000, costUsd: 0.02 }),
      spanRow({ atMs: NOW_MS - 4 * 86400_000, costUsd: 0.03 }),
      spanRow({ atMs: NOW_MS - 3 * 86400_000, costUsd: null }),
      spanRow({ atMs: NOW_MS - 2 * 86400_000, status: 'done', costUsd: 9 }), // done cost never joins
    ]);
    expect(cells).toHaveLength(1);
    expect(cells[0]!.costUsd).toBeCloseTo(0.05, 5);
    expect(cells[0]!.costUnknown).toBe(1);
  });

  it('keeps lanes separate and sorts by adverse count then recency', () => {
    const cells = foldFromRows([
      spanRow({ provider: 'openai', model: 'gpt', tier: 'cloud', atMs: NOW_MS - 5 * 86400_000 }),
      spanRow({ provider: 'openai', model: 'gpt', tier: 'cloud', atMs: NOW_MS - 4 * 86400_000 }),
      spanRow({ provider: 'openai', model: 'gpt', tier: 'cloud', atMs: NOW_MS - 3 * 86400_000 }),
      spanRow({ provider: 'ashlr-swarm', model: 'swarm', tier: 'local', atMs: NOW_MS - 86400_000 }),
      spanRow({ provider: 'ashlr-swarm', model: 'swarm', tier: 'local', atMs: NOW_MS - 2 * 86400_000 }),
      spanRow({ provider: 'ashlr-swarm', model: 'swarm', tier: 'local', status: 'done', atMs: NOW_MS - 86400_000 }),
    ]);
    // openai lane: 3 adverse/3 days → cell. swarm lane: 2 adverse → under bars.
    expect(cells.map((c) => c.key)).toEqual(['openai|gpt|cloud']);
  });
});

/** Fold validated TelemetrySpanRow fixtures the way the file path does after parsing. */
function foldFromRows(rows: TelemetrySpanRow[]): ReturnType<typeof foldTelemetrySpanCells> {
  return foldTelemetrySpanCells(rows, NOW_MS);
}

describe('telemetrySpanBacklogItems', () => {
  it('turns a recurring failed lane into a valid item', async () => {
    writeDay(0, [
      span('failed', 1, { runId: 'run-a', name: 't1', estCostUsd: 0.02 }),
      span('done', 1, { runId: 'run-a', name: 't2' }),
      span('aborted', 3, { runId: 'run-b', name: 't1', estCostUsd: 0.01 }),
      span('failed', 5, { runId: 'run-c', name: 't1', estCostUsd: 0.03 }),
      span('skipped', 2, { runId: 'run-d', name: 't1' }),
    ]);
    const items = await telemetrySpanBacklogItems({ repo: REPO, now: NOW });
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item).toMatchObject({ priority: 3, repo: REPO, area: 'telemetry-spans' });
    expect(item.id).toMatch(/^telspan-[0-9a-f]{16}$/);
    expect(item.title).toContain('anthropic/claude');
    expect(item.title).toContain('failed/aborted');
    expect(item.prompt).toContain('telemetry-');
    expect(item.prompt).toContain('.jsonl');
    expect(item.prompt).toContain('3 failed/aborted span(s)');
    expect(item.prompt).toContain('distinct UTC day(s)');
    expect(item.prompt).toContain('1 \'done\' span(s)');
    expect(item.prompt).toContain('estimated $0.0600');
    expect(item.prompt).toContain('no-change');
    expect(item.prompt).toContain('otlp.ts');
  });

  it('emits per-lane items for distinct provider/model/tier cells', async () => {
    writeDay(0, [
      span('failed', 1, { provider: 'anthropic', model: 'claude', tier: 'cloud' }),
      span('failed', 3, { provider: 'anthropic', model: 'claude', tier: 'cloud' }),
      span('failed', 5, { provider: 'anthropic', model: 'claude', tier: 'cloud' }),
      span('aborted', 2, { provider: 'ollama', model: 'llama3', tier: 'local', runId: 'run-l1' }),
      span('failed', 4, { provider: 'ollama', model: 'llama3', tier: 'local', runId: 'run-l2' }),
      span('failed', 6, { provider: 'ollama', model: 'llama3', tier: 'local', runId: 'run-l3' }),
    ]);
    const items = await telemetrySpanBacklogItems({ repo: REPO, now: NOW });
    expect(items).toHaveLength(2);
    const prompts = items.map((i) => i.prompt).join('\n');
    expect(prompts).toContain('anthropic/claude');
    expect(prompts).toContain('ollama/llama3');
    expect(items.every((i) => validBacklogItem(i) !== null)).toBe(true);
  });

  it('emits nothing below the recurring bars', async () => {
    writeDay(0, [
      span('failed', 1), span('failed', 1, { runId: 'run-b' }), span('failed', 1, { runId: 'run-c' }),
    ]);
    expect(await telemetrySpanBacklogItems({ repo: REPO, now: NOW })).toEqual([]);
    writeDay(0, '');
    expect(await telemetrySpanBacklogItems({ repo: REPO, now: NOW })).toEqual([]);
  });

  it('yields nothing when no daily file reads — unknown stays unknown', async () => {
    expect(await telemetrySpanBacklogItems({ repo: REPO, now: NOW })).toEqual([]);
    expect(await telemetrySpanBacklogItems({ repo: '', now: NOW })).toEqual([]);
    expect(await telemetrySpanBacklogItems({ repo: 'not-a-repo', now: NOW })).toEqual([]);
    const dir = path.join(home, '.ashlr', 'telemetry');
    fs.mkdirSync(dir, { recursive: true });
    // A directory where a daily file would be — exists but is not a file.
    fs.mkdirSync(path.join(dir, `telemetry-${fileDate(0)}.jsonl`));
    expect(await telemetrySpanBacklogItems({ repo: REPO, now: NOW })).toEqual([]);
  });

  it('emits nothing for another repository', async () => {
    writeDay(0, [span('failed', 1), span('failed', 3), span('failed', 5)]);
    expect(await telemetrySpanBacklogItems({ repo: 'ashlrai/other', now: NOW })).toEqual([]);
    expect(await telemetrySpanBacklogItems({ repo: 'AshlrAI/Phantom', now: NOW })).toHaveLength(1);
  });

  it('malformed journals yield no items rather than throwing', async () => {
    writeDay(0, 'not json\n{"name":"t"}\n');
    writeDay(1, [span('failed', 1), span('failed', 3), span('failed', 5)]);
    const items = await telemetrySpanBacklogItems({ repo: REPO, now: NOW });
    expect(items).toHaveLength(1);
    expect(items[0]!.prompt).toContain('malformed or off-contract lines dropped');
  });

  it('names unreadable daily files in the prompt while still folding readable ones', async () => {
    const dir = path.join(home, '.ashlr', 'telemetry');
    fs.mkdirSync(dir, { recursive: true });
    // A directory squatting on one daily file's name — readLedgerTail reports not-file.
    fs.mkdirSync(path.join(dir, `telemetry-${fileDate(2)}.jsonl`));
    writeDay(0, [span('failed', 1), span('failed', 3), span('failed', 5)]);
    const items = await telemetrySpanBacklogItems({ repo: REPO, now: NOW });
    expect(items).toHaveLength(1);
    expect(items[0]!.prompt).toContain('could not be read');
  });

  it('states truncation as a lower bound in the prompt', async () => {
    const file = writeDay(0, [span('failed', 1), span('failed', 3), span('failed', 5)]);
    // Pad the daily file past the 4 MiB tail so the read reports truncated.
    fs.writeFileSync(file, 'x'.repeat(5 * 1024 * 1024) + '\n' + fs.readFileSync(file, 'utf8'));
    const items = await telemetrySpanBacklogItems({ repo: REPO, now: NOW });
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) expect(item.prompt).toContain('lower bound');
  });

  it('derives stable ids so a refresh re-adds nothing', async () => {
    const rows = [span('failed', 1), span('failed', 3), span('failed', 5)];
    writeDay(0, rows);
    const first = await telemetrySpanBacklogItems({ repo: REPO, now: NOW });
    const second = await telemetrySpanBacklogItems({ repo: REPO, now: NOW });
    expect(first.length).toBeGreaterThan(0);
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
    writeDay(0, [...rows, span('failed', 6)]);
    const third = await telemetrySpanBacklogItems({ repo: REPO, now: NOW });
    expect(third.map((i) => i.id)).toEqual(first.map((i) => i.id));
    expect(first.length).toBeLessThanOrEqual(TELEMETRY_SPAN_BACKLOG_MAX_ITEMS);
  });

  it('appends telemetry-span items through discovery and dedupes on refresh', async () => {
    const now = Date.now();
    const today = new Date(now).toISOString().slice(0, 10);
    const dir = path.join(home, '.ashlr', 'telemetry');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `telemetry-${today}.jsonl`), journal(
      [1, 3, 5].map((days) => span('failed', 0, {
        runId: `run-${days}`, name: `task-${days}`,
        startTs: new Date(now - days * 86400_000 - 3600_000).toISOString(),
        endTs: new Date(now - days * 86400_000).toISOString(),
      })),
    ));
    const greenGh = async (args: string[]) => {
      const p = args[4] ?? '';
      if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
    };
    const first = await discoverBacklog(REPO, { gh: greenGh });
    const spanItems = first.items.filter((i) => i.id.startsWith('telspan-'));
    expect(spanItems).toHaveLength(1);
    expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    expect(appendUserBacklogItems(spanItems)).toBe(spanItems.length);
    const second = await discoverBacklog(REPO, { gh: greenGh });
    expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('telspan-')))).toBe(0);
    expect(readUserBacklogItems().filter((i) => i.id.startsWith('telspan-'))).toHaveLength(spanItems.length);
  });
});
