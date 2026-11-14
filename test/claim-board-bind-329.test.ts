/** RQ-PHX-CLAIMBOARDBIND329 — the claim-board-ref producer contract binds a
 * coordination claim to one work-board item through exactly one `[board:<id>]`
 * token in its free-text task, without changing the ledger schema. The recheck
 * task section verifies only when a claim live at the verdict clock is held by
 * the item's board owner and carries that item's token; `fleet claim-item` is
 * the producer. Every reader and the claim function are faked: nothing touches
 * the real home, ledger, bus or network. Fixtures are plainly fake. */
import { describe, expect, it } from 'vitest';
import { cmdFleetClaimItem, type FleetClaimItemDeps } from '../src/cli/fleet-claim-item.js';
import { formatBoardRef, parseBoardRef, withBoardRef } from '../src/core/fleet/claim-board-ref.js';
import { readFleetRecheck, type FleetRecheckDeps } from '../src/core/fleet/fleet-recheck.js';
import type { ChannelHealth, ChannelHealthReport } from '../src/core/fleet/channel-health.js';
import type { FleetBoard, FleetClaim } from '../src/core/fleet/coordination.js';
import type { RuntimeIdentity } from '../src/core/fleet/runtime-identity.js';
import type { WorkBoardItem, WorkBoardResult } from '../src/core/comms/work-board.js';

const NOW = new Date('2026-11-14T00:30:00.000Z');
const NOW_MS = NOW.getTime();
const ISO = NOW.toISOString();
const ITEM = 'fake-item-329';
const TOKEN = `[board:${ITEM}]`;

describe('claim-board-ref', () => {
  it('parses none, one, ambiguous and invalid tokens', () => {
    expect(parseBoardRef('plain task')).toEqual({ itemId: null, reason: 'none' });
    expect(parseBoardRef(`fix the thing ${TOKEN}`)).toEqual({ itemId: ITEM });
    expect(parseBoardRef(`${TOKEN} first`)).toEqual({ itemId: ITEM });
    expect(parseBoardRef(`a ${TOKEN} b [board:other-1]`)).toEqual({ itemId: null, reason: 'ambiguous' });
    expect(parseBoardRef(`${TOKEN} ${TOKEN}`)).toEqual({ itemId: null, reason: 'ambiguous' });
    // A malformed second opener still makes the task ambiguous.
    expect(parseBoardRef(`${TOKEN} [board:`)).toEqual({ itemId: null, reason: 'ambiguous' });
    expect(parseBoardRef('x [board:]')).toEqual({ itemId: null, reason: 'invalid' });
    expect(parseBoardRef('x [board:-leading-dash]')).toEqual({ itemId: null, reason: 'invalid' });
    expect(parseBoardRef('x [board:has space]')).toEqual({ itemId: null, reason: 'invalid' });
    expect(parseBoardRef('x [board:unterminated')).toEqual({ itemId: null, reason: 'invalid' });
    expect(parseBoardRef(`x [board:${'a'.repeat(129)}]`)).toEqual({ itemId: null, reason: 'invalid' });
    // Case matters: only the exact lowercase opener is a token.
    expect(parseBoardRef(`x [Board:${ITEM}]`)).toEqual({ itemId: null, reason: 'none' });
  });

  it('formats only valid ids', () => {
    expect(formatBoardRef(ITEM)).toBe(TOKEN);
    expect(formatBoardRef('ok.id:with-chars_1')).toBe('[board:ok.id:with-chars_1]');
    expect(formatBoardRef('')).toBeNull();
    expect(formatBoardRef('bad]id')).toBeNull();
    expect(formatBoardRef('a'.repeat(129))).toBeNull();
  });

  it('withBoardRef appends one token and refuses a second, an invalid id or an oversize task', () => {
    expect(withBoardRef('  fix it  ', ITEM)).toBe(`fix it ${TOKEN}`);
    expect(withBoardRef('', ITEM)).toBe(TOKEN);
    expect(withBoardRef(`fix it ${TOKEN}`, ITEM)).toBeNull();
    expect(withBoardRef('fix it [board:other-1]', ITEM)).toBeNull();
    expect(withBoardRef('fix it [board:', ITEM)).toBeNull();
    expect(withBoardRef('fix it', 'bad id')).toBeNull();
    const room = 1000 - TOKEN.length - 1;
    expect(withBoardRef('a'.repeat(room), ITEM)).toHaveLength(1000);
    expect(withBoardRef('a'.repeat(room + 1), ITEM)).toBeNull();
    const bound = withBoardRef('fix it', ITEM)!;
    expect(parseBoardRef(bound)).toEqual({ itemId: ITEM });
  });
});

// ── recheck task section ────────────────────────────────────────────────────

const runtime: RuntimeIdentity = {
  host: 'fake-host', platform: 'fakeos', asOf: ISO,
  installedVersion: '1.2.3', sourceVersion: '1.2.3', versionDrift: false,
  fleetState: { path: '~/.ashlr-runs/guardian/state.json', mtime: ISO, ageSeconds: 5, stale: false },
  tailnetName: 'fake-tailnet-node', reasons: [],
};
const channel = (name: 'slack' | 'imessage'): ChannelHealth => ({
  channel: name, configured: true, processAlive: true, runtimeHost: 'fake-host',
  lastInboundAt: null, lastReplyAt: null, unansweredCount: 0,
  proof: { requestCoverage: 'idle', futureDatedCount: 0 }, state: 'LIVE', missing: [], asOf: ISO,
});
const channels: ChannelHealthReport = { schemaVersion: 1, asOf: ISO, channels: [channel('slack'), channel('imessage')] };

function claim(over: Partial<FleetClaim> = {}): FleetClaim {
  return {
    id: 'fake-claim-1', repo: 'fake-org/fake-repo', task: `work-board slack item ${ITEM} ${TOKEN}`,
    agent: 'dot', claimedAt: NOW_MS - 1_000, expiresAt: NOW_MS + 3_600_000, ...over,
  };
}
function item(over: Partial<WorkBoardItem> = {}): WorkBoardItem {
  return {
    id: ITEM, channel: 'slack', channelRef: 'T0FAKE/C0FAKE/1', receivedAt: '2026-11-14T00:29:00.000Z',
    state: 'RUNNING', asOf: ISO, source: 'bus-work-claims', missing: [],
    owner: 'dot', claimReceipt: `bus-claim:${ITEM}:1:1700000000000`, ...over,
  };
}
const ledger = (claims: FleetClaim[]): FleetBoard =>
  ({ schema: 'fleet.coordination.v1', state: 'known', claims, messages: [], proposals: [], expiredClaims: 0 });
const work = (items: WorkBoardItem[]): WorkBoardResult => ({ items, inbox: 'ok', truncated: false });

function deps(claims: FleetClaim[], items: WorkBoardItem[] = [item()]): FleetRecheckDeps {
  return {
    now: () => NOW, homeDir: () => '/home/fakeuser',
    readRuntimeIdentity: () => runtime, readChannelHealth: () => channels,
    readFleetBoard: () => ledger(claims), listWorkBoard: () => work(items),
  };
}

const NOT_BOUND = `task: no live claim by dot carries ${TOKEN}; owner match is not task identity`;

describe('fleet recheck task section ↔ [board:<id>] binding', () => {
  it('verifies when the board owner holds a live claim carrying the token', async () => {
    const recheck = await readFleetRecheck(deps([claim()]));
    const task = recheck.sections.task;
    expect(task.state).toBe('VERIFIED');
    expect(task.missing).toEqual([]);
    expect(task.task).toMatchObject({ id: ITEM, owner: 'dot', state: 'RUNNING' });
    expect(task.task?.ledgerClaim).toEqual({
      id: 'fake-claim-1', repo: 'fake-org/fake-repo', expiresAt: new Date(NOW_MS + 3_600_000).toISOString(),
    });
    expect(recheck.overall.state).toBe('VERIFIED');
  });

  it('verifies an ASSIGNED item too and takes the newest bound owner claim', async () => {
    const recheck = await readFleetRecheck(deps(
      [claim({ id: 'fake-old', claimedAt: NOW_MS - 9_000 }), claim({ id: 'fake-new', repo: 'fake-org/other', task: `other ${TOKEN}` })],
      [item({ state: 'ASSIGNED' })],
    ));
    expect(recheck.sections.task.state).toBe('VERIFIED');
    expect(recheck.sections.task.task?.ledgerClaim?.id).toBe('fake-new');
  });

  it('stays UNKNOWN when the only token-bearing claim has expired or has not started', async () => {
    for (const stale of [claim({ expiresAt: NOW_MS }), claim({ claimedAt: NOW_MS + 1, expiresAt: NOW_MS + 60_000 })]) {
      const task = (await readFleetRecheck(deps([stale]))).sections.task;
      expect(task.state).toBe('UNKNOWN');
      expect(task.task?.ledgerClaim).toBeNull();
      expect(task.missing).toEqual([NOT_BOUND]);
    }
  });

  it('never verifies on another agent\'s token-bearing claim, and names the holder', async () => {
    const recheck = await readFleetRecheck(deps([
      claim({ agent: 'mallory' }),
      claim({ id: 'fake-owner-unbound', task: 'unrelated owner lease' }),
    ]));
    const task = recheck.sections.task;
    expect(task.state).toBe('UNKNOWN');
    expect(task.task?.ledgerClaim).toBeNull();
    expect(task.missing).toEqual([`task: ${TOKEN} claim held by mallory, not board owner dot`]);
    expect(recheck.overall.state).not.toBe('VERIFIED');
  });

  it('treats an agent differing only in case as another agent', async () => {
    const task = (await readFleetRecheck(deps([claim({ agent: 'Dot' })]))).sections.task;
    expect(task.state).toBe('UNKNOWN');
    expect(task.missing).toEqual([`task: ${TOKEN} claim held by Dot, not board owner dot`]);
  });

  it('stays UNKNOWN on an ambiguous, invalid or token-free owner claim', async () => {
    for (const text of [`${TOKEN} [board:other-1]`, `${TOKEN} ${TOKEN}`, 'x [board:bad id]', ITEM, 'unrelated']) {
      const task = (await readFleetRecheck(deps([claim({ task: text })]))).sections.task;
      expect(task.state, text).toBe('UNKNOWN');
      expect(task.task?.ledgerClaim, text).toBeNull();
      expect(task.missing, text).toEqual([NOT_BOUND]);
    }
  });

  it('does not bind a token naming a different board item', async () => {
    const task = (await readFleetRecheck(deps([claim({ task: 'x [board:fake-item-other]' })]))).sections.task;
    expect(task.state).toBe('UNKNOWN');
    expect(task.missing).toEqual([NOT_BOUND]);
  });

  it('prefers a bound item over a newer item whose owner merely holds a lease', async () => {
    const newer = item({ id: 'fake-item-newer', owner: 'bea', receivedAt: '2026-11-14T00:29:59.000Z', claimReceipt: 'bus-claim:n:1:1' });
    const recheck = await readFleetRecheck(deps(
      [claim(), claim({ id: 'fake-bea', agent: 'bea', task: 'bea unrelated lease' })],
      [newer, item({ state: 'ASSIGNED' })],
    ));
    expect(recheck.sections.task.state).toBe('VERIFIED');
    expect(recheck.sections.task.task?.id).toBe(ITEM);
  });

  it('keeps the unreadable-ledger reason when the ledger is unknown', async () => {
    const task = (await readFleetRecheck({ ...deps([claim()]), readFleetBoard: () => ({ ...ledger([claim()]), state: 'unknown' }) })).sections.task;
    expect(task.state).toBe('UNKNOWN');
    expect(task.task?.ledgerClaim).toBeNull();
    expect(task.missing).toEqual(['task: claims ledger unreadable, owner claim unverified']);
  });
});

// ── fleet claim-item CLI ────────────────────────────────────────────────────

interface Harness { deps: FleetClaimItemDeps; out: string[]; err: string[]; calls: Array<{ repo: string; task: string; agent: string; ttlMs?: number }> }
function harness(items: WorkBoardItem[] = [item()], over: Partial<FleetClaimItemDeps> = {}): Harness {
  const h: Harness = { out: [], err: [], calls: [], deps: {} };
  h.deps = {
    now: () => NOW_MS,
    listWorkBoard: () => work(items),
    claimFleetWork: input => {
      h.calls.push(input);
      return { ok: true, value: { claim: { id: 'fake-claim-new', repo: input.repo, task: input.task, agent: input.agent, claimedAt: NOW_MS, expiresAt: NOW_MS + (input.ttlMs ?? 3_600_000) }, lease: 'fake-lease-0000' } };
    },
    out: line => h.out.push(line),
    err: line => h.err.push(line),
    ...over,
  };
  return h;
}
const ARGS = [ITEM, '--agent', 'dot', '--repo', 'fake-org/fake-repo'];

describe('fleet claim-item', () => {
  it('claims with a task carrying [board:<id>] and prints the lease once', async () => {
    const h = harness();
    expect(await cmdFleetClaimItem([...ARGS, '--ttl-minutes', '30'], h.deps)).toBe(0);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({ repo: 'fake-org/fake-repo', agent: 'dot', ttlMs: 30 * 60_000 });
    expect(parseBoardRef(h.calls[0]!.task)).toEqual({ itemId: ITEM });
    expect(h.calls[0]!.task).toContain(TOKEN);
    expect(h.out).toEqual([`claimed fake-claim-new for board item ${ITEM} lease=fake-lease-0000`]);
    expect(h.err).toEqual([]);
  });

  it('produces a claim the recheck task section verifies', async () => {
    const h = harness();
    expect(await cmdFleetClaimItem(ARGS, h.deps)).toBe(0);
    const c = h.calls[0]!;
    const produced = claim({ id: 'fake-claim-new', repo: c.repo, task: c.task, agent: c.agent });
    expect((await readFleetRecheck(deps([produced]))).sections.task.state).toBe('VERIFIED');
  });

  it('emits JSON with --json', async () => {
    const h = harness();
    expect(await cmdFleetClaimItem([...ARGS, '--json'], h.deps)).toBe(0);
    const parsed = JSON.parse(h.out[0]!) as { ok: boolean; boardItem: string; claim: { task: string }; lease: string };
    expect(parsed).toMatchObject({ ok: true, boardItem: ITEM, lease: 'fake-lease-0000' });
    expect(parsed.claim.task).toContain(TOKEN);
  });

  it('refuses a non-owner without claiming', async () => {
    const h = harness([item({ owner: 'bea' })]);
    expect(await cmdFleetClaimItem(ARGS, h.deps)).toBe(1);
    expect(h.calls).toHaveLength(0);
    expect(h.err).toEqual([`fleet claim-item: board item ${ITEM} is owned by bea, not dot`]);
    const unowned = harness([item({ owner: null })]);
    expect(await cmdFleetClaimItem(ARGS, unowned.deps)).toBe(1);
    expect(unowned.calls).toHaveLength(0);
    expect(unowned.err[0]).toContain('has no named owner');
  });

  it('refuses an item that is not RUNNING or ASSIGNED', async () => {
    for (const state of ['RECEIVED', 'BLOCKED', 'VERIFIED'] as const) {
      const h = harness([item({ state })]);
      expect(await cmdFleetClaimItem(ARGS, h.deps), state).toBe(1);
      expect(h.calls).toHaveLength(0);
      expect(h.err).toEqual([`fleet claim-item: board item ${ITEM} is ${state}, not RUNNING or ASSIGNED`]);
    }
  });

  it('refuses a missing item, an unavailable inbox and an unreadable board', async () => {
    const missing = harness([]);
    expect(await cmdFleetClaimItem(ARGS, missing.deps)).toBe(1);
    expect(missing.err).toEqual([`fleet claim-item: board item ${ITEM} not found`]);
    const down = harness([], { listWorkBoard: () => ({ items: [], inbox: 'unavailable', truncated: false }) });
    expect(await cmdFleetClaimItem(ARGS, down.deps)).toBe(1);
    expect(down.err).toEqual(['fleet claim-item: work board inbox unavailable']);
    const thrown = harness([], { listWorkBoard: () => { throw new Error('boom'); } });
    expect(await cmdFleetClaimItem(ARGS, thrown.deps)).toBe(1);
    expect(thrown.err).toEqual(['fleet claim-item: work board unreadable']);
    for (const h of [missing, down, thrown]) expect(h.calls).toHaveLength(0);
  });

  it('maps ledger duplicate/unavailable to exit 1 and never prints a lease', async () => {
    for (const error of ['duplicate', 'unavailable'] as const) {
      const h = harness(undefined, { claimFleetWork: () => ({ ok: false, error }) });
      expect(await cmdFleetClaimItem(ARGS, h.deps), error).toBe(1);
      expect(h.out).toEqual([]);
      expect(h.err.join('\n')).not.toContain('lease=');
    }
  });

  it('rejects bad arguments with exit 2 before reading the board', async () => {
    let reads = 0;
    const cases: string[][] = [
      [],
      ['--agent', 'dot', '--repo', 'fake-org/fake-repo'],
      [ITEM, '--repo', 'fake-org/fake-repo'],
      [ITEM, '--agent', 'dot'],
      [ITEM, '--agent', 'dot', '--repo', 'not-a-repo'],
      ['bad id', '--agent', 'dot', '--repo', 'fake-org/fake-repo'],
      [...ARGS, '--ttl-minutes', '0'],
      [...ARGS, '--ttl-minutes', '10081'],
      [...ARGS, '--bogus'],
      [...ARGS, 'extra'],
      [...ARGS, '--agent', 'dot'],
    ];
    for (const args of cases) {
      const h = harness(undefined, { listWorkBoard: () => { reads += 1; return work([item()]); } });
      expect(await cmdFleetClaimItem(args, h.deps), args.join(' ')).toBe(2);
      expect(h.calls).toHaveLength(0);
    }
    expect(reads).toBe(0);
  });

  it('prints usage and exits 0 for --help', async () => {
    const h = harness();
    expect(await cmdFleetClaimItem(['--help'], h.deps)).toBe(0);
    expect(h.out[0]).toMatch(/^Usage: ashlr fleet claim-item/);
    expect(h.calls).toHaveLength(0);
  });
});
