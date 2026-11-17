import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse } from 'smol-toml';
import { updateProfile, validateProfile, type Connector } from '../src/core/connectors/profile.js';
import { execConnector, planExec, sessionEnv } from '../src/core/connectors/exec.js';
import { buildClientConfig } from '../src/core/connectors/client-config.js';
import { cmdConnectors } from '../src/cli/connectors.js';

// Session tokens are phantom's own `phm_` + 64 hex shape; they are not credentials.
const TOKEN_A = 'phm_' + 'a'.repeat(64);
const TOKEN_B = 'phm_' + 'b'.repeat(64);
// Absolute loader: the shim runs with the --project directory as its cwd.
const SELF = [process.execPath, '--import', import.meta.resolve('tsx'), resolve('test/fixtures/connectors-cli.ts')];

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
function secretGate(text: string): number | null {
  return spawnSync('perl', ['.github/tests/secret-shape/scrub.pl', '--check'], { input: text, encoding: 'utf8' }).status;
}

beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'connector-exec-')); });
afterEach(async () => { vi.unstubAllEnvs(); vi.restoreAllMocks(); await rm(home, { recursive: true, force: true }); });

describe('planExec', () => {
  it('pins the profile command and appends profile then extra args', async () => {
    await save(connector({ args: ['--read-only'] }));
    expect((await planExec('github', { tool: 'claude', lane: 'work' }, ['gh', 'repo', 'list'], home)).argv).toEqual(['gh', '--read-only', 'repo', 'list']);
  });
  it.each([
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
  }, 30_000);

  it('propagates the child exit status and refuses a session without phantom', async () => {
    const failing = await script('fail.sh', 'exit 7');
    await save(connector({ command: failing }));
    expect(await execConnector('github', { tool: 'claude', lane: 'work' }, [failing], { home })).toBe(7);
    await save(connector({ command: failing, credentials: [{ binding: 'GH_TOKEN', name: 'GITHUB_ACCESS' }] }));
    vi.stubEnv('HOME', home);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdConnectors(['exec-session', 'github', '--tool', 'claude', '--lane', 'work', '--', failing])).toBe(2);
  });

  it('keeps stdout byte-for-byte the child output through the real CLI entry', async () => {
    const tool = await recorder();
    await save(connector({ command: tool }));
    const run = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', 'connectors', 'exec', 'github', '--tool', 'claude', '--lane', 'work', '--', tool], { encoding: 'utf8', env: { ...process.env, HOME: home, NO_COLOR: '1' } });
    expect(run.status).toBe(0);
    expect(run.stdout).toBe('tool-ran\n');
  }, 60_000);
});

describe('client config', () => {
  async function seed() {
    await save(
      ...validateProfile({ version: 1, connectors: [
        { id: 'github', kind: 'mcp-stdio', command: 'github-mcp-server', args: ['stdio'], tools: ['claude', 'codex', 'cursor'], lanes: ['work'], credentials: [{ binding: 'GITHUB_PERSONAL_ACCESS_TOKEN', name: 'GITHUB_ACCESS' }] },
        { id: 'context7', kind: 'mcp-http', url: 'https://mcp.context7.com/mcp', tools: ['claude', 'codex', 'cursor'], lanes: ['work'] },
        { id: 'sentry', kind: 'mcp-http', url: 'https://mcp.sentry.dev/mcp', tools: ['claude'], lanes: ['work'], credentials: [{ binding: 'Authorization', name: 'SENTRY_ACCESS' }] },
        { id: 'gh', kind: 'cli', command: 'gh', tools: ['claude'], lanes: ['work'] },
        { id: 'elsewhere', kind: 'mcp-stdio', command: 'x', tools: ['claude'], lanes: ['home'] },
      ] }).connectors,
    );
  }
  it.each(['claude', 'cursor', 'codex'])('generates a %s config that launches through the wrapper and passes the secret-shape gate', async client => {
    await seed();
    const result = await buildClientConfig(client, 'work', { home, project: '/srv/app' });
    const data = (client === 'codex' ? parse(result.config) : JSON.parse(result.config)) as Record<string, Record<string, Record<string, unknown>>>;
    const servers = data[client === 'codex' ? 'mcp_servers' : 'mcpServers']!;
    expect(servers.github).toEqual({ command: 'phm', args: ['connectors', 'exec', 'github', '--tool', client, '--lane', 'work', '--project', '/srv/app', '--', 'github-mcp-server'] });
    expect(servers.context7!.url).toBe('https://mcp.context7.com/mcp');
    expect(Object.keys(servers).sort()).toEqual(['context7', 'github']);
    expect(result.config).not.toMatch(/GITHUB_ACCESS|SENTRY_ACCESS|env|headers/);
    expect(result.skipped).toEqual(client === 'claude' ? [{ id: 'sentry', reason: expect.stringContaining('HTTP header credentials') }] : []);
    expect(secretGate(result.config)).toBe(0);
    expect(secretGate(JSON.stringify(result))).toBe(0);
  });
  it('rejects unknown clients and relative projects; CLI reports skipped entries with exit 1', async () => {
    await seed();
    await expect(buildClientConfig('vscode', 'work', { home })).rejects.toThrow('--client');
    await expect(buildClientConfig('claude', 'work', { home, project: 'rel' })).rejects.toThrow('absolute');
    vi.stubEnv('HOME', home);
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdConnectors(['config', '--client', 'claude', '--lane', 'work', '--json'])).toBe(1);
    expect(JSON.parse(String(out.mock.calls[0]![0])).servers).toEqual(['github', 'context7']);
    expect(await cmdConnectors(['config', '--client', 'codex', '--lane', 'work', '--json'])).toBe(0);
  });
});
