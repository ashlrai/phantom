/**
 * Upstream error bodies that echo the caller's key must never carry it into a
 * thrown error or a result detail. Pattern scrubbing (scrubSecrets) catches
 * known key shapes; these keys are opaque (no vendor prefix), so only
 * redaction of the value actually sent can catch them. No network: every
 * fetch is injected or stubbed.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DevinClient } from '../src/core/devin/client.js';
import { buildOpenAICompatibleClient } from '../src/core/run/provider-client.js';
import { locateVisualTargets } from '../src/core/visual/grounding.js';
import { fakeDevin } from './helpers/fake-devin.js';

const HEX_KEY = '9f8e7d6c5b4a39281706f5e4d3c2b1a0';
const GATEWAY_KEY = 'local-gateway-key-FAKE-2026';
const DEVIN_OPAQUE_KEY = 'Zq7mW2pLx9Rt4Vb8Nc3Kd6Hf';

/** True when any 8-character run of `key` appears in `text`. */
function leaksFragment(text: string, key: string): boolean {
  for (let i = 0; i + 8 <= key.length; i += 1) {
    if (text.includes(key.slice(i, i + 8))) return true;
  }
  return false;
}

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env['PHANTOM_TEST_GROUNDING_KEY'];
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function openAiEcho(key: string): string {
  return JSON.stringify({ error: { message: `Incorrect API key provided: ${key}. You can find your API key at the dashboard.`, type: 'invalid_request_error', code: 'invalid_api_key' } });
}

describe('OpenAI-compatible client: 401 body that echoes the key', () => {
  for (const key of [HEX_KEY, GATEWAY_KEY]) {
    it(`redacts an echoed opaque key (${key.length} chars) from the thrown error`, async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(openAiEcho(key), { status: 401 })));
      const client = buildOpenAICompatibleClient('http://127.0.0.1:9/v1', key, 'm', false);
      const err = await client.chat([{ role: 'user', content: 'hi' }]).then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      const message = (err as Error).message;
      expect(message).toContain('OpenAI-compat HTTP 401');
      expect(message).toContain('Incorrect API key provided');
      expect(leaksFragment(message, key)).toBe(false);
    });
  }

  it('redacts a partial echo (a long middle run of the key)', async () => {
    const partial = HEX_KEY.slice(4, 20);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(openAiEcho(`****${partial}****`), { status: 401 })));
    const client = buildOpenAICompatibleClient('http://127.0.0.1:9/v1', HEX_KEY, 'm', false);
    const err = await client.chat([{ role: 'user', content: 'hi' }]).then(() => null, (e: unknown) => e);
    expect(leaksFragment((err as Error).message, HEX_KEY)).toBe(false);
  });
});

describe('visual grounding: provider error body that echoes the key', () => {
  it('redacts the key read from apiKeyEnv out of the failure detail', async () => {
    process.env['PHANTOM_TEST_GROUNDING_KEY'] = GATEWAY_KEY;
    const dir = mkdtempSync(join(tmpdir(), 'ground-echo-'));
    dirs.push(dir);
    const imagePath = join(dir, 'shot.png');
    writeFileSync(imagePath, Buffer.from('89504e470d0a1a0a', 'hex'));
    const fetch = vi.fn(async () => ({ ok: false, status: 401, statusText: 'Unauthorized', text: async () => openAiEcho(GATEWAY_KEY) }));
    const result = await locateVisualTargets(
      { imagePath, query: 'Find deploy button' },
      { foundry: { visualGrounding: { enabled: true, provider: 'generic-openai-vision', endpoint: 'http://127.0.0.1:8000/v1', apiKeyEnv: 'PHANTOM_TEST_GROUNDING_KEY' } } } as never,
      { fetch: fetch as never },
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('HTTP 401');
    expect(leaksFragment(JSON.stringify(result), GATEWAY_KEY)).toBe(false);
  });
});

describe('Devin client: problem detail that echoes the key', () => {
  it('redacts an echoed key without a cog_ prefix from the error message', async () => {
    const f = fakeDevin();
    const client = new DevinClient({ apiKey: DEVIN_OPAQUE_KEY, fetch: f.fetch, sleep: async () => undefined, retries: 0, baseUrl: 'https://api.devin.ai/v3' });
    const err = await client.getSelf().then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toContain('Devin said: Invalid key');
    expect(leaksFragment(message, DEVIN_OPAQUE_KEY)).toBe(false);
  });
});
