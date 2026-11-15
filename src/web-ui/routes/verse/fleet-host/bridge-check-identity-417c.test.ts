import { expect, it } from 'vitest';
import { bridgeClaimsLine, bridgeRuntimeLine, parseBridgeCheck } from './bridge-check-model.js';

const sec = (extra: Record<string, unknown> = {}) => ({
  status: 'ok', source: 'fleet-runtime', asOf: '2026-11-15T12:00:00.000Z', ...extra,
});
const body = (over: Record<string, unknown> = {}, check: Record<string, unknown> = {}) => ({
  v: 1, authority: 'none',
  check: {
    verdict: 'READY', asOf: '2026-11-15T12:00:00.000Z', missing: [],
    runtime: sec({ host: 'mac-mini-test', stateRoot: '~/.ashlr-runs', lastFleetStateRead: { ageSeconds: 120 }, ...over }),
    claims: sec({ source: 'coordination-ledger', live: 3, newestAgeSec: 240 }),
    peers: sec({ source: 'peer-ledger' }), ...check,
  },
});

it('READY body yields runtime and claims lines', () => {
  const view = parseBridgeCheck(body())!;
  expect(view.verdict).toBe('READY');
  expect(bridgeRuntimeLine(view)).toBe('host mac-mini-test · stateRoot ~/.ashlr-runs · fleet-state age 2m');
  expect(bridgeClaimsLine(view)).toBe('3 live, newest 4m');
});
it('timed-out runtime reader shows host unknown and stays BLOCKED', () => {
  const view = parseBridgeCheck(body({}, {
    verdict: 'BLOCKED', missing: ['runtime'],
    runtime: sec({ status: 'unavailable', reason: 'runtime-reader-timeout' }),
  }))!;
  expect(view.verdict).toBe('BLOCKED');
  expect(bridgeRuntimeLine(view)).toBe('host unknown · stateRoot unknown · fleet-state age unknown');
});
it('sanitizes home paths, control characters, ANSI and length', () => {
  const v = (over: Record<string, unknown>) => parseBridgeCheck(body(over))!.runtimeIdentity;
  expect(v({ stateRoot: '/Users/someone/.ashlr-runs' }).stateRoot).toBe('~/.ashlr-runs');
  expect(v({ stateRoot: '/home/someone/.ashlr-runs' }).stateRoot).toBe('~/.ashlr-runs');
  expect(v({ host: 'mac\u0007-mini\n' }).host).toBe('mac-mini');
  expect(v({ host: '\u001b[31mred-host\u001b[0m' }).host).toBe('red-host');
  expect(v({ host: 'h'.repeat(200) }).host).toHaveLength(64);
  expect(v({ host: '  \u0001 ' }).host).toBeNull();
});
it('wrong-typed optional fields are unknown, not a shape failure', () => {
  const view = parseBridgeCheck(body({ host: 42, lastFleetStateRead: { ageSeconds: -5 } },
    { claims: sec({ live: -1, newestAgeSec: 'x' }) }))!;
  expect(view).not.toBeNull();
  expect(view.verdict).toBe('READY');
  expect(view.runtimeIdentity).toEqual({ host: null, stateRoot: '~/.ashlr-runs', fleetStateAgeSec: null });
  expect(bridgeClaimsLine(view)).toBe('claims unknown');
});
it('missing newest age prints unknown beside a known count', () => {
  const view = parseBridgeCheck(body({}, { claims: sec({ live: 0 }) }))!;
  expect(bridgeClaimsLine(view)).toBe('0 live, newest unknown');
});
