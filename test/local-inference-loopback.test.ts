/**
 * Local inference slice P2: loopback-only by default (incl. OPENAI_COMPAT_BASE_URL),
 * explicit remote opt-in with warning, no placeholder/OAuth keys to local URLs,
 * abliterated models never default and never in credentialed roles.
 */
import { describe, expect, it } from 'vitest';
import {
  isAbliteratedModel,
  isForbiddenLocalKey,
  localInferenceConfigProblems,
  parseLocalInferenceConfig,
  resolveOpenAICompatTarget,
  validateLocalBaseUrl,
} from '../src/core/run/local-inference.js';

const PIN = '@sha256:' + 'a'.repeat(64);

describe('validateLocalBaseUrl', () => {
  it('accepts 127.0.0.1, [::1] and localhost over http', () => {
    for (const u of ['http://127.0.0.1:11434/v1', 'http://[::1]:8000/v1', 'http://localhost:8000/v1', 'http://LOCALHOST:8000/v1/']) {
      const r = validateLocalBaseUrl(u);
      expect(r.ok, u).toBe(true);
      if (r.ok) { expect(r.loopback).toBe(true); expect(r.warning).toBeNull(); }
    }
  });

  it('refuses remote hosts by default, including other IP literals and lookalikes', () => {
    for (const u of ['http://10.0.0.5:8000/v1', 'https://api.example.com/v1', 'http://0.0.0.0:8000', 'http://127.0.0.2:8000', 'http://localhost.evil.com/v1']) {
      expect(validateLocalBaseUrl(u), u).toEqual({ ok: false, reason: 'remote-not-allowed' });
    }
  });

  it('refuses non-canonical loopback spellings, userinfo, query, fragment, bad paths and schemes', () => {
    expect(validateLocalBaseUrl('http://2130706433:8000/v1')).toEqual({ ok: false, reason: 'host-not-canonical' });
    expect(validateLocalBaseUrl('http://0x7f.1:8000/v1')).toEqual({ ok: false, reason: 'host-not-canonical' });
    expect(validateLocalBaseUrl('http://127.0.0.1.:8000/v1')).toEqual({ ok: false, reason: 'host-not-canonical' });
    expect(validateLocalBaseUrl('http://user:pw@127.0.0.1:8000/v1')).toEqual({ ok: false, reason: 'userinfo-not-allowed' });
    expect(validateLocalBaseUrl('http://127.0.0.1@evil.com/v1')).toEqual({ ok: false, reason: 'userinfo-not-allowed' });
    expect(validateLocalBaseUrl('http://127.0.0.1:8000/v1?x=1')).toEqual({ ok: false, reason: 'query-not-allowed' });
    expect(validateLocalBaseUrl('http://127.0.0.1:8000/v1#f')).toEqual({ ok: false, reason: 'fragment-not-allowed' });
    expect(validateLocalBaseUrl('http://127.0.0.1:8000/../v1')).toEqual({ ok: false, reason: 'path-not-allowed' });
    expect(validateLocalBaseUrl('file:///etc/passwd')).toEqual({ ok: false, reason: 'scheme-not-allowed' });
    expect(validateLocalBaseUrl('http://127.0.0.1:99999/v1')).toEqual({ ok: false, reason: 'base-url-invalid' });
    expect(validateLocalBaseUrl(42)).toEqual({ ok: false, reason: 'base-url-invalid' });
  });

  it('allowRemote must be literally true and remote needs https; then it warns', () => {
    expect(validateLocalBaseUrl('https://gpu.example.com/v1', { allowRemote: 'true' })).toEqual({ ok: false, reason: 'remote-not-allowed' });
    expect(validateLocalBaseUrl('http://gpu.example.com/v1', { allowRemote: true })).toEqual({ ok: false, reason: 'remote-requires-https' });
    const r = validateLocalBaseUrl('https://gpu.example.com/v1', { allowRemote: true });
    expect(r).toMatchObject({ ok: true, loopback: false, warning: 'remote-local-inference', host: 'gpu.example.com' });
  });

  it('refusal reasons never echo the input', () => {
    const r = validateLocalBaseUrl('https://secret-host-xyz.example.com/v1');
    expect(JSON.stringify(r)).not.toContain('secret-host-xyz');
  });
});

describe('parseLocalInferenceConfig', () => {
  it('absent is off; provider defaults are loopback', () => {
    expect(parseLocalInferenceConfig(undefined)).toEqual({ ok: true, config: null });
    const o = parseLocalInferenceConfig({ provider: 'ollama' });
    expect(o.ok && o.config).toMatchObject({ provider: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', loopback: true, allowRemote: false, allowAbliterated: false });
    const m = parseLocalInferenceConfig({ provider: 'omlx', models: { coder: 'qwen3.8:27b', reviewer: 'qwen3.6:27b-coding' } });
    expect(m.ok && m.config).toMatchObject({ baseUrl: 'http://127.0.0.1:8000/v1', models: { coder: 'qwen3.8:27b', reviewer: 'qwen3.6:27b-coding' } });
  });

  it('openai-compat needs a baseUrl; bad provider, unknown keys and non-boolean flags are problems', () => {
    expect(localInferenceConfigProblems({ provider: 'openai-compat' })).toEqual(['localInference.baseUrl: required for provider openai-compat']);
    expect(localInferenceConfigProblems({ provider: 'mystery' })[0]).toContain('localInference.provider');
    expect(localInferenceConfigProblems({ provider: 'ollama', extra: 1 })).toEqual(['localInference: 1 unrecognized key(s)']);
    expect(localInferenceConfigProblems({ provider: 'ollama', allowRemote: 'yes' })).toContain('localInference.allowRemote: must be a boolean');
    expect(localInferenceConfigProblems({ provider: 'ollama', baseUrl: 'http://10.1.1.1:11434/v1' })).toEqual(['localInference.baseUrl: remote-not-allowed']);
  });

  it('abliterated: never in coder/reviewer/planner, even with allowAbliterated', () => {
    for (const role of ['coder', 'reviewer', 'planner']) {
      const p = localInferenceConfigProblems({ provider: 'ollama', allowAbliterated: true, models: { [role]: `huihui-ai/Huihui-Qwen3.8-27B-abliterated${PIN}` } });
      expect(p[0], role).toContain('never allowed in a role with credentials or merge rights');
    }
  });

  it('abliterated in proposalOnly needs allowAbliterated and a digest pin', () => {
    expect(localInferenceConfigProblems({ provider: 'ollama', models: { proposalOnly: `x-uncensored${PIN}` } })[0]).toContain('needs allowAbliterated');
    expect(localInferenceConfigProblems({ provider: 'ollama', allowAbliterated: true, models: { proposalOnly: 'x-abliterated:latest' } })[0]).toContain('pinned by digest');
    const ok = parseLocalInferenceConfig({ provider: 'ollama', allowAbliterated: true, models: { proposalOnly: `x-abliterated${PIN}` } });
    expect(ok.ok && ok.config?.models.proposalOnly).toBe(`x-abliterated${PIN}`);
    expect(isAbliteratedModel('qwen3.8:27b')).toBe(false);
  });
});

describe('resolveOpenAICompatTarget (OPENAI_COMPAT_BASE_URL gate)', () => {
  const base = { defaultBaseUrl: 'http://localhost:8000/v1', apiKey: '' };
  it('default and loopback env pass unchanged', () => {
    expect(resolveOpenAICompatTarget(base)).toMatchObject({ ok: true, baseUrl: 'http://localhost:8000/v1', loopback: true });
    expect(resolveOpenAICompatTarget({ ...base, envBaseUrl: 'http://127.0.0.1:4000/v1' })).toMatchObject({ ok: true, baseUrl: 'http://127.0.0.1:4000/v1' });
  });

  it('a remote OPENAI_COMPAT_BASE_URL is refused unless config opts in (env alone never widens)', () => {
    expect(resolveOpenAICompatTarget({ ...base, envBaseUrl: 'https://api.fireworks.ai/inference/v1' })).toEqual({ ok: false, reason: 'remote-not-allowed' });
    const opted = resolveOpenAICompatTarget({ ...base, envBaseUrl: 'https://api.fireworks.ai/inference/v1', localInference: { provider: 'openai-compat', baseUrl: 'http://127.0.0.1:8000/v1', allowRemote: true } });
    expect(opted).toMatchObject({ ok: true, loopback: false, warning: 'remote-local-inference' });
  });

  it('an invalid localInference block refuses instead of falling back', () => {
    expect(resolveOpenAICompatTarget({ ...base, localInference: { provider: 'ollama', baseUrl: 'http://10.0.0.1/v1' } })).toEqual({ ok: false, reason: 'local-inference-config-invalid' });
  });

  it('localInference baseUrl is used when no env override', () => {
    expect(resolveOpenAICompatTarget({ ...base, localInference: { provider: 'ollama' } })).toMatchObject({ ok: true, baseUrl: 'http://127.0.0.1:11434/v1' });
  });

  it('keys: ollama/omlx get none; placeholders and OAuth tokens are dropped; a real configured key is kept', () => {
    expect(resolveOpenAICompatTarget({ ...base, apiKey: 'sk-local-1234', localInference: { provider: 'omlx' } })).toMatchObject({ apiKey: '', keyDropped: true });
    expect(resolveOpenAICompatTarget({ ...base, apiKey: 'phm_abc123' })).toMatchObject({ apiKey: '', keyDropped: true });
    expect(resolveOpenAICompatTarget({ ...base, apiKey: 'sk-ant-oat01-xyz' })).toMatchObject({ apiKey: '', keyDropped: true });
    expect(resolveOpenAICompatTarget({ ...base, apiKey: 'sk-litellm-master' })).toMatchObject({ apiKey: 'sk-litellm-master', keyDropped: false });
    expect(isForbiddenLocalKey('ya29.token')).toBe(true);
  });
});
