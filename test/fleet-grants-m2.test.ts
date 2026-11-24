import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkGrant, grantSchema, revocationSchema } from '../src/core/fleet/grants.js';

const issuer = 'own_' + 'a'.repeat(32), aud = 'own_' + 'b'.repeat(32), kid = 'kid_' + 'c'.repeat(32);
const grant = () => ({
  v: 1, ctx: 'phantom.fleet.grant.v1', kind: 'fleet.grant', id: 'grt_' + 'd'.repeat(32),
  issuer, aud, kid, nonce: 'A'.repeat(22), grantee: { owner: aud, agents: ['reviewer'] },
  scope: [{ verb: 'roster.view' }], limits: { maxMessagesPerHour: 120, spend: 'none', egress: 'none' },
  issuedAt: 100, nbf: 100, exp: 200, alg: 'ES256',
  signature: { alg: 'ES256', kid, backend: 'tpm', sig: 'A'.repeat(86) },
});
afterEach(() => vi.unstubAllEnvs());

describe('M2-1 deny-only cross-owner grants', () => {
  it.each([
    ['malformed', null], ['unknown verb', { ...grant(), scope: [{ verb: 'tool.use' }] }],
    ['expired', { ...grant(), issuedAt: 1, nbf: 1, exp: 2 }], ['not yet valid', { ...grant(), nbf: 9_999_999_999, exp: 9_999_999_999 + 1 }],
    ['fully validly shaped', { ...grant(), exp: 9_999_999_999 }],
  ])('M2-1 denies %s input', (_name, input) => {
    if (['expired', 'not yet valid', 'fully validly shaped'].includes(_name)) expect(grantSchema.safeParse(input).success).toBe(true);
    expect(checkGrant(input)).toEqual({ decision: 'deny', reason: 'cross-owner-disabled-m2' });
  });
  it('M2-1 environment, configuration, CLI flags and request parameters cannot enable grants', () => {
    vi.stubEnv('PHANTOM_FLEET_GRANTS', '1');
    vi.stubEnv('PHM_FLEET_GRANTS_ENABLED', 'true');
    const input = { grant: grant(), principal: aud, localPrincipal: issuer,
      fleet: { grants: { enabled: true } }, flags: ['--enable-grants', '--allow-cross-owner'], allow: true };
    expect(checkGrant(input).decision).toBe('deny');
    expect(checkGrant(grant()).decision).toBe('deny');
  });
  it('M2-1 source has one unconditional deny return and no cross-owner allow branch', () => {
    const source = readFileSync(new URL('../src/core/fleet/grants.ts', import.meta.url), 'utf8');
    const implementation = source.slice(source.indexOf('export function checkGrant'));
    expect(implementation.match(/\breturn\b/g)).toHaveLength(1);
    expect(implementation).not.toMatch(/\b(?:if|switch|process|config|allow)\b|\?/);
    expect(implementation).toContain("return { decision: 'deny'");
  });
  it('M2-1 strictly validates grant data without treating shape as verified authority', () => {
    expect(grantSchema.safeParse(grant()).success).toBe(true);
    for (const input of [{ ...grant(), enabled: true }, { ...grant(), nbf: 1.5 },
      { ...grant(), alg: 'none' }, { ...grant(), aud: issuer }, { ...grant(), nonce: 'short' },
      { ...grant(), issuer: issuer + '\n' }, { ...grant(), kid: kid + '\n' },
      { ...grant(), scope: [{ verb: 'tool.use' }] }]) expect(grantSchema.safeParse(input).success).toBe(false);
  });
  it('M2-1 validates bounded revocation data with replay, algorithm and audit fields', () => {
    const { grantee: _grantee, scope: _scope, limits: _limits, id: _id, ...common } = grant();
    const input = { ...common, ctx: 'phantom.fleet.revocation.v1', kind: 'fleet.revocation',
      seq: 1, nextUpdate: 200, devices: [{ kid, backend: 'tpm', alg: 'ES256' }],
      auditChainHead: 'e'.repeat(64), revoked: { grants: [], owners: [], devices: [], agents: [] } };
    expect(revocationSchema.safeParse(input).success).toBe(true);
    expect(revocationSchema.safeParse({ ...input, nextUpdate: 1001 }).success).toBe(false);
    expect(revocationSchema.safeParse({ ...input, enable: true }).success).toBe(false);
    expect(checkGrant(input).decision).toBe('deny');
  });
});
