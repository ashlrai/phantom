/** Stub `claude` launcher only: never runs the real CLI or reads real authentication. */
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runAuthorityCli } from '../src/cli/authority.js';
import { checkClaudeAuth, renewClaudeToken } from '../src/core/resources/claude-resignin.js';

let root: string;
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-claude-resignin-test-'))); });
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

// Mirrors native `claude auth status --json`: exit 0 signed in, exit 1 signed out.
function stub(loggedIn: boolean): string[] {
  const bin = join(root, loggedIn ? 'claude-valid' : 'claude-out');
  const body = loggedIn ? '{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max"}'
    : '{"loggedIn":false,"authMethod":"none"}';
  writeFileSync(bin, `#!/bin/sh\n[ "$1 $2" = "auth status" ] || exit 9\nprintf '%s' '${body}'\nexit ${loggedIn ? 0 : 1}\n`);
  chmodSync(bin, 0o755);
  return [bin];
}
const scratch = (): string => realpathSync(mkdtempSync(join(root, 'cwd-')));

// Built at runtime from fragments so no secret-shaped literal sits in the source.
const fixtureToken = ['fixture', 'opaque', 'value'].join('-') + 'x'.repeat(24);

describe('Claude auth state from the CLI auth-status exit code', () => {
  it('valid: exit 0', async () => {
    expect(await checkClaudeAuth({ command: stub(true), cwd: scratch() })).toMatchObject({ state: 'valid' });
  });
  it('expired: exit 1 with a credential entry seen', async () => {
    const check = await checkClaudeAuth({ command: stub(false), cwd: scratch(), credentialSeen: true });
    expect(check.state).toBe('expired');
    expect(check.message).toContain('Claude auth expired: needs re-sign-in');
  });
  it('missing: exit 1 with no credential entry', async () => {
    const check = await checkClaudeAuth({ command: stub(false), cwd: scratch(), credentialSeen: false });
    expect(check.state).toBe('missing');
    expect(check.message).not.toContain('expired');
  });
  it('unknown when the CLI cannot be run', async () => {
    expect((await checkClaudeAuth({ command: [join(root, 'absent')], cwd: scratch() })).state).toBe('unknown');
  });
});

describe('Claude token renewal', () => {
  it('prompts once and hands the value only to custody', async () => {
    const readSecret = vi.fn(async () => `  ${fixtureToken}\n`);
    const storeClaudeToken = vi.fn(async () => undefined);
    await renewClaudeToken({ readSecret, storeClaudeToken });
    expect(readSecret).toHaveBeenCalledTimes(1);
    expect(storeClaudeToken).toHaveBeenCalledExactlyOnceWith(fixtureToken);
  });
  it('refuses an empty entry without storing', async () => {
    const storeClaudeToken = vi.fn();
    await expect(renewClaudeToken({ readSecret: async () => ' ', storeClaudeToken })).rejects.toThrow('nothing was entered');
    expect(storeClaudeToken).not.toHaveBeenCalled();
  });
  it('CLI never prints the token, even when custody rejects it', async () => {
    // Resolve `claude` to the signed-out stub only; /usr/bin is for `which`.
    vi.stubEnv('PATH', `${root}:/usr/bin:/bin`);
    const lines: string[] = [];
    const sink = (line: string) => { lines.push(line); };
    writeFileSync(join(root, 'claude'), readFileSync(stub(false)[0]!)); chmodSync(join(root, 'claude'), 0o755);
    const code = await runAuthorityCli(['claude-signin'], {
      out: sink, err: sink, readSecret: async () => fixtureToken,
      custody: { storeClaudeToken: async () => { throw new Error('that does not look like a Claude setup token'); } } as never,
    });
    expect(code).toBe(1);
    expect(lines.join('\n')).not.toContain(fixtureToken);
    expect(lines.join('\n')).toContain('Claude token not stored');
  });
});
