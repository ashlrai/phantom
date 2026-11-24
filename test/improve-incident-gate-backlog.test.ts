import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverBacklog } from '../src/core/improve/discover.js';
import { incidentGateBacklogItems } from '../src/core/improve/incident-gate-backlog.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';

let home: string;
let saved: { HOME?: string; ASHLR_HOME?: string; ASHLR_RUNS_DIR?: string };
beforeEach(() => {
  saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME, ASHLR_RUNS_DIR: process.env.ASHLR_RUNS_DIR };
  delete process.env.ASHLR_HOME;
  delete process.env.ASHLR_RUNS_DIR;
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'improve-incidentgate-')));
  process.env.HOME = home;
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(home, { recursive: true, force: true });
});

const NOW = new Date('2026-11-23T12:00:00Z');
const NOW_MS = NOW.getTime();
/** ISO timestamp `days` before NOW (fractional hours allowed via `hours`). */
const at = (days: number, hours = 0): string =>
  new Date(NOW_MS - days * 86400_000 + hours * 3600_000).toISOString();

const REPO = 'ashlrai/phantom';

type Cls = 'lane-error' | 'test-failure' | 'merge-conflict';
type Gate = 'lane-hold' | 'repo-cooldown';
type Result = 'applied' | 'refused' | 'error';

interface LedgerRow {
  v?: number;
  ts?: string;
  kind?: string;
  cls?: Cls;
  key?: string;
  gate?: Gate;
  scope?: string;
  count?: number;
  result?: Result;
  until?: string;
  detail?: string;
}

/** One decision row in the writer's own shape (src/cli/fleet-incident-gate.ts). */
const decision = (over: LedgerRow): LedgerRow => ({
  v: 1,
  kind: 'incident-gate',
  cls: 'lane-error',
  key: 'lane-error:codex:class-pool-error',
  gate: 'lane-hold',
  scope: 'codex',
  count: 4,
  result: 'applied',
  ...over,
});

const laneFire = (key: string, scope: string, result: Result, daysAgo: number, detail?: string, count = 4): LedgerRow =>
  decision({ ts: at(daysAgo), cls: 'lane-error', key, gate: 'lane-hold', scope, count, result, ...(detail !== undefined ? { detail } : {}) });

const repoFire = (key: string, repoScope: string, cls: Cls, result: Result, daysAgo: number, detail?: string, count = 5): LedgerRow =>
  decision({
    ts: at(daysAgo), cls, key, gate: 'repo-cooldown', scope: repoScope, count, result,
    ...(detail !== undefined ? { detail } : {}),
  });

const ledger = (rows: Array<LedgerRow | string>): string =>
  rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n';

const writeLedger = (rows: Array<LedgerRow | string> | string): string => {
  const file = path.join(home, 'incident-gates.jsonl');
  fs.writeFileSync(file, typeof rows === 'string' ? rows : ledger(rows));
  return file;
};

/** Two watermark-advancing fires of one lane-error class on different days. */
const recurringLaneRows = (): LedgerRow[] => [
  laneFire('lane-error:codex:class-pool-error', 'codex', 'applied', 1, undefined, 4),
  laneFire('lane-error:codex:class-pool-error', 'codex', 'applied', 3, undefined, 6),
];

describe('incidentGateBacklogItems', () => {
  it('turns a recurring lane-error class into a valid priority-3 backlog item', async () => {
    const items = await incidentGateBacklogItems({ repo: REPO, ledgerPath: writeLedger(recurringLaneRows()), now: NOW_MS });
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(item.id).toMatch(/^incident-gate-recurring-[0-9a-f]{16}$/);
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item).toMatchObject({ priority: 3, repo: REPO, area: 'incident-gate' });
    expect(item.title).toContain('lane-error:codex:class-pool-error');
    expect(item.prompt).toContain('2 time(s) across 2 distinct UTC day(s)');
    expect(item.prompt).toContain('2 applied, 0 refused');
    expect(item.prompt).toContain('6 fresh signals');
    expect(item.prompt).toContain("'codex'");
    expect(item.prompt).toContain('incident-gates.jsonl');
    expect(item.prompt).toContain('incident-gate --apply');
    expect(item.prompt).toContain('no-change');
  });

  it('turns recurring repo-scoped classes into items only for the matching repository', async () => {
    const rows: LedgerRow[] = [
      repoFire('test-failure:ashlrai/phantom:bugfix:task-failed', 'ashlrai/phantom', 'test-failure', 'applied', 1),
      repoFire('test-failure:ashlrai/phantom:bugfix:task-failed', 'ashlrai/phantom', 'test-failure', 'applied', 4),
      repoFire('merge-conflict:ashlrai/lexicon', 'ashlrai/lexicon', 'merge-conflict', 'applied', 2),
      repoFire('merge-conflict:ashlrai/lexicon', 'ashlrai/lexicon', 'merge-conflict', 'applied', 5),
    ];
    const items = await incidentGateBacklogItems({ repo: REPO, ledgerPath: writeLedger(rows), now: NOW_MS });
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toMatch(/^incident-gate-recurring-[0-9a-f]{16}$/);
    expect(items[0]!.prompt).toContain('test-failure:ashlrai/phantom:bugfix:task-failed');
    expect(items[0]!.prompt).toContain("'repo-cooldown' gate");
    // The lexicon merge-conflict rows never land on phantom.
    expect(items[0]!.prompt).not.toContain('merge-conflict:ashlrai/lexicon');
    expect(items[0]!.prompt).not.toContain("'ashlrai/lexicon'");
    // Discovering for lexicon picks up its own repo-scoped rows only.
    const lexicon = await incidentGateBacklogItems({ repo: 'ashlrai/lexicon', ledgerPath: writeLedger(rows), now: NOW_MS });
    expect(lexicon).toHaveLength(1);
    expect(lexicon[0]!.prompt).toContain('merge-conflict:ashlrai/lexicon');
    expect(lexicon[0]).toMatchObject({ repo: 'ashlrai/lexicon' });
    // Lane-error evidence is this install's machinery: never inherited by other repos.
    const laneOnly = await incidentGateBacklogItems({ repo: 'ashlrai/lexicon', ledgerPath: writeLedger(recurringLaneRows()), now: NOW_MS });
    expect(laneOnly).toEqual([]);
  });

  it('turns recurring errored tightenings into a tighten-failed item', async () => {
    const rows: LedgerRow[] = [
      laneFire('lane-error:devin:event-auth-failure', 'devin', 'error', 1, 'placeLaneHold: slots.json unwritable'),
      laneFire('lane-error:devin:event-auth-failure', 'devin', 'error', 2, 'placeLaneHold: slots.json unwritable'),
      laneFire('lane-error:devin:event-auth-failure', 'devin', 'error', 4, 'placeLaneHold: EACCES'),
    ];
    const items = await incidentGateBacklogItems({ repo: REPO, ledgerPath: writeLedger(rows), now: NOW_MS });
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(item.id).toMatch(/^incident-gate-tighten-failed-[0-9a-f]{16}$/);
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item).toMatchObject({ priority: 3, repo: REPO, area: 'incident-gate' });
    expect(item.prompt).toContain('3 tightening(s) that never landed across 3 distinct UTC day(s)');
    expect(item.prompt).toContain('3 errored, 0 refused');
    expect(item.prompt).toContain('slots.json unwritable');
    expect(item.prompt).toContain('setRepoHold');
    expect(item.prompt).toContain('no-change');
    // An all-error class is not "recurring" evidence — no advancing fires.
    expect(item.id).not.toMatch(/recurring/);
  });

  it('counts repo-cooldown refusals as stuck tightenings, lane-hold refusals as advancing fires', async () => {
    // Repo-cooldown refused: setRepoHold declined — watermark stuck, tighten-failed.
    const refusedRepo = [
      repoFire('test-failure:ashlrai/phantom:docs:task-failed', 'ashlrai/phantom', 'test-failure', 'refused', 1, 'the repo hold store is unreadable'),
      repoFire('test-failure:ashlrai/phantom:docs:task-failed', 'ashlrai/phantom', 'test-failure', 'refused', 3, 'the repo hold store is unreadable'),
    ];
    const items = await incidentGateBacklogItems({ repo: REPO, ledgerPath: writeLedger(refusedRepo), now: NOW_MS });
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toMatch(/^incident-gate-tighten-failed-/);
    expect(items[0]!.prompt).toContain('0 errored, 2 refused');
    expect(items[0]!.prompt).toContain('repo hold store is unreadable');
    // Lane-hold refused (manual-hold/unknown-lane) advances the watermark — recurring, not stuck.
    const refusedLane = [
      laneFire('lane-error:codex:event-launch-failed', 'codex', 'refused', 1, 'manual-hold'),
      laneFire('lane-error:codex:event-launch-failed', 'codex', 'refused', 3, 'manual-hold'),
    ];
    const laneItems = await incidentGateBacklogItems({ repo: REPO, ledgerPath: writeLedger(refusedLane), now: NOW_MS });
    expect(laneItems).toHaveLength(1);
    expect(laneItems[0]!.id).toMatch(/^incident-gate-recurring-/);
    expect(laneItems[0]!.prompt).toContain('0 applied, 2 refused');
  });

  it('keeps both buckets quiet below the two-distinct-day bar', async () => {
    // Two advancing fires on the same UTC day.
    const sameDay = [
      laneFire('lane-error:codex:class-pool-error', 'codex', 'applied', 1),
      laneFire('lane-error:codex:class-pool-error', 'codex', 'applied', 1, undefined, 8),
    ];
    expect(await incidentGateBacklogItems({ repo: REPO, ledgerPath: writeLedger(sameDay), now: NOW_MS })).toEqual([]);
    // A single fire, however large its count.
    const single = [laneFire('lane-error:codex:class-pool-error', 'codex', 'applied', 1, undefined, 40)];
    expect(await incidentGateBacklogItems({ repo: REPO, ledgerPath: writeLedger(single), now: NOW_MS })).toEqual([]);
    // Error rows on one day only.
    const oneDayErrors = [
      laneFire('lane-error:codex:class-pool-error', 'codex', 'error', 2, 'boom'),
      laneFire('lane-error:codex:class-pool-error', 'codex', 'error', 2, 'boom'),
      laneFire('lane-error:codex:class-pool-error', 'codex', 'error', 2, 'boom'),
    ];
    expect(await incidentGateBacklogItems({ repo: REPO, ledgerPath: writeLedger(oneDayErrors), now: NOW_MS })).toEqual([]);
  });

  it('splits advancing and stuck evidence per class key', async () => {
    const rows: LedgerRow[] = [
      // Class A: advancing fires on days 1 and 3, one error on day 5 → recurring only.
      laneFire('lane-error:codex:class-pool-error', 'codex', 'applied', 1),
      laneFire('lane-error:codex:class-pool-error', 'codex', 'applied', 3),
      laneFire('lane-error:codex:class-pool-error', 'codex', 'error', 5, 'transient'),
      // Class B: applied day 1, errors days 2 and 4 → tighten-failed only.
      laneFire('lane-error:devin:event-usage-limit', 'devin', 'applied', 1),
      laneFire('lane-error:devin:event-usage-limit', 'devin', 'error', 2, 'setRepoHold: lock unavailable'),
      laneFire('lane-error:devin:event-usage-limit', 'devin', 'error', 4, 'setRepoHold: lock unavailable'),
    ];
    const items = await incidentGateBacklogItems({ repo: REPO, ledgerPath: writeLedger(rows), now: NOW_MS });
    expect(items).toHaveLength(2);
    expect(items[0]!.id).toMatch(/^incident-gate-recurring-/);
    expect(items[0]!.prompt).toContain('lane-error:codex:class-pool-error');
    expect(items[1]!.id).toMatch(/^incident-gate-tighten-failed-/);
    expect(items[1]!.prompt).toContain('lane-error:devin:event-usage-limit');
    expect(items[1]!.prompt).toContain('lock unavailable');
  });

  it('emits recurring cells sorted by fire count and honours the limit', async () => {
    const rows: LedgerRow[] = [
      ...recurringLaneRows(),
      laneFire('lane-error:devin:event-model-capacity', 'devin', 'applied', 1),
      laneFire('lane-error:devin:event-model-capacity', 'devin', 'applied', 2),
      laneFire('lane-error:devin:event-model-capacity', 'devin', 'applied', 4),
      laneFire('lane-error:devin:event-model-capacity', 'devin', 'applied', 6),
    ];
    const items = await incidentGateBacklogItems({ repo: REPO, ledgerPath: writeLedger(rows), now: NOW_MS });
    expect(items).toHaveLength(2);
    // devin's class fired 4 times vs codex's 2 — it sorts first.
    expect(items[0]!.prompt).toContain('event-model-capacity');
    expect(items[1]!.prompt).toContain('class-pool-error');
    const one = await incidentGateBacklogItems({ repo: REPO, ledgerPath: writeLedger(rows), now: NOW_MS, limit: 1 });
    expect(one).toHaveLength(1);
    expect(one[0]!.id).toBe(items[0]!.id);
  });

  it('drops events outside the 7-day window and future-skewed rows', async () => {
    const stale = recurringLaneRows().map((r) => ({ ...r, ts: at(9) }));
    expect(await incidentGateBacklogItems({ repo: REPO, ledgerPath: writeLedger(stale), now: NOW_MS })).toEqual([]);
    const future = recurringLaneRows().map((r) => ({ ...r, ts: new Date(NOW_MS + 2 * 3600_000).toISOString() }));
    expect(await incidentGateBacklogItems({ repo: REPO, ledgerPath: writeLedger(future), now: NOW_MS })).toEqual([]);
  });

  it('yields nothing for a missing or malformed ledger', async () => {
    expect(await incidentGateBacklogItems({ repo: REPO, ledgerPath: path.join(home, 'no-such.jsonl'), now: NOW_MS })).toEqual([]);
    const file = writeLedger([
      'not json',
      '{"v":1,"kind":"other","ts":"2026-11-20T00:00:00Z"}',
      JSON.stringify({ ...decision({ ts: at(1) }), v: 2 }),
      JSON.stringify(decision({ ts: at(1), cls: 'bogus' as Cls })),
      // cls↔gate mismatch cannot be a real decision row.
      JSON.stringify(decision({ ts: at(1), cls: 'lane-error', gate: 'repo-cooldown' as Gate })),
      JSON.stringify(decision({ ts: at(1), cls: 'test-failure', gate: 'lane-hold' as Gate })),
      JSON.stringify(decision({ ts: at(1), key: '' })),
      JSON.stringify(decision({ ts: at(1), scope: '' })),
      JSON.stringify(decision({ ts: at(1), count: 0 })),
      JSON.stringify(decision({ ts: at(1), result: 'bogus' as Result })),
      JSON.stringify(decision({ ts: 'not-a-date' })),
      JSON.stringify(decision({ ts: at(1) })),
      JSON.stringify(decision({ ts: at(3) })),
    ]);
    // Only the last two well-formed rows survive — one per day would emit,
    // but they are the same key on days 1 and 3 → actually recurring.
    const items = await incidentGateBacklogItems({ repo: REPO, ledgerPath: file, now: NOW_MS });
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toMatch(/^incident-gate-recurring-/);
    expect(await incidentGateBacklogItems({ repo: '', ledgerPath: file, now: NOW_MS })).toEqual([]);
    expect(await incidentGateBacklogItems({ repo: 'not-a-repo', ledgerPath: file, now: NOW_MS })).toEqual([]);
  });

  it('derives stable ids so a refresh re-adds nothing', async () => {
    const file = writeLedger(recurringLaneRows());
    const first = await incidentGateBacklogItems({ repo: REPO, ledgerPath: file, now: NOW_MS });
    const second = await incidentGateBacklogItems({ repo: REPO, ledgerPath: file, now: NOW_MS });
    expect(first).toHaveLength(1);
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
    // Shifted tallies on the same class re-derive the same id.
    const grown = writeLedger([...recurringLaneRows(), laneFire('lane-error:codex:class-pool-error', 'codex', 'applied', 1, undefined, 9)]);
    const third = await incidentGateBacklogItems({ repo: REPO, ledgerPath: grown, now: NOW_MS });
    expect(third.map((i) => i.id)).toEqual(first.map((i) => i.id));
  });

  it('scrubs secret-shaped text out of recorded details before it reaches a prompt', async () => {
    const token = `ghp_${'a'.repeat(36)}`;
    const rows = [
      laneFire('lane-error:codex:class-pool-error', 'codex', 'error', 1, `auth failed with ${token}`),
      laneFire('lane-error:codex:class-pool-error', 'codex', 'error', 3, `auth failed with ${token}`),
    ];
    const items = await incidentGateBacklogItems({ repo: REPO, ledgerPath: writeLedger(rows), now: NOW_MS });
    expect(items).toHaveLength(1);
    expect(items[0]!.prompt).not.toContain(token);
    expect(items[0]!.prompt).toContain('[REDACTED]');
  });

  it('reads the default ledger path under the Ashlr home', async () => {
    const dir = path.join(home, '.ashlr', 'fleet');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'incident-gates.jsonl'), ledger(recurringLaneRows()));
    const items = await incidentGateBacklogItems({ repo: REPO, now: NOW_MS });
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toMatch(/^incident-gate-recurring-/);
  });

  it('appends incident-gate items through discovery and dedupes on refresh', async () => {
    const dir = path.join(home, '.ashlr', 'fleet');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'incident-gates.jsonl'), ledger(recurringLaneRows()));
    const greenGh = async (args: string[]) => {
      const p = args[4] ?? '';
      if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
    };
    const first = await discoverBacklog(REPO, { gh: greenGh });
    const gate = first.items.filter((i) => i.id.startsWith('incident-gate-'));
    expect(gate).toHaveLength(1);
    expect(gate[0]!.id).toMatch(/^incident-gate-recurring-/);
    expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    expect(appendUserBacklogItems(gate)).toBe(gate.length);
    const second = await discoverBacklog(REPO, { gh: greenGh });
    expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('incident-gate-')))).toBe(0);
    expect(readUserBacklogItems().filter((i) => i.id.startsWith('incident-gate-'))).toHaveLength(gate.length);
  });
});
