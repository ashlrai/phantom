import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverBacklog } from '../src/core/improve/discover.js';
import { routeExplainBacklogItems } from '../src/core/improve/route-explain-backlog.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';

let home: string;
let saved: { HOME?: string; ASHLR_HOME?: string; ASHLR_RUNS_DIR?: string };
beforeEach(() => {
  saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME, ASHLR_RUNS_DIR: process.env.ASHLR_RUNS_DIR };
  delete process.env.ASHLR_HOME;
  delete process.env.ASHLR_RUNS_DIR;
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'improve-routex-')));
  process.env.HOME = home;
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(home, { recursive: true, force: true });
});

const NOW = new Date('2026-11-23T12:00:00Z');
const NOW_S = Math.floor(NOW.getTime() / 1000);
const daysAgoS = (days: number): number => NOW_S - days * 86_400;

const REPO = 'ashlrai/phantom';

interface Decision {
  lane: string;
  model: string;
  effort: string;
  speed_tier: string;
  reason_codes: string[];
}

/** One observed route.explain.v1 row — a validated typed pick. */
const observed = (codes: string[], days: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  schema: 'route.explain.v1',
  event: 'route.explain',
  ts: daysAgoS(days),
  advisory: true,
  status: 'observed',
  decision: {
    lane: 'claude', model: 'claude-opus-4.5', effort: 'high', speed_tier: 'workhorse',
    reason_codes: codes,
  } satisfies Decision,
  duration_ms: 180,
  attempts: 1,
  candidate_count: 4,
  ...extra,
});

/** One unavailable route.explain.v1 row — the service call itself failed. */
const unavailable = (days: number): Record<string, unknown> => ({
  schema: 'route.explain.v1',
  event: 'route.explain',
  ts: daysAgoS(days),
  advisory: true,
  status: 'unavailable',
});

const HEALTHY = ['local-fast', 'free-capacity', 'cheapest'];

const journal = (rows: unknown[]): string => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';

const writeLedger = (rows: unknown[] | string, dir: string = home): string => {
  const metrics = path.join(dir, 'metrics');
  fs.mkdirSync(metrics, { recursive: true });
  const file = path.join(metrics, 'route.explain.jsonl');
  fs.writeFileSync(file, typeof rows === 'string' ? rows : journal(rows));
  return file;
};

const ledgerPath = (rows: unknown[] | string): string => writeLedger(rows);

describe('routeExplainBacklogItems', () => {
  it('turns a mostly-unavailable service window into a valid priority-3 item', async () => {
    const rows = [
      unavailable(1), unavailable(1), unavailable(2), unavailable(3), unavailable(4),
      observed(HEALTHY, 1), observed(HEALTHY, 2),
    ];
    const items = await routeExplainBacklogItems({ repo: REPO, ledgerPath: ledgerPath(rows), now: NOW });
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(item.id).toMatch(/^route-explain-service-[0-9a-f]{16}$/);
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item).toMatchObject({ priority: 3, repo: REPO, area: 'typed-routing' });
    expect(item.prompt).toContain("5 'unavailable' rows against 2 observed picks");
    expect(item.prompt).toContain('7 valid journal rows');
    expect(item.prompt).toContain('phm route explain');
    expect(item.prompt).toContain('route.explain.jsonl');
    expect(item.prompt).toContain('no-change');
  });

  it('stays quiet when unavailable rows are a minority or below the recurring bar', async () => {
    // Three unavailable rows but ten healthy observations — transient, not a dark service.
    const minority = await routeExplainBacklogItems({
      repo: REPO, now: NOW,
      ledgerPath: ledgerPath([unavailable(1), unavailable(2), unavailable(3), ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((d) => observed(HEALTHY, d))]),
    });
    expect(minority).toEqual([]);
    // Two unavailable rows never reach the bar even with no observed rows.
    const few = await routeExplainBacklogItems({
      repo: REPO, now: NOW,
      ledgerPath: ledgerPath([unavailable(1), unavailable(2)]),
    });
    expect(few).toEqual([]);
    // Exactly half unavailable does not outnumber observed — no convict.
    const tie = await routeExplainBacklogItems({
      repo: REPO, now: NOW,
      ledgerPath: ledgerPath([unavailable(1), unavailable(2), unavailable(3), observed(HEALTHY, 1), observed(HEALTHY, 2), observed(HEALTHY, 3)]),
    });
    expect(tie).toEqual([]);
  });

  it('turns recurring degraded reason codes into per-code items', async () => {
    const rows = [
      observed(['deterministic-fallback', 'backend-unavailable', 'deadline'], 1),
      observed(['deterministic-fallback', 'backend-unavailable'], 2),
      observed(['deterministic-fallback', 'deadline'], 3),
      observed(HEALTHY, 1), observed(HEALTHY, 2), observed(HEALTHY, 3), observed(HEALTHY, 4),
    ];
    const items = await routeExplainBacklogItems({ repo: REPO, ledgerPath: ledgerPath(rows), now: NOW });
    // deterministic-fallback on 3, backend-unavailable on 2 (below bar), deadline on 2 (below bar).
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(item.id).toMatch(/^route-explain-reason-deterministic-fallback-[0-9a-f]{16}$/);
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item).toMatchObject({ priority: 3, repo: REPO, area: 'typed-routing' });
    expect(item.prompt).toContain("'deterministic-fallback' appeared on 3 of the window's observed route decisions");
    expect(item.prompt).toContain('3 of those decisions carried');
    expect(item.prompt).toContain('42.9% of the window');
    expect(item.prompt).toContain('phm route explain');
    expect(item.prompt).toContain('no-change');
  });

  it('emits one item per recurring code sorted by count and stays quiet on a healthy majority', async () => {
    const rows = [
      unavailable(1), unavailable(1), unavailable(2), unavailable(3),
      observed(['deadline'], 1), observed(['deadline'], 1), observed(['deadline'], 2),
      observed(['schema-invalid'], 1), observed(['schema-invalid'], 2), observed(['schema-invalid'], 3),
      observed(['schema-invalid'], 3), observed(['schema-invalid'], 4),
      observed(HEALTHY, 5),
    ];
    const items = await routeExplainBacklogItems({ repo: REPO, ledgerPath: ledgerPath(rows), now: NOW });
    // unavailable 4 > observed 6? No: 4 unavailable vs 9 observed → no service item.
    expect(items.filter((i) => i.id.startsWith('route-explain-service-'))).toHaveLength(0);
    const reasonItems = items.filter((i) => i.id.startsWith('route-explain-reason-'));
    expect(reasonItems.map((i) => i.id)).toEqual([
      expect.stringMatching(/^route-explain-reason-schema-invalid-/),
      expect.stringMatching(/^route-explain-reason-deadline-/),
    ]);
    expect(items.every((i) => validBacklogItem(i) !== null)).toBe(true);
  });

  it('never emits for healthy state codes or successful backend picks', async () => {
    const rows = [
      observed(['no-candidates'], 1), observed(['no-candidates'], 2), observed(['no-candidates'], 3),
      observed(['admission-blocked'], 1), observed(['admission-blocked'], 2), observed(['admission-blocked'], 3),
      observed(['single-candidate'], 1), observed(['single-candidate'], 2), observed(['single-candidate'], 3),
      observed(['local-fast', 'free-capacity'], 1), observed(['jev', 'adequate-tier'], 2), observed(['local-strong', 'cheapest'], 3),
      observed(['mode-tier', 'cost-prior'], 1), observed(['reset-pressure'], 2),
    ];
    expect(await routeExplainBacklogItems({ repo: REPO, ledgerPath: ledgerPath(rows), now: NOW })).toEqual([]);
  });

  it('ignores rows outside the window and rows failing the producer contract', async () => {
    const stale = await routeExplainBacklogItems({
      repo: REPO, now: NOW,
      ledgerPath: ledgerPath([
        unavailable(8), unavailable(9), unavailable(10),
        observed(['deadline'], 8), observed(['deadline'], 9), observed(['deadline'], 10),
      ]),
    });
    expect(stale).toEqual([]);
    const corrupt = ledgerPath([
      'not json at all',
      JSON.stringify({ schema: 'route.explain.v1', event: 'route.explain', ts: daysAgoS(1), advisory: true, status: 'bogus' }),
      JSON.stringify({ schema: 'other.v9', event: 'route.explain', ts: daysAgoS(1), advisory: true, status: 'unavailable' }),
      JSON.stringify({ schema: 'route.explain.v1', event: 'route.explain', ts: daysAgoS(1), advisory: false, status: 'unavailable' }),
      // Observed row whose decision fails the allowlist (bad effort) — invalid, never counted.
      JSON.stringify({
        schema: 'route.explain.v1', event: 'route.explain', ts: daysAgoS(1), advisory: true, status: 'observed',
        decision: { lane: 'claude', model: 'm', effort: 'ludicrous', speed_tier: 'workhorse', reason_codes: ['deadline'] },
      }),
      // Observed row with an out-of-vocabulary reason code — invalid.
      JSON.stringify({
        schema: 'route.explain.v1', event: 'route.explain', ts: daysAgoS(1), advisory: true, status: 'observed',
        decision: { lane: 'claude', model: 'm', effort: 'high', speed_tier: 'workhorse', reason_codes: ['deadline', 'made-up-code'] },
      }),
      unavailable(1), unavailable(1),
    ]);
    // Only the two valid unavailable rows remain — below the bar.
    expect(await routeExplainBacklogItems({ repo: REPO, ledgerPath: corrupt, now: NOW })).toEqual([]);
  });

  it('yields nothing for a missing or unreadable ledger and for non-fleet repositories', async () => {
    expect(await routeExplainBacklogItems({ repo: REPO, ledgerPath: path.join(home, 'no-such.jsonl'), now: NOW })).toEqual([]);
    const file = ledgerPath([unavailable(1), unavailable(1), unavailable(1)]);
    expect(await routeExplainBacklogItems({ repo: 'ashlrai/lexicon', ledgerPath: file, now: NOW })).toEqual([]);
    expect(await routeExplainBacklogItems({ repo: 'not-a-repo', ledgerPath: file, now: NOW })).toEqual([]);
    expect(await routeExplainBacklogItems({ repo: '', ledgerPath: file, now: NOW })).toEqual([]);
  });

  it('orders the service item first when both kinds recur and honours the limit', async () => {
    const rows = [
      // Seven unavailable rows outnumber the six observed picks, so the
      // service cell convicts alongside the two recurring reason codes.
      ...[1, 1, 1, 2, 2, 3, 4].map((d) => unavailable(d)),
      observed(['deadline'], 1), observed(['deadline'], 1), observed(['deadline'], 2),
      observed(['schema-invalid'], 1), observed(['schema-invalid'], 2), observed(['schema-invalid'], 3),
    ];
    const file = ledgerPath(rows);
    const items = await routeExplainBacklogItems({ repo: REPO, ledgerPath: file, now: NOW });
    expect(items).toHaveLength(3);
    expect(items[0]!.id).toMatch(/^route-explain-service-/);
    const one = await routeExplainBacklogItems({ repo: REPO, ledgerPath: file, now: NOW, limit: 1 });
    expect(one).toHaveLength(1);
    expect(one[0]!.id).toBe(items[0]!.id);
  });

  it('derives stable ids so a refresh re-adds nothing', async () => {
    const file = ledgerPath([unavailable(1), unavailable(1), unavailable(1)]);
    const first = await routeExplainBacklogItems({ repo: REPO, ledgerPath: file, now: NOW });
    const second = await routeExplainBacklogItems({ repo: REPO, ledgerPath: file, now: NOW });
    expect(first).toHaveLength(1);
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
    const grown = ledgerPath([unavailable(1), unavailable(1), unavailable(1), unavailable(2)]);
    const third = await routeExplainBacklogItems({ repo: REPO, ledgerPath: grown, now: NOW });
    expect(third.map((i) => i.id)).toEqual(first.map((i) => i.id));
  });

  it('resolves the default ledger under ASHLR_RUNS_DIR', async () => {
    const runs = path.join(home, 'runs');
    writeLedger([unavailable(1), unavailable(1), unavailable(1)], runs);
    process.env.ASHLR_RUNS_DIR = runs;
    const items = await routeExplainBacklogItems({ repo: REPO, now: NOW });
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toMatch(/^route-explain-service-/);
  });

  it('appends route-explain items through discovery and dedupes on refresh', async () => {
    process.env.ASHLR_HOME = path.join(home, '.ashlr-e2e');
    const runs = path.join(home, 'runs');
    process.env.ASHLR_RUNS_DIR = runs;
    writeLedger([unavailable(1), unavailable(1), unavailable(1)], runs);
    const greenGh = async (args: string[]) => {
      const p = args[4] ?? '';
      if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
    };
    const first = await discoverBacklog(REPO, { gh: greenGh });
    const typed = first.items.filter((i) => i.id.startsWith('route-explain-'));
    expect(typed).toHaveLength(1);
    expect(typed[0]!.id).toMatch(/^route-explain-service-/);
    expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    expect(appendUserBacklogItems(typed)).toBe(typed.length);
    const second = await discoverBacklog(REPO, { gh: greenGh });
    expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('route-explain-')))).toBe(0);
    expect(readUserBacklogItems().filter((i) => i.id.startsWith('route-explain-'))).toHaveLength(typed.length);
  });
});
