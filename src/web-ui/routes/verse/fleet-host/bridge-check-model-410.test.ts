import type { IncomingMessage, ServerResponse } from 'node:http';
import { expect, it } from 'vitest';
import type { VerseApiContext } from '../../../../core/verse/verse-api.js';
import { createFleetBridgeCheckApi, VERSE_FLEET_BRIDGE_CHECK_PATH } from '../../../../core/verse/fleet-bridge-check-api.js';
import { bridgeCheckAsOf, bridgeCheckHeadline, parseBridgeCheck } from './bridge-check-model.js';

const section = (extra: Record<string, unknown> = {}) => ({
  status: 'ok', source: 'fleet-runtime', asOf: '2026-11-15T12:00:00.000Z', ...extra,
});
export const readyCheck = () => ({
  verdict: 'READY', asOf: '2026-11-15T12:00:05.000Z', missing: [],
  runtime: section(), claims: section({ source: 'coordination-ledger', asOf: '2026-11-15T11:59:00.000Z' }),
  peers: section({ status: 'empty', source: 'peer-ledger' }),
});
const env = (check: unknown) => ({ v: 1, authority: 'none', check });

it('READY when every section reads cleanly; as-of is the oldest section', () => {
  const view = parseBridgeCheck(env(readyCheck()));
  expect(view).not.toBeNull();
  expect(bridgeCheckHeadline(view!)).toBe('Bridge: READY');
  expect(bridgeCheckAsOf(view!)).toBe('as of 2026-11-15T11:59:00.000Z');
  expect(view!.sections.map(s => s.name)).toEqual(['runtime', 'claims', 'peers']);
});
it('BLOCKED names the first failing section and its reason', () => {
  const check = { ...readyCheck(), verdict: 'BLOCKED', missing: ['claims', 'peers'],
    claims: section({ status: 'unavailable', reason: 'claims-reader-failed' }),
    peers: section({ status: 'unavailable', reason: 'peers-reader-failed' }) };
  expect(bridgeCheckHeadline(parseBridgeCheck(env(check))!)).toBe('Bridge: BLOCKED (claims: claims-reader-failed)');
});
it('BLOCKED falls back to the status when a section has no reason', () => {
  const check = { ...readyCheck(), verdict: 'BLOCKED', missing: ['peers'], peers: section({ status: 'unavailable' }) };
  expect(bridgeCheckHeadline(parseBridgeCheck(env(check))!)).toBe('Bridge: BLOCKED (peers: unavailable)');
});
it('parses the reader-failed envelope as BLOCKED', () => {
  const failed = { verdict: 'BLOCKED', asOf: '2026-11-15T12:00:00.000Z', missing: ['bridge-check'], reason: 'bridge-check-reader-failed' };
  const view = parseBridgeCheck(env(failed))!;
  expect(bridgeCheckHeadline(view)).toBe('Bridge: BLOCKED (bridge-check: bridge-check-reader-failed)');
  expect(bridgeCheckAsOf(view)).toBe('as of 2026-11-15T12:00:00.000Z');
});
it('never infers READY from missing or unhealthy data', () => {
  const { peers: _peers, ...noPeers } = readyCheck();
  expect(parseBridgeCheck(env(noPeers))).toBeNull();
  expect(parseBridgeCheck(env({ ...readyCheck(), missing: ['claims'] }))).toBeNull();
  expect(parseBridgeCheck(env({ ...readyCheck(), claims: section({ status: 'unavailable' }) }))).toBeNull();
  expect(parseBridgeCheck(env({ ...readyCheck(), runtime: section({ reason: 'fleet-state-stale' }) }))).toBeNull();
});
it('returns null on malformed bodies', () => {
  for (const bad of [null, 'x', [], {}, env(null), env({}), { v: 2, authority: 'none', check: readyCheck() },
    { v: 1, authority: 'write', check: readyCheck() }, env({ ...readyCheck(), verdict: 'MAYBE' }),
    env({ ...readyCheck(), missing: 'none' }), env({ ...readyCheck(), asOf: 5 }),
    env({ ...readyCheck(), runtime: 'ok' }), env({ ...readyCheck(), runtime: section({ source: 3 }) })]) {
    expect(parseBridgeCheck(bad)).toBeNull();
  }
});
it('unparseable timestamps stay unknown', () => {
  const check = { verdict: 'BLOCKED', asOf: 'garbage', missing: ['bridge-check'] };
  const view = parseBridgeCheck(env(check))!;
  expect(bridgeCheckAsOf(view)).toBe('as of unknown');
  expect(bridgeCheckHeadline(view)).toBe('Bridge: BLOCKED (bridge-check: unknown)');
});

/** Body produced by the real server route, so client and server shapes cannot drift. */
export async function serverBody(read: () => unknown): Promise<unknown> {
  let text = '';
  const res = { writeHead() { return this; }, end(b: string) { text = b; } } as unknown as ServerResponse;
  const api = createFleetBridgeCheckApi({ read, now: () => new Date('2026-11-15T12:00:00.000Z') });
  await api({} as VerseApiContext, { url: VERSE_FLEET_BRIDGE_CHECK_PATH } as IncomingMessage, res, VERSE_FLEET_BRIDGE_CHECK_PATH, 'GET');
  return JSON.parse(text);
}
it('parses bodies from the real createFleetBridgeCheckApi', async () => {
  expect(bridgeCheckHeadline(parseBridgeCheck(await serverBody(async () => readyCheck()))!)).toBe('Bridge: READY');
  const failed = await serverBody(() => { throw new Error('boom'); });
  expect(bridgeCheckHeadline(parseBridgeCheck(failed)!)).toBe('Bridge: BLOCKED (bridge-check: bridge-check-reader-failed)');
});
