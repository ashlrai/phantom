/** Local metadata fixtures only; no native process or provider request. */
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readResourceAccountLocalEpoch, recheckResourceAccountIdentitySnapshot } from '../src/core/resources/account-identity-witness.js';
import { createResourceReadingCache } from '../src/core/resources/reading-cache.js';
import type { ResourceAccountConnection } from '../src/core/resources/connection-types.js';
import type { ResourceConnectionConfig } from '../src/core/resources/connection-monitor.js';

const resolver = vi.hoisted(() => vi.fn());
vi.mock('../src/core/resources/native-profile.js', () => ({ resolveNativeSeatLaunch: resolver }));
const now = Date.parse('2026-01-01T00:00:00.000Z');
const account: ResourceConnectionConfig['accounts'][number] = {
  id: 'claude-fixture', label: 'Fixture', provider: 'claude', command: ['/inert/claude'],
};
let root: string;
let state: string;
beforeEach(() => {
  // Keep real I/O timers running so the deferred cache writer can finish.
  vi.spyOn(Date, 'now').mockReturnValue(now);
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-identity-expiry-')));
  state = join(root, 'native-state');
  mkdirSync(state, { mode: 0o700 });
  resolver.mockReset().mockReturnValue({ ok: true, launch: {
    provider: account.provider, seatId: account.id, nativeStatePath: state,
    command: account.command, executable: '/inert/claude',
  } });
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

it('preserves same-account history across expiry and settings replacement without renewing financial proof', async () => {
  const file = join(state, '.claude.json');
  const identity = { emailAddress: 'fixture@example.invalid', organizationUuid: 'fixture-org' };
  writeFileSync(file, JSON.stringify({ oauthAccount: identity, settings: 1 }), { mode: 0o600 });
  const epoch = readResourceAccountLocalEpoch(root, account)!;
  expect(epoch.accountDigest).toMatch(/^[a-f0-9]{64}$/);
  const row: ResourceAccountConnection = {
    id: account.id, label: account.label, provider: account.provider, state: 'observed',
    authentication: 'signed-in', health: 'reachable', planType: 'max',
    observedAt: new Date(now).toISOString(), expiresAt: new Date(now + 60_000).toISOString(),
    windows: [{ id: 'weekly', usedPercent: 7, resetsAt: null }], reason: 'probe-observed',
    onDemandEnabled: false, executionSupported: true,
  };
  const cache = createResourceReadingCache({ root, accountsRoot: root, accounts: [account], assertOwnership: () => {} });
  cache.remember(account, row, epoch.accountDigest!, epoch);
  await cache.flush();
  const snapshot = cache.identityWitnessesSnapshot()[0]!;
  expect(snapshot.localEpoch).toEqual(epoch);
  expect(recheckResourceAccountIdentitySnapshot(root, account, snapshot, now)).toEqual(snapshot.witness);
  vi.mocked(Date.now).mockReturnValue(now + 60_000);
  expect(recheckResourceAccountIdentitySnapshot(root, account, snapshot)).toBeNull();
  expect(cache.identityWitnessesSnapshot()).toEqual([]);

  const temporary = join(state, 'replacement.json');
  writeFileSync(temporary, JSON.stringify({ oauthAccount: identity, settings: 2 }), { mode: 0o600 });
  renameSync(temporary, file);
  const restarted = createResourceReadingCache({ root, accountsRoot: root, accounts: [account], assertOwnership: () => {} });
  expect(restarted.lastKnown(account)).toEqual({
    observedAt: row.observedAt, expiresAt: row.expiresAt, windows: row.windows,
    source: 'native-account-checked-history', identitySource: 'native-account-checked-display-identity',
  });
  expect(restarted.witness(account)).toBeNull();
  expect(restarted.identityWitnessesSnapshot()).toEqual([]);
  writeFileSync(file, JSON.stringify({ oauthAccount: { ...identity, organizationUuid: 'other-org' } }), { mode: 0o600 });
  expect(restarted.lastKnown(account)).toBeNull();
});
