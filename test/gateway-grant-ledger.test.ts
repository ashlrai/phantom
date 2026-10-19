/**
 * Governed-client gateway slice B: the claude-api grant ledger accepts an
 * optional, exact `gateway: { via: 'gateway', host }` marker on a row and
 * refuses any other shape, so the ledger can never carry a key, URL or path.
 * First-party rows are unchanged. Hermetic: temp ledger dir, no network.
 */
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FreshClaudeApiGrantProof } from '../src/core/resources/claude-api-grant-types.js';
import { createClaudeApiGrantAdmission, reserveClaudeApiGrantRequest, CLAUDE_API_GRANT_LEDGER_FILE } from '../src/core/resources/claude-api-grant.js';
import type { ClaudeApiGrantAdmission } from '../src/core/resources/claude-api-grant-types.js';

let root: string; let admission: ClaudeApiGrantAdmission; let readFreshProof: () => FreshClaudeApiGrantProof;
const pricingDigest = 'e'.repeat(64);
const file = () => join(root, CLAUDE_API_GRANT_LEDGER_FILE);
const rows = (): Array<Record<string, unknown>> => JSON.parse(readFileSync(file(), 'utf8')).rows;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'gateway-grant-ledger-'))); chmodSync(root, 0o700);
  const now = Date.now(); const stamp = new Date(now).toISOString();
  const proof: FreshClaudeApiGrantProof = { observation: { v: 1, kind: 'claude-api-promotion', observationId: 'observation-one', cycleId: 'cycle-one',
    binding: { organizationDigest: 'a'.repeat(64), workspaceDigest: 'b'.repeat(64), credentialDigest: createHash('sha256').update('k').digest('hex'), generation: 'generation-one' },
    remainingUsdMicros: '10000000', totalUsdMicros: '10000000', capturedAt: stamp,
    expiry: { precision: 'date', date: new Date(now + 86_400_000).toISOString().slice(0, 10), timezone: 'UTC', instant: null }, evidenceDigest: 'c'.repeat(64) },
    observedAt: stamp, validUntil: new Date(now + 60_000).toISOString(),
    funding: { source: 'verified-provider-billing', prepaid: true, invoiced: false, autoReload: 'off', purchasedUsdMicros: '0', otherPaidFunding: false },
    authority: { active: true, stop: false, localOnly: false, engineEnabled: true, repoAuthorized: true, roleAuthorized: true, meteredCeilingUsdMicros: '10000000', dailyRemainingUsdMicros: '10000000', identityDigest: 'd'.repeat(64) } };
  readFreshProof = () => structuredClone(proof);
  const created = createClaudeApiGrantAdmission({ expectedBinding: proof.observation.binding, readFreshProof });
  if (!created.ok) throw new Error(created.reason);
  admission = created.value;
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const reserve = (requestId: string, gateway?: unknown) => reserveClaudeApiGrantRequest({
  root, admission, requestId, maxUsdMicros: '100', pricingDigest, readFreshProof,
  ...(gateway === undefined ? {} : { gateway: gateway as { via: 'gateway'; host: string } }),
});

describe('grant ledger gateway marker', () => {
  it('first-party rows carry no gateway key', () => {
    expect(reserve('first-party-one').ok).toBe(true);
    expect(rows()[0]).not.toHaveProperty('gateway');
  });

  it('gateway rows carry exactly via and host, and the ledger reloads', () => {
    expect(reserve('gateway-one', { via: 'gateway', host: 'gw.example.com' }).ok).toBe(true);
    expect(reserve('gateway-two', { via: 'gateway', host: '[::1]' }).ok).toBe(true);
    expect(rows().map(row => row.gateway)).toEqual([{ via: 'gateway', host: 'gw.example.com' }, { via: 'gateway', host: '[::1]' }]);
  });

  it.each([
    ['extra url key', { via: 'gateway', host: 'gw.example.com', url: 'https://gw.example.com/x' }],
    ['host with path', { via: 'gateway', host: 'gw.example.com/x' }],
    ['host with port', { via: 'gateway', host: 'gw.example.com:443' }],
    ['host with userinfo', { via: 'gateway', host: 'user:pw@gw.example.com' }],
    ['wrong via', { via: 'proxy', host: 'gw.example.com' }],
    ['missing host', { via: 'gateway' }],
  ])('refuses a %s marker at reserve', (_label, gateway) => {
    expect(reserve('bad-one', gateway)).toEqual({ ok: false, reason: 'reservation-invalid' });
  });

  it('a tampered on-disk marker makes the ledger unavailable (fails closed)', () => {
    expect(reserve('gateway-one', { via: 'gateway', host: 'gw.example.com' }).ok).toBe(true);
    const ledger = JSON.parse(readFileSync(file(), 'utf8'));
    ledger.rows[0].gateway = { via: 'gateway', host: 'gw.example.com', key: 'sk-leak' };
    writeFileSync(file(), JSON.stringify(ledger), { mode: 0o600 });
    expect(reserve('next-one')).toEqual({ ok: false, reason: 'store-unavailable' });
  });
});
