import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  claimFleetWork,
  readFleetBoard,
  type FleetBoard,
  type FleetCoordinationOptions,
  type FleetCoordinationResult,
  type FleetMessage,
} from '../src/core/fleet/coordination.js';
import { returnFleetClaim } from '../src/core/fleet/coordination-return.js';
import { projectCoordinationReturns } from '../src/core/fleet/coordination-returns-view.js';

const REPO = 'ashlrai/phantom';
const AGENT = 'agent-395s';
const dirs: string[] = [];

function fixture(now: number) {
  const dir = mkdtempSync(join(tmpdir(), 'return-clock-evidence-395s-'));
  dirs.push(dir);
  return { path: join(dir, 'coordination.jsonl'), now } satisfies FleetCoordinationOptions & { now: number };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function must<T>(result: FleetCoordinationResult<T>): T {
  if (!result.ok) throw new Error(`expected ok, got ${result.error}`);
  return result.value;
}

/** Typed fixture: receipt messages whose clock fields the writer itself never emits. */
function receipt(claimId: string, at: number, expiresAt: number): FleetMessage {
  return { id: `return-${claimId}`, from: AGENT, to: 'all',
    body: `RESULT VERIFIED ${REPO} claim ${claimId} task "return clock ${claimId}": tests passed`,
    at, expiresAt };
}

function boardWith(messages: FleetMessage[]): FleetBoard {
  return { schema: 'fleet.coordination.v1', state: 'known', claims: [], messages, proposals: [], expiredClaims: 0 };
}

describe('RESULT receipt temporal qualification at asOf', () => {
  it('keeps a retained receipt as current history, then expired at and past its expiry boundary', () => {
    const options = fixture(1_000);
    const claim = must(claimFleetWork({ repo: REPO, task: 'return clock evidence 395s', agent: AGENT }, options));
    expect(returnFleetClaim({ id: claim.claim.id, agent: AGENT, lease: claim.lease,
      tests: '11 tests passed', ttlMs: 2_000 }, options))
      .toMatchObject({ ok: true, outcome: 'returned', claimId: claim.claim.id });

    // One read before expiry; the retained board is then projected at later clocks.
    const board = readFleetBoard(options);
    expect(board).toMatchObject({ state: 'known', claims: [] });
    const retained = JSON.stringify(board);

    // Exact creation boundary: the observation equals the receipt's posted at.
    const created = projectCoordinationReturns(board, 1_000);
    expect(created.returns).toHaveLength(1);
    expect(created.returns[0]).toMatchObject({ claimId: claim.claim.id, temporal: 'current' });

    // Still current one ms before the stored expiry.
    expect(projectCoordinationReturns(board, 2_999).returns[0]?.temporal).toBe('current');

    // Exact expiry boundary: the [at, expiresAt) window has closed, so the
    // retained receipt reads as expired history, never silent absence.
    const boundary = projectCoordinationReturns(board, 3_000);
    expect(boundary).toMatchObject({ state: 'known', unparsed: 0, asOf: new Date(3_000).toISOString() });
    expect(boundary.returns).toEqual([expect.objectContaining({
      claimId: claim.claim.id, repo: REPO, result: 'VERIFIED', temporal: 'expired',
      at: new Date(1_000).toISOString(), expiresAt: new Date(3_000).toISOString(),
    })]);

    // Past expiry the row stays visible and stays explicitly qualified.
    expect(projectCoordinationReturns(board, 60_000).returns[0]?.temporal).toBe('expired');

    // The read board is untouched, serialized output carries the field, and no
    // lease material appears in either surface.
    expect(JSON.stringify(board)).toBe(retained);
    const parsed = JSON.parse(JSON.stringify(boundary)) as { returns: Array<{ temporal?: string }> };
    expect(parsed.returns[0]?.temporal).toBe('expired');
    const serialized = JSON.stringify(boundary);
    expect(serialized).not.toContain('lease');
    expect(serialized).not.toContain(claim.lease);
  });

  it('qualifies a clock-ahead receipt as future evidence beside a current neighbor', () => {
    const board = boardWith([
      receipt('posted-ahead', 5_000, 6_000),
      receipt('live', 1_000, 2_000),
    ]);
    const retained = JSON.stringify(board);
    const view = projectCoordinationReturns(board, 1_500);
    expect(view).toMatchObject({ state: 'known', unparsed: 0, asOf: new Date(1_500).toISOString() });
    // Newest-first ordering is untouched; each row carries its own qualification.
    expect(view.returns.map(row => row.claimId)).toEqual(['posted-ahead', 'live']);
    expect(view.returns[0]?.temporal).toBe('future');
    expect(view.returns[1]?.temporal).toBe('current');
    expect(JSON.stringify(board)).toBe(retained);
    const parsed = JSON.parse(JSON.stringify(view)) as { returns: Array<{ temporal?: string }> };
    expect(parsed.returns.map(row => row.temporal)).toEqual(['future', 'current']);
  });

  it.each([NaN, Infinity, -Infinity, 9e15, -9e15])(
    'never advertises current evidence under an unrenderable observation (%p)', (nowMs) => {
      const board = boardWith([receipt('live', 1_000, 2_000)]);
      expect(() => projectCoordinationReturns(board, nowMs)).not.toThrow();
      const view = projectCoordinationReturns(board, nowMs);
      expect(view).toMatchObject({ state: 'known', asOf: 'unknown', unparsed: 0 });
      expect(view.returns[0]?.temporal).toBe('invalid');
      expect(JSON.stringify(view)).toContain('"temporal":"invalid"');
    });

  it('still qualifies rows under a valid extreme observation at the Date-range edge', () => {
    const view = projectCoordinationReturns(boardWith([receipt('live', 1_000, 2_000)]), 8.64e15);
    expect(view.asOf).toBe(new Date(8.64e15).toISOString());
    expect(view.returns[0]?.temporal).toBe('expired');
  });

  it.each([
    ['posted at a finite time outside the Date range', receipt('bad-at', 9e15, 9.1e15), true],
    ['posted at NaN', receipt('nan-at', NaN, 2_000), true],
    ['expiring at a finite time outside the Date range', receipt('bad-expiry', 1_000, 9e15), false],
    ['a reversed lifetime', receipt('reversed', 2_000, 1_000), false],
    ['a zero-length lifetime', receipt('empty-window', 1_500, 1_500), false],
  ])('marks a receipt with %s as invalid beside surviving neighbors', (_label, message, atUnknown) => {
    const board = boardWith([message, receipt('live', 1_000, 2_000)]);
    const view = projectCoordinationReturns(board, 1_500);
    const row = view.returns.find(r => r.claimId === message.id.slice('return-'.length));
    const neighbor = view.returns.find(r => r.claimId === 'live');
    expect(row?.temporal).toBe('invalid');
    expect(row?.at === 'unknown').toBe(atUnknown);
    expect(neighbor?.temporal).toBe('current');
    expect(view.unparsed).toBe(0);
    expect(() => JSON.stringify(view)).not.toThrow();
  });

  it('keeps the unknown-board and empty-board paths free of qualified rows', () => {
    const missing = boardWith([]);
    missing.state = 'unknown';
    missing.expiredClaims = null;
    for (const board of [null, missing]) {
      expect(projectCoordinationReturns(board, 1_000))
        .toMatchObject({ state: 'unknown', returns: [], unparsed: 0 });
    }
    const empty = projectCoordinationReturns(boardWith([]), 1_000);
    expect(empty).toMatchObject({ state: 'known', returns: [], unparsed: 0 });
    expect(JSON.stringify(empty)).not.toContain('temporal');
  });
});
