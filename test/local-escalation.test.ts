import { describe, expect, it } from 'vitest';
import { decideLocalEscalation, localLaneMayMergeToMain, type EscalationInput } from '../src/core/routing/local-escalation.js';

const base: EscalationInput = { kind: 'edit', localAvailable: true, localModel: 'qwen3.8:27b' };

describe('decideLocalEscalation', () => {
  it('FIRST: any role holding merge rights or credentials is frontier-only; local only for proposal and coding loops', () => {
    for (const kind of ['edit', 'test', 'lint', 'tool-loop', 'draft', 'review', 'plan', 'architecture'] as const) {
      for (const localModel of ['qwen3.8:27b', 'huihui-qwen-abliterated@sha256:' + 'a'.repeat(64)]) {
        expect(decideLocalEscalation({ ...base, kind, localModel, mergesToMain: true }).lane, `${kind} merge`).toBe('frontier');
        expect(decideLocalEscalation({ ...base, kind, localModel, holdsMergeRights: true }).lane, `${kind} merge rights`).toBe('frontier');
        expect(decideLocalEscalation({ ...base, kind, localModel, needsCredentials: true }).lane, `${kind} credentials`).toBe('frontier');
      }
    }
    expect(decideLocalEscalation({ ...base, holdsMergeRights: true })).toEqual({ lane: 'frontier', reason: 'merge-rights-frontier-only' });
    expect(decideLocalEscalation({ ...base, needsCredentials: true })).toEqual({ lane: 'frontier', reason: 'credentials-frontier-only' });
    expect(localLaneMayMergeToMain()).toBe(false);
    // Without merge or credential rights, only proposal/coding loops stay local.
    expect(decideLocalEscalation({ ...base, kind: 'review' }).lane).toBe('local');
    expect(decideLocalEscalation({ ...base, kind: 'plan' }).lane).toBe('frontier');
  });

  it('stays local for coding, test, lint, tool loops, drafts and review', () => {
    for (const kind of ['edit', 'test', 'lint', 'tool-loop', 'draft', 'review'] as const) {
      expect(decideLocalEscalation({ ...base, kind })).toEqual({ lane: 'local', reason: 'local-ok' });
    }
  });

  it('merge to main is frontier-only, before every other rule', () => {
    expect(decideLocalEscalation({ ...base, mergesToMain: true })).toEqual({ lane: 'frontier', reason: 'merge-to-main-frontier-only' });
    expect(decideLocalEscalation({ ...base, mergesToMain: true, localAvailable: false })).toMatchObject({ reason: 'merge-to-main-frontier-only' });
    expect(localLaneMayMergeToMain()).toBe(false);
  });

  it('abliterated local model never runs a credentialed step', () => {
    expect(decideLocalEscalation({ ...base, needsCredentials: true, localModel: 'huihui-qwen-abliterated@sha256:' + 'a'.repeat(64) }))
      .toEqual({ lane: 'frontier', reason: 'abliterated-with-credentials' });
  });

  it('local unavailable, complex kinds and protected paths escalate', () => {
    expect(decideLocalEscalation({ ...base, localAvailable: false })).toMatchObject({ lane: 'frontier', reason: 'local-unavailable' });
    expect(decideLocalEscalation({ ...base, kind: 'plan' })).toMatchObject({ reason: 'complex-task-kind' });
    expect(decideLocalEscalation({ ...base, kind: 'architecture' })).toMatchObject({ reason: 'complex-task-kind' });
    expect(decideLocalEscalation({ ...base, kind: 'unknown' as never })).toMatchObject({ reason: 'complex-task-kind' });
    expect(decideLocalEscalation({ ...base, touchesProtectedPath: true })).toMatchObject({ reason: 'protected-path' });
  });

  it('escalates on repeated verify failures and on the retry cap (defaults 2 and 3)', () => {
    expect(decideLocalEscalation({ ...base, failedVerifyAttempts: 1 }).lane).toBe('local');
    expect(decideLocalEscalation({ ...base, failedVerifyAttempts: 2 })).toMatchObject({ reason: 'verify-failures' });
    expect(decideLocalEscalation({ ...base, retries: 2 }).lane).toBe('local');
    expect(decideLocalEscalation({ ...base, retries: 3 })).toMatchObject({ reason: 'retry-cap' });
    expect(decideLocalEscalation({ ...base, retries: 1 }, { maxLocalVerifyFailures: 2, maxLocalRetries: 1 })).toMatchObject({ reason: 'retry-cap' });
    expect(decideLocalEscalation({ ...base, retries: -5, failedVerifyAttempts: Number.NaN }).lane).toBe('local');
  });

  it('escalates when context exceeds the local window; unknown window skips the check', () => {
    expect(decideLocalEscalation({ ...base, contextTokens: 70_000, localContextLimit: 65_536 })).toMatchObject({ reason: 'context-over-local-limit' });
    expect(decideLocalEscalation({ ...base, contextTokens: 60_000, localContextLimit: 65_536 }).lane).toBe('local');
    expect(decideLocalEscalation({ ...base, contextTokens: 900_000, localContextLimit: null }).lane).toBe('local');
  });

  it('is deterministic', () => {
    const i = { ...base, retries: 3, touchesProtectedPath: true };
    expect(decideLocalEscalation(i)).toEqual(decideLocalEscalation(i));
  });
});
