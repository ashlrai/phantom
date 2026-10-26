import { describe, expect, it, vi } from 'vitest';
import { buildScopedCompanionPacket, companionPacketDigest, isScopedCompanionPacketAuthorized,
  parseScopedCompanionPacket, reportCompanionPacketFreshness } from '../src/core/proactive/packets.js';
import type { CompanionPacketAuthorization, CompanionPacketInput } from '../src/core/proactive/packet-types.js';

const now = '2026-10-12T10:00:00.000Z';
function input(): CompanionPacketInput {
  return { projectBindingId: 'project-a', tenantId: 'tenant-client', taskId: 'outcome:a:task:review',
    goal: 'Review the exact proposed artifact.', acceptance: ['Cite findings against the bound revision.'],
    accountRefs: ['client-docs', 'client-code'], allowedDestination: { provider: 'custom-provider', accountId: 'review-account', agentId: 'reviewer-a' },
    artifact: { repo: '/workspace/project', expectedHeadSha: 'a'.repeat(40), artifactRef: 'proposal-one', revision: 'revision-one' },
    evidence: [{ source: { provider: 'documents', accountRef: 'client-docs', objectRef: 'brief-one', revisionRef: 'revision-one' },
      observedAt: '2026-10-12T09:59:00.000Z', epistemic: 'recorded', excerpt: 'Keep accounts isolated.' }],
    asOf: now, coverage: { sourceState: 'healthy', complete: true, stopReasons: [] }, deadline: '2026-10-12T11:00:00.000Z',
    limits: { maxCostUsd: null, maxAttempts: 2, maxContextBytes: 32768 } };
}
function authorization(): CompanionPacketAuthorization {
  const packet = input();
  return { projectBindingId: packet.projectBindingId, tenantId: packet.tenantId, taskId: packet.taskId,
    accountRefs: [...packet.accountRefs], allowedDestination: { ...packet.allowedDestination }, stillAuthorized: () => true };
}
function packet(value = input()) { return buildScopedCompanionPacket(value, authorization()).packet; }

describe('scoped companion evidence packets', () => {
  it('builds arbitrary provider identities without inferring cost, connectivity or permission', () => {
    const built = buildScopedCompanionPacket(input(), authorization());
    expect(built.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(built.packet.limits.maxCostUsd).toBeNull();
    expect(built.packet.allowedDestination.provider).toBe('custom-provider');
    expect(parseScopedCompanionPacket(JSON.parse(JSON.stringify(built.packet)))).toEqual(built.packet);
    expect(Object.keys(built.packet)).not.toContain('executable');
  });
  it.each(['tenantId', 'projectBindingId', 'taskId'] as const)('rejects a host grant for another %s', key => {
    expect(() => buildScopedCompanionPacket(input(), { ...authorization(), [key]: 'other-scope' })).toThrow('not authorized');
  });
  it.each(['provider', 'accountId', 'agentId'] as const)('binds the exact destination %s', key => {
    const grant = authorization();
    grant.allowedDestination[key] = 'other-destination';
    expect(() => buildScopedCompanionPacket(input(), grant)).toThrow('not authorized');
  });
  it('requires explicit cross-account approval and source account membership', () => {
    expect(() => buildScopedCompanionPacket(input(), { ...authorization(), accountRefs: ['review-account'] })).toThrow('not authorized');
    const invalid = input(); invalid.evidence[0]!.source.accountRef = 'unlisted-account';
    expect(() => buildScopedCompanionPacket(invalid, authorization())).toThrow('Invalid companion');
    expect(isScopedCompanionPacketAuthorized(packet(), { ...authorization(), accountRefs: [] })).toBe(false);
  });
  it('rechecks authorization and prevents a callback changing the packet being authorized', () => {
    const recheck = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false);
    expect(() => buildScopedCompanionPacket(input(), { ...authorization(), stillAuthorized: recheck })).toThrow('no longer authorized');
    expect(recheck).toHaveBeenCalledTimes(2);
    expect(() => buildScopedCompanionPacket(input(), { ...authorization(), stillAuthorized: value => {
      value.allowedDestination.accountId = 'steal-account'; return true;
    } })).toThrow('not authorized');
    expect(isScopedCompanionPacketAuthorized(packet(), { ...authorization(), stillAuthorized: () => { throw new Error('sensitive host error'); } })).toBe(false);
  });
  it('never accepts authorization functions, credentials or raw sessions from packet JSON', () => {
    const valid = packet();
    for (const field of ['stillAuthorized', 'authorization', 'credentials', 'approvalToken', 'rawSession']) {
      expect(parseScopedCompanionPacket({ ...valid, [field]: 'private payload' })).toBeNull();
    }
    const getter = vi.fn(() => 'untrusted');
    const malicious = { ...valid }; Object.defineProperty(malicious, 'goal', { get: getter, enumerable: true });
    expect(parseScopedCompanionPacket(malicious)).toBeNull(); expect(getter).not.toHaveBeenCalled();
    const inherited = Object.create(valid);
    expect(parseScopedCompanionPacket(inherited)).toBeNull();
    const hidden = { ...valid, artifact: { ...valid.artifact } };
    Object.defineProperty(hidden.artifact, 'artifactRef', { value: 'proposal-one', enumerable: false });
    expect(parseScopedCompanionPacket(hidden)).toBeNull();
    const sparse = { ...valid, acceptance: new Array(1) };
    expect(parseScopedCompanionPacket(sparse)).toBeNull();
    expect(parseScopedCompanionPacket({ ...valid, evidence: [{ ...valid.evidence[0], content: 'raw temporal record' }] })).toBeNull();
  });
  it('rejects credential-shaped data instead of silently scrubbing it into an authorized packet', () => {
    const invalid = input(); invalid.evidence[0]!.excerpt = 'Authorization: Bearer secret-access-credential-1234567890';
    expect(() => buildScopedCompanionPacket(invalid, authorization())).toThrow('Invalid companion evidence packet.');
    invalid.evidence[0]!.excerpt = 'api_key=private-secret-value-1234567890';
    expect(() => buildScopedCompanionPacket(invalid, authorization())).toThrow('Invalid companion evidence packet.');
  });
  it('bounds the canonical UTF-8 envelope and excerpts without returning supplied sensitive errors', () => {
    const oversized = input(); oversized.limits.maxContextBytes = 1;
    expect(() => buildScopedCompanionPacket(oversized, authorization())).toThrow('Invalid companion evidence packet.');
    oversized.limits.maxContextBytes = 32768; oversized.evidence[0]!.excerpt = '💡'.repeat(3000);
    expect(() => buildScopedCompanionPacket(oversized, authorization())).toThrow('Invalid companion evidence packet.');
    const unicode = input(); unicode.evidence[0]!.excerpt = '💡'.repeat(1000);
    const built = packet(unicode); const bytes = Buffer.byteLength(JSON.stringify(built), 'utf8');
    unicode.limits.maxContextBytes = bytes - 10;
    expect(() => packet(unicode)).toThrow('Invalid companion');
  });
  it('binds every scope, goal, limit, criterion, source revision and artifact to the digest', () => {
    const first = buildScopedCompanionPacket(input(), authorization());
    const reordered = input(); reordered.accountRefs.reverse();
    expect(buildScopedCompanionPacket(reordered, authorization()).digest).toBe(first.digest);
    const fields: Array<(value: CompanionPacketInput) => void> = [
      value => { value.goal = 'A changed goal.'; }, value => { value.acceptance = ['A changed criterion.']; },
      value => { value.artifact.expectedHeadSha = 'b'.repeat(40); }, value => { value.evidence[0]!.source.revisionRef = 'revision-two'; },
      value => { value.evidence[0]!.epistemic = 'hypothesis'; }, value => { value.limits.maxCostUsd = 0; },
    ];
    for (const change of fields) { const changed = input(); change(changed); expect(companionPacketDigest(packet(changed))).not.toBe(first.digest); }
    expect(input().accountRefs).toEqual(['client-docs', 'client-code']);
  });
  it('requires exact artifact versions and explicit valid budgets and deadlines', () => {
    for (const artifact of [{ repo: '/workspace/project' }, { expectedHeadSha: 'a'.repeat(40) }, { artifactRef: 'one' }, { revision: 'one' }, {}]) {
      expect(() => packet({ ...input(), artifact })).toThrow('Invalid companion');
    }
    for (const cost of [-1, NaN, Infinity]) expect(() => packet({ ...input(), limits: { ...input().limits, maxCostUsd: cost } })).toThrow('Invalid companion');
    expect(packet({ ...input(), limits: { ...input().limits, maxCostUsd: 0 } }).limits.maxCostUsd).toBe(0);
    for (const deadline of [now, '2026-10-12T09:00:00Z', '2026-10-12T11:00:00', '2026-02-29T11:00:00Z']) {
      expect(() => packet({ ...input(), deadline })).toThrow('Invalid companion');
    }
    for (const attempts of [0, -1, 1.5, 101]) expect(() => packet({ ...input(), limits: { ...input().limits, maxAttempts: attempts } })).toThrow('Invalid companion');
    expect(packet({ ...input(), deadline: null }).deadline).toBeNull();
  });
  it('reports stale, partial, missing and future evidence without claiming complete knowledge', () => {
    const built = packet();
    expect(reportCompanionPacketFreshness(built, { asOf: now, maxAgeMs: 60000 })).toMatchObject({ freshness: 'fresh', partial: false });
    expect(reportCompanionPacketFreshness(built, { asOf: '2026-10-12T12:00:00Z', maxAgeMs: 60000 }))
      .toMatchObject({ freshness: 'stale', staleEvidenceIndexes: [0], deadlineExceeded: true });
    const partial = packet({ ...input(), coverage: { sourceState: 'degraded', complete: false, stopReasons: ['read-incomplete'] } });
    expect(reportCompanionPacketFreshness(partial, { asOf: now, maxAgeMs: 60000 }))
      .toMatchObject({ freshness: 'unknown', partial: true, stopReasons: ['read-incomplete'] });
    expect(reportCompanionPacketFreshness(packet({ ...input(), evidence: [] }), { asOf: now, maxAgeMs: 60000 }).freshness).toBe('unknown');
    expect(reportCompanionPacketFreshness(built, { asOf: '2026-10-12T09:00:00Z', maxAgeMs: 60000 }))
      .toMatchObject({ freshness: 'unknown', futureEvidenceIndexes: [0] });
    expect(() => reportCompanionPacketFreshness(built, { asOf: now, maxAgeMs: -1 })).toThrow('Invalid companion freshness query.');
  });
  it('normalizes timestamps and rejects duplicate/future source projections or false coverage', () => {
    const normalized = input(); normalized.asOf = '2026-10-12T11:00:00+01:00';
    expect(packet(normalized).asOf).toBe(now);
    const duplicate = input(); duplicate.evidence.push({ ...duplicate.evidence[0]! });
    expect(() => packet(duplicate)).toThrow('Invalid companion');
    const future = input(); future.evidence[0]!.observedAt = '2026-10-12T10:01:00Z';
    expect(() => packet(future)).toThrow('Invalid companion');
    expect(() => packet({ ...input(), coverage: { sourceState: 'missing', complete: true, stopReasons: [] } })).toThrow('Invalid companion');
    expect(() => packet({ ...input(), coverage: { sourceState: 'healthy', complete: true, stopReasons: ['truncated'] } })).toThrow('Invalid companion');
  });
});
