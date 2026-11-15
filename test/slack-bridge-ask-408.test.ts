import { describe, expect, it, vi } from 'vitest';
import { ownerStatusReply, OWNER_BRIDGE_FALLBACK } from '../src/core/agents/owner-status-reply.js';
import { isBridgeAsk } from '../src/core/fleet/bridge-ask.js';
import { isOwnersAsk } from '../src/core/fleet/owners-ask.js';
import { formatBridgeCheckReply } from '../src/core/fleet/bridge-check-reply.js';
import type { FleetBridgeCheck } from '../src/mcp/fleet-bridge-check.js';

const NOW = new Date('2026-11-15T06:00:00.000Z');
const FOOTER = 'Reachability only; this is not an assignment or claim.';
const check = (over: Partial<FleetBridgeCheck> = {}): FleetBridgeCheck => ({
  verdict: 'READY', asOf: NOW.toISOString(), missing: [],
  runtime: { status: 'ok', source: 'fleet-runtime', asOf: NOW.toISOString(), lastFleetStateRead: { ageSeconds: 12 } },
  claims: { status: 'ok', source: 'coordination-ledger', asOf: NOW.toISOString(), state: 'known', live: 3, newestAgeSec: 45 },
  peers: { status: 'ok', source: 'peer-ledger', asOf: NOW.toISOString() }, ...over,
});

function format(report: FleetBridgeCheck): string {
  const reply = formatBridgeCheckReply(report, NOW);
  expect(reply.length).toBeLessThanOrEqual(600);
  expect(reply.split('\n').length).toBeLessThanOrEqual(6);
  expect(reply.endsWith(FOOTER)).toBe(true);
  return reply;
}

describe('isBridgeAsk', () => {
  it.each(['bridge', 'bridge check', 'bridge status', 'can you reach the runtime', 'runtime reachable'])(
    'accepts %s with normalization', phrase => {
      expect(isBridgeAsk(phrase)).toBe(true);
      expect(isBridgeAsk(`  ${phrase.toUpperCase()}?  `)).toBe(true);
    });
  it.each(['who owns the bridge', 'bridge owner', 'bridge check for PR #12 please', 'status', '', `bridge${'?'.repeat(35)}`])(
    'rejects %s', phrase => expect(isBridgeAsk(phrase)).toBe(false));
  it.each(['owner', 'owners', 'who owns', 'who owns the bridge', 'bridge owner', 'bridge owners', "who's the owner", 'who is the owner', 'Who’s the owner?!'])(
    'preserves owners ask %s', phrase => {
      expect(isOwnersAsk(phrase)).toBe(true);
      expect(isBridgeAsk(phrase)).toBe(false);
    });
});

describe('formatBridgeCheckReply', () => {
  it('shows snapshot evidence for READY', () => {
    expect(format(check())).toBe([
      `Bridge: READY as of ${NOW.toISOString()}`, 'Runtime: ok · fleet-state age 12s',
      'Claims: 3 live, newest 45s', 'Peers: ok', FOOTER,
    ].join('\n'));
  });
  it('names the missing bridge parts for BLOCKED', () => {
    expect(format(check({ verdict: 'BLOCKED', missing: ['runtime.fleet-state-stale', 'claims'] })))
      .toContain(`Bridge: BLOCKED as of ${NOW.toISOString()} · missing runtime.fleet-state-stale, claims`);
  });
  it('retains unknown counts and ages without inventing numbers', () => {
    const report = check();
    report.claims.live = null;
    report.claims.newestAgeSec = null;
    delete report.runtime['lastFleetStateRead'];
    expect(format(report)).toContain('Claims: unknown');
    expect(format(report)).toContain('Runtime: ok\n');
    report.claims.live = 0;
    report.runtime['lastFleetStateRead'] = { ageSeconds: null };
    expect(format(report)).toContain('Claims: 0 live, newest unknown');
    expect(format(report)).toContain('fleet-state age unknown');
  });
  it('bounds oversized evidence and removes control characters and home paths', () => {
    const report = check({ verdict: 'BLOCKED', missing: ['x'.repeat(2000)] });
    report.peers.status = '\u001b[31m/Users/fake/private\nextra';
    const reply = format(report);
    expect(reply).not.toContain(String.fromCharCode(27));
    expect(reply).not.toMatch(/\[31m|\/Users\/fake/);
  });
});

describe('ownerStatusReply bridge routing', () => {
  it('routes the exact ask to the injected bridge composer', async () => {
    const bridge = vi.fn(async () => 'fake bridge evidence');
    const reply = ownerStatusReply({ bridge });
    expect(reply.ask('bridge?')).toBe(true);
    expect(await reply.compose('/fake-runs', NOW, 'bridge?')).toBe('fake bridge evidence');
    expect(bridge).toHaveBeenCalledExactlyOnceWith(NOW);
  });
  it('uses the fixed fallback when the bridge composer throws', async () => {
    expect(await ownerStatusReply({ bridge: async () => { throw new Error('private failure'); } })
      .compose('/fake-runs', NOW, 'bridge?')).toBe(OWNER_BRIDGE_FALLBACK);
  });
  it('retains owners routing for who owns the bridge', async () => {
    const owners = vi.fn(async () => 'fake owners evidence');
    const bridge = vi.fn(async () => 'wrong route');
    expect(await ownerStatusReply({ owners, bridge }).compose('/fake-runs', NOW, 'who owns the bridge')).toBe('fake owners evidence');
    expect(owners).toHaveBeenCalledExactlyOnceWith(NOW);
    expect(bridge).not.toHaveBeenCalled();
  });
});
