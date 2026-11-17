import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetSurfaceOwner } from '../src/cli/fleet-surface-owner.js';
import { SURFACES, type SurfaceOwnerDeps } from '../src/core/fleet/surface-owner.js';

const NOW = Date.parse('2026-11-13T14:00:00.000Z');
const board: NonNullable<SurfaceOwnerDeps['board']> = () => ({
  schema: 'fleet.coordination.v1', state: 'known',
  claims: [{ id: 'fake-claim', repo: 'ashlrai/phantom', task: 'dot-handoff', agent: 'fake-agent', claimedAt: NOW - 1000, expiresAt: NOW + 60_000 }],
  messages: [], proposals: [], expiredClaims: 0,
});
let output: string[];
let errors: string[];
beforeEach(() => {
  output = []; errors = [];
  vi.spyOn(console, 'log').mockImplementation(value => { output.push(String(value)); });
  vi.spyOn(console, 'error').mockImplementation(value => { errors.push(String(value)); });
});
afterEach(() => { vi.restoreAllMocks(); });

const deps = (log: NonNullable<SurfaceOwnerDeps['log']>) => ({ board, log, now: () => NOW, historyBudgetMs: 30 });

describe('CLI surface history deadline', () => {
  it.each([false, true])('bounds stalled history and retains the live claim (json=%s)', async json => {
    const log = vi.fn(() => new Promise<never>(() => {}));
    const start = performance.now();
    expect(await cmdFleetSurfaceOwner(['dot-handoff', ...(json ? ['--json'] : [])], deps(log))).toBe(0);
    expect(performance.now() - start).toBeLessThan(1000);
    expect(log).toHaveBeenCalledTimes(SURFACES['dot-handoff']!.length);
    if (json) {
      expect(JSON.parse(output[0]!)).toMatchObject({ owner: 'fake-agent', ownerSource: 'advisory-claim', asOf: '2026-11-13T14:00:00.000Z', lastLanded: null, liveClaims: [{ id: 'fake-claim', agent: 'fake-agent' }] });
      expect(JSON.parse(output[0]!).reasons).toHaveLength(SURFACES['dot-handoff']!.length);
    } else {
      expect(output[0]).toContain('owner: fake-agent; source: advisory-claim');
      expect(output[0]).toContain('last landed: none in scanned paths');
      expect(output[0]).toContain('asOf: 2026-11-13T14:00:00.000Z');
      expect(output[0]).toContain('path history unreadable:');
    }
  });

  it.each([false, true])('does not expose reader failures (json=%s)', async json => {
    const log = async () => { throw new Error('private-looking-fake-error'); };
    expect(await cmdFleetSurfaceOwner(['dot-handoff', ...(json ? ['--json'] : [])], deps(log))).toBe(0);
    expect(output.join('') + errors.join('')).not.toContain('private-looking-fake-error');
    expect(output[0]).toContain('path history unreadable:');
  });

  it.each([false, true])('retains fast landed evidence (json=%s)', async json => {
    const log: NonNullable<SurfaceOwnerDeps['log']> = async path => path === SURFACES['dot-handoff']![0]
      ? [{ sha: 'abc1234', date: '2026-11-13T12:00:00.000Z', subject: 'bridge(RQ-PHX-FAKE1): fake work (#4242)', filesChanged: 1 }] : [];
    expect(await cmdFleetSurfaceOwner(['dot-handoff', ...(json ? ['--json'] : [])], deps(log))).toBe(0);
    expect(output[0]).toContain('RQ-PHX-FAKE1');
    if (json) expect(JSON.parse(output[0]!).lastLanded).toMatchObject({ jobId: 'RQ-PHX-FAKE1', pr: 4242 });
  });

  it('consumes a rejection after the deadline', async () => {
    let reject!: (error: Error) => void;
    const pending = new Promise<never>((_resolve, fail) => { reject = fail; });
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      expect(await cmdFleetSurfaceOwner(['dot-handoff', '--json'], deps(() => pending))).toBe(0);
      reject(new Error('private-looking-late-error'));
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(unhandled).not.toHaveBeenCalled();
      expect(output.join('') + errors.join('')).not.toContain('private-looking-late-error');
    } finally { process.off('unhandledRejection', unhandled); }
  });

  it('keeps an unknown board unknown even with landed history', async () => {
    const unknown: NonNullable<SurfaceOwnerDeps['board']> = () => ({ schema: 'fleet.coordination.v1', state: 'unknown', claims: [], messages: [], proposals: [], expiredClaims: null });
    const log: NonNullable<SurfaceOwnerDeps['log']> = async () => [{ sha: 'abc1234', date: '2026-11-13T12:00:00.000Z', subject: 'bridge(RQ-PHX-FAKE1): work (#4242)', filesChanged: 1 }];
    expect(await cmdFleetSurfaceOwner(['dot-handoff', '--json'], { ...deps(log), board: unknown })).toBe(0);
    expect(JSON.parse(output[0]!)).toMatchObject({ owner: 'UNKNOWN', ownerSource: 'none', lastLanded: { jobId: 'RQ-PHX-FAKE1' }, reasons: ['coordination ledger: missing or unreadable'] });
  });

  it('rejects malformed flags before readers and preserves help', async () => {
    const readBoard = vi.fn(board);
    const log = vi.fn(async () => []);
    for (const args of [['dot-handoff', '--bad'], ['dot-handoff', '--json', '--json'], ['unknown'], []]) {
      expect(await cmdFleetSurfaceOwner(args, { ...deps(log), board: readBoard })).toBe(2);
    }
    expect(await cmdFleetSurfaceOwner(['--help'], { ...deps(log), board: readBoard })).toBe(0);
    expect(output[0]).toContain('Usage: ashlr fleet surface-owner');
    expect(readBoard).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });
});
