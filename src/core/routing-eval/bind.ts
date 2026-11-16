/**
 * Binds the complexity policy to the real Tier-1 path matcher.
 *
 * The decision lives in routing/policy.ts and the limits live in routing/tiers.ts.
 * Those modules stay browser-safe, so they cannot import protected-paths
 * (that module reaches node:fs). This file is the call site the eval uses.
 * It is not a second router. Seat choice stays in routing/router.ts.
 */
import { matchProtectedPath } from '../authority/protected-paths.js';
import {
  decideComplexityTier,
  type ComplexityDecision,
  type ComplexityModelClient,
  type ComplexityRouteInput,
} from '../routing/policy.js';

/** True when `path` is protected for this repo, including a caller-supplied Tier-1 import. */
export function complexityPathIsTier1(path: string, importsTier1: readonly string[] = []): boolean {
  return matchProtectedPath(path, {
    selfRepo: true,
    testsImportingTier1: new Set(importsTier1),
  }) !== null;
}

/**
 * Score one task with the real Tier-1 matcher. `model.complete` is required
 * so the caller has a stub in hand, and this function does not call it.
 */
export function routeComplexity(input: ComplexityRouteInput, model: ComplexityModelClient): ComplexityDecision {
  if (typeof model.complete !== 'function') {
    throw new Error('complexity routing needs a model client stub');
  }
  const importsTier1 = input.importsTier1 ?? [];
  return decideComplexityTier(input, (path) => complexityPathIsTier1(path, importsTier1));
}

/** A stub that counts calls and throws if the policy ever completes a prompt. */
export function stubModelClient(): { client: ComplexityModelClient; calls: () => number } {
  let calls = 0;
  return {
    client: {
      complete(request) {
        calls += 1;
        throw new Error(`model client was called for ${request.taskId}`);
      },
    },
    calls: () => calls,
  };
}
