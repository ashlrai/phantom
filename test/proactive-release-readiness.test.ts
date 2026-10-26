import {describe, expect, it} from 'vitest';
import {evaluateReleaseReadiness} from '../src/core/proactive/release-readiness.js';
import type {ReleaseBinding, ReleaseChannel, ReleaseEvidenceReceipt, ReleaseReadinessHost, ReleaseReadinessInput} from '../src/core/proactive/release-readiness-types.js';

const asOf = '2026-10-12T12:00:00.000Z';
const binding = (channel: ReleaseChannel): ReleaseBinding => ({channel, targetId: `${channel}:example-target`, version: '1.2.3',
  sourceRevision: 'a'.repeat(40), artifactDigest: 'b'.repeat(64), attemptId: 'review-attempt-1'});
const host: ReleaseReadinessHost = {verifyEvidence: () => 'verified'};
function example(channel: ReleaseChannel = 'npm', source: ReleaseEvidenceReceipt['source'] = 'host-observed'): ReleaseReadinessInput {
  const target = binding(channel);
  return {binding: target, asOf, sourceClean: true,
    evidence: (['tests', 'qualification', 'provenance', 'commissioning', 'provider-status', 'replay'] as const).map(kind => ({
      id: `${kind}-receipt`, kind, binding: {...target}, source, status: 'passed',
      observedAt: '2026-10-12T11:00:00.000Z', expiresAt: '2026-10-12T13:00:00.000Z', reference: `fixture:${kind}`,
      ...(kind === 'commissioning' ? {scopeRevision: 'scope-1'} : {}),
      ...(kind === 'provider-status' ? {providerState: 'not-contacted' as const} : {}),
      ...(kind === 'replay' ? {replayState: 'unconsumed' as const} : {}),
    })),
    postChecks: {binding: {...target}, checks: ['verify-exact-public-artifact', 'consumer-acceptance'], deadlineAt: '2026-10-12T14:00:00.000Z', ownerId: 'release-owner'},
    recovery: channel === 'npm' ? {channel, binding: {...target}, strategy: 'corrective-version', correctiveVersion: '1.2.4', overwritePublishedVersion: false, ownerId: 'release-owner'} :
      channel === 'website' ? {channel, binding: {...target}, strategy: 'restore-deployment', previousDeploymentId: 'previous-deployment', affectedTargets: [target.targetId], ownerId: 'release-owner'} :
        {channel, binding: {...target}, strategy: 'signed-recovery-update', previousSignedInstallerDigest: 'c'.repeat(64), updateChannel: 'stable', customerUpdatePath: 'documented signed recovery installer', compatibilityChecks: ['data-and-schema-compatible', 'stopped-state-preserved'], ownerId: 'release-owner'},
  };
}
function receipt(input: ReleaseReadinessInput, kind: ReleaseEvidenceReceipt['kind']) { return input.evidence.find(r => r.kind === kind)!; }
function expectNoEffects(value: ReturnType<typeof evaluateReleaseReadiness>) {
  expect(value.releaseAuthorized).toBe(false);
  expect(Object.values(value.effects)).toEqual([false, false, false, false, false]);
}

describe('provider-neutral release readiness evidence', () => {
  it.each(['npm', 'website', 'desktop'] as const)('evaluates exact %s target for review without authorizing an effect', channel => {
    const result = evaluateReleaseReadiness(example(channel), host);
    expect(result.readiness).toBe('ready-for-review'); expect(result.evidenceLayer).toBe('source'); expect(result.simulated).toBe(false);
    expectNoEffects(result);
  });
  it('keeps an otherwise successful fixture explicitly simulated', () => {
    const result = evaluateReleaseReadiness(example('npm', 'fixture'));
    expect(result.readiness).toBe('ready-for-review'); expect(result.simulated).toBe(true); expect(result.evidenceLayer).toBe('simulated');
    expect(result.gates.find(g => g.id === 'commissioning')?.state).toBe('simulated'); expectNoEffects(result);
  });
  it('keeps current local build evidence unknown without commissioned target evidence', () => {
    const input = example(); input.evidence = [{...receipt(input, 'tests'), source: 'local-readonly'}]; input.postChecks = null; input.recovery = null;
    const result = evaluateReleaseReadiness(input);
    expect(result.readiness).toBe('unknown'); expect(result.gates.find(g => g.id === 'tests')?.state).toBe('passed');
    expect(result.gates.find(g => g.id === 'commissioning')?.state).toBe('unknown'); expectNoEffects(result);
  });
  it('cannot trust host claims from JSON without an independent host validator', () => {
    const input = example(); Object.assign(receipt(input, 'commissioning'), {signedGrant: true, authority: true});
    expect(evaluateReleaseReadiness(input).readiness).toBe('unknown');
    expectNoEffects(evaluateReleaseReadiness(input, host));
  });
  it('refuses local or declared commissioning even with a permissive host validator', () => {
    for (const source of ['local-readonly', 'declared'] as const) {
      const input = example(); receipt(input, 'commissioning').source = source;
      expect(evaluateReleaseReadiness(input, host).readiness).toBe('unknown');
    }
  });
  it.each(['targetId', 'version', 'sourceRevision', 'artifactDigest', 'attemptId'] as const)('blocks mismatched %s on a receipt', key => {
    const input = example(); const changed = receipt(input, 'tests').binding;
    changed[key] = key === 'sourceRevision' ? 'd'.repeat(40) : key === 'artifactDigest' ? 'd'.repeat(64) : key === 'version' ? '1.2.4' : 'other';
    expect(evaluateReleaseReadiness(input, host).readiness).toBe('blocked');
  });
  it.each(['failed', 'revoked'] as const)('blocks %s qualification', status => {
    const input = example(); receipt(input, 'qualification').status = status;
    expect(evaluateReleaseReadiness(input, host).readiness).toBe('blocked');
  });
  it.each(['invalid', 'revoked'] as const)('blocks independently %s commissioning', verdict => {
    expect(evaluateReleaseReadiness(example(), {verifyEvidence: r => r.kind === 'commissioning' ? verdict : 'verified'}).readiness).toBe('blocked');
  });
  it('treats unavailable and throwing validators as unknown without throwing', () => {
    expect(evaluateReleaseReadiness(example(), {verifyEvidence: () => 'unavailable'}).readiness).toBe('unknown');
    expect(evaluateReleaseReadiness(example(), {verifyEvidence: () => {throw new Error('offline');}}).readiness).toBe('unknown');
  });
  it('blocks expired and future evidence', () => {
    for (const field of ['expiresAt', 'observedAt'] as const) {
      const input = example(); receipt(input, 'tests')[field] = field === 'expiresAt' ? asOf : '2026-10-12T12:30:00.000Z';
      expect(evaluateReleaseReadiness(input, host).readiness).toBe('blocked');
    }
  });
  it('blocks dirty source and keeps unknown cleanliness unknown', () => {
    const input = example(); input.sourceClean = false;
    expect(evaluateReleaseReadiness(input, host).readiness).toBe('blocked'); input.sourceClean = null;
    expect(evaluateReleaseReadiness(input, host).readiness).toBe('unknown');
  });
  it('blocks unknown remote state and consumed or unknown replay state', () => {
    const input = example(); receipt(input, 'provider-status').providerState = 'unknown';
    expect(evaluateReleaseReadiness(input, host).readiness).toBe('blocked');
    for (const replayState of ['consumed', 'unknown'] as const) {
      const another = example(); receipt(another, 'replay').replayState = replayState;
      expect(evaluateReleaseReadiness(another, host).readiness).toBe('blocked');
    }
  });
  it('deduplicates identical receipts and blocks conflicting receipt-ID replay', () => {
    const input = example(); input.evidence.push({...receipt(input, 'tests'), binding: {...input.binding}});
    expect(evaluateReleaseReadiness(input, host).readiness).toBe('ready-for-review');
    input.evidence.at(-1)!.reference = 'conflicting-evidence';
    expect(evaluateReleaseReadiness(input, host).readiness).toBe('blocked');
  });
  it('deduplicates receipt replay regardless of object property order', () => {
    const input = example(); const original = receipt(input, 'tests');
    input.evidence.push(Object.fromEntries(Object.entries(original).reverse()) as unknown as ReleaseEvidenceReceipt);
    expect(evaluateReleaseReadiness(input, host).readiness).toBe('ready-for-review');
  });
  it('blocks conflicting provider observations even when both are fresh', () => {
    const input = example(); input.evidence.push({...receipt(input, 'provider-status'), id: 'new-provider-status', providerState: 'published'});
    expect(evaluateReleaseReadiness(input, host).gates.find(g => g.id === 'provider-status')?.state).toBe('blocked');
  });
  it('does not claim post checks ran and blocks expired or mismatched plans', () => {
    const input = example(); input.postChecks = null;
    expect(evaluateReleaseReadiness(input, host).readiness).toBe('unknown');
    const expired = example(); expired.postChecks!.deadlineAt = asOf;
    expect(evaluateReleaseReadiness(expired, host).readiness).toBe('blocked');
    const mismatch = example(); mismatch.postChecks!.binding.targetId = 'different';
    expect(evaluateReleaseReadiness(mismatch, host).readiness).toBe('blocked');
    expect(evaluateReleaseReadiness(example(), host).gates.find(g => g.id === 'post-checks')?.reason).toContain('not been executed');
  });
  it('rejects npm immutable-version overwrite and non-newer recovery', () => {
    const input = example(); if (input.recovery?.channel !== 'npm') throw new Error('fixture');
    input.recovery.correctiveVersion = '1.2.3'; expect(evaluateReleaseReadiness(input, host).readiness).toBe('blocked');
    input.recovery.correctiveVersion = '1.2.4'; Object.assign(input.recovery, {overwritePublishedVersion: true});
    expect(evaluateReleaseReadiness(input, host).readiness).toBe('blocked');
  });
  it('requires website recovery to include the exact target and prior deployment', () => {
    const input = example('website'); if (input.recovery?.channel !== 'website') throw new Error('fixture');
    input.recovery.affectedTargets = ['different']; expect(evaluateReleaseReadiness(input, host).readiness).toBe('blocked');
    input.recovery.affectedTargets = [input.binding.targetId]; input.recovery.previousDeploymentId = '';
    expect(evaluateReleaseReadiness(input, host).readiness).toBe('blocked');
  });
  it('requires desktop signed recovery identity, channel, update path and compatibility', () => {
    const input = example('desktop'); if (input.recovery?.channel !== 'desktop') throw new Error('fixture');
    input.recovery.previousSignedInstallerDigest = input.binding.artifactDigest;
    expect(evaluateReleaseReadiness(input, host).readiness).toBe('blocked');
    input.recovery.previousSignedInstallerDigest = 'c'.repeat(64); input.recovery.customerUpdatePath = '';
    expect(evaluateReleaseReadiness(input, host).readiness).toBe('blocked');
  });
  it('distinguishes verified published and installed layers from source evidence', () => {
    const input = example(); receipt(input, 'provider-status').providerState = 'published';
    expect(evaluateReleaseReadiness(input, host).evidenceLayer).toBe('published');
    receipt(input, 'provider-status').providerState = 'installed'; expect(evaluateReleaseReadiness(input, host).evidenceLayer).toBe('installed');
    expect(evaluateReleaseReadiness(input).evidenceLayer).toBe('source');
  });
  it('is repeatable, does not mutate input and presents immutable host snapshots', () => {
    const input = example(); const before = structuredClone(input);
    const validator: ReleaseReadinessHost = {verifyEvidence: (r, b) => {
      expect(Object.isFrozen(r)).toBe(true); expect(Object.isFrozen(r.binding)).toBe(true); expect(Object.isFrozen(b)).toBe(true); return 'verified';
    }};
    expect(evaluateReleaseReadiness(input, validator)).toEqual(evaluateReleaseReadiness(input, validator)); expect(input).toEqual(before);
  });
  it('pins remaining plan inputs before an injected validator can change the caller object', () => {
    const input = example();
    const validator: ReleaseReadinessHost = {verifyEvidence: () => {input.postChecks = null; input.recovery = null; input.asOf = 'changed'; return 'verified';}};
    const result = evaluateReleaseReadiness(input, validator);
    expect(result.readiness).toBe('ready-for-review'); expect(result.asOf).toBe(asOf);
  });
  it('fails closed on malformed input without evaluating getters', () => {
    const input = example(); let read = false;
    Object.defineProperty(input, 'asOf', {get: () => {read = true; return asOf;}});
    expect(evaluateReleaseReadiness(input, host).readiness).toBe('blocked'); expect(read).toBe(false);
    expectNoEffects(evaluateReleaseReadiness(null as unknown as ReleaseReadinessInput));
  });
});
