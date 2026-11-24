import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverBacklog } from '../src/core/improve/discover.js';
import { gatewayShadowBacklogItems } from '../src/core/improve/gateway-shadow-backlog.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';

let home: string;
let saved: { HOME?: string; ASHLR_HOME?: string; ASHLR_RUNS_DIR?: string };
beforeEach(() => {
  saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME, ASHLR_RUNS_DIR: process.env.ASHLR_RUNS_DIR };
  delete process.env.ASHLR_HOME;
  delete process.env.ASHLR_RUNS_DIR;
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'improve-gateway-shadow-')));
  process.env.HOME = home;
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(home, { recursive: true, force: true });
});

const NOW = new Date('2026-11-23T12:00:00Z');
const NOW_MS = NOW.getTime();
const daysAgo = (days: number): string => new Date(NOW_MS - days * 86_400_000).toISOString();
const dayOf = (iso: string): string => iso.slice(0, 10);

const REPO = 'ashlrai/phantom';

interface Row {
  ts: string;
  workItemId?: string;
  source?: string;
  legacy: { backend: string; tier: string | null; model?: string | null; dispatched: boolean };
  gateway: { backend: string; tier: string | null; model?: string | null; wouldDispatch: boolean };
  diverged: boolean;
  safetyRelevant: boolean;
}

let seq = 0;
/** One shadow record in the writer's shape; safety implies diverged like compareDecisions derives it. */
const shadow = (
  days: number,
  opts: { diverged?: boolean; safety?: boolean; legacy?: string; gateway?: string; legacyDispatched?: boolean; gatewayWould?: boolean } = {},
): Row => {
  const diverged = opts.diverged ?? false;
  const safety = opts.safety ?? false;
  const legacyDispatched = opts.legacyDispatched ?? true;
  const gatewayWould = opts.gatewayWould ?? true;
  return {
    ts: daysAgo(days),
    workItemId: `item-${++seq}`,
    source: 'queue',
    legacy: { backend: opts.legacy ?? 'codex', tier: 'work', model: null, dispatched: legacyDispatched },
    gateway: { backend: opts.gateway ?? 'codex', tier: 'work', model: null, wouldDispatch: gatewayWould },
    diverged: diverged || safety,
    safetyRelevant: safety,
  };
};

const clean = (days: number, n: number, opts: Parameters<typeof shadow>[1] = {}): Row[] =>
  Array.from({ length: n }, () => shadow(days, opts));

/** n clean decisions plus `diverged` disagreements, spread across days and backends. */
const divergenceJournal = (decisions: number, diverged: number): Row[] => {
  const rows: Row[] = [];
  for (let i = 0; i < decisions; i += 1) {
    const isDiverged = i < diverged;
    rows.push(shadow(i % 6, isDiverged
      ? { diverged: true, legacy: i % 2 === 0 ? 'codex' : 'claude', gateway: i % 2 === 0 ? 'devin' : 'codex' }
      : {}));
  }
  return rows;
};

const safetyRows = (n: number, days = 1): Row[] =>
  Array.from({ length: n }, (_, i) => shadow(days + (i % 3), { safety: true, legacyDispatched: false, gatewayWould: true }));

const writeDay = (dir: string, rows: Row[]): void => {
  const byDay = new Map<string, Row[]>();
  for (const row of rows) {
    const day = dayOf(row.ts);
    const list = byDay.get(day) ?? [];
    list.push(row);
    byDay.set(day, list);
  }
  for (const [day, list] of byDay) {
    fs.writeFileSync(path.join(dir, `gateway-shadow-${day}.jsonl`), list.map((r) => JSON.stringify(r)).join('\n') + '\n');
  }
};

const fabricDir = (): string => {
  const dir = path.join(home, '.ashlr', 'fabric');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

const writeFabric = (rows: Row[]): string => {
  const dir = fabricDir();
  writeDay(dir, rows);
  return dir;
};

describe('gatewayShadowBacklogItems', () => {
  it('turns recurring safety-relevant divergences into a valid priority-3 backlog item', async () => {
    const items = await gatewayShadowBacklogItems({ repo: REPO, fabricDir: writeFabric([...clean(1, 10), ...safetyRows(3)]), now: NOW_MS });
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(item.id).toMatch(/^gateway-shadow-safety-[0-9a-f]{16}$/);
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item).toMatchObject({ priority: 3, repo: REPO, area: 'gateway-shadow' });
    expect(item.prompt).toContain('3 safety-relevant divergence(s)');
    expect(item.prompt).toContain('ZERO safety-relevant');
    expect(item.prompt).toContain('13 shadowed decision(s)');
    expect(item.prompt).toContain('gateway-shadow-<UTC-day>.jsonl');
    expect(item.prompt).toContain('foundry.fabric.gatewayShadow');
    expect(item.prompt).toContain('no-change');
  });

  it('stays quiet below the safety bar, on clean journals, or outside the fleet repo', async () => {
    // Two safety rows never reach the recurring bar.
    expect(await gatewayShadowBacklogItems({ repo: REPO, fabricDir: writeFabric([...clean(1, 10), ...safetyRows(2)]), now: NOW_MS })).toEqual([]);
    // A healthy shadow: decisions but no divergence, no safety rows.
    expect(await gatewayShadowBacklogItems({ repo: REPO, fabricDir: writeFabric(clean(1, 60)), now: NOW_MS })).toEqual([]);
    // Fleet machinery evidence never lands on another repository's backlog.
    const dir = writeFabric([...clean(1, 10), ...safetyRows(3)]);
    expect(await gatewayShadowBacklogItems({ repo: 'ashlrai/lexicon', fabricDir: dir, now: NOW_MS })).toEqual([]);
    expect(await gatewayShadowBacklogItems({ repo: '', fabricDir: dir, now: NOW_MS })).toEqual([]);
  });

  it('turns a divergence rate at the stage-2 bar into an item naming the top pairs', async () => {
    const rows = divergenceJournal(60, 3); // 5% — above the 2% tolerance
    const items = await gatewayShadowBacklogItems({ repo: REPO, fabricDir: writeFabric(rows), now: NOW_MS });
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(item.id).toMatch(/^gateway-shadow-divergence-[0-9a-f]{16}$/);
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item).toMatchObject({ priority: 3, repo: REPO, area: 'gateway-shadow' });
    expect(item.prompt).toContain('3 of 60 shadowed decisions');
    expect(item.prompt).toContain('5.00%');
    expect(item.prompt).toContain("'codex'→'devin'");
    expect(item.prompt).toContain("'claude'→'codex'");
    expect(item.prompt).toContain('CONTRACT-M334');
    expect(item.prompt).toContain('gatewayDecide');
    expect(item.prompt).toContain('no-change');
  });

  it('stays quiet below the decision floor or under the divergence rate', async () => {
    // Same 5% shape but only 40 decisions — under the judging floor.
    expect(await gatewayShadowBacklogItems({ repo: REPO, fabricDir: writeFabric(divergenceJournal(40, 2)), now: NOW_MS })).toEqual([]);
    // 60 decisions, 1 divergence = 1.67% — under the 2% bar.
    expect(await gatewayShadowBacklogItems({ repo: REPO, fabricDir: writeFabric(divergenceJournal(60, 1)), now: NOW_MS })).toEqual([]);
    // Exactly at the bar (1 of 50 = 2.00%) emits.
    const atBar = await gatewayShadowBacklogItems({ repo: REPO, fabricDir: writeFabric(divergenceJournal(50, 1)), now: NOW_MS });
    expect(atBar).toHaveLength(1);
    expect(atBar[0]!.id).toMatch(/^gateway-shadow-divergence-/);
  });

  it('windows rows by ts and only opens files whose day can hold in-window rows', async () => {
    // Safety rows 8+ days old live in a day-file the reader never opens
    // (the window start day is 2026-11-16; these rows are 2026-11-15).
    const staleDir = fabricDir();
    writeDay(staleDir, safetyRows(3, 8));
    expect(await gatewayShadowBacklogItems({ repo: REPO, fabricDir: staleDir, now: NOW_MS })).toEqual([]);

    // An opened file still cannot count a row whose own ts fell out of
    // the window: three fresh safety rows plus one stale row in the same
    // file emit with the stale row excluded from the count.
    const dir = fabricDir();
    const old = shadow(8, { safety: true, legacyDispatched: false });
    const fresh = safetyRows(3, 1);
    fs.writeFileSync(
      path.join(dir, `gateway-shadow-${dayOf(fresh[0]!.ts)}.jsonl`),
      [old, ...fresh].map((r) => JSON.stringify(r)).join('\n') + '\n',
    );
    const items = await gatewayShadowBacklogItems({ repo: REPO, fabricDir: dir, now: NOW_MS });
    expect(items).toHaveLength(1);
    expect(items[0]!.prompt).toContain('3 safety-relevant divergence(s)');
    expect(items[0]!.prompt).not.toContain('4 safety-relevant');
  });

  it('skips malformed lines and rows missing the record contract', async () => {
    const dir = fabricDir();
    const day = daysAgo(1).slice(0, 10);
    const lines = [
      'not json',
      JSON.stringify({ ts: daysAgo(1), diverged: true }), // no safetyRelevant/backends
      JSON.stringify({ ts: 'not-a-date', diverged: true, safetyRelevant: true, legacy: { backend: 'a' }, gateway: { backend: 'b' } }),
      JSON.stringify({ ts: daysAgo(1), diverged: 'yes', safetyRelevant: false, legacy: { backend: 'a' }, gateway: { backend: 'b' } }),
      JSON.stringify({ ts: daysAgo(1), diverged: true, safetyRelevant: true, legacy: { backend: '' }, gateway: { backend: 'b' } }),
      ...safetyRows(3, 1).map((r) => JSON.stringify(r)),
    ];
    fs.writeFileSync(path.join(dir, `gateway-shadow-${day}.jsonl`), lines.join('\n') + '\n');
    const items = await gatewayShadowBacklogItems({ repo: REPO, fabricDir: dir, now: NOW_MS });
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toMatch(/^gateway-shadow-safety-/);
  });

  it('emits both kinds with the safety item first and honours the limit', async () => {
    // 3 safety rows (each diverged+safety) inside a 60-decision journal already over the rate bar.
    const rows = [...divergenceJournal(60, 3), ...safetyRows(3, 1)];
    const items = await gatewayShadowBacklogItems({ repo: REPO, fabricDir: writeFabric(rows), now: NOW_MS });
    expect(items.map((i) => i.id.split('-').slice(0, 3).join('-'))).toEqual([
      'gateway-shadow-safety',
      'gateway-shadow-divergence',
    ]);
    const one = await gatewayShadowBacklogItems({ repo: REPO, fabricDir: writeFabric(rows), now: NOW_MS, limit: 1 });
    expect(one).toHaveLength(1);
    expect(one[0]!.id).toMatch(/^gateway-shadow-safety-/);
  });

  it('derives stable ids so a refresh re-adds nothing', async () => {
    const dir = writeFabric([...clean(1, 10), ...safetyRows(3)]);
    const first = await gatewayShadowBacklogItems({ repo: REPO, fabricDir: dir, now: NOW_MS });
    const second = await gatewayShadowBacklogItems({ repo: REPO, fabricDir: dir, now: NOW_MS });
    expect(first).toHaveLength(1);
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
  });

  it('yields nothing for a missing fabric dir or non-fleet repo names', async () => {
    expect(await gatewayShadowBacklogItems({ repo: REPO, fabricDir: path.join(home, 'no-such-dir'), now: NOW_MS })).toEqual([]);
    // Bare 'phantom' still counts as the fleet repo (last-segment rule).
    const items = await gatewayShadowBacklogItems({ repo: 'phantom', fabricDir: writeFabric([...clean(1, 10), ...safetyRows(3)]), now: NOW_MS });
    expect(items).toHaveLength(1);
    expect(items[0]!.repo).toBeUndefined();
  });

  it('reads the default fabric dir under HOME/.ashlr/fabric', async () => {
    writeFabric([...clean(1, 10), ...safetyRows(3)]);
    const items = await gatewayShadowBacklogItems({ repo: REPO, now: NOW_MS });
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toMatch(/^gateway-shadow-safety-/);
  });

  it('scrubs secret-shaped backend names before they reach a prompt', async () => {
    const token = `ghp_${'a'.repeat(36)}`;
    // The divergence prompt quotes the top backend pairs, so the token
    // rides in as a legacy backend on the diverged rows.
    const rows: Row[] = [
      ...clean(1, 58),
      shadow(1, { diverged: true, legacy: token, gateway: 'codex' }),
      shadow(1, { diverged: true, legacy: token, gateway: 'codex' }),
    ];
    const items = await gatewayShadowBacklogItems({ repo: REPO, fabricDir: writeFabric(rows), now: NOW_MS });
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toMatch(/^gateway-shadow-divergence-/);
    expect(items[0]!.prompt).not.toContain(token);
    expect(items[0]!.prompt).toContain('REDACTED');
  });

  it('appends gateway-shadow items through discovery and dedupes on refresh', async () => {
    process.env.ASHLR_RUNS_DIR = path.join(home, 'runs');
    writeFabric([...clean(1, 10), ...safetyRows(3)]);
    const greenGh = async (args: string[]) => {
      const p = args[4] ?? '';
      if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
    };
    const first = await discoverBacklog(REPO, { gh: greenGh });
    const shadow = first.items.filter((i) => i.id.startsWith('gateway-shadow-'));
    expect(shadow).toHaveLength(1);
    expect(shadow[0]!.id).toMatch(/^gateway-shadow-safety-/);
    expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    expect(appendUserBacklogItems(shadow)).toBe(shadow.length);
    const second = await discoverBacklog(REPO, { gh: greenGh });
    expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('gateway-shadow-')))).toBe(0);
    expect(readUserBacklogItems().filter((i) => i.id.startsWith('gateway-shadow-'))).toHaveLength(shadow.length);
  });
});
