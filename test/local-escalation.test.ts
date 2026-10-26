import { describe, expect, it } from 'vitest';
import { decideLocalEscalation, engineMayHoldMergeOrCredentials, isLocalEngine, isPublicHost, type EscalationInput } from '../src/core/routing/local-escalation.js';

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

describe('tier-promotion gap: local engines never hold merge or credential roles', () => {
  it('a known local engine id promoted to tier frontier (and in mergeAuthority) is refused', () => {
    for (const engineId of ['local-coder', 'ollama', 'omlx', 'llama-server']) {
      expect(engineMayHoldMergeOrCredentials({ engineId, tier: 'frontier' }), engineId).toBe(false);
    }
  });

  it('a frontier-tier engine pointed at loopback is refused', () => {
    for (const baseUrl of ['http://127.0.0.1:11434/v1', 'http://localhost:8080', 'http://[::1]:1234/v1', 'http://127.0.0.2:9000']) {
      expect(engineMayHoldMergeOrCredentials({ engineId: 'openai-compat', baseUrl, tier: 'frontier' }), baseUrl).toBe(false);
      expect(engineMayHoldMergeOrCredentials({ engineId: 'claude', baseUrl, tier: 'frontier' }), baseUrl).toBe(false);
    }
    expect(isLocalEngine({ engineId: 'x', baseUrl: 'not a url' })).toBe(true);
  });

  it('remote frontier engines keep authority eligibility', () => {
    expect(engineMayHoldMergeOrCredentials({ engineId: 'claude', tier: 'frontier' })).toBe(true);
    expect(engineMayHoldMergeOrCredentials({ engineId: 'codex', baseUrl: 'https://api.openai.com/v1', tier: 'frontier' })).toBe(true);
  });
});

describe('review #926: fail-closed locality table', () => {
  const local = (engineId: string, baseUrl?: string | null) => isLocalEngine({ engineId, baseUrl, tier: 'frontier' });

  it.each([
    'http://localhost.:1', 'http://LOCALHOST..:1', 'http://[::ffff:127.0.0.1]', 'http://[::ffff:10.0.0.1]', 'http://[::]', 'http://[::1]',
    'http://foo.localhost', 'http://FOO.LOCALHOST.', 'http://host.docker.internal', 'http://box.local', 'http://ollama-box:11434',
    'file:///tmp/x', 'unix:/var/run/x.sock', 'http+unix://%2Fvar%2Frun%2Fx.sock', 'ftp://api.openai.com', '', '   ', 'not a url', 'http://',
    'http://10.0.0.5', 'http://172.16.0.1', 'http://172.31.255.255', 'http://192.168.1.10', 'http://169.254.169.254', 'http://100.64.0.1',
    'http://0.0.0.0', 'http://0', 'http://0x7f000001', 'http://2130706433', 'http://api.openai.com@127.0.0.1',
    'http://[fc00::1]', 'http://[fd12::1]', 'http://[fe80::1]', 'http://[febf::1]',
  ])('endpoint %j is local (refused authority)', (baseUrl) => {
    expect(local('claude', baseUrl)).toBe(true);
    expect(engineMayHoldMergeOrCredentials({ engineId: 'claude', baseUrl, tier: 'frontier' })).toBe(false);
  });

  it.each(['https://api.openai.com/v1', 'https://api.anthropic.com', 'http://8.8.8.8', 'http://172.32.0.1', 'http://100.128.0.1', 'https://[2606:4700::1111]', 'https://example.com.'])(
    'public endpoint %j is remote', (baseUrl) => expect(local('claude', baseUrl)).toBe(false),
  );

  it.each(['ollama', 'Ollama', ' ollama', 'ollama2', 'vllm', 'vLLM-server', 'llamacpp', 'llama.cpp', 'lm-studio', 'LM_Studio', 'tgi', 'omlx', 'localai', 'mlx-lm', 'gguf'])(
    'engine id %j is local with no endpoint', (engineId) => expect(local(engineId)).toBe(true),
  );

  it('hosted engines with no endpoint stay eligible', () => {
    for (const id of ['claude', 'codex', 'gemini']) expect(local(id), id).toBe(false);
    expect(isPublicHost('')).toBe(false);
  });

  it('truthy flags block local, whatever their type', () => {
    for (const v of [true, 'true', 1, 'yes'] as unknown as boolean[]) {
      expect(decideLocalEscalation({ ...base, mergesToMain: v }).lane).toBe('frontier');
      expect(decideLocalEscalation({ ...base, holdsMergeRights: v }).lane).toBe('frontier');
      expect(decideLocalEscalation({ ...base, needsCredentials: v }).lane).toBe('frontier');
    }
    expect(decideLocalEscalation({ ...base, mergesToMain: false }).lane).toBe('local');
  });

  it('NaN or non-finite policy limits fail closed', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, undefined as unknown as number]) {
      expect(decideLocalEscalation(base, { maxLocalVerifyFailures: bad, maxLocalRetries: 3 }).lane).toBe('frontier');
      expect(decideLocalEscalation(base, { maxLocalVerifyFailures: 2, maxLocalRetries: bad })).toMatchObject({ lane: 'frontier', reason: 'retry-cap' });
    }
  });

  it('abliterated models report the abliterated reason for any authority', () => {
    const localModel = 'huihui-qwen-abliterated@sha256:' + 'a'.repeat(64);
    expect(decideLocalEscalation({ ...base, localModel, mergesToMain: true }).reason).toBe('abliterated-with-credentials');
  });
});
