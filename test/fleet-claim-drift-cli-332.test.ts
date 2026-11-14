/** RQ-PHX-CLAIMSTOREDRIFT332 — `ashlr fleet claim-drift` exit codes and
 * --json schema. Readers are faked through deps: nothing touches the real
 * home, ledger, bus or network. Fixtures are plainly fake. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetClaimDrift } from '../src/cli/fleet-claim-drift.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
import type { ClaimDriftDeps, ClaimDriftSource } from '../src/core/fleet/claim-store-drift.js';
import type { BusWorkClaimView } from '../src/core/fleet/bus-work-claims.js';
import type { CoordinationView } from '../src/core/agents/claim-store.js';

const NOW = Date.parse('2026-11-13T12:00:00.000Z');
const RECV = NOW - 60_000;
const LEASE = NOW + 600_000;

const busRow: BusWorkClaimView = {
  id: 'fake-request-1', cursor: 7, receivedAt: RECV, owner: 'agent-alpha',
  leaseUntil: LEASE, completedAt: null,
};
const coordRow: CoordinationView = {
  origin: 'message', key: 'queue:fake-request-1', owner: 'agent-alpha',
  leaseUntil: LEASE, sourceId: `fake-request-1:7:${RECV}`, live: true,
  repo: null, branch: null, path: null, started: null,
};

function deps(over: { bus?: BusWorkClaimView[]; coord?: CoordinationView[]; busSource?: ClaimDriftSource; coordSource?: ClaimDriftSource } = {}): ClaimDriftDeps {
  return {
    now: NOW,
    inspectBus: () => ({ source: over.busSource ?? 'available', claims: over.bus ?? [] }),
    listCoord: () => ({ source: over.coordSource ?? 'available', claims: over.coord ?? [], statuses: [] }),
  };
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...a) => { out.push(a.join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...a) => { err.push(a.join(' ')); });
  return { out, err };
}

afterEach(() => vi.restoreAllMocks());

describe('cmdFleetClaimDrift', () => {
  it('prints the verdict object with --json and exits 0 when verified', async () => {
    const { out } = capture();
    expect(await cmdFleetClaimDrift(['--json'], deps({ bus: [busRow], coord: [coordRow] }))).toBe(0);
    const parsed = JSON.parse(out.join('\n'));
    expect(parsed).toMatchObject({
      schema: 'fleet.claim-drift.v1', bus: 'available', coordination: 'available',
      matched: 1, busOnly: [], coordOnly: [], ownerMismatch: [], state: 'VERIFIED', missing: [],
    });
  });

  it('prints one line per drift row then a state line and exits 1 on DRIFT', async () => {
    const { out } = capture();
    expect(await cmdFleetClaimDrift([], deps({ bus: [busRow] }))).toBe(1);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatch(/^bus-only id=fake-request-1 cursor=7 received-at=\S+ lease-until=\S+ owner=agent-alpha$/);
    expect(out[1]).toBe('state: DRIFT');
  });

  it('names the unavailable source on the state line and exits 2 on UNKNOWN', async () => {
    const { out } = capture();
    expect(await cmdFleetClaimDrift([], deps({ busSource: 'unavailable' }))).toBe(2);
    expect(out).toEqual(['state: UNKNOWN missing=bus']);
  });

  it('exits 2 on bad arguments and prints nothing to stdout', async () => {
    const { out, err } = capture();
    for (const args of [['--bogus'], ['--json', '--json'], ['extra'], ['--json', 'tail']]) {
      expect(await cmdFleetClaimDrift(args, deps())).toBe(2);
    }
    expect(out).toEqual([]);
    expect(err.length).toBeGreaterThan(0);
  });

  it('--help prints usage and exits 0 without touching readers', async () => {
    const { out } = capture();
    const inspectBus = vi.fn(() => { throw new Error('must not be called'); });
    expect(await cmdFleetClaimDrift(['--help'], deps({ busSource: 'unavailable' }))).toBe(0);
    await cmdFleetClaimDrift(['-h'], { ...deps(), inspectBus });
    expect(out.join('\n')).toContain('Usage: ashlr fleet claim-drift');
    expect(inspectBus).not.toHaveBeenCalled();
  });

  it('flattens control characters in observed ids and owners', async () => {
    const { out } = capture();
    const evil = { ...busRow, id: 'fake\nrequest', owner: 'agent\u001B]8;;evil\u0007' };
    expect(await cmdFleetClaimDrift([], deps({ bus: [evil] }))).toBe(1);
    expect(out).toHaveLength(2);
    expect(out[0]).not.toContain('\u001B');
  });

  it('emits no 64-hex token anywhere in either output mode', async () => {
    const { out } = capture();
    await cmdFleetClaimDrift(['--json'], deps({ bus: [busRow], coord: [{ ...coordRow, owner: 'agent-beta' }] }));
    await cmdFleetClaimDrift([], deps({ bus: [busRow] }));
    expect(out.join('\n')).not.toMatch(/[a-f0-9]{64}/);
  });

  it('is registered for dispatch under the convention name', async () => {
    const mod = await FLEET_SUBCOMMAND_LOADERS['claim-drift']!();
    expect(mod.cmdFleetClaimDrift).toBe(cmdFleetClaimDrift);
  });
});
