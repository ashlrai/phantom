import { afterEach, expect, it, vi } from 'vitest';
import type { SurfaceOwnerDeps } from '../src/core/fleet/surface-owner.js';
import { parseFleetSurfaceOwnerArgs, readFleetSurfaceOwner, SURFACE_OWNER_READ_DEADLINE_MS } from '../src/mcp/fleet-surface-owner.js';

const NOW = Date.parse('2026-11-13T14:00:00Z');
const deps: SurfaceOwnerDeps = {
  now: () => NOW,
  board: () => ({ schema: 'fleet.coordination.v1', state: 'known', messages: [], proposals: [], expiredClaims: 0,
    claims: [{ id: 'synthetic-claim', agent: 'synthetic-agent', repo: 'ashlrai/phantom', task: 'slack-bridge',
      claimedAt: NOW - 1000, expiresAt: NOW + 60_000 }] }),
  log: async () => [{ sha: 'abc1234', date: '2026-11-13T12:00:00Z',
    subject: 'bridge(RQ-PHX-SYNTHETIC): synthetic (#1)', filesChanged: 1 }],
};
afterEach(() => vi.useRealTimers());

it('bounds the default deadline, discards partial claims and permits an immediate fresh read', async () => {
  vi.useFakeTimers();
  const pending = readFleetSurfaceOwner('slack-bridge', { ...deps, log: () => new Promise(() => {}) });
  await vi.advanceTimersByTimeAsync(SURFACE_OWNER_READ_DEADLINE_MS - 1);
  const settled = vi.fn();
  void pending.then(settled);
  expect(settled).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(await pending).toMatchObject({ schemaVersion: 1, authority: 'none', surface: 'slack-bridge',
    asOf: new Date(NOW).toISOString(), owner: 'UNKNOWN', ownerSource: 'none', liveClaims: [],
    lastLanded: null, scannedPaths: [], reasons: ['surface owner: read deadline exceeded'] });
  expect((await pending)?.note).toContain('Claims are advisory only');
  expect(await readFleetSurfaceOwner('slack-bridge', deps)).toMatchObject({ owner: 'synthetic-agent',
    ownerSource: 'advisory-claim', liveClaims: [{ id: 'synthetic-claim' }],
    lastLanded: { jobId: 'RQ-PHX-SYNTHETIC', pr: 1 }, reasons: [] });
  expect(vi.getTimerCount()).toBe(0);
});

it('consumes late rejection after an optional short test deadline', async () => {
  vi.useFakeTimers();
  let reject!: (reason: Error) => void;
  const log = new Promise<never>((_, fail) => { reject = fail; });
  const pending = readFleetSurfaceOwner('slack-bridge', { ...deps, log: () => log }, 10);
  await vi.advanceTimersByTimeAsync(10);
  const report = await pending;
  reject(new Error('synthetic private failure'));
  await vi.advanceTimersByTimeAsync(0);
  expect(JSON.stringify(report)).not.toContain('synthetic private failure');
  expect(report?.owner).toBe('UNKNOWN');
  expect(vi.getTimerCount()).toBe(0);
});

it.each(['throw', 'invalid'] as const)('sanitizes reader failure with a %s clock and safe timestamp', async mode => {
  vi.useFakeTimers();
  const report = await readFleetSurfaceOwner('slack-bridge', { ...deps, now: () => {
    if (mode === 'throw') throw new Error('synthetic private failure');
    return NaN;
  } });
  expect(report).toMatchObject({ authority: 'none', owner: 'UNKNOWN', ownerSource: 'none',
    liveClaims: [], lastLanded: null, scannedPaths: [], reasons: ['surface owner: reader failed'] });
  expect(Number.isFinite(Date.parse(report!.asOf))).toBe(true);
  expect(JSON.stringify(report)).not.toContain('synthetic private failure');
  expect(vi.getTimerCount()).toBe(0);
});

it('preserves shared-reader degradation for rejecting board and log without leaking errors', async () => {
  const report = await readFleetSurfaceOwner('slack-bridge', { ...deps,
    board: () => { throw new Error('synthetic private board'); },
    log: async () => { throw new Error('synthetic private log'); } });
  expect(report).toMatchObject({ authority: 'none', owner: 'UNKNOWN', liveClaims: [], lastLanded: null });
  expect(JSON.stringify(report)).not.toContain('synthetic private');
  expect(report?.reasons).toContain('coordination ledger: missing or unreadable');
});

it('keeps unknown surfaces null without reads and rejects caller deadline arguments', async () => {
  const board = vi.fn(deps.board!);
  const log = vi.fn(deps.log!);
  for (const surface of ['unknown', 'toString', '__proto__']) {
    expect(await readFleetSurfaceOwner(surface, { ...deps, board, log })).toBeNull();
  }
  expect(board).not.toHaveBeenCalled();
  expect(log).not.toHaveBeenCalled();
  expect(parseFleetSurfaceOwnerArgs({ surface: 'slack-bridge', deadlineMs: 1 })).toBeNull();
});
