import { canonical, digest, readArtifactSnapshot } from './artifacts.js';
import type { FixedEvaluatorResult } from './fixed-evaluator-diagnostics.js';

export interface SealedIntegrationScenarioPin {
  id: 'checkout-budget-v1';
  digest: string;
}

const checkout = Object.freeze({
  id: 'checkout-budget-v1', subtotalCents: 1000, feePath: 'fee-cents.json', limitPath: 'budget-cents.json',
  expectedAccepted: true,
});

export function assertSealedIntegrationScenario(pin: SealedIntegrationScenarioPin): void {
  if (pin.id !== checkout.id || pin.digest !== digest(canonical(checkout))) {
    throw new Error('Sealed integration scenario identity or digest mismatch');
  }
}

/** The downstream consumer reads bounded data only; no candidate code runs on the host. */
export function runSealedIntegrationScenario(pin: SealedIntegrationScenarioPin, artifactPath: string,
  expectedArtifactDigest: string): FixedEvaluatorResult {
  assertSealedIntegrationScenario(pin);
  const snapshot = readArtifactSnapshot(artifactPath);
  if (snapshot.digest !== expectedArtifactDigest) throw new Error('Scored artifact changed before evaluation');
  const cents = (path: string): number | null => {
    const data = snapshot.entries.find((entry) => entry.path === path)?.data;
    if (!data || data.length > 32) return null;
    const value = data.toString('utf8').trim();
    return /^(0|[1-9][0-9]{0,8})$/.test(value) ? Number(value) : null;
  };
  const fee = cents(checkout.feePath), limit = cents(checkout.limitPath);
  const passed = fee !== null && limit !== null && (checkout.subtotalCents + fee <= limit) === checkout.expectedAccepted;
  return { stdout: JSON.stringify({ passed, score: Number(passed), metrics: {} }), stderr: '', exitCode: 0, signal: null,
    timedOut: false, cancelled: false, processGroupSettlement: 'not-started' };
}
