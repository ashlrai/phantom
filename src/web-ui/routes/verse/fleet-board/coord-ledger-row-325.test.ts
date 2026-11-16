/** RQ-PHX-COORDLEDGERROW325 — the 'Claims ledger' row of the coordination answer. Fake agents only. */
import { expect, it } from 'vitest';
import { deriveCoordAnswer, type CoordAnswerInput } from './coord-answer-model.js';
import type { CoordLedgerView } from './coordination-claims-query.js';

const NOW = Date.parse('2026-11-13T18:00:00Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const base: CoordAnswerInput = {
  runtime: { host: 'fake-host-a', installedVersion: '1.2.3', fleetState: { ageSeconds: 60, stale: false } } as never,
  channels: { available: true, channels: [{ channel: 'slack', state: 'LIVE', lastReplyAt: ago(60_000), missing: [] }] } as never,
  board: { inbox: 'ok', items: [], asOf: ago(1000) },
  now: NOW,
};
const claim = (agent: string) => ({ agent, repo: 'fake-repo', task: 'fake-task', expiresInSeconds: 600 });
const view = (agents: string[], over: Partial<CoordLedgerView> = {}): CoordLedgerView =>
  ({ state: 'known', generatedAt: ago(120_000), claims: agents.map(claim), expiredClaims: 0, ...over });
const ledgerRow = (input: CoordAnswerInput) => deriveCoordAnswer(input).rows.find((r) => r.label === 'Claims ledger');

it('puts the row right after Claims/work read', () => {
  const labels = deriveCoordAnswer({ ...base, ledger: view(['agent-alpha']) }).rows.map((r) => r.label);
  expect(labels.indexOf('Claims ledger')).toBe(labels.indexOf('Claims/work read') + 1);
});

it('undefined ledger is unknown with no missing reason', () => {
  expect(ledgerRow(base)).toEqual({ label: 'Claims ledger', value: 'unknown', ok: 'unknown' });
  expect(deriveCoordAnswer(base).missing.join()).not.toMatch(/ledger/);
});

it('null ledger is not on this build', () => {
  const a = deriveCoordAnswer({ ...base, ledger: null });
  expect(a.rows.find((r) => r.label === 'Claims ledger')).toMatchObject({ value: 'not on this build', ok: 'unknown' });
  expect(a.missing).toContain('claims ledger not available on this build');
});

it('unknown state is unreadable', () => {
  const a = deriveCoordAnswer({ ...base, ledger: view([], { state: 'unknown' }) });
  expect(a.rows.find((r) => r.label === 'Claims ledger')).toMatchObject({ value: 'ledger unreadable', ok: false });
  expect(a.missing).toContain('claims ledger unreadable');
});

it('lists live agents with the age of the read', () => {
  expect(ledgerRow({ ...base, ledger: view(['agent-alpha', 'agent-beta']) }))
    .toMatchObject({ value: '2 live · agents agent-alpha, agent-beta · as of 2m ago', ok: true });
});

it('truncates to 3 names then +k', () => {
  const r = ledgerRow({ ...base, ledger: view(['agent-a', 'agent-b', 'agent-c', 'agent-d', 'agent-e']) });
  expect(r?.value).toContain('5 live · agents agent-a, agent-b, agent-c +2 · as of');
});

it('zero claims is unknown with a missing reason', () => {
  const a = deriveCoordAnswer({ ...base, ledger: view([]) });
  expect(a.rows.find((r) => r.label === 'Claims ledger')).toMatchObject({ value: '0 live · as of 2m ago', ok: 'unknown' });
  expect(a.missing).toContain('no live coordination claim');
});

it('unparseable generatedAt prints a dash, not a fake age', () => {
  expect(ledgerRow({ ...base, ledger: view(['agent-alpha'], { generatedAt: null }) })?.value).toMatch(/as of —$/);
});

it('verdict is unchanged by the ledger alone', () => {
  const verdicts = [undefined, null, view([]), view(['agent-alpha']), view([], { state: 'unknown' })]
    .map((ledger) => deriveCoordAnswer({ ...base, ledger }).verdict);
  expect(new Set(verdicts)).toEqual(new Set(['REACHABLE']));
});
