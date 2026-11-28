import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  POOL_DETECT_MAX_ITEMS,
  POOL_DETECT_MIN_DAYS,
  POOL_DETECT_MIN_JOBS,
  foldPoolDetectCells,
  poolDetectBacklogItems,
} from '../src/core/improve/pool-detect-backlog.js';
import { discoverBacklog } from '../src/core/improve/discover.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';

const HOUR = 3_600_000;
const J = (o: Record<string, unknown>): string => JSON.stringify(o);
const NOW = Date.now();
const ago = (hours: number): string => new Date(NOW - hours * HOUR).toISOString();

// Fixed UTC anchors keep the distinct-day assertions independent of the
// wall clock: D2/D1/D0 are three consecutive UTC dates, NOW_MS sits at
// D0 noon so every stamp below lands inside the 168h window.
const NOW_MS = Date.parse('2026-11-20T12:00:00.000Z');
const at = (day: 'D2' | 'D1' | 'D0', hhmm: string): string =>
  ({ D2: '2026-11-18', D1: '2026-11-19', D0: '2026-11-20' })[day] + `T${hhmm}:00.000Z`;

/** A pool receipt in the producer's exact shape (dispatchd metric() + ratelimited()). */
const poolRow = (job: string, stamp: string, opts: {
  lane?: string; kind?: string; mem?: unknown; swap?: unknown; extra?: Record<string, unknown>;
} = {}): string => J({
  event: 'pool',
  lane: opts.lane ?? 'codex',
  job,
  kind: opts.kind ?? 'rate_limit',
  mem_free_pct: opts.mem === undefined ? 42 : opts.mem,
  swap_gb: opts.swap === undefined ? 1.5 : opts.swap,
  ts: stamp,
  ...opts.extra,
});

describe('foldPoolDetectCells', () => {
  it('groups pool rows by (lane, kind) with distinct-job counts', () => {
    const cells = foldPoolDetectCells([
      poolRow('RQ-A', at('D2', '10:00')), poolRow('RQ-B', at('D1', '09:00')), poolRow('RQ-C', at('D0', '08:00')),
      poolRow('RQ-D', at('D2', '11:00'), { lane: 'devin', kind: 'model_capacity' }),
    ].join('\n'), NOW_MS, 168 * HOUR);
    expect(cells).toHaveLength(2);
    const main = cells[0]!;
    expect(main.lane).toBe('codex');
    expect(main.kind).toBe('rate_limit');
    expect(main.jobs).toBe(3);
    expect(main.rows).toBe(3);
    expect(main.days).toBe(3);
    expect(main.examples).toEqual(['RQ-A', 'RQ-B', 'RQ-C']);
    expect(main.firstSeen).toBe(at('D2', '10:00'));
    expect(main.lastSeen).toBe(at('D0', '08:00'));
    expect(cells[1]!.kind).toBe('model_capacity');
    expect(cells[1]!.jobs).toBe(1);
  });

  it('keeps the four closed-vocabulary kinds on separate cells', () => {
    const cells = foldPoolDetectCells([
      poolRow('RQ-U1', at('D2', '10:00'), { kind: 'usage_limit' }),
      poolRow('RQ-U2', at('D1', '09:00'), { kind: 'usage_limit' }),
      poolRow('RQ-U3', at('D0', '08:00'), { kind: 'usage_limit' }),
      poolRow('RQ-R1', at('D1', '10:00'), { kind: 'rate_limit' }),
      poolRow('RQ-R2', at('D1', '11:00'), { kind: 'rate_limit' }),
      poolRow('RQ-R3', at('D0', '09:00'), { kind: 'rate_limit' }),
      // A kind outside the producer's CLS vocabulary never counts.
      poolRow('RQ-X1', at('D0', '10:00'), { kind: 'overloaded' }),
      poolRow('RQ-X2', at('D0', '11:00'), { kind: 'quota' }),
    ].join('\n'), NOW_MS, 168 * HOUR);
    expect(cells).toHaveLength(2);
    expect(cells.find((c) => c.kind === 'usage_limit')!.jobs).toBe(3);
    expect(cells.find((c) => c.kind === 'rate_limit')!.jobs).toBe(3);
  });

  it('counts a duplicated job row once toward the distinct-job bar', () => {
    const cells = foldPoolDetectCells([
      poolRow('RQ-DUP', at('D2', '10:00')), poolRow('RQ-DUP', at('D1', '10:00')),
      poolRow('RQ-DUP2', at('D2', '11:00'), { kind: 'credits_exhausted' }),
      poolRow('RQ-DUP2', at('D1', '11:00'), { kind: 'credits_exhausted' }),
      poolRow('RQ-DUP2', at('D0', '11:00'), { kind: 'credits_exhausted' }),
    ].join('\n'), NOW_MS, 168 * HOUR);
    expect(cells).toHaveLength(2);
    for (const cell of cells) {
      expect(cell.jobs).toBe(1);
      expect(cell.days).toBeGreaterThanOrEqual(2);
    }
    expect(cells.find((c) => c.kind === 'credits_exhausted')!.rows).toBe(3);
  });

  it('folds host memory readings as recorded min/max context', () => {
    const cells = foldPoolDetectCells([
      poolRow('RQ-M1', at('D2', '10:00'), { mem: 55, swap: 2.5 }),
      poolRow('RQ-M2', at('D1', '09:00'), { mem: 12, swap: 8.25 }),
      poolRow('RQ-M3', at('D0', '08:00'), { mem: 30, swap: null }),
      poolRow('RQ-M4', at('D0', '09:00'), { mem: 'high', swap: 'lots' }),
      poolRow('RQ-M5', at('D0', '10:00'), { mem: -1, swap: -2 }),
    ].join('\n'), NOW_MS, 168 * HOUR);
    expect(cells).toHaveLength(1);
    const cell = cells[0]!;
    expect(cell.memRows).toBe(3);
    expect(cell.swapRows).toBe(2);
    expect(cell.memFreePctMin).toBe(12);
    expect(cell.swapGbMax).toBe(8.25);
  });

  it('leaves host readings unrecorded — never zero — when rows carry none', () => {
    const cells = foldPoolDetectCells([
      J({ event: 'pool', lane: 'codex', job: 'RQ-N1', kind: 'rate_limit', ts: at('D2', '10:00') }),
      J({ event: 'pool', lane: 'codex', job: 'RQ-N2', kind: 'rate_limit', mem_free_pct: null, swap_gb: null, ts: at('D1', '09:00') }),
      J({ event: 'pool', lane: 'codex', job: 'RQ-N3', kind: 'rate_limit', ts: at('D0', '08:00') }),
    ].join('\n'), NOW_MS, 168 * HOUR);
    expect(cells).toHaveLength(1);
    expect(cells[0]!.memRows).toBe(0);
    expect(cells[0]!.swapRows).toBe(0);
    expect(cells[0]!.memFreePctMin).toBeNull();
    expect(cells[0]!.swapGbMax).toBeNull();
  });

  it('drops malformed, out-of-contract and unplaceable rows', () => {
    const cells = foldPoolDetectCells([
      // Kind outside the closed CLS vocabulary.
      poolRow('RQ-BADKIND', at('D1', '10:00'), { kind: 'provider_down' }),
      // Missing or malformed required fields.
      J({ event: 'pool', job: 'RQ-NOLANE', kind: 'rate_limit', ts: at('D1', '10:00') }),
      J({ event: 'pool', lane: 'codex', kind: 'rate_limit', ts: at('D1', '10:00') }),
      J({ event: 'pool', lane: 'codex', job: 'bad job id', kind: 'rate_limit', ts: at('D1', '10:00') }),
      J({ event: 'pool', lane: 'bad lane!', job: 'RQ-BADLANE', kind: 'rate_limit', ts: at('D1', '10:00') }),
      J({ event: 'pool', lane: 'codex', job: 'RQ-NOKIND', ts: at('D1', '10:00') }),
      // Non-pool events never count, even carrying a wall-sounding kind.
      J({ event: 'finish', lane: 'codex', job: 'RQ-F', kind: 'rate_limit', ts: at('D1', '10:00') }),
      J({ event: 'autobackoff_hold', lane: 'codex', job: 'RQ-H', kind: 'rate_limit', ts: at('D1', '10:00') }),
      // A bare kind-as-event-name row is not the producer's contract.
      J({ kind: 'pool', lane: 'codex', job: 'RQ-KONLY', rate_limit: true, ts: at('D1', '10:00') }),
      // Unplaceable or out-of-window stamps never count.
      poolRow('RQ-NOTS', 'not a date'),
      poolRow('RQ-FUTURE', '2026-11-25T10:00:00.000Z'),
      poolRow('RQ-OLD', '2026-11-01T10:00:00.000Z'),
      'not json at all',
    ].join('\n'), NOW_MS, 48 * HOUR);
    expect(cells).toEqual([]);
  });

  it('accepts the alias event-name spellings the dialect shares', () => {
    const cells = foldPoolDetectCells([
      J({ type: 'pool', lane: 'codex', job: 'RQ-T', kind: 'usage_limit', ts: at('D2', '10:00') }),
      J({ event: 'pool', lane: 'codex', job: 'RQ-E', kind: 'usage_limit', ts: at('D1', '09:00') }),
      J({ event: 'pool', lane: 'codex', job: 'RQ-E2', kind: 'usage_limit', ts: at('D0', '08:00') }),
    ].join('\n'), NOW_MS, 168 * HOUR);
    expect(cells).toHaveLength(1);
    expect(cells[0]!.jobs).toBe(3);
  });
});

describe('poolDetectBacklogItems', () => {
  let home: string;
  let saved: { HOME?: string; ASHLR_HOME?: string; ASHLR_RUNS_DIR?: string };

  beforeEach(async () => {
    saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME, ASHLR_RUNS_DIR: process.env.ASHLR_RUNS_DIR };
    delete process.env.ASHLR_HOME;
    delete process.env.ASHLR_RUNS_DIR;
    home = await mkdtemp(join(tmpdir(), 'pool-detect-backlog-'));
    process.env.HOME = home;
  });
  afterEach(async () => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    vi.restoreAllMocks();
    await rm(home, { recursive: true, force: true });
  });

  async function runsDir(name: string, ledger?: string[]): Promise<string> {
    const dir = join(home, name);
    await mkdir(join(dir, 'metrics'), { recursive: true });
    if (ledger !== undefined) await writeFile(join(dir, 'metrics', 'jobs.jsonl'), ledger.join('\n') + '\n');
    return dir;
  }

  it('emits one item for a recurring detection cell and validates it', async () => {
    const dir = await runsDir('runs-hit', [
      poolRow('RQ-W1', ago(50)), poolRow('RQ-W2', ago(30)), poolRow('RQ-W3', ago(10)),
      poolRow('RQ-OTHER', ago(5), { lane: 'devin', kind: 'model_capacity' }),
      J({ event: 'finish', job: 'RQ-F', lane: 'codex', ts: ago(5) }),
    ]);
    const items = await poolDetectBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW) });
    expect(items).toHaveLength(1);
    const [item] = items;
    expect(item).toMatchObject({ priority: 3, repo: 'ashlrai/phantom', area: 'pool-detects' });
    expect(item!.id).toMatch(/^fleet-pool-detect-[0-9a-f]{16}$/);
    expect(item!.title).toContain('codex');
    expect(item!.title).toContain('Rate-limit');
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item!.prompt).toContain('RQ-W1');
    expect(item!.prompt).toContain('rate_limit');
    expect(item!.prompt).toContain('ratelimited');
    expect(item!.prompt).toContain('mem_free_pct');
    expect(item!.prompt).toContain('no-change');
  });

  it('emits one item per recurring (lane, kind) cell', async () => {
    const dir = await runsDir('runs-cells', [
      poolRow('RQ-A1', ago(50), { lane: 'codex', kind: 'usage_limit' }),
      poolRow('RQ-A2', ago(30), { lane: 'codex', kind: 'usage_limit' }),
      poolRow('RQ-A3', ago(10), { lane: 'codex', kind: 'usage_limit' }),
      poolRow('RQ-B1', ago(49), { lane: 'claude', kind: 'credits_exhausted' }),
      poolRow('RQ-B2', ago(29), { lane: 'claude', kind: 'credits_exhausted' }),
      poolRow('RQ-B3', ago(9), { lane: 'claude', kind: 'credits_exhausted' }),
      poolRow('RQ-C1', ago(48), { lane: 'devin', kind: 'model_capacity' }),
      poolRow('RQ-C2', ago(28), { lane: 'devin', kind: 'model_capacity' }),
      poolRow('RQ-C3', ago(8), { lane: 'devin', kind: 'model_capacity' }),
    ]);
    const items = await poolDetectBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW) });
    expect(items).toHaveLength(3);
    const prompts = items.map((i) => i.prompt).join('\n');
    expect(prompts).toContain('usage_limit');
    expect(prompts).toContain('credits_exhausted');
    expect(prompts).toContain('model_capacity');
    expect(new Set(items.map((i) => i.id)).size).toBe(3);
    const credits = items.find((i) => i.prompt.includes('credits_exhausted'))!;
    expect(credits.title).toContain('Credits-exhausted');
    expect(credits.prompt).toContain('lane hold');
    const capacity = items.find((i) => i.prompt.includes('model_capacity'))!;
    expect(capacity.prompt).toContain('no slot');
  });

  it('emits nothing below the recurring bars of distinct jobs and days', async () => {
    // Three rows but only two distinct jobs.
    const dup = await runsDir('runs-dup', [
      poolRow('RQ-D1', ago(50)), poolRow('RQ-D1', ago(30)), poolRow('RQ-D2', ago(10)),
    ]);
    expect(await poolDetectBacklogItems({ repo: 'ashlrai/phantom', runsDir: dup, now: new Date(NOW) })).toEqual([]);
    // Three distinct jobs but all inside one UTC day: anchor `now` at UTC
    // noon and stamp every row inside that same date.
    const day = '2026-11-20';
    const noon = new Date(`${day}T12:00:00.000Z`);
    const sameDay = await runsDir('runs-sameday', [
      poolRow('RQ-S1', `${day}T06:00:00.000Z`),
      poolRow('RQ-S2', `${day}T07:00:00.000Z`),
      poolRow('RQ-S3', `${day}T08:00:00.000Z`),
    ]);
    expect(await poolDetectBacklogItems({ repo: 'ashlrai/phantom', runsDir: sameDay, now: noon })).toEqual([]);
    expect(POOL_DETECT_MIN_JOBS).toBeGreaterThanOrEqual(3);
    expect(POOL_DETECT_MIN_DAYS).toBeGreaterThanOrEqual(2);
  });

  it('emits nothing for a missing ledger or another repository', async () => {
    const empty = await runsDir('runs-empty');
    expect(await poolDetectBacklogItems({ repo: 'ashlrai/phantom', runsDir: empty, now: new Date(NOW) })).toEqual([]);
    expect(await poolDetectBacklogItems({ repo: 'ashlrai/phantom', runsDir: join(home, 'no-such'), now: new Date(NOW) })).toEqual([]);

    const dir = await runsDir('runs-repo', [
      poolRow('RQ-P1', ago(50)), poolRow('RQ-P2', ago(30)), poolRow('RQ-P3', ago(10)),
    ]);
    expect(await poolDetectBacklogItems({ repo: 'ashlrai/other', runsDir: dir, now: new Date(NOW) })).toEqual([]);
    expect(await poolDetectBacklogItems({ repo: 'AshlrAI/Phantom', runsDir: dir, now: new Date(NOW) })).toHaveLength(1);
  });

  it('derives stable ids so a refresh re-adds nothing', async () => {
    const dir = await runsDir('runs-stable', [
      poolRow('RQ-T1', ago(50)), poolRow('RQ-T2', ago(30)), poolRow('RQ-T3', ago(10)),
    ]);
    const opts = { repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW) };
    const first = await poolDetectBacklogItems(opts);
    const second = await poolDetectBacklogItems(opts);
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
  });

  it('states a truncated tail as a lower bound in the prompt', async () => {
    const dir = await runsDir('runs-trunc', []);
    await writeFile(join(dir, 'metrics', 'jobs.jsonl'),
      'x'.repeat(32 * 1024) + '\n' + [
        poolRow('RQ-U1', ago(50)), poolRow('RQ-U2', ago(30)), poolRow('RQ-U3', ago(10)),
      ].join('\n') + '\n');
    const items = await poolDetectBacklogItems({
      repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW), ledgerLimit: 16 * 1024,
    });
    expect(items).toHaveLength(1);
    expect(items[0]!.prompt).toContain('lower bound');
  });

  it('honours the item limit', async () => {
    const dir = await runsDir('runs-limit', [
      poolRow('RQ-A1', ago(50), { lane: 'codex', kind: 'usage_limit' }), poolRow('RQ-A2', ago(30), { lane: 'codex', kind: 'usage_limit' }), poolRow('RQ-A3', ago(10), { lane: 'codex', kind: 'usage_limit' }),
      poolRow('RQ-B1', ago(49), { lane: 'claude', kind: 'credits_exhausted' }), poolRow('RQ-B2', ago(29), { lane: 'claude', kind: 'credits_exhausted' }), poolRow('RQ-B3', ago(9), { lane: 'claude', kind: 'credits_exhausted' }),
      poolRow('RQ-C1', ago(48), { lane: 'devin', kind: 'model_capacity' }), poolRow('RQ-C2', ago(28), { lane: 'devin', kind: 'model_capacity' }), poolRow('RQ-C3', ago(8), { lane: 'devin', kind: 'model_capacity' }),
    ]);
    const all = await poolDetectBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW) });
    expect(all).toHaveLength(3);
    const limited = await poolDetectBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW), limit: 1 });
    expect(limited).toHaveLength(1);
    expect(POOL_DETECT_MAX_ITEMS).toBeGreaterThan(0);
  });

  it('appends pool-detect items through discovery and dedupes on refresh', async () => {
    const runs = join(home, '.ashlr-runs');
    await mkdir(join(runs, 'metrics'), { recursive: true });
    await writeFile(join(runs, 'metrics', 'jobs.jsonl'), [
      poolRow('RQ-D1', ago(50)), poolRow('RQ-D2', ago(30)), poolRow('RQ-D3', ago(10)),
    ].join('\n') + '\n');
    const greenGh = async (args: string[]) => {
      const p = args[4] ?? '';
      if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
    };
    const first = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    const detectItems = first.items.filter((i) => i.id.startsWith('fleet-pool-detect-'));
    expect(detectItems).toHaveLength(1);
    expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    expect(appendUserBacklogItems(detectItems)).toBe(1);
    const second = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('fleet-pool-detect-')))).toBe(0);
    expect(readUserBacklogItems().filter((i) => i.id.startsWith('fleet-pool-detect-'))).toHaveLength(1);
  });
});
