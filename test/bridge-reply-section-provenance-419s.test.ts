import { describe, expect, it } from 'vitest';
import { formatBridgeCheckReply } from '../src/core/fleet/bridge-check-reply.js';
import type { FleetBridgeCheck } from '../src/mcp/fleet-bridge-check.js';

const CHECK_AS_OF = '2026-11-15T10:00:00.000Z';
const REPLY_CLOCK = new Date('2026-11-15T12:30:00.000Z');
const FOOTER = 'Reachability only; this is not an assignment or claim.';

const check = (): FleetBridgeCheck => ({
  verdict: 'READY', asOf: CHECK_AS_OF, missing: [],
  runtime: { status: 'ok', source: 'fleet-runtime', asOf: '2026-11-15T09:58:11.000Z', lastFleetStateRead: { ageSeconds: 12 } },
  claims: { status: 'ok', source: 'coordination-ledger', asOf: '2026-11-15T09:57:40.000Z', state: 'known', live: 3, newestAgeSec: 45 },
  peers: { status: 'ok', source: 'peer-ledger', asOf: '2026-11-15T09:59:02.000Z' },
});

const render = (value: FleetBridgeCheck, now: Date = REPLY_CLOCK) => formatBridgeCheckReply(value, now);

describe('formatBridgeCheckReply section provenance', () => {
  it('attributes each section to its own source and observation time, not the reply clock', () => {
    const reply = render(check());
    expect(reply).toContain('Runtime: ok · fleet-state age 12s [fleet-runtime 2026-11-15T09:58:11.000Z]');
    expect(reply).toContain('Claims: 3 live, newest 45s [coordination-ledger 2026-11-15T09:57:40.000Z]');
    expect(reply).toContain('Peers: ok [peer-ledger 2026-11-15T09:59:02.000Z]');
    expect(reply).toContain(`Bridge: READY as of ${CHECK_AS_OF}`);
    // A later reply clock never refreshes the producer stamps.
    expect(render(check(), new Date('2026-11-16T00:00:00.000Z'))).toBe(reply);
  });

  it('keeps the ordinary compact reply when every section matches the check stamp', () => {
    const value = check();
    for (const section of [value.runtime, value.claims, value.peers]) section.asOf = CHECK_AS_OF;
    expect(render(value)).toBe([
      `Bridge: READY as of ${CHECK_AS_OF}`, 'Runtime: ok · fleet-state age 12s',
      'Claims: 3 live, newest 45s', 'Peers: ok', FOOTER,
    ].join('\n'));
  });

  it('shows provenance when only the source differs from the default', () => {
    const value = check();
    for (const section of [value.runtime, value.claims, value.peers]) section.asOf = CHECK_AS_OF;
    value.runtime.source = 'runtime-snapshot-v2';
    const reply = render(value);
    expect(reply).toContain(`Runtime: ok · fleet-state age 12s [runtime-snapshot-v2 ${CHECK_AS_OF}]`);
    expect(reply).not.toContain('[fleet-runtime');
    expect(reply).not.toContain('[coordination-ledger');
    expect(reply).not.toContain('[peer-ledger');
  });

  it('sanitizes control characters and private home prefixes in provenance without throwing', () => {
    const value = check();
    value.peers.source = 'peer\u0007-ledger/Users/fake/private';
    value.peers.asOf = `2026-11-15T09:59:02.000Z\u001b[31m/home/fake/x`;
    const reply = render(value);
    expect(reply.length).toBeLessThanOrEqual(600);
    expect(reply).not.toContain('\u0007');
    expect(reply).not.toContain('\u001b');
    expect(reply).not.toContain('/Users/fake');
    expect(reply).not.toContain('/home/fake');
    expect(reply.endsWith(FOOTER)).toBe(true);
  });

  it('treats malformed provenance as absent instead of throwing or leaking raw content', () => {
    const value = check();
    value.runtime.source = 42 as unknown as string;
    value.runtime.asOf = CHECK_AS_OF;
    value.claims.asOf = null as unknown as string;
    const reply = render(value);
    expect(reply).toContain('Runtime: ok · fleet-state age 12s\n');
    expect(reply).toContain('Claims: 3 live, newest 45s\n');
    expect(reply).toContain('Peers: ok [peer-ledger 2026-11-15T09:59:02.000Z]');
  });

  it('keeps BLOCKED missing evidence, status lines and the footer inside the bound with long labels', () => {
    const value = check();
    value.verdict = 'BLOCKED';
    value.missing = ['runtime.fleet-state-stale', 'claims-reader-timeout'];
    value.runtime.source = `src-${'r'.repeat(400)}`;
    value.claims.source = `claims-${'c'.repeat(400)}`;
    value.peers.source = `peer-${'p'.repeat(400)}`;
    value.peers.asOf = `2026-11-15T09:59:02.000Z-${'t'.repeat(200)}`;
    const reply = render(value);
    expect(reply.length).toBeLessThanOrEqual(600);
    expect(reply).toContain('Bridge: BLOCKED as of ' + CHECK_AS_OF);
    expect(reply).toContain('missing runtime.fleet-state-stale, claims-reader-timeout');
    expect(reply).toContain('Runtime: ok');
    expect(reply).toContain('Claims: 3 live');
    expect(reply).toContain('Peers: ok');
    expect(reply.endsWith(FOOTER)).toBe(true);
    expect(reply).not.toContain('r'.repeat(100));
  });
});
