import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BACKOFF_SKIP_MAX_ITEMS,
  BACKOFF_SKIP_MIN_DAYS,
  BACKOFF_SKIP_MIN_JOBS,
  backoffSkipBacklogItems,
  foldBackoffSkipCells,
} from '../src/core/improve/backoff-skip-backlog.js';
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

/** An autobackoff_skip row in the producer's exact shape (dispatchd metric()). */
const usageSkipRow = (job: string, stamp: string, opts: {
  lane?: string; pattern?: string; src?: string; extra?: Record<string, unknown>;
} = {}): string => J({
  event: 'autobackoff_skip',
  lane: opts.lane ?? 'codex',
  job,
  pattern: opts.pattern ?? 'codex_usage_limit',
  src: opts.src ?? 'helper_unavailable',
  ts: stamp,
  ...opts.extra,
});

/** An authbackoff_skip row in the producer's exact shape (dispatchd metric()). */
const authSkipRow = (job: string, stamp: string, opts: {
  lane?: string; pattern?: string; src?: string; extra?: Record<string, unknown>;
} = {}): string => J({
  event: 'authbackoff_skip',
  lane: opts.lane ?? 'claude',
  job,
  pattern: opts.pattern ?? 'claude_auth_401',
  src: opts.src ?? 'helper_unavailable',
  ts: stamp,
  ...opts.extra,
});

describe('foldBackoffSkipCells', () => {
  it('groups skip rows by (family, lane, pattern) with distinct-job counts', () => {
    const cells = foldBackoffSkipCells([
      usageSkipRow('RQ-A', at('D2', '10:00')), usageSkipRow('RQ-B', at('D1', '09:00')), usageSkipRow('RQ-C', at('D0', '08:00')),
      authSkipRow('RQ-D', at('D2', '11:00'), { lane: 'devin', pattern: 'devin_auth_failure' }),
    ].join('\n'), NOW_MS, 168 * HOUR);
    expect(cells).toHaveLength(2);
    const main = cells[0]!;
    expect(main.family).toBe('usage');
    expect(main.event).toBe('autobackoff_skip');
    expect(main.lane).toBe('codex');
    expect(main.pattern).toBe('codex_usage_limit');
    expect(main.jobs).toBe(3);
    expect(main.rows).toBe(3);
    expect(main.days).toBe(3);
    expect(main.examples).toEqual(['RQ-A', 'RQ-B', 'RQ-C']);
    expect(main.firstSeen).toBe(at('D2', '10:00'));
    expect(main.lastSeen).toBe(at('D0', '08:00'));
    expect(cells[1]!.family).toBe('auth');
    expect(cells[1]!.jobs).toBe(1);
  });

  it('keeps the two event families and their pattern vocabularies separate', () => {
    const cells = foldBackoffSkipCells([
      usageSkipRow('RQ-U1', at('D2', '10:00')), usageSkipRow('RQ-U2', at('D1', '09:00')), usageSkipRow('RQ-U3', at('D0', '08:00')),
      authSkipRow('RQ-A1', at('D1', '10:00')), authSkipRow('RQ-A2', at('D1', '11:00')), authSkipRow('RQ-A3', at('D0', '09:00')),
      // A usage pattern quoted on an auth row is not that family's vocabulary.
      authSkipRow('RQ-X1', at('D0', '10:00'), { pattern: 'codex_usage_limit' }),
    ].join('\n'), NOW_MS, 168 * HOUR);
    expect(cells).toHaveLength(2);
    const usage = cells.find((c) => c.family === 'usage')!;
    expect(usage.jobs).toBe(3);
    const auth = cells.find((c) => c.family === 'auth')!;
    expect(auth.jobs).toBe(3);
    expect(auth.pattern).toBe('claude_auth_401');
  });

  it('counts a duplicated job row once toward the distinct-job bar', () => {
    const cells = foldBackoffSkipCells([
      usageSkipRow('RQ-DUP', at('D2', '10:00')), usageSkipRow('RQ-DUP', at('D1', '10:00')),
      authSkipRow('RQ-DUP2', at('D2', '11:00')), authSkipRow('RQ-DUP2', at('D1', '11:00')),
      authSkipRow('RQ-DUP2', at('D0', '11:00')),
    ].join('\n'), NOW_MS, 168 * HOUR);
    expect(cells).toHaveLength(2);
    for (const cell of cells) {
      expect(cell.jobs).toBe(1);
      expect(cell.days).toBeGreaterThanOrEqual(2);
    }
    expect(cells.find((c) => c.family === 'auth')!.rows).toBe(3);
  });

  it('drops malformed, out-of-contract and unplaceable rows', () => {
    const cells = foldBackoffSkipCells([
      // Wrong src: not the helper_unavailable skip contract.
      usageSkipRow('RQ-BADSRC', at('D1', '10:00'), { src: 'outcome_unreadable' }),
      J({ event: 'autobackoff_skip', lane: 'codex', job: 'RQ-NOSRC', pattern: 'codex_usage_limit', ts: at('D1', '10:00') }),
      // Pattern outside the family's closed vocabulary.
      usageSkipRow('RQ-BADPAT', at('D1', '10:00'), { pattern: 'overloaded' }),
      authSkipRow('RQ-BADPAT2', at('D1', '10:00'), { pattern: 'codex_usage_limit' }),
      // Missing or malformed fields.
      J({ event: 'autobackoff_skip', job: 'RQ-NOLANE', pattern: 'codex_usage_limit', src: 'helper_unavailable', ts: at('D1', '10:00') }),
      J({ event: 'autobackoff_skip', lane: 'codex', pattern: 'codex_usage_limit', src: 'helper_unavailable', ts: at('D1', '10:00') }),
      J({ event: 'autobackoff_skip', lane: 'codex', job: 'bad job id', pattern: 'codex_usage_limit', src: 'helper_unavailable', ts: at('D1', '10:00') }),
      J({ event: 'autobackoff_skip', lane: 'codex', job: 'RQ-NOPAT', src: 'helper_unavailable', ts: at('D1', '10:00') }),
      J({ event: 'autobackoff_skip', lane: 'bad lane!', job: 'RQ-BADLANE', pattern: 'codex_usage_limit', src: 'helper_unavailable', ts: at('D1', '10:00') }),
      // Non-skip events and unplaceable stamps never count.
      usageSkipRow('RQ-OLD', at('D2', '10:00')),
      usageSkipRow('RQ-OLDER', '2026-11-10T10:00:00.000Z'),
      J({ event: 'autobackoff_hold', lane: 'codex', job: 'RQ-H', pattern: 'codex_usage_limit', src: 'cli_line', ts: at('D1', '10:00') }),
      J({ event: 'finish', job: 'RQ-F', lane: 'codex', ts: at('D1', '10:00') }),
      J({ event: 'autobackoff_skip', lane: 'codex', job: 'RQ-NOTS', pattern: 'codex_usage_limit', src: 'helper_unavailable', ts: 'not a date' }),
      'not json at all',
    ].join('\n'), NOW_MS, 48 * HOUR);
    expect(cells).toEqual([]);
  });

  it('accepts the alias event-name spellings', () => {
    const cells = foldBackoffSkipCells([
      J({ type: 'autobackoff_skip', lane: 'codex', job: 'RQ-T', pattern: 'codex_usage_limit', src: 'helper_unavailable', ts: at('D2', '10:00') }),
      J({ kind: 'autobackoff_skip', lane: 'codex', job: 'RQ-K', pattern: 'codex_usage_limit', src: 'helper_unavailable', ts: at('D1', '10:00') }),
      J({ event: 'autobackoff_skip', lane: 'codex', job: 'RQ-E', pattern: 'codex_usage_limit', src: 'helper_unavailable', ts: at('D0', '09:00') }),
    ].join('\n'), NOW_MS, 168 * HOUR);
    expect(cells).toHaveLength(1);
    expect(cells[0]!.jobs).toBe(3);
  });
});

describe('backoffSkipBacklogItems', () => {
  let home: string;
  let saved: { HOME?: string; ASHLR_HOME?: string; ASHLR_RUNS_DIR?: string };

  beforeEach(async () => {
    saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME, ASHLR_RUNS_DIR: process.env.ASHLR_RUNS_DIR };
    delete process.env.ASHLR_HOME;
    delete process.env.ASHLR_RUNS_DIR;
    home = await mkdtemp(join(tmpdir(), 'backoff-skip-backlog-'));
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

  it('emits one item for a recurring usage-skip cell and validates it', async () => {
    const dir = await runsDir('runs-hit', [
      usageSkipRow('RQ-W1', ago(50)), usageSkipRow('RQ-W2', ago(30)), usageSkipRow('RQ-W3', ago(10)),
      authSkipRow('RQ-OTHER', ago(5)),
      J({ event: 'finish', job: 'RQ-F', lane: 'codex', ts: ago(5) }),
    ]);
    const items = await backoffSkipBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW) });
    expect(items).toHaveLength(1);
    const [item] = items;
    expect(item).toMatchObject({ priority: 3, repo: 'ashlrai/phantom', area: 'backoff-skips' });
    expect(item!.id).toMatch(/^fleet-backoff-skip-[0-9a-f]{16}$/);
    expect(item!.title).toContain('codex');
    expect(item!.title).toContain('Usage-limit');
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item!.prompt).toContain('RQ-W1');
    expect(item!.prompt).toContain('autobackoff_skip');
    expect(item!.prompt).toContain('helper_unavailable');
    expect(item!.prompt).toContain('git-safe');
    expect(item!.prompt).toContain('no-change');
  });

  it('emits one item per recurring family on its lane', async () => {
    const dir = await runsDir('runs-families', [
      usageSkipRow('RQ-U1', ago(50)), usageSkipRow('RQ-U2', ago(30)), usageSkipRow('RQ-U3', ago(10)),
      authSkipRow('RQ-A1', ago(49)), authSkipRow('RQ-A2', ago(29)), authSkipRow('RQ-A3', ago(9)),
      usageSkipRow('RQ-U4', ago(48), { lane: 'claude', pattern: 'claude_usage_limit' }),
      usageSkipRow('RQ-U5', ago(28), { lane: 'claude', pattern: 'claude_usage_limit' }),
      usageSkipRow('RQ-U6', ago(8), { lane: 'claude', pattern: 'claude_usage_limit' }),
    ]);
    const items = await backoffSkipBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW) });
    expect(items).toHaveLength(3);
    const prompts = items.map((i) => i.prompt).join('\n');
    expect(prompts).toContain('codex_usage_limit');
    expect(prompts).toContain('claude_auth_401');
    expect(prompts).toContain('claude_usage_limit');
    expect(new Set(items.map((i) => i.id)).size).toBe(3);
    const authItem = items.find((i) => i.prompt.includes('authbackoff_skip'))!;
    expect(authItem.title).toContain('Auth-failure');
  });

  it('emits nothing below the recurring bars of distinct jobs and days', async () => {
    // Three rows but only two distinct jobs.
    const dup = await runsDir('runs-dup', [
      usageSkipRow('RQ-D1', ago(50)), usageSkipRow('RQ-D1', ago(30)), usageSkipRow('RQ-D2', ago(10)),
    ]);
    expect(await backoffSkipBacklogItems({ repo: 'ashlrai/phantom', runsDir: dup, now: new Date(NOW) })).toEqual([]);
    // Three distinct jobs but all inside one UTC day: anchor `now` at UTC
    // noon and stamp every row inside that same date.
    const day = '2026-11-20';
    const noon = new Date(`${day}T12:00:00.000Z`);
    const sameDay = await runsDir('runs-sameday', [
      usageSkipRow('RQ-S1', `${day}T06:00:00.000Z`),
      usageSkipRow('RQ-S2', `${day}T07:00:00.000Z`),
      usageSkipRow('RQ-S3', `${day}T08:00:00.000Z`),
    ]);
    expect(await backoffSkipBacklogItems({ repo: 'ashlrai/phantom', runsDir: sameDay, now: noon })).toEqual([]);
    expect(BACKOFF_SKIP_MIN_JOBS).toBeGreaterThanOrEqual(3);
    expect(BACKOFF_SKIP_MIN_DAYS).toBeGreaterThanOrEqual(2);
  });

  it('emits nothing for a missing ledger or another repository', async () => {
    const empty = await runsDir('runs-empty');
    expect(await backoffSkipBacklogItems({ repo: 'ashlrai/phantom', runsDir: empty, now: new Date(NOW) })).toEqual([]);
    expect(await backoffSkipBacklogItems({ repo: 'ashlrai/phantom', runsDir: join(home, 'no-such'), now: new Date(NOW) })).toEqual([]);

    const dir = await runsDir('runs-repo', [
      usageSkipRow('RQ-P1', ago(50)), usageSkipRow('RQ-P2', ago(30)), usageSkipRow('RQ-P3', ago(10)),
    ]);
    expect(await backoffSkipBacklogItems({ repo: 'ashlrai/other', runsDir: dir, now: new Date(NOW) })).toEqual([]);
    expect(await backoffSkipBacklogItems({ repo: 'AshlrAI/Phantom', runsDir: dir, now: new Date(NOW) })).toHaveLength(1);
  });

  it('derives stable ids so a refresh re-adds nothing', async () => {
    const dir = await runsDir('runs-stable', [
      usageSkipRow('RQ-T1', ago(50)), usageSkipRow('RQ-T2', ago(30)), usageSkipRow('RQ-T3', ago(10)),
    ]);
    const opts = { repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW) };
    const first = await backoffSkipBacklogItems(opts);
    const second = await backoffSkipBacklogItems(opts);
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
  });

  it('states a truncated tail as a lower bound in the prompt', async () => {
    const dir = await runsDir('runs-trunc', []);
    await writeFile(join(dir, 'metrics', 'jobs.jsonl'),
      'x'.repeat(32 * 1024) + '\n' + [
        usageSkipRow('RQ-U1', ago(50)), usageSkipRow('RQ-U2', ago(30)), usageSkipRow('RQ-U3', ago(10)),
      ].join('\n') + '\n');
    const items = await backoffSkipBacklogItems({
      repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW), ledgerLimit: 16 * 1024,
    });
    expect(items).toHaveLength(1);
    expect(items[0]!.prompt).toContain('lower bound');
  });

  it('honours the item limit', async () => {
    const dir = await runsDir('runs-limit', [
      usageSkipRow('RQ-A1', ago(50), { lane: 'codex' }), usageSkipRow('RQ-A2', ago(30), { lane: 'codex' }), usageSkipRow('RQ-A3', ago(10), { lane: 'codex' }),
      authSkipRow('RQ-B1', ago(49), { lane: 'claude' }), authSkipRow('RQ-B2', ago(29), { lane: 'claude' }), authSkipRow('RQ-B3', ago(9), { lane: 'claude' }),
      usageSkipRow('RQ-C1', ago(48), { lane: 'devin', pattern: 'devin_usage_limit' }), usageSkipRow('RQ-C2', ago(28), { lane: 'devin', pattern: 'devin_usage_limit' }), usageSkipRow('RQ-C3', ago(8), { lane: 'devin', pattern: 'devin_usage_limit' }),
    ]);
    const all = await backoffSkipBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW) });
    expect(all).toHaveLength(3);
    const limited = await backoffSkipBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW), limit: 1 });
    expect(limited).toHaveLength(1);
    expect(BACKOFF_SKIP_MAX_ITEMS).toBeGreaterThan(0);
  });

  it('appends backoff-skip items through discovery and dedupes on refresh', async () => {
    const runs = join(home, '.ashlr-runs');
    await mkdir(join(runs, 'metrics'), { recursive: true });
    await writeFile(join(runs, 'metrics', 'jobs.jsonl'), [
      usageSkipRow('RQ-D1', ago(50)), usageSkipRow('RQ-D2', ago(30)), usageSkipRow('RQ-D3', ago(10)),
    ].join('\n') + '\n');
    const greenGh = async (args: string[]) => {
      const p = args[4] ?? '';
      if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
    };
    const first = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    const skipItems = first.items.filter((i) => i.id.startsWith('fleet-backoff-skip-'));
    expect(skipItems).toHaveLength(1);
    expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    expect(appendUserBacklogItems(skipItems)).toBe(1);
    const second = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('fleet-backoff-skip-')))).toBe(0);
    expect(readUserBacklogItems().filter((i) => i.id.startsWith('fleet-backoff-skip-'))).toHaveLength(1);
  });
});
