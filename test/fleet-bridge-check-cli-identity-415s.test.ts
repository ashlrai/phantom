import { hostname } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetBridgeCheck } from '../src/cli/fleet-bridge-check.js';
import type { FleetBridgeCheckDeps } from '../src/mcp/fleet-bridge-check.js';

// Caller clock is later than every producer timestamp: output keeps the producer's own source/asOf.
const NOW = Date.parse('2026-11-15T12:00:00.000Z');
const PRODUCER_AS_OF = '2026-11-13T13:13:00.000Z';
const CHECK_AS_OF = '2026-11-15T12:00:00.000Z';

function fixture(overrides: FleetBridgeCheckDeps = {}): FleetBridgeCheckDeps {
  return {
    runtime: async () => ({ host: 'fake-rt-415s', stateRoot: '~/.ashlr-runs', asOf: PRODUCER_AS_OF,
      lastFleetStateRead: { ageSeconds: 5 } }),
    claims: () => ({ state: 'known', claims: [{ id: 'claim-415s', repo: 'fake/repo', task: 'fake-task', agent: 'fake-agent',
      claimedAt: '2026-11-15T11:59:00.000Z', expiresAt: '2026-11-15T12:05:00.000Z', expiresInSeconds: 300 }] }),
    peers: () => ({ status: 'ok', asOf: PRODUCER_AS_OF }), now: () => NOW, ...overrides,
  };
}

function capture() {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  return { log, text: () => log.mock.calls.flat().join('\n') };
}

afterEach(() => vi.restoreAllMocks());

describe('fleet bridge-check CLI runtime identity (415s)', () => {
  it('prints producer host/stateRoot and per-section evidence, exit 0', async () => {
    const out = capture();
    expect(await cmdFleetBridgeCheck([], fixture())).toBe(0);
    const text = out.text();
    expect(text).toContain('runtime: ok · host fake-rt-415s · stateRoot ~/.ashlr-runs');
    expect(text).toContain(`[fleet-runtime ${PRODUCER_AS_OF}]`);
    expect(text).toContain(`[peer-ledger ${PRODUCER_AS_OF}]`);
    expect(text).toContain(`as of ${CHECK_AS_OF}`);
    expect(text).toContain('Reachability only; grants no claim, dispatch or merge authority.');
    expect(text).not.toContain(hostname());
  });

  it('keeps producer timestamps under a later caller clock and exits 3 when BLOCKED', async () => {
    const out = capture();
    expect(await cmdFleetBridgeCheck([], fixture({
      peers: () => ({ status: 'unavailable', asOf: PRODUCER_AS_OF }) }))).toBe(3);
    const text = out.text();
    expect(text).toContain('Bridge: BLOCKED (missing: peers)');
    expect(text).toContain(`[peer-ledger ${PRODUCER_AS_OF}]`);
    expect(text).toContain(`as of ${CHECK_AS_OF}`);
  });

  it('reports absent identity fields as unknown and never substitutes the CLI host', async () => {
    const out = capture();
    const rt = async () => ({ host: 'fake-only-host', lastFleetStateRead: { ageSeconds: 1 } });
    expect(await cmdFleetBridgeCheck([], fixture({ runtime: rt }))).toBe(0);
    expect(out.text()).toContain('host fake-only-host · stateRoot unknown');
    expect(out.text()).not.toContain(hostname());
  });

  it('sanitizes controls, home segments, IPs and hostile plain text; output stays bounded', async () => {
    const out = capture();
    const nasty = `\u001b[31mfake\n/Users/masonwyatt/secret 10.0.0.1 ${'x'.repeat(500)}`;
    const rt = async () => ({ host: nasty, stateRoot: `/Users/masonwyatt/runs\u0000`,
      lastFleetStateRead: { ageSeconds: 1 } });
    expect(await cmdFleetBridgeCheck([], fixture({ runtime: rt }))).toBe(0);
    const text = out.text();
    for (const bad of ['\u001b', 'masonwyatt', '10.0.0.1', '\u0000', 'x'.repeat(100)]) {
      expect(text).not.toContain(bad);
    }
    expect(text.length).toBeLessThan(2000);
  });

  it('preserves the single-line JSON contract', async () => {
    const out = capture();
    expect(await cmdFleetBridgeCheck(['--json'], fixture())).toBe(0);
    expect(out.log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(out.text())).toMatchObject({ verdict: 'READY', asOf: CHECK_AS_OF,
      runtime: { host: 'fake-rt-415s', stateRoot: '~/.ashlr-runs', asOf: PRODUCER_AS_OF } });
  });
});
