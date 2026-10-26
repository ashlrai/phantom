import { describe, expect, it } from 'vitest';
import { claudeSandboxHostRefusal } from '../src/cli/run-preflight.js';

describe('claudeSandboxHostRefusal', () => {
  it('refuses a sandboxed claude run as root', () => {
    expect(claudeSandboxHostRefusal('claude', true, {}, 0)?.reason).toBe('claude-as-root');
  });

  it('refuses host-managed sign-in without an engine token', () => {
    const env = { CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1' };
    expect(claudeSandboxHostRefusal('claude', true, env, 1000)?.reason).toBe('claude-host-managed-auth');
    expect(claudeSandboxHostRefusal('claude', true, { ...env, CLAUDE_CODE_OAUTH_TOKEN: 'x' }, 1000)).toBeNull();
  });

  it('leaves other engines and unsandboxed runs alone', () => {
    expect(claudeSandboxHostRefusal('codex', true, {}, 0)).toBeNull();
    expect(claudeSandboxHostRefusal('claude', false, {}, 0)).toBeNull();
    expect(claudeSandboxHostRefusal(undefined, true, {}, 0)).toBeNull();
  });
});
