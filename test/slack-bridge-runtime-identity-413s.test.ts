import { describe, expect, it } from 'vitest';
import { formatBridgeCheckReply } from '../src/core/fleet/bridge-check-reply.js';
import type { FleetBridgeCheck } from '../src/mcp/fleet-bridge-check.js';

const asOf = '2026-11-13T18:13:00.000Z';
const footer = 'Reachability only; this is not an assignment or claim.';
const check = (): FleetBridgeCheck => ({
  verdict: 'READY', asOf, missing: [],
  runtime: { status: 'ok', source: 'fleet-runtime', asOf, host: 'fake-runtime', stateRoot: '~/runs', lastFleetStateRead: { ageSeconds: 12 } },
  claims: { status: 'ok', source: 'coordination-ledger', asOf, state: 'known', live: 3, newestAgeSec: 45 },
  peers: { status: 'ok', source: 'peer-ledger', asOf },
});
const render = (value: FleetBridgeCheck, now = new Date(asOf)) => formatBridgeCheckReply(value, now);

describe('bridge runtime identity', () => {
  it.each(['READY', 'BLOCKED'] as const)('shows snapshot identity for %s', verdict => {
    const value = check();
    value.verdict = verdict;
    if (verdict === 'BLOCKED') value.missing = ['peers'];
    expect(render(value)).toContain('Runtime: ok · fleet-state age 12s · host fake-runtime · stateRoot ~/runs');
  });
  it('preserves the exact minimal reply when identity is absent', () => {
    const value = check();
    delete value.runtime['host'];
    delete value.runtime['stateRoot'];
    expect(render(value)).toBe(`Bridge: READY as of ${asOf}\nRuntime: ok · fleet-state age 12s\nClaims: 3 live, newest 45s\nPeers: ok\n${footer}`);
  });
  it('bounds and sanitizes oversized identity and missing evidence while retaining the footer', () => {
    const value = check();
    value.verdict = 'BLOCKED';
    value.missing = ['missing'.repeat(500)];
    value.runtime['host'] = `fake\n${'x'.repeat(1000)}`;
    value.runtime['stateRoot'] = `/Users/fake/${'y'.repeat(1000)}\u0000`;
    const reply = render(value);
    expect(reply.length).toBeLessThanOrEqual(600);
    expect(reply.split('\n').length).toBeLessThanOrEqual(6);
    expect(reply).toContain('host fake x');
    expect(reply).toContain('stateRoot ~/');
    expect(reply).not.toContain('/Users/fake');
    expect(reply).not.toContain('\u0000');
    expect(reply.endsWith(footer)).toBe(true);
  });
  it('keeps the snapshot time when rendered later', () => {
    expect(render(check(), new Date('2026-11-15T18:13:00.000Z'))).toContain(`as of ${asOf}`);
  });
});
