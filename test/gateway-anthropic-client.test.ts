/**
 * Governed-client gateway slice B: Anthropic Messages client.
 *
 * The client keeps the first-party endpoint unless `gateways.anthropic` is
 * explicitly enabled and validates. Grant admission, output caps, the price
 * table and strict response parsing are unchanged. The ledger row and the
 * returned billing record carry `gateway: { via: 'gateway', host }` (host only)
 * for gateway requests and nothing new for first-party requests.
 *
 * Hermetic: in-process fetch stand-in, temp ledger dir, no sockets.
 */
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AshlrConfig, ChatMessage } from '../src/core/types.js';
import type { FreshClaudeApiGrantProof } from '../src/core/resources/claude-api-grant-types.js';
import { createClaudeApiGrantAdmission, CLAUDE_API_GRANT_LEDGER_FILE } from '../src/core/resources/claude-api-grant.js';
import { buildAnthropicMessagesClient, type ClaudeApiExecutionBinding } from '../src/core/run/anthropic-client.js';

const key = 'disposable-gateway-test-key-0123456789';
const secret = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('../src/core/integrations/secrets.js', () => ({ resolveProviderKey: secret.read }));
const model = 'claude-sonnet-4-6';
const firstParty = 'https://api.anthropic.com/v1/messages';
const messages: ChatMessage[] = [{ role: 'user', content: 'test goal' }];
const limits = { maxOutputTokens: 128 };
const baseCfg = (gateways?: unknown): AshlrConfig => ({
  version: 1, roots: [], models: {}, foundry: { allowedBackends: ['claude-api'] },
  ...(gateways === undefined ? {} : { gateways }),
} as unknown as AshlrConfig);

let root: string; let binding: ClaudeApiExecutionBinding;
function ledgerRows(): Array<Record<string, unknown>> {
  return JSON.parse(readFileSync(join(root, CLAUDE_API_GRANT_LEDGER_FILE), 'utf8')).rows;
}
function reply(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: 'message', id: 'msg_Gw1', role: 'assistant', model, stop_reason: 'end_turn', stop_sequence: null,
    content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 10, output_tokens: 5 }, ...over };
}
interface Seen { url: string; headers: Record<string, string>; redirect: RequestRedirect | undefined }
/**
 * In-process fetch stand-in (no socket, so the file stays in the fast lane).
 * It records exactly where the key went. 'redirect' rejects the way fetch
 * does for a 3xx under redirect: 'error'.
 */
function peerFetch(handler: () => Record<string, unknown> | 'redirect' = () => reply()) {
  const seen: Seen[] = [];
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    seen.push({ url: String(url), headers: { ...(init?.headers as Record<string, string>) }, redirect: init?.redirect });
    // The durable pre-contact state is already 'sent' when the peer is reached.
    expect(ledgerRows().at(-1)?.state).toBe('sent');
    const result = handler();
    if (result === 'redirect') throw new TypeError('fetch failed: redirect mode is set to error');
    return Response.json(result);
  });
  return { seen, spy };
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'gateway-anthropic-ledger-'))); chmodSync(root, 0o700);
  const now = Date.now(); const stamp = new Date(now).toISOString();
  const proof: FreshClaudeApiGrantProof = { observation: { v: 1, kind: 'claude-api-promotion', observationId: 'observation-one', cycleId: 'cycle-one',
    binding: { organizationDigest: 'a'.repeat(64), workspaceDigest: 'b'.repeat(64), credentialDigest: createHash('sha256').update(key).digest('hex'), generation: 'generation-one' },
    remainingUsdMicros: '10000000', totalUsdMicros: '10000000', capturedAt: stamp,
    expiry: { precision: 'date', date: new Date(now + 86_400_000).toISOString().slice(0, 10), timezone: 'UTC', instant: null }, evidenceDigest: 'c'.repeat(64) },
    observedAt: stamp, validUntil: new Date(now + 60_000).toISOString(),
    funding: { source: 'verified-provider-billing', prepaid: true, invoiced: false, autoReload: 'off', purchasedUsdMicros: '0', otherPaidFunding: false },
    authority: { active: true, stop: false, localOnly: false, engineEnabled: true, repoAuthorized: true, roleAuthorized: true, meteredCeilingUsdMicros: '10000000', dailyRemainingUsdMicros: '10000000', identityDigest: 'd'.repeat(64) } };
  const readFreshProof = () => structuredClone(proof);
  const admission = createClaudeApiGrantAdmission({ expectedBinding: proof.observation.binding, readFreshProof });
  if (!admission.ok) throw new Error(admission.reason);
  binding = { ledgerRoot: root, admission: admission.value, expectedBinding: proof.observation.binding, readFreshProof };
  secret.read.mockReset(); secret.read.mockReturnValue(key);
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['ANTHROPIC_BASE_URL'];
  rmSync(root, { recursive: true, force: true });
});

describe('anthropic client: defaults unchanged', () => {
  it('no gateways block: fixed first-party endpoint, no gateway marker anywhere', async () => {
    const peer = peerFetch();
    process.env['ANTHROPIC_BASE_URL'] = 'http://127.0.0.1:9/hostile';
    const result = await buildAnthropicMessagesClient(baseCfg(), model, binding).chat(messages, [], undefined, limits);
    expect(peer.seen.map(call => [call.url, call.redirect])).toEqual([[firstParty, 'error']]);
    expect(result.billing).not.toHaveProperty('gateway');
    expect(ledgerRows()[0]).not.toHaveProperty('gateway');
    expect(Object.keys(ledgerRows()[0]!).sort()).toEqual(['actualUsdMicros', 'binding', 'createdAt', 'cycleId', 'heldUsdMicros', 'id', 'maxUsdMicros', 'pricingDigest', 'providerRequestId', 'state']);
  });

  it.each([
    ['enabled false', { anthropic: { enabled: false, baseUrl: 'http://127.0.0.1:9' } }],
    ['enabled string', { anthropic: { enabled: 'true', baseUrl: 'http://127.0.0.1:9' } }],
    ['other client only', { openaiAgents: { enabled: true, baseUrl: 'http://127.0.0.1:9' } }],
  ])('%s keeps first-party', async (_label, gateways) => {
    const spy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('stop'));
    await expect(buildAnthropicMessagesClient(baseCfg(gateways), model, binding).chat(messages, [], undefined, limits)).rejects.toThrow();
    expect(spy.mock.calls[0]?.[0]).toBe(firstParty);
  });
});

describe('anthropic client: explicit loopback gateway', () => {
  it('sends to the configured target only, settles with the pinned price, records host only', async () => {
    const peer = peerFetch();
    const cfg = baseCfg({ anthropic: { enabled: true, baseUrl: 'http://127.0.0.1:4555/gw/prefix' } });
    const result = await buildAnthropicMessagesClient(cfg, model, binding).chat(messages, [], undefined, limits);
    expect(peer.seen).toHaveLength(1);
    expect(peer.seen[0]).toMatchObject({ url: 'http://127.0.0.1:4555/gw/prefix/v1/messages', redirect: 'error' });
    expect(peer.seen[0]!.headers['x-api-key']).toBe(key);
    // 10 in * 3 + 5 out * 15 microUSD, from the unchanged first-party table.
    expect(result.billing).toMatchObject({ actualUsdMicros: '105', requestId: 'msg_Gw1' });
    expect(result.billing!.gateway).toEqual({ via: 'gateway', host: '127.0.0.1' });
    expect(ledgerRows()[0]).toMatchObject({ state: 'settled', actualUsdMicros: '105', gateway: { via: 'gateway', host: '127.0.0.1' } });
    const persisted = readFileSync(join(root, CLAUDE_API_GRANT_LEDGER_FILE), 'utf8');
    expect(persisted).not.toContain(key);
    expect(persisted).not.toContain('/gw/prefix');
    expect(persisted).not.toContain('4555');
    expect(JSON.stringify(result)).not.toContain(key);
  });

  it('a second request on the same ledger settles too (gateway rows reload and validate)', async () => {
    let n = 0;
    peerFetch(() => reply({ id: `msg_Gw${++n}` }));
    const cfg = baseCfg({ anthropic: { enabled: true, baseUrl: 'http://127.0.0.1:4555' } });
    const client = buildAnthropicMessagesClient(cfg, model, binding);
    await client.chat(messages, [], undefined, limits);
    await client.chat(messages, [], undefined, limits);
    expect(ledgerRows().map(row => [row.state, row.providerRequestId, row.gateway])).toEqual([
      ['settled', 'msg_Gw1', { via: 'gateway', host: '127.0.0.1' }],
      ['settled', 'msg_Gw2', { via: 'gateway', host: '127.0.0.1' }],
    ]);
    expect(client.getApiBillingSummary?.()).toMatchObject({ settledUsdMicros: '210', settledRequests: 2 });
  });

  it('a redirect from the gateway fails closed and is not followed', async () => {
    const peer = peerFetch(() => 'redirect');
    const cfg = baseCfg({ anthropic: { enabled: true, baseUrl: 'http://127.0.0.1:4555' } });
    await expect(buildAnthropicMessagesClient(cfg, model, binding).chat(messages, [], undefined, limits)).rejects.toThrow('contact-unconfirmed');
    expect(peer.seen).toHaveLength(1);
    expect(ledgerRows()[0]).toMatchObject({ state: 'unknown', gateway: { via: 'gateway', host: '127.0.0.1' } });
  });

  it('a gateway response with an unfamiliar usage shape fails closed', async () => {
    peerFetch(() => reply({ usage: { input_tokens: 10, output_tokens: 5, gateway_cost: 1 } }));
    const cfg = baseCfg({ anthropic: { enabled: true, baseUrl: 'http://127.0.0.1:4555' } });
    await expect(buildAnthropicMessagesClient(cfg, model, binding).chat(messages, [], undefined, limits)).rejects.toThrow('contact-unconfirmed');
  });
});

describe('anthropic client: refusals before any contact', () => {
  it('opted-in invalid target refuses at build with a closed reason and no input echo', () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    for (const baseUrl of ['http://localhost:4000', 'https://SECRETUSER:SECRETPASS@gw.example.com', 'http://gw.example.com', 'https://gw.example.com']) {
      // The last case names a host that is not on the (absent) allowlist.
      const allowedHosts = baseUrl === 'https://gw.example.com' ? undefined : ['gw.example.com:443'];
      const cfg = baseCfg({ anthropic: { enabled: true, baseUrl, ...(allowedHosts ? { allowedHosts } : {}) } });
      let message = '';
      try { buildAnthropicMessagesClient(cfg, model, binding); } catch (error) { message = (error as Error).message; }
      expect(message).toBe('Claude API held: gateway-config-invalid');
      expect(message).not.toContain('SECRET');
    }
    expect(spy).not.toHaveBeenCalled();
    expect(secret.read).not.toHaveBeenCalled();
  });

  it('unknown keys such as headers or ca refuse', () => {
    for (const extra of [{ headers: { a: 'b' } }, { ca: 'pem' }]) {
      const cfg = baseCfg({ anthropic: { enabled: true, baseUrl: 'http://127.0.0.1:4000', ...extra } });
      expect(() => buildAnthropicMessagesClient(cfg, model, binding)).toThrow('gateway-config-invalid');
    }
  });

  it('pricing, engine and output-limit refusals are unchanged with a gateway configured', async () => {
    const gateways = { anthropic: { enabled: true, baseUrl: 'http://127.0.0.1:4000' } };
    const spy = vi.spyOn(globalThis, 'fetch');
    expect(() => buildAnthropicMessagesClient(baseCfg(gateways), 'claude-unknown-model', binding)).toThrow('pricing-unknown');
    expect(() => buildAnthropicMessagesClient({ ...baseCfg(gateways), foundry: {} } as AshlrConfig, model, binding)).toThrow('engine-disabled');
    const client = buildAnthropicMessagesClient(baseCfg(gateways), model, binding);
    await expect(client.chat(messages, [], undefined, undefined)).rejects.toThrow('output-limit-required');
    await expect(client.chat(messages, [], undefined, { maxOutputTokens: 10_000_000 })).rejects.toThrow('output-limit-required');
    expect(spy).not.toHaveBeenCalled();
  });

  it('a config change after build refuses before contact and releases the hold', async () => {
    const cfg = baseCfg({ anthropic: { enabled: true, baseUrl: 'http://127.0.0.1:4000' } }) as unknown as { gateways: { anthropic: { baseUrl: string } } };
    const client = buildAnthropicMessagesClient(cfg as unknown as AshlrConfig, model, binding);
    cfg.gateways.anthropic.baseUrl = 'http://127.0.0.1:4001';
    const spy = vi.spyOn(globalThis, 'fetch');
    await expect(client.chat(messages, [], undefined, limits)).rejects.toThrow('gateway-config-changed');
    expect(spy).not.toHaveBeenCalled();
    expect(secret.read).not.toHaveBeenCalled();
  });

  it('a credential digest mismatch still refuses before contact', async () => {
    secret.read.mockReturnValue('a-different-key');
    const spy = vi.spyOn(globalThis, 'fetch');
    const cfg = baseCfg({ anthropic: { enabled: true, baseUrl: 'http://127.0.0.1:4000' } });
    await expect(buildAnthropicMessagesClient(cfg, model, binding).chat(messages, [], undefined, limits)).rejects.toThrow('credential-binding-changed');
    expect(spy).not.toHaveBeenCalled();
    expect(ledgerRows()[0]).toMatchObject({ state: 'released' });
  });
});

describe('anthropic client: https gateway on a listed host', () => {
  it('uses the exact listed origin and keeps redirect error', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('stop'));
    const cfg = baseCfg({ anthropic: { enabled: true, baseUrl: 'https://gw.example.com/anthropic', allowedHosts: ['gw.example.com:443'] } });
    await expect(buildAnthropicMessagesClient(cfg, model, binding).chat(messages, [], undefined, limits)).rejects.toThrow('contact-unconfirmed');
    expect(spy.mock.calls[0]![0]).toBe('https://gw.example.com/anthropic/v1/messages');
    expect(spy.mock.calls[0]![1]?.redirect).toBe('error');
    expect(ledgerRows()[0]).toMatchObject({ state: 'unknown', gateway: { via: 'gateway', host: 'gw.example.com' } });
  });
});
