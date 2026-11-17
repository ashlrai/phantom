import type { SlackBridgeConfig } from './slack-network.js';

/** Values stay inside the host process. This is NOT a vault/proxy client. */
export function injectedSlackCredentialResolver(config: SlackBridgeConfig, env: Readonly<NodeJS.ProcessEnv>) {
  const bot = config.botTokenRef, app = config.appTokenRef;
  const valid = (value: string | undefined, role: 'BOT' | 'APP') =>
    typeof value === 'string' && new RegExp(`^phm_SLACK_(?:AGENTNET_)?${role}_TOKEN(?![\\s\\S])`).test(value);
  return (reference: string): string | undefined => {
    // Validate the requested role only: a bot-only authenticated probe does not
    // require an app credential. Never resolve arbitrary environment names.
    if ((reference === bot && !valid(bot, 'BOT')) || (reference === app && !valid(app, 'APP'))) return undefined;
    if (!((reference === bot && valid(bot, 'BOT')) || (reference === app && valid(app, 'APP')))) return undefined;
    const name = reference.slice(4);
    if (!Object.hasOwn(env, name)) return undefined;
    const value = env[name];
    if (typeof value !== 'string' || value.length === 0 || value.length > 4096 || /\s/.test(value)) return undefined;
    // A named config reference is not an injected credential. Opaque Secrets
    // session tokens remain supported; their proxy setup is the host's job.
    if (/^phm_/i.test(value) && !/^phm_[a-f0-9]{64}(?![\s\S])/.test(value)) return undefined;
    return value;
  };
}
