import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { updateProfile, validateProfile, type Connector } from '../src/core/connectors/profile.js';
import { execConnector, planExec, sessionEnv } from '../src/core/connectors/exec.js';
import { cmdConnectors } from '../src/cli/connectors.js';

// Session tokens are phantom's own `phm_` + 64 hex shape; they are not credentials.
const TOKEN_A = 'phm_' + 'a'.repeat(64);
const TOKEN_B = 'phm_' + 'b'.repeat(64);
// Re-enters the real CLI dispatcher; the --project directory is the child's cwd.
const SELF = [process.execPath, '--import', import.meta.resolve('tsx'), resolve('src/cli/index.ts')];

let home: string;
const connector = (fields: Record<string, unknown>): Connector => validateProfile({ version: 1, connectors: [{ id: 'github', kind: 'cli', command: 'gh', tools: ['claude'], lanes: ['work'], ...fields }] }).connectors[0]!;
const save = (...connectors: Connector[]) => updateProfile(() => ({ version: 1, connectors }), home);
async function script(name: string, body: string): Promise<string> {
  const path = join(home, name);
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
  return path;
}
/** A connector command that records its argv and environment, then prints a marker. */
const recorder = () => script('tool.sh', `printf '%s\\n' "$@" > "${home}/argv"; env > "${home}/env"; echo tool-ran`);
const envOf = async () => Object.fromEntries((await readFile(join(home, 'env'), 'utf8')).trim().split('\n').map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));

beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'connector-exec-')); });
afterEach(async () => { vi.unstubAllEnvs(); vi.restoreAllMocks(); await rm(home, { recursive: true, force: true }); });

describe('planExec', () => {
  it('pins the profile command and appends profile then extra args', async () => {
    await save(connector({ args: ['--read-only'] }));
    expect((await planExec('github', { tool: 'claude', lane: 'work' }, ['gh', 'repo', 'list'], home)).argv).toEqual(['gh', '--read-only', 'repo', 'list']);
  });
  it.each<[ { tool: string; lane: string }, string[], string]>([
    [{ tool: 'claude', lane: 'other' }, ['gh'], 'selectors denied'],
    [{ tool: 'cursor', lane: 'work' }, ['gh'], 'selectors denied'],
    [{ tool: '', lane: '' }, ['gh'], 'selectors denied'],
    [{ tool: 'claude', lane: 'work' }, ['/bin/sh', '-c', 'id'], 'connector command exactly'],
    [{ tool: 'claude', lane: 'work' }, ['gh', '--token=opaque'], 'Credential arguments refused'],
    [{ tool: 'claude', lane: 'work' }, ['gh', 'gh' + 'p_' + 'A1'.repeat(20)], 'Secret-shaped'],
  ])('refuses %j %j', async (selectors, cmd, message) => {
    await save(connector({}));
    await expect(planExec('github', selectors, cmd, home)).rejects.toThrow(message);
  });
  it('denies connectors with empty selector lists and kinds without a process', async () => {
    await save(connector({ id: 'open', tools: [], lanes: [] }), validateProfile({ version: 1, connectors: [{ id: 'web', kind: 'mcp-http', url: 'https://example.com/mcp', tools: ['claude'], lanes: ['work'] }] }).connectors[0]!);
    await expect(planExec('open', { tool: 'claude', lane: 'work' }, ['gh'], home)).rejects.toThrow('selectors denied');
    await expect(planExec('web', { tool: 'claude', lane: 'work' }, ['x'], home)).rejects.toThrow('Only cli and mcp-stdio');
    await expect(planExec('missing', { tool: 'claude', lane: 'work' }, ['gh'], home)).rejects.toThrow('not found');
  });
});

describe('sessionEnv', () => {
  const c = connector({ credentials: [{ binding: 'GH_TOKEN', name: 'GITHUB_ACCESS' }] });
  const session = { PATH: '/bin', PHANTOM_PROXY_TOKEN: 'proxy', PHANTOM_SESSION_KEYS: 'GITHUB_ACCESS,OTHER_ACCESS', GITHUB_ACCESS: TOKEN_A, OTHER_ACCESS: TOKEN_B, STRAY: TOKEN_B };
  it('binds only the referenced session token and drops every other one', () => {
    const env = sessionEnv(c, session);
    expect(env.GH_TOKEN).toBe(TOKEN_A);
    expect(env.PHANTOM_SESSION_KEYS).toBe('GH_TOKEN');
    expect(env).not.toHaveProperty('GITHUB_ACCESS');
    expect(env).not.toHaveProperty('OTHER_ACCESS');
    expect(env).not.toHaveProperty('STRAY');
    expect(env.PATH).toBe('/bin');
  });
  it('fails closed outside phantom exec or for a name phantom did not serve', () => {
    expect(() => sessionEnv(c, { ...session, PHANTOM_PROXY_TOKEN: undefined })).toThrow('only under phantom exec');
    expect(() => sessionEnv(c, { ...session, PHANTOM_SESSION_KEYS: 'OTHER_ACCESS' })).toThrow('not served');
    // An ambient value that is not a phantom session token is never forwarded.
    expect(() => sessionEnv(c, { ...session, GITHUB_ACCESS: 'plain-ambient-value' })).toThrow('not served');
  });
});

describe('execConnector', () => {
  it('starts a credential-free connector directly without phantom internals', async () => {
    const tool = await recorder();
    await save(connector({ command: tool, args: ['--read-only'] }));
    const code = await execConnector('github', { tool: 'claude', lane: 'work' }, [tool, 'status'], { home, env: { PATH: process.env.PATH, PHANTOM_VAULT_PASSPHRASE: 'x', PHANTOM_PROXY_TOKEN: 'y' }, phantomBin: '/nonexistent/phantom' });
    expect(code).toBe(0);
    expect(await readFile(join(home, 'argv'), 'utf8')).toBe('--read-only\nstatus\n');
    const env = await envOf();
    expect(env).not.toHaveProperty('PHANTOM_VAULT_PASSPHRASE');
    expect(env).not.toHaveProperty('PHANTOM_PROXY_TOKEN');
  });

  it('launches through phantom exec and the session shim with only bound tokens', async () => {
    const tool = await recorder();
    // Fake phantom: records its argv, then behaves like `phantom exec` toward its child.
    const phantom = await script('fake-phantom', [
      `printf '%s\\n' "$@" > "${home}/phantom-argv"`,
      '[ "$1" = "--quiet" ] && [ "$2" = "exec" ] && [ "$3" = "--" ] || exit 9',
      'shift 3',
      `export PHANTOM_PROXY_TOKEN=proxy PHANTOM_PROXY_PORT=1 PHANTOM_SESSION_KEYS=GITHUB_ACCESS,OTHER_ACCESS GITHUB_ACCESS=${TOKEN_A} OTHER_ACCESS=${TOKEN_B}`,
      'exec "$@"',
    ].join('\n'));
    await save(connector({ command: tool, credentials: [{ binding: 'GH_TOKEN', name: 'GITHUB_ACCESS' }] }));
    const code = await execConnector('github', { tool: 'claude', lane: 'work' }, [tool, 'repo'], { home, env: { ...process.env, HOME: home }, phantomBin: phantom, self: SELF, project: home });
    expect(code).toBe(0);
    const env = await envOf();
    expect(env.GH_TOKEN).toBe(TOKEN_A);
    expect(env).not.toHaveProperty('GITHUB_ACCESS');
    expect(env).not.toHaveProperty('OTHER_ACCESS');
    expect(await readFile(join(home, 'argv'), 'utf8')).toBe('repo\n');
    // Every argv in the chain holds ids, selectors and the executable, never a token.
    const phantomArgv = await readFile(join(home, 'phantom-argv'), 'utf8');
    expect(phantomArgv).toContain('exec-session');
    expect(phantomArgv).not.toMatch(/phm_[0-9a-f]{8}/);
  }, 60_000);

  it('propagates the child exit status and refuses a session without phantom', async () => {
    const failing = await script('fail.sh', 'exit 7');
    await save(connector({ command: failing }));
    expect(await execConnector('github', { tool: 'claude', lane: 'work' }, [failing], { home })).toBe(7);
    await save(connector({ command: failing, credentials: [{ binding: 'GH_TOKEN', name: 'GITHUB_ACCESS' }] }));
    vi.stubEnv('HOME', home);
    vi.stubEnv('PHANTOM_PROXY_TOKEN', '');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdConnectors(['exec-session', 'github', '--tool', 'claude', '--lane', 'work', '--', failing])).toBe(2);
  });

  it('refuses exec-session outside phantom exec through the real CLI entry', async () => {
    const tool = await recorder();
    await save(connector({ command: tool, credentials: [{ binding: 'GH_TOKEN', name: 'GITHUB_ACCESS' }] }));
    const run = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', 'connectors', 'exec-session', 'github', '--tool', 'claude', '--lane', 'work', '--', tool], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home, PHANTOM_PROXY_TOKEN: '', NO_COLOR: '1' },
    });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('only under phantom exec');
  }, 60_000);

  it('rejects a missing, relative or .codex project directory before launch', async () => {
    const tool = await recorder();
    await save(connector({ command: tool }));
    const selectors = { tool: 'claude', lane: 'work' };
    await expect(execConnector('github', selectors, [tool], { home, project: 'relative/dir' })).rejects.toThrow('absolute');
    await expect(execConnector('github', selectors, [tool], { home, project: join(home, '.codex', 'lane') })).rejects.toThrow('.codex');
    await expect(execConnector('github', selectors, [tool], { home, project: join(home, 'missing') })).rejects.toThrow('not found');
    expect(await execConnector('github', selectors, [tool], { home, project: home })).toBe(0);
  });

  it('reports spawn failure with a static message and exit 127', async () => {
    const missing = join(home, 'not-installed-tool');
    await save(connector({ command: missing }));
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(await execConnector('github', { tool: 'claude', lane: 'work' }, [missing], { home })).toBe(127);
    expect(String(err.mock.calls[0]![0])).toContain('could not be started');
    expect(String(err.mock.calls[0]![0])).not.toContain(missing);
  });

  it('keeps stdout byte-for-byte the child output through the real CLI entry', async () => {
    const tool = await recorder();
    await save(connector({ command: tool }));
    const run = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', 'connectors', 'exec', 'github', '--tool', 'claude', '--lane', 'work', '--', tool], { encoding: 'utf8', env: { ...process.env, HOME: home, NO_COLOR: '1' } });
    expect(run.status).toBe(0);
    expect(run.stdout).toBe('tool-ran\n');
  }, 60_000);
});
