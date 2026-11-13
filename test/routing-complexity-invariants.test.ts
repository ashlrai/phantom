/**
 * Hard invariants for complexity escalation. The full corpus score, including
 * accuracy and the labeled dollar estimate, stays in `npm run eval:routing`.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { complexityPathIsTier1, routeComplexity, stubModelClient } from '../src/core/routing-eval/bind.js';
import { frontierEstimateMicros } from '../src/core/routing-eval/prices.js';
import { parseRoutingEvalCorpus, type RoutingEvalTask } from '../src/core/routing-eval/report.js';
import type { ComplexityRouteInput } from '../src/core/routing/policy.js';
import { LOCAL_CONTEXT_TOKEN_LIMIT, LOCAL_INFERENCE_DEFAULT_HOST } from '../src/core/routing/tiers.js';

const CORPUS_PATH = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'routing-eval', 'corpus.json');

const TIER1_PATHS = [
  'src/core/routing/policy.ts',
  'src/core/routing/tiers.ts',
  'src/core/inbox/merge.ts',
  'src/core/authority/protected-paths.ts',
  'src/core/daemon/loop.ts',
  'src/core/policy/local-only.ts',
  '.github/workflows/ci.yml',
  '.github/CODEOWNERS',
  'CODEOWNERS',
  'package.json',
  '.env',
  'test/routing-seat-router.test.ts',
];

function ordinary(over: Partial<ComplexityRouteInput> = {}): ComplexityRouteInput {
  return {
    id: 'ordinary',
    taskKind: 'edit',
    role: 'implement',
    touchedPaths: ['src/core/verse/preview.ts'],
    contextTokens: 1000,
    priorVerifyFailures: 0,
    mainMerge: false,
    ...over,
  };
}

describe('complexity escalation invariants', () => {
  const stub = stubModelClient();
  const corpus = parseRoutingEvalCorpus(JSON.parse(readFileSync(CORPUS_PATH, 'utf8')) as unknown);

  it('keeps a small edit, test, lint, or draft on the local loopback tier', () => {
    for (const taskKind of ['edit', 'test', 'lint', 'draft'] as const) {
      const decision = routeComplexity(ordinary({ id: taskKind, taskKind }), stub.client);
      expect(decision.tier).toBe('local');
      expect(decision.localInference).toEqual({ host: LOCAL_INFERENCE_DEFAULT_HOST, loopback: true });
      expect(decision.reasons).toEqual([]);
    }
  });

  it('never routes a merge role, a credential role, or a main merge to local', () => {
    for (const role of ['merge', 'credential'] as const) {
      for (const taskKind of ['edit', 'test', 'lint', 'draft'] as const) {
        const decision = routeComplexity(ordinary({ id: `${taskKind}-${role}`, taskKind, role }), stub.client);
        expect(decision.tier).not.toBe('local');
        expect(decision.localInference).toBeNull();
      }
    }
    const mainMerge = routeComplexity(ordinary({ id: 'main', mainMerge: true }), stub.client);
    expect(mainMerge.tier).not.toBe('local');
    expect(mainMerge.reasons).toContain('main-merge');
  });

  it('never routes a Tier-1 path to local', () => {
    for (const path of TIER1_PATHS) {
      expect(complexityPathIsTier1(path)).toBe(true);
      const decision = routeComplexity(ordinary({ id: path, touchedPaths: [path] }), stub.client);
      expect(decision.tier).not.toBe('local');
      expect(decision.reasons).toContain('tier1-path');
    }
    const importing = routeComplexity(ordinary({
      id: 'imports',
      taskKind: 'test',
      touchedPaths: ['test/preview-layout.test.ts'],
      importsTier1: ['test/preview-layout.test.ts'],
    }), stub.client);
    expect(importing.tier).not.toBe('local');
  });

  it('escalates planning, architecture, a repeated verify failure, context over the limit, and a non-loopback host', () => {
    expect(routeComplexity(ordinary({ id: 'plan', taskKind: 'plan' }), stub.client).tier).toBe('frontier');
    expect(routeComplexity(ordinary({ id: 'arch', taskKind: 'architecture' }), stub.client).tier).toBe('frontier');
    expect(routeComplexity(ordinary({ id: 'repeat', priorVerifyFailures: 2 }), stub.client).reasons).toContain('repeated-verify-failure');
    expect(routeComplexity(ordinary({
      id: 'context',
      contextTokens: LOCAL_CONTEXT_TOKEN_LIMIT + 1,
    }), stub.client).reasons).toContain('context-over-local-limit');
    const remote = routeComplexity(ordinary({ id: 'remote', inferenceHost: '10.0.0.8' }), stub.client);
    expect(remote.tier).not.toBe('local');
    expect(remote.reasons).toContain('non-loopback-inference');
    const atLimit = routeComplexity(ordinary({ id: 'limit', contextTokens: LOCAL_CONTEXT_TOKEN_LIMIT }), stub.client);
    expect(atLimit.tier).toBe('local');
  });

  it('holds the same invariants on every corpus record and does not call the model', () => {
    for (const task of corpus.tasks) {
      assertCorpusInvariant(task);
    }
    expect(stub.calls()).toBe(0);
  });

  it('prices the labeled frontier table in integer micros', () => {
    expect(frontierEstimateMicros(4_000, 600)).toBe(4_000 * 3 + 600 * 15);
  });
});

function assertCorpusInvariant(task: RoutingEvalTask): void {
  const stub = stubModelClient();
  const decision = routeComplexity(task, stub.client);
  const tier1 = task.touchedPaths.some((path) => complexityPathIsTier1(path, task.importsTier1 ?? []));
  if (task.role === 'merge' || task.role === 'credential' || task.mainMerge === true || tier1) {
    expect(decision.tier, task.id).not.toBe('local');
  }
  if (decision.tier === 'local') {
    expect(decision.localInference?.loopback, task.id).toBe(true);
    expect(['127.0.0.1', 'localhost', '::1']).toContain(decision.localInference?.host);
  }
  expect(stub.calls(), task.id).toBe(0);
}
