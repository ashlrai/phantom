import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverBacklog } from '../src/core/improve/discover.js';
import { foldTickHealth, tickHealthBacklogItems, TICK_HEALTH_RECURRING } from '../src/core/improve/tick-health-backlog.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';

let home: string;
let saved: { HOME?: string; ASHLR_HOME?: string };
beforeEach(() => {
  saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME };
  delete process.env.ASHLR_HOME;
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'improve-tick-health-')));
  process.env.HOME = home;
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(home, { recursive: true, force: true });
});

const NOW = new Date('2026-11-23T12:00:00Z');
const iso = (hoursAgo: number): string => new Date(NOW.getTime() - hoursAgo * 3_600_000).toISOString();

/** A persisted DaemonTick-shaped row: only ts/reason/phases are consumed. */
const tick = (hoursAgo: number, phases: unknown[] = [], reason = 'ok'): Record<string, unknown> => ({
  ts: iso(hoursAgo),
  itemsConsidered: 3,
  proposalsCreated: 0,
  spentUsd: 0,
  reason,
  phases,
});

const phase = (name: string, status: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  name, status, durationMs: 100, ...extra,
});

const degraded = (name: string, error = 'stage blew up'): Record<string, unknown> =>
  phase(name, 'degraded', { error });
const okPhase = (name: string): Record<string, unknown> => phase(name, 'ok');

/** Write daemon.json under a scratch ASHLR root and return the rootDir option. */
const writeState = (rootName: string, state: unknown): string => {
  const root = path.join(home, rootName);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'daemon.json'), typeof state === 'string' ? state : `${JSON.stringify(state)}\n`);
  return root;
};

/** Ticks where 'reward-sync' degrades every time — the recurring-failure fixture. */
const failingTicks = (count: number, hoursStart = 50): Record<string, unknown>[] =>
  Array.from({ length: count }, (_, i) => tick(hoursStart - i, [degraded('reward-sync', `sync failed ${i}`), okPhase('backlog-refresh')]));

describe('daemon tick health fold', () => {
  it('counts every non-clean outcome class and ignores neutral ones', () => {
    const rows = [
      tick(9, [
        phase('a', 'timeout', { error: 'deadline' }),
        phase('b', 'running'),
        phase('c', 'skipped', { error: 'tick-budget-exhausted' }),
        phase('d', 'skipped', { error: 'no-frontier' }),
        phase('e', 'off-tick', { offTick: { state: 'running', run: 2, since: iso(9), lastStatus: 'degraded', lastSettledAt: iso(9), lastError: 'job died' } }),
        phase('f', 'off-tick', { offTick: { state: 'running', run: 1, since: iso(9), lastStatus: 'ok', lastSettledAt: iso(9) } }),
        phase('g', 'off-tick', { offTick: { state: 'running', run: 1, since: iso(9) } }),
        okPhase('h'),
      ]),
    ];
    const fold = foldTickHealth(rows, NOW);
    expect(fold.ticks).toBe(1);
    const byName = new Map(fold.phases.map((p) => [p.name, p]));
    expect(byName.get('a')).toMatchObject({ timeout: 1, failures: 1 });
    expect(byName.get('b')).toMatchObject({ abandoned: 1, failures: 1 });
    expect(byName.get('c')).toMatchObject({ budgetSkipped: 1, failures: 1 });
    expect(byName.get('d')).toMatchObject({ skipped: 1, failures: 0 });
    expect(byName.get('e')).toMatchObject({ offTickFailed: 1, failures: 1 });
    expect(byName.get('f')).toMatchObject({ offTickClean: 1, failures: 0 });
    expect(byName.get('g')).toMatchObject({ offTickQuiet: 1, failures: 0 });
    expect(byName.get('h')).toMatchObject({ ok: 1, failures: 0 });
  });

  it('counts one settled off-tick failure once however many ticks observe it', () => {
    const settled = { state: 'running', run: 3, since: iso(60), lastStatus: 'degraded', lastDurationMs: 900, lastSettledAt: iso(60), lastError: 'reward sync blew up' };
    const rows = Array.from({ length: 6 }, (_, i) => tick(50 - i, [phase('reward-sync', 'off-tick', { offTick: settled })]));
    const fold = foldTickHealth(rows, NOW);
    const tally = fold.phases.find((p) => p.name === 'reward-sync')!;
    expect(tally.observed).toBe(6);
    expect(tally.offTickFailed).toBe(1);
    expect(tally.failures).toBe(1);
  });

  it('counts distinct settled off-tick run failures separately', () => {
    const rows = [0, 1, 2].map((i) => tick(50 - i, [phase('reward-sync', 'off-tick', {
      offTick: { state: 'running', run: 3 + i, since: iso(60), lastStatus: 'timeout', lastSettledAt: iso(50 - i), lastError: `run ${3 + i} timed out` },
    })]));
    const fold = foldTickHealth(rows, NOW);
    const tally = fold.phases.find((p) => p.name === 'reward-sync')!;
    expect(tally.offTickFailed).toBe(3);
    expect(tally.failures).toBe(3);
  });

  it('keeps the worst outcome when one tick records a phase name twice', () => {
    const rows = [tick(9, [okPhase('auto-merge'), degraded('auto-merge', 'second run died')])];
    const fold = foldTickHealth(rows, NOW);
    const tally = fold.phases.find((p) => p.name === 'auto-merge')!;
    expect(tally.observed).toBe(1);
    expect(tally.degraded).toBe(1);
    expect(tally.ok).toBe(0);
    expect(tally.failures).toBe(1);
  });

  it('drops ticks outside the window, with bad timestamps, or stamped in the future', () => {
    const rows = [
      tick(24 * 8, [degraded('old-phase')]),
      { ts: 'not-a-date', phases: [degraded('bad-ts')] },
      { phases: [degraded('no-ts')] },
      tick(-2, [degraded('future-phase')]),
      tick(10, [degraded('fresh-phase')]),
      'garbage',
      null,
    ];
    const fold = foldTickHealth(rows, NOW);
    expect(fold.ticks).toBe(1);
    expect(fold.phases.map((p) => p.name)).toEqual(['fresh-phase']);
  });

  it('tallies only whole-tick reasons in the bad-reason set', () => {
    const rows = [
      ...Array.from({ length: 4 }, (_, i) => tick(40 - i, [], 'state-persistence-failed')),
      ...Array.from({ length: 5 }, (_, i) => tick(30 - i, [], 'budget-exhausted')),
      tick(20, [], 'no-backlog'),
      tick(19, [], 'ok'),
    ];
    const fold = foldTickHealth(rows, NOW);
    expect(fold.reasons).toHaveLength(1);
    expect(fold.reasons[0]).toMatchObject({ reason: 'state-persistence-failed', count: 4 });
  });
});

describe('tickHealthBacklogItems', () => {
  it('turns a recurring phase failure into a valid priority-3 backlog item', async () => {
    const rootDir = writeState('.ashlr-a', { running: false, ticks: failingTicks(TICK_HEALTH_RECURRING + 1) });
    const items = await tickHealthBacklogItems({ repo: 'ashlrai/phantom', rootDir, now: NOW });
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(item.id).toMatch(/^tick-health-[0-9a-f]{16}$/);
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item).toMatchObject({ priority: 3, repo: 'ashlrai/phantom', area: 'daemon-tick' });
    expect(item.title).toContain('reward-sync');
    expect(item.prompt).toContain('degraded 4');
    expect(item.prompt).toContain('daemon.json');
    expect(item.prompt).toContain('phm daemon status');
    expect(item.prompt).toContain('no-change');
    expect(item.prompt).toContain('sync failed 3');
  });

  it('emits items for every failure class and for recurring bad tick reasons', async () => {
    const rows = [
      ...Array.from({ length: 3 }, (_, i) => tick(60 - i, [phase('flaky', 'timeout', { error: 'over deadline' })])),
      ...Array.from({ length: 3 }, (_, i) => tick(50 - i, [phase('stuck', 'running')])),
      ...Array.from({ length: 3 }, (_, i) => tick(40 - i, [phase('slow', 'skipped', { error: 'tick-budget-exhausted' })])),
      ...Array.from({ length: 3 }, (_, i) => tick(30 - i, [phase('job', 'off-tick', {
        offTick: { state: 'running', run: 7 + i, since: iso(60), lastStatus: 'degraded', lastSettledAt: iso(30 - i), lastError: `job run ${7 + i} died` },
      })])),
      ...Array.from({ length: 3 }, (_, i) => tick(20 - i, [], 'activation-refused')),
    ];
    const rootDir = writeState('.ashlr-b', { ticks: rows });
    const items = await tickHealthBacklogItems({ repo: 'ashlrai/phantom', rootDir, now: NOW });
    expect(items).toHaveLength(5);
    const titles = items.map((i) => i.title);
    expect(titles.some((t) => t.includes('flaky'))).toBe(true);
    expect(titles.some((t) => t.includes('stuck'))).toBe(true);
    expect(titles.some((t) => t.includes('slow'))).toBe(true);
    expect(titles.some((t) => t.includes('job'))).toBe(true);
    expect(titles.some((t) => t.includes('activation-refused'))).toBe(true);
    const reason = items.find((i) => i.title.includes('activation-refused'))!;
    expect(reason.prompt).toContain('3 of 15 in-window tick(s)');
    expect(reason.prompt).toContain('activation capability');
    for (const item of items) expect(validBacklogItem(item)).not.toBeNull();
  });

  it('emits nothing below the recurring bar or when only neutral outcomes record', async () => {
    const below = writeState('.ashlr-c', {
      ticks: [
        ...Array.from({ length: TICK_HEALTH_RECURRING - 1 }, (_, i) => tick(50 - i, [degraded('reward-sync')])),
        tick(10, [okPhase('reward-sync'), phase('invent', 'skipped', { error: 'no-frontier' })]),
      ],
    });
    expect(await tickHealthBacklogItems({ repo: 'ashlrai/phantom', rootDir: below, now: NOW })).toEqual([]);
    const clean = writeState('.ashlr-d', {
      ticks: Array.from({ length: 10 }, (_, i) => tick(50 - i, [okPhase('reward-sync'), phase('invent', 'skipped', { error: 'no-frontier' })])),
    });
    expect(await tickHealthBacklogItems({ repo: 'ashlrai/phantom', rootDir: clean, now: NOW })).toEqual([]);
  });

  it('emits nothing for stale history, a missing file, malformed JSON or a non-array ticks', async () => {
    const stale = writeState('.ashlr-e', { ticks: failingTicks(6, 24 * 9) });
    expect(await tickHealthBacklogItems({ repo: 'ashlrai/phantom', rootDir: stale, now: NOW })).toEqual([]);
    expect(await tickHealthBacklogItems({
      repo: 'ashlrai/phantom', rootDir: path.join(home, 'no-such-root'), now: NOW,
    })).toEqual([]);
    const malformed = writeState('.ashlr-f', '{not json');
    expect(await tickHealthBacklogItems({ repo: 'ashlrai/phantom', rootDir: malformed, now: NOW })).toEqual([]);
    const noTicks = writeState('.ashlr-g', { running: true, ticks: 'corrupt' });
    expect(await tickHealthBacklogItems({ repo: 'ashlrai/phantom', rootDir: noTicks, now: NOW })).toEqual([]);
  });

  it('emits nothing for another repository — the daemon is this install\'s machinery', async () => {
    const rootDir = writeState('.ashlr-h', { ticks: failingTicks(TICK_HEALTH_RECURRING + 1) });
    expect(await tickHealthBacklogItems({ repo: 'ashlrai/other', rootDir, now: NOW })).toEqual([]);
    expect(await tickHealthBacklogItems({ repo: 'phantom', rootDir, now: NOW })).not.toEqual([]);
  });

  it('scrubs secret-shaped text out of recorded errors before it reaches a prompt', async () => {
    const token = `ghp_${'a'.repeat(36)}`;
    const rows = Array.from({ length: 3 }, (_, i) => tick(50 - i, [degraded('reward-sync', `auth failed with ${token}`)]));
    const rootDir = writeState('.ashlr-i', { ticks: rows });
    const items = await tickHealthBacklogItems({ repo: 'ashlrai/phantom', rootDir, now: NOW });
    expect(items).toHaveLength(1);
    expect(items[0]!.prompt).not.toContain(token);
    expect(items[0]!.prompt).toContain('[REDACTED]');
  });

  it('derives stable ids so a refresh re-adds nothing and honours the limit', async () => {
    // reward-sync fails on all 5 ticks; the other two phases fail on only 4,
    // so the failures-desc sort puts reward-sync first deterministically.
    const rows = [
      ...Array.from({ length: 5 }, (_, i) => tick(60 - i, [degraded('reward-sync')])),
      ...Array.from({ length: 4 }, (_, i) => tick(55 - i, [
        phase('invent', 'timeout', { error: 'over deadline' }),
        phase('node-bridge', 'running'),
      ])),
    ];
    const rootDir = writeState('.ashlr-j', { ticks: rows });
    const first = await tickHealthBacklogItems({ repo: 'ashlrai/phantom', rootDir, now: NOW });
    const second = await tickHealthBacklogItems({ repo: 'ashlrai/phantom', rootDir, now: NOW });
    expect(first).toHaveLength(3);
    expect(first[0]!.title).toContain('reward-sync');
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
    const one = await tickHealthBacklogItems({ repo: 'ashlrai/phantom', rootDir, now: NOW, limit: 1 });
    expect(one).toHaveLength(1);
    expect(one[0]!.id).toBe(first[0]!.id);
  });

  it('appends tick-health items through discovery and dedupes on refresh', async () => {
    // discoverBacklog anchors the fold at the real clock, so fixture ticks
    // stamp relative to it — the 7-day window is the fold's own.
    const recent = (hoursAgo: number): string => new Date(Date.now() - hoursAgo * 3_600_000).toISOString();
    const rows = Array.from({ length: TICK_HEALTH_RECURRING + 1 }, (_, i) => ({
      ts: recent(50 - i),
      reason: 'ok',
      phases: [{ name: 'reward-sync', status: 'degraded', durationMs: 50, error: 'sync failed' }],
    }));
    const root = path.join(home, '.ashlr');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'daemon.json'), `${JSON.stringify({ running: true, ticks: rows })}\n`);
    const greenGh = async (args: string[]) => {
      const p = args[4] ?? '';
      if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
    };
    const first = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    const health = first.items.filter((i) => i.id.startsWith('tick-health-'));
    expect(health).toHaveLength(1);
    expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    expect(appendUserBacklogItems(health)).toBe(1);
    const second = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('tick-health-')))).toBe(0);
    expect(readUserBacklogItems().filter((i) => i.id.startsWith('tick-health-'))).toHaveLength(1);
  });
});
