import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ANTHROPIC_API_VERSION, PROVIDER_API_CAPABILITIES, anthropicVersionHeaders } from '../src/core/run/model-catalog.js';
import type { AshlrConfig, ChatMessage } from '../src/core/types.js';
import type { FreshClaudeApiGrantProof } from '../src/core/resources/claude-api-grant-types.js';
import { createClaudeApiGrantAdmission } from '../src/core/resources/claude-api-grant.js';
import { buildAnthropicMessagesClient, type ClaudeApiExecutionBinding } from '../src/core/run/anthropic-client.js';
import { resolveUsageWindows } from '../src/core/observability/limits.js';
import { warmLocalModel, resetThroughputForTest } from '../src/core/verse/multimodel/local-warm.js';

const key = 'disposable-version-contract-test-key';
const secret = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('../src/core/integrations/secrets.js', () => ({ resolveProviderKey: secret.read }));
vi.mock('../src/core/observability/usage-source.js', () => ({ collectUsageEvents: () => [] }));
vi.mock('../src/core/observability/codex-source.js', () => ({ readCodexRateLimits: () => null }));

const model = 'claude-sonnet-4-6';
const roots: string[] = [];
const cfg = (gateway = false): AshlrConfig => ({
  version: 1, roots: [], models: {}, foundry: { allowedBackends: ['claude-api'] },
  ...(gateway ? { gateways: { anthropic: { enabled: true, baseUrl: 'http://127.0.0.1:4555/relay' } } } : {}),
} as AshlrConfig);

// Use genuine admission and settlement, with disposable credentials and a fetch stub.
function binding(gateway: boolean): ClaudeApiExecutionBinding {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'anthropic-version-')));
  roots.push(root);
  chmodSync(root, 0o700);
  const now = Date.now();
  const stamp = new Date(now).toISOString();
  const proof: FreshClaudeApiGrantProof = {
    observation: {
      v: 1, kind: 'claude-api-promotion', observationId: 'version-test', cycleId: 'version-test',
      binding: {
        organizationDigest: 'a'.repeat(64), workspaceDigest: 'b'.repeat(64),
        credentialDigest: createHash('sha256').update(key).digest('hex'), generation: 'version-test',
        ...(gateway ? { origin: 'gateway:127.0.0.1:4555' } : {}),
      },
      remainingUsdMicros: '10000000', totalUsdMicros: '10000000', capturedAt: stamp,
      expiry: { precision: 'date', date: new Date(now + 86_400_000).toISOString().slice(0, 10), timezone: 'UTC', instant: null },
      evidenceDigest: 'c'.repeat(64),
    },
    observedAt: stamp, validUntil: new Date(now + 60_000).toISOString(),
    funding: { source: 'verified-provider-billing', prepaid: true, invoiced: false, autoReload: 'off', purchasedUsdMicros: '0', otherPaidFunding: false },
    authority: { active: true, stop: false, localOnly: false, engineEnabled: true, repoAuthorized: true, roleAuthorized: true, meteredCeilingUsdMicros: '10000000', dailyRemainingUsdMicros: '10000000', identityDigest: 'd'.repeat(64) },
  };
  const readFreshProof = () => structuredClone(proof);
  const admission = createClaudeApiGrantAdmission({ expectedBinding: proof.observation.binding, readFreshProof });
  if (!admission.ok) throw new Error(admission.reason);
  return { ledgerRoot: root, admission: admission.value, expectedBinding: proof.observation.binding, readFreshProof };
}

beforeEach(() => {
  secret.read.mockReturnValue(key);
  vi.stubEnv('ANTHROPIC_API_KEY', key);
  vi.stubEnv('OPENAI_API_KEY', '');
  // Fail closed if any test forgets to provide its in-process peer.
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Unexpected network request')));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetThroughputForTest();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Anthropic version capability', () => {
  it('pins the reviewed HTTP version without an SDK dependency', () => {
    expect(ANTHROPIC_API_VERSION).toBe('2026-10-21');
    expect(PROVIDER_API_CAPABILITIES.anthropic.anthropicVersionHeader).toBe(true);
    expect(anthropicVersionHeaders('anthropic')).toEqual({ 'anthropic-version': ANTHROPIC_API_VERSION });
  });

  it.each(['llama-server', 'ollama', 'openai', 'unknown', 'constructor', '__proto__'])('does not claim Anthropic version support for %s', provider => {
    expect(anthropicVersionHeaders(provider)).toEqual({});
  });

  it('keeps capability policy immutable and returns independent headers', () => {
    expect(Object.isFrozen(PROVIDER_API_CAPABILITIES)).toBe(true);
    expect(Object.values(PROVIDER_API_CAPABILITIES).every(Object.isFrozen)).toBe(true);
    const headers = anthropicVersionHeaders('anthropic');
    headers['anthropic-version'] = 'changed';
    expect(anthropicVersionHeaders('anthropic')['anthropic-version']).toBe(ANTHROPIC_API_VERSION);
  });
});

describe('versioned request contracts', () => {
  it.each([false, true])('sends compliant Messages requests (gateway=%s) and settles usage', async gateway => {
    const peer = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
      expect(String(url)).toBe(gateway ? 'http://127.0.0.1:4555/relay/v1/messages' : 'https://api.anthropic.com/v1/messages');
      expect(new Headers(init?.headers).get('anthropic-version')).toBe(ANTHROPIC_API_VERSION);
      expect(init?.redirect).toBe('error');
      const body = JSON.parse(String(init?.body));
      for (const removed of ['temperature', 'top_p', 'top_k']) expect(body).not.toHaveProperty(removed);
      expect(body.messages).toEqual([
        { role: 'user', content: [{ type: 'text', text: 'Read the file' }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'read', input: { path: 'README.md' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'file contents' }] },
      ]);
      expect(body.tools).toEqual([{ name: 'read', input_schema: { type: 'object' } }]);
      return Response.json({
        type: 'message', id: 'msg_Version', role: 'assistant', model, stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'complete' }], usage: { input_tokens: 10, output_tokens: 5 },
      });
    });
    vi.stubGlobal('fetch', peer);
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Read the file' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'read', arguments: { path: 'README.md' } }] },
      { role: 'tool', content: 'file contents', toolCallId: 'call_1' },
    ];
    const client = buildAnthropicMessagesClient(cfg(gateway), model, binding(gateway));
    const result = await client.chat(messages, [{ type: 'function', function: { name: 'read', parameters: { type: 'object' } } }], undefined, { maxOutputTokens: 128 });
    expect(peer).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ content: 'complete', usageKnown: true, billing: { actualUsdMicros: '105' } });
  });

  it('does not retry or silently downgrade after a version rejection', async () => {
    const peer = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: { type: 'invalid_request_error' } }, { status: 400 }));
    vi.stubGlobal('fetch', peer);
    const client = buildAnthropicMessagesClient(cfg(), model, binding(false));
    await expect(client.chat([{ role: 'user', content: 'hello' }], [], undefined, { maxOutputTokens: 128 })).rejects.toThrow('contact-unconfirmed');
    expect(peer).toHaveBeenCalledTimes(1);
    expect(new Headers(peer.mock.calls[0]?.[1]?.headers).get('anthropic-version')).toBe(ANTHROPIC_API_VERSION);
    expect(client.getApiBillingSummary?.()).toMatchObject({ settledRequests: 0, unknownRequests: 1 });
  });

  it.each([200, 403, 404, 429])('versions usage polling and preserves graceful failure (%s)', async status => {
    const peer = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ input_tokens: 10, output_tokens: 5 }, { status }));
    vi.stubGlobal('fetch', peer);
    const result = await resolveUsageWindows(cfg());
    expect(peer).toHaveBeenCalledTimes(1);
    const [url, init] = peer.mock.calls[0]!;
    expect(url).toBe('https://api.anthropic.com/v1/usage');
    expect(new Headers(init?.headers).get('anthropic-version')).toBe(ANTHROPIC_API_VERSION);
    const entry = result.providers.find(provider => provider.provider === 'anthropic');
    expect(entry).not.toHaveProperty('limit');
    if (status === 200) expect(entry?.used).toBe(15);
    else expect(entry).not.toHaveProperty('used');
  });

  it.each(['llama-server', 'ollama'])('warms %s without an Anthropic version claim', async provider => {
    const peer = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ usage: { output_tokens: 4 }, eval_count: 4, eval_duration: 1e9, load_duration: 0 }));
    vi.stubGlobal('fetch', peer);
    const result = await warmLocalModel({
      seatId: 'local', model: 'local-model', ollamaBaseUrl: 'http://127.0.0.1:11434',
      ...(provider === 'llama-server' ? { anthropicBaseUrl: 'http://127.0.0.1:8080' } : {}),
    });
    expect(result.ok).toBe(true);
    expect(peer).toHaveBeenCalledTimes(1);
    const [url, init] = peer.mock.calls[0]!;
    expect(String(url)).toBe(provider === 'llama-server' ? 'http://127.0.0.1:8080/v1/messages' : 'http://127.0.0.1:11434/api/generate');
    expect(new Headers(init?.headers).has('anthropic-version')).toBe(false);
    const body = JSON.parse(String(init?.body));
    if (provider === 'ollama') expect(body.options.temperature).toBe(0);
    else for (const removed of ['temperature', 'top_p', 'top_k']) expect(body).not.toHaveProperty(removed);
  });
});
