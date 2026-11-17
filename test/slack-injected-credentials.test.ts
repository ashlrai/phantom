import { describe, expect, it, vi } from 'vitest';
import { injectedSlackCredentialResolver } from '../src/core/agents/slack-credentials.js';
import { createSlackApi } from '../src/core/agents/slack-transport.js';
const config = { bridgeId: 'slack', teamId: 'T0TEAM', botTokenRef: 'phm_SLACK_AGENTNET_BOT_TOKEN', appTokenRef: 'phm_SLACK_AGENTNET_APP_TOKEN', map: [] };
const fake = 'FAKE_EXAMPLE_INJECTED_VALUE';
describe('host-injected Slack references', () => {
  it('reads only the exact configured own environment properties', () => {
    const reads: string[] = [];
    const env = new Proxy({ SLACK_AGENTNET_BOT_TOKEN: fake, SLACK_AGENTNET_APP_TOKEN: fake }, {
      get(target, key) { reads.push(String(key)); return Reflect.get(target, key); },
      ownKeys() { throw new Error('must not enumerate credentials'); },
    });
    const resolve = injectedSlackCredentialResolver(config, env);
    expect(resolve(config.botTokenRef)).toBe(fake);
    expect(resolve('phm_OTHER_SECRET')).toBeUndefined();
    expect(resolve('phm_SLACK_BOT_TOKEN')).toBeUndefined();
    expect(reads).toEqual(['SLACK_AGENTNET_BOT_TOKEN']);
  });
  it('rejects a swapped role or trailing newline in the requested reference', () => {
    for (const botTokenRef of [config.appTokenRef, config.botTokenRef + '\n']) {
      expect(injectedSlackCredentialResolver({ ...config, botTokenRef }, { SLACK_AGENTNET_APP_TOKEN: fake, SLACK_AGENTNET_BOT_TOKEN: fake })(botTokenRef)).toBeUndefined();
    }
  });
  it('preserves bot-only probe and refuses missing app before HTTP', async () => {
    const botOnly = { ...config, appTokenRef: undefined };
    const request = vi.fn(async () => new Response(JSON.stringify({ ok: true })));
    const call = createSlackApi({ config: botOnly, resolveCredential: injectedSlackCredentialResolver(botOnly,
      { SLACK_AGENTNET_BOT_TOKEN: fake }), fetch: request });
    await expect(call('auth.test')).resolves.toMatchObject({ ok: true });
    await expect(call('apps.connections.open', {}, 'app')).rejects.toThrow('slack-credential-unavailable');
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('rejects inherited, missing, malformed and unresolved values without trimming', () => {
    expect(injectedSlackCredentialResolver(config, Object.create({ SLACK_AGENTNET_BOT_TOKEN: fake }))(config.botTokenRef)).toBeUndefined();
    for (const value of [undefined, '', ' ', fake + '\n', 'x'.repeat(4097), config.botTokenRef, 'phm_unknown']) {
      expect(injectedSlackCredentialResolver(config, { SLACK_AGENTNET_BOT_TOKEN: value })(config.botTokenRef)).toBeUndefined();
    }
  });
  it('preserves existing aliases and opaque session tokens without claiming proxy setup', () => {
    const alias = { ...config, botTokenRef: 'phm_SLACK_BOT_TOKEN', appTokenRef: 'phm_SLACK_APP_TOKEN' };
    expect(injectedSlackCredentialResolver(alias, { SLACK_BOT_TOKEN: fake })(alias.botTokenRef)).toBe(fake);
    const opaque = 'phm_' + 'a'.repeat(64);
    expect(injectedSlackCredentialResolver(config, { SLACK_AGENTNET_BOT_TOKEN: opaque })(config.botTokenRef)).toBe(opaque);
  });
  it('rereads current injected value and refuses missing credentials before HTTP', async () => {
    const env: NodeJS.ProcessEnv = { SLACK_AGENTNET_BOT_TOKEN: fake };
    const resolve = injectedSlackCredentialResolver(config, env);
    expect(resolve(config.botTokenRef)).toBe(fake); delete env.SLACK_AGENTNET_BOT_TOKEN;
    const request = vi.fn();
    await expect(createSlackApi({ config, resolveCredential: resolve, fetch: request })('auth.test')).rejects.toThrow('slack-credential-unavailable');
    expect(request).not.toHaveBeenCalled();
  });
});
