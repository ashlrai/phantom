import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { discoverBacklog } from '../src/core/improve/discover.js';
import { coordinationBacklogItems } from '../src/core/improve/coordination-backlog.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';

let home: string;
let saved: { HOME?: string; ASHLR_HOME?: string; ASHLR_RUNS_DIR?: string; PHANTOM_FLEET_LEDGER_PATH?: string };
beforeEach(() => {
  saved = {
    HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME,
    ASHLR_RUNS_DIR: process.env.ASHLR_RUNS_DIR, PHANTOM_FLEET_LEDGER_PATH: process.env.PHANTOM_FLEET_LEDGER_PATH,
  };
  delete process.env.ASHLR_HOME;
  delete process.env.ASHLR_RUNS_DIR;
  delete process.env.PHANTOM_FLEET_LEDGER_PATH;
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'improve-coordination-')));
  process.env.HOME = home;
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(home, { recursive: true, force: true });
});

const NOW = new Date('2026-11-23T12:00:00Z');
const NOW_MS = NOW.getTime();
const DAY = 86_400_000;
const daysAgo = (days: number): number => NOW_MS - days * DAY;
const HASH = 'a'.repeat(64);

const REPO = 'ashlrai/phantom';
const WORK_REPO = 'ashlrai/lexicon';

const claim = (id: string, agent: string, repo: string, task: string, at: number): Record<string, unknown> => ({
  version: 1, kind: 'claim', at,
  claim: { id, repo, task, agent, claimedAt: at, expiresAt: at + 3_600_000, leaseHash: HASH },
});
const handoff = (id: string, to: string, repo: string, task: string, at: number): Record<string, unknown> => ({
  version: 1, kind: 'handoff', at,
  claim: { id, repo, task, agent: to, claimedAt: at, expiresAt: at + 3_600_000, leaseHash: HASH },
});
const release = (id: string, at: number): Record<string, unknown> => ({ version: 1, kind: 'release', at, id });
const reapExpired = (id: string, owner: string, at: number): Record<string, unknown> => ({
  version: 1, kind: 'reap', at, id, owner, state: 'RELEASED', reason: 'lease-expired',
});
const reapPlain = (id: string, at: number): Record<string, unknown> => ({ version: 1, kind: 'reap', at, id });
const ret = (id: string, agent: string, at: number): Record<string, unknown> => ({
  version: 1, kind: 'return', at, id, agent, leaseHash: HASH,
  message: { id: `return-${id}`, from: agent, to: 'leader', body: 'RESULT VERIFIED x', at, expiresAt: at + DAY },
});
const post = (from: string, to: string, body: string, at: number): Record<string, unknown> => ({
  version: 1, kind: 'post', at,
  message: { id: `m-${at}`, from, to, body, at, expiresAt: at + DAY },
});
const assign = (repo: string, task: string, to: string, at: number): Record<string, unknown> => ({
  version: 1, kind: 'assign', at,
  proposal: { id: `p-${at}`, repo, task, to, at, expiresAt: at + DAY, executionAuthorized: false },
});

const journal = (rows: Record<string, unknown>[]): string => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';

/** Three distinct claims lease-expired for one owner across two UTC days. */
const leaseChurn = (owner = 'agent-a'): Record<string, unknown>[] => [
  claim('claim-1', owner, WORK_REPO, 'first task', daysAgo(3)),
  claim('claim-2', owner, 'ashlrai/phantom', 'second task', daysAgo(2)),
  claim('claim-3', owner, WORK_REPO, 'third task', daysAgo(1)),
  ret('claim-9', owner, daysAgo(2)),
  reapExpired('claim-1', owner, daysAgo(3)),
  reapExpired('claim-2', owner, daysAgo(2)),
  reapExpired('claim-3', owner, daysAgo(1)),
];

/** The same work handed off across two claims and three days. */
const handoffChurn = (): Record<string, unknown>[] => [
  claim('claim-a', 'agent-a', WORK_REPO, 'ping-pong task', daysAgo(4)),
  handoff('claim-a', 'agent-b', WORK_REPO, 'ping-pong task', daysAgo(3)),
  handoff('claim-a', 'agent-c', WORK_REPO, 'ping-pong task', daysAgo(2)),
  claim('claim-b', 'agent-d', WORK_REPO, 'ping-pong task', daysAgo(1)),
  handoff('claim-b', 'agent-a', WORK_REPO, 'ping-pong task', daysAgo(1)),
];

const writeJournal = (rows: Record<string, unknown>[] | string): string => {
  const file = path.join(home, 'coordination.jsonl');
  fs.writeFileSync(file, typeof rows === 'string' ? rows : journal(rows));
  return file;
};

describe('coordinationBacklogItems', () => {
  it('turns recurring lease-expired reaps into a valid priority-3 backlog item', async () => {
    const items = await coordinationBacklogItems({ repo: REPO, journalPath: writeJournal(leaseChurn()), now: NOW_MS });
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(item.id).toMatch(/^coord-lease-[0-9a-f]{16}$/);
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item).toMatchObject({ priority: 3, repo: REPO, area: 'fleet-coordination' });
    expect(item.title).toContain('agent-a');
    expect(item.prompt).toContain('3 distinct claims lease-expired');
    expect(item.prompt).toContain('across 3 days');
    expect(item.prompt).toContain('1 concluded return(s) for this agent');
    expect(item.prompt).toContain(`'${WORK_REPO}' (2)`);
    expect(item.prompt).toContain('fleet coordination');
    expect(item.prompt).toContain('no-change');
    expect(item.prompt).toContain('fleet/coordination.jsonl');
  });

  it('stays quiet below the recurring bar, on one day, or outside the window', async () => {
    // Two reaps never reach the bar.
    const two = await coordinationBacklogItems({
      repo: REPO, now: NOW_MS,
      journalPath: writeJournal([
        claim('claim-1', 'agent-a', WORK_REPO, 't', daysAgo(2)),
        claim('claim-2', 'agent-a', WORK_REPO, 't', daysAgo(1)),
        reapExpired('claim-1', 'agent-a', daysAgo(2)),
        reapExpired('claim-2', 'agent-a', daysAgo(1)),
      ]),
    });
    expect(two).toEqual([]);
    // Three reaps but all journaled the same UTC day.
    const oneDay = await coordinationBacklogItems({
      repo: REPO, now: NOW_MS,
      journalPath: writeJournal([
        claim('claim-1', 'agent-a', WORK_REPO, 't', daysAgo(1)),
        claim('claim-2', 'agent-a', WORK_REPO, 't', daysAgo(1)),
        claim('claim-3', 'agent-a', WORK_REPO, 't', daysAgo(1)),
        reapExpired('claim-1', 'agent-a', daysAgo(1)),
        reapExpired('claim-2', 'agent-a', daysAgo(1)),
        reapExpired('claim-3', 'agent-a', daysAgo(1)),
      ]),
    });
    expect(oneDay).toEqual([]);
    // Recurring shape but every reap older than the 7-day window.
    const stale = await coordinationBacklogItems({
      repo: REPO, now: NOW_MS,
      journalPath: writeJournal([
        claim('claim-1', 'agent-a', WORK_REPO, 't', daysAgo(9)),
        claim('claim-2', 'agent-a', WORK_REPO, 't', daysAgo(8)),
        claim('claim-3', 'agent-a', WORK_REPO, 't', daysAgo(7.5)),
        reapExpired('claim-1', 'agent-a', daysAgo(9)),
        reapExpired('claim-2', 'agent-a', daysAgo(8)),
        reapExpired('claim-3', 'agent-a', daysAgo(7.5)),
      ]),
    });
    expect(stale).toEqual([]);
    // One expiry each for three different owners is not one agent's pattern.
    const spread = await coordinationBacklogItems({
      repo: REPO, now: NOW_MS,
      journalPath: writeJournal([
        claim('claim-1', 'agent-a', WORK_REPO, 't', daysAgo(2)),
        claim('claim-2', 'agent-b', WORK_REPO, 't', daysAgo(2)),
        claim('claim-3', 'agent-c', WORK_REPO, 't', daysAgo(1)),
        reapExpired('claim-1', 'agent-a', daysAgo(2)),
        reapExpired('claim-2', 'agent-b', daysAgo(2)),
        reapExpired('claim-3', 'agent-c', daysAgo(1)),
      ]),
    });
    expect(spread).toEqual([]);
  });

  it('emits only for the fleet repository target', async () => {
    const file = writeJournal(leaseChurn());
    expect(await coordinationBacklogItems({ repo: 'ashlrai/lexicon', journalPath: file, now: NOW_MS })).toEqual([]);
    expect(await coordinationBacklogItems({ repo: '', journalPath: file, now: NOW_MS })).toEqual([]);
    expect(await coordinationBacklogItems({ repo: 'not-a-repo', journalPath: file, now: NOW_MS })).toEqual([]);
    const items = await coordinationBacklogItems({ repo: 'AshlrAI/Phantom', journalPath: file, now: NOW_MS });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ repo: 'AshlrAI/Phantom' });
  });

  it('turns recurring handoff churn into a valid backlog item', async () => {
    const items = await coordinationBacklogItems({ repo: REPO, journalPath: writeJournal(handoffChurn()), now: NOW_MS });
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(item.id).toMatch(/^coord-handoff-[0-9a-f]{16}$/);
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item).toMatchObject({ priority: 3, repo: REPO, area: 'fleet-coordination' });
    expect(item.title).toContain(WORK_REPO);
    expect(item.title).toContain('ping-pong task');
    expect(item.prompt).toContain('3 handoffs across 2 distinct claims');
    expect(item.prompt).toContain('in 3 days');
    expect(item.prompt).toContain('agent-b');
    expect(item.prompt).toContain('agent-c');
    expect(item.prompt).toContain('fleet coordination returns');
    expect(item.prompt).toContain('no-change');
  });

  it('stays quiet on isolated handoffs, plain reaps, releases, posts and assigns', async () => {
    const quiet = await coordinationBacklogItems({
      repo: REPO, now: NOW_MS,
      journalPath: writeJournal([
        claim('claim-a', 'agent-a', WORK_REPO, 'one handoff only', daysAgo(2)),
        handoff('claim-a', 'agent-b', WORK_REPO, 'one handoff only', daysAgo(1)),
        claim('claim-b', 'agent-c', WORK_REPO, 'released work', daysAgo(2)),
        release('claim-b', daysAgo(1)),
        reapPlain('claim-c', daysAgo(1)),
        post('agent-a', 'leader', 'status note', daysAgo(1)),
        assign(WORK_REPO, 'proposed work', 'agent-b', daysAgo(1)),
      ]),
    });
    expect(quiet).toEqual([]);
  });

  it('counts reaped claims whose claim row fell out of the tail, naming no repo', async () => {
    const items = await coordinationBacklogItems({
      repo: REPO, now: NOW_MS,
      journalPath: writeJournal([
        reapExpired('claim-x', 'agent-z', daysAgo(3)),
        reapExpired('claim-y', 'agent-z', daysAgo(2)),
        reapExpired('claim-w', 'agent-z', daysAgo(1)),
      ]),
    });
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toMatch(/^coord-lease-/);
    expect(items[0]!.prompt).toContain('work repos are unknown');
    expect(items[0]!.prompt).toContain('3 distinct claims lease-expired');
  });

  it('ignores malformed rows, foreign versions and rows outside the event vocabulary', async () => {
    const file = writeJournal([
      ...leaseChurn(),
      { not: 'json at all' } as unknown as Record<string, unknown>,
      { version: 2, kind: 'reap', at: daysAgo(1), id: 'claim-3', owner: 'agent-a', state: 'RELEASED', reason: 'lease-expired' },
      { version: 1, kind: 'reap', at: 'not-a-number', id: 'claim-3', owner: 'agent-a', state: 'RELEASED', reason: 'lease-expired' },
      { version: 1, kind: 'reap', at: daysAgo(1), id: 'claim-3', owner: 'agent-a', state: 'RELEASED', reason: 'other' },
      { version: 1, kind: 'mystery', at: daysAgo(1) },
    ] as Record<string, unknown>[]);
    // Malformed lines never reach the fold; the valid churn still emits once.
    const items = await coordinationBacklogItems({ repo: REPO, journalPath: file, now: NOW_MS });
    expect(items).toHaveLength(1);
    expect(items[0]!.prompt).toContain('3 distinct claims lease-expired');
  });

  it('yields nothing for a missing or non-file journal and bad input', async () => {
    expect(await coordinationBacklogItems({ repo: REPO, journalPath: path.join(home, 'no-such.jsonl'), now: NOW_MS })).toEqual([]);
    const dir = path.join(home, 'a-directory');
    fs.mkdirSync(dir);
    expect(await coordinationBacklogItems({ repo: REPO, journalPath: dir, now: NOW_MS })).toEqual([]);
    const file = writeJournal('not json\n{"version":1}\n');
    expect(await coordinationBacklogItems({ repo: REPO, journalPath: file, now: NOW_MS })).toEqual([]);
  });

  it('waits for future-stamped rows beyond the skew to enter the window', async () => {
    const future = daysAgo(-1); // tomorrow — far beyond the one-minute skew
    const items = await coordinationBacklogItems({
      repo: REPO, now: NOW_MS,
      journalPath: writeJournal([
        claim('claim-1', 'agent-a', WORK_REPO, 't', future),
        claim('claim-2', 'agent-a', WORK_REPO, 't', future),
        claim('claim-3', 'agent-a', WORK_REPO, 't', future),
        reapExpired('claim-1', 'agent-a', future),
        reapExpired('claim-2', 'agent-a', future),
        reapExpired('claim-3', 'agent-a', future),
      ]),
    });
    expect(items).toEqual([]);
    // The same rows stamped within the skew tolerance count normally.
    const skewed = NOW_MS + 30_000;
    const tolerated = await coordinationBacklogItems({
      repo: REPO, now: NOW_MS,
      journalPath: writeJournal([
        claim('claim-1', 'agent-a', WORK_REPO, 't', skewed),
        claim('claim-2', 'agent-a', WORK_REPO, 't', skewed),
        claim('claim-3', 'agent-a', WORK_REPO, 't', daysAgo(1)),
        reapExpired('claim-1', 'agent-a', skewed),
        reapExpired('claim-2', 'agent-a', skewed),
        reapExpired('claim-3', 'agent-a', daysAgo(1)),
      ]),
    });
    expect(tolerated).toHaveLength(1);
  });

  it('derives stable ids so a refresh re-adds nothing', async () => {
    const file = writeJournal([...leaseChurn(), ...handoffChurn()]);
    const first = await coordinationBacklogItems({ repo: REPO, journalPath: file, now: NOW_MS });
    expect(first).toHaveLength(2);
    const second = await coordinationBacklogItems({ repo: REPO, journalPath: file, now: NOW_MS });
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
    // Shifted tallies on the same cells re-derive the same ids.
    const grown = writeJournal([
      ...leaseChurn(),
      ...handoffChurn(),
      claim('claim-4', 'agent-a', WORK_REPO, 'fourth', daysAgo(1)),
      reapExpired('claim-4', 'agent-a', daysAgo(1)),
    ]);
    const third = await coordinationBacklogItems({ repo: REPO, journalPath: grown, now: NOW_MS });
    expect(third.map((i) => i.id)).toEqual(first.map((i) => i.id));
  });

  it('scrubs secret-shaped text out of recorded fields before they reach a prompt', async () => {
    const token = `ghp_${'b'.repeat(36)}`;
    const items = await coordinationBacklogItems({
      repo: REPO, now: NOW_MS,
      journalPath: writeJournal([
        claim('claim-1', 'agent-a', WORK_REPO, `task with ${token} inside`, daysAgo(3)),
        claim('claim-2', 'agent-a', WORK_REPO, 'second', daysAgo(2)),
        claim('claim-3', 'agent-a', WORK_REPO, 'third', daysAgo(1)),
        handoff('claim-1', 'agent-b', WORK_REPO, `task with ${token} inside`, daysAgo(2)),
        handoff('claim-1', 'agent-c', WORK_REPO, `task with ${token} inside`, daysAgo(1)),
        handoff('claim-1', 'agent-d', WORK_REPO, `task with ${token} inside`, daysAgo(0.5)),
        reapExpired('claim-1', 'agent-a', daysAgo(3)),
        reapExpired('claim-2', 'agent-a', daysAgo(2)),
        reapExpired('claim-3', 'agent-a', daysAgo(1)),
      ]),
    });
    expect(items).toHaveLength(2);
    for (const item of items) {
      expect(item.prompt).not.toContain(token);
      expect(item.title).not.toContain(token);
    }
    expect(items.find((i) => i.id.startsWith('coord-handoff-'))!.prompt).toContain('[REDACTED]');
  });

  it('reads the default ledger path under ASHLR_HOME', async () => {
    process.env.ASHLR_HOME = path.join(home, '.ashlr');
    const dir = path.join(home, '.ashlr', 'fleet');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'coordination.jsonl'), journal(leaseChurn()));
    const items = await coordinationBacklogItems({ repo: REPO, now: NOW_MS });
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toMatch(/^coord-lease-/);
  });

  it('appends coordination items through discovery and dedupes on refresh', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    try {
      process.env.ASHLR_HOME = path.join(home, '.ashlr-e2e');
      process.env.ASHLR_RUNS_DIR = path.join(home, 'runs');
      const dir = path.join(home, '.ashlr-e2e', 'fleet');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'coordination.jsonl'), journal(leaseChurn()));
      const greenGh = async (args: string[]) => {
        const p = args[4] ?? '';
        if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
        return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
      };
      const first = await discoverBacklog(REPO, { gh: greenGh });
      const coord = first.items.filter((i) => i.id.startsWith('coord-'));
      expect(coord).toHaveLength(1);
      expect(coord[0]!.id).toMatch(/^coord-lease-/);
      expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
      expect(appendUserBacklogItems(coord)).toBe(coord.length);
      const second = await discoverBacklog(REPO, { gh: greenGh });
      expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('coord-')))).toBe(0);
      expect(readUserBacklogItems().filter((i) => i.id.startsWith('coord-'))).toHaveLength(coord.length);
    } finally {
      vi.useRealTimers();
    }
  });
});
