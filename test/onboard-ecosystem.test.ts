import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { detectEcosystem, metadataName, probeEcosystemLoopback, readMetadataFile, type EcosystemOptions, type ProbeResult } from '../src/core/onboard/ecosystem.js';
import { grantEcosystem } from '../src/core/onboard/ecosystem-grant.js';

let home: string;
let cwd: string;
let bin: string;
let options: EcosystemOptions;
const ok = (value: unknown): ProbeResult => ({ code: 0, stdout: JSON.stringify(value), stderr: '' });
const byId = (plan: Awaited<ReturnType<typeof detectEcosystem>>, id: string) => plan.capabilities.find(row => row.id === id)!;
async function file(path: string, text: string) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, text); }
async function cli(name: string, directory = bin, script = 'exit 0') {
  const path = join(directory, name);
  await file(path, `#!/bin/sh\n${script}\n`); await chmod(path, 0o755); return path;
}
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'ecosystem-onboard-'));
  cwd = join(home, 'example-org', 'example-repo');
  bin = join(home, 'bin');
  await mkdir(cwd, { recursive: true }); await mkdir(bin);
  vi.stubEnv('HOME', home);
  options = { home, cwd, env: { PATH: bin }, probe: vi.fn(async () => false), run: vi.fn(async () => ok([])) };
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); await rm(home, { recursive: true, force: true }); });

describe('ecosystem detection', () => {
  it('is read-only, deterministic and never mistakes missing tools for connected accounts', async () => {
    const before = await readdir(home, { recursive: true });
    const first = await detectEcosystem(options);
    expect(await detectEcosystem(options)).toEqual(first);
    expect(first.phase).toBe('preview');
    expect(byId(first, 'vault').state).toBe('missing');
    expect(byId(first, 'cli:codex:missing')).toMatchObject({ state: 'missing', selected: false });
    expect(options.run).not.toHaveBeenCalled();
    expect(await readdir(home, { recursive: true })).toEqual(before);
  });

  it('finds multiple installations and aliases without running provider login or reading auth files', async () => {
    const second = join(home, 'bin2');
    await cli('claude'); await cli('claude', second); await cli('codex-personal'); await cli('grok'); await cli('devin');
    await file(join(home, '.codex', 'auth.json'), 'private-auth-sentinel');
    options.env!.PATH = `${bin}${delimiter}${second}`;
    const plan = await detectEcosystem(options);
    expect(plan.capabilities.filter(row => row.id.startsWith('cli:claude:'))).toHaveLength(2);
    expect(byId(plan, 'cli:codex-personal:0').state).toBe('detected');
    expect(options.run).not.toHaveBeenCalled();
    expect(JSON.stringify(plan)).not.toContain('private-auth-sentinel');
  });

  it('projects key names, vocabulary, MCP names and installed services while withholding all values', async () => {
    await cli('gh'); await cli('lexicon'); await cli('stack'); await cli('mdopen'); await cli('op');
    options.env!.OPENAI_API_KEY = 'environment-private-sentinel';
    // Host secret-file protection may refuse even synthetic dotenv writes.
    // Supply those bytes through the read seam, retaining the same parser.
    options.read = path => path === join(cwd, '.env') ? Promise.resolve('ANTHROPIC_API_KEY=dotenv-private-sentinel\n') : readMetadataFile(path);
    await file(join(home, '.config', 'grok', 'config.json'), JSON.stringify({ apiKey: 'config-private-sentinel' }));
    await file(join(home, '.claude.json'), JSON.stringify({ mcpServers: { supabase: { env: { secret: 'mcp-private-sentinel' } }, ashlr: {} } }));
    await file(join(cwd, '.lexicon.yaml'), 'version: 1\nterms:\n  - canonical: Example\n    aliases: [private-alias-sentinel]\n');
    const plan = await detectEcosystem(options);
    expect(byId(plan, 'api-keys').names).toEqual(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'XAI_API_KEY']);
    expect(byId(plan, 'lexicon').names).toEqual(['Example']);
    expect(byId(plan, 'connected-mcps').names).toEqual(['ashlr', 'supabase']);
    expect(byId(plan, 'service:supabase').state).toBe('detected');
    expect(byId(plan, 'plugin').state).toBe('detected');
    expect(byId(plan, 'ashlr-md').state).toBe('detected');
    expect(byId(plan, 'import:1password').selected).toBe(false);
    expect(JSON.stringify(plan)).not.toMatch(/private-sentinel|private-alias/);
  });

  it.each(['locked', 'empty', 'populated', 'unknown', 'partial'] as const)('distinguishes vault %s without surfacing diagnostic or entry values', async state => {
    await cli('phantom');
    options.run = vi.fn(async (_command, args) => args[0] === 'status' ? ok({ schema_version: 1, initialized: true })
      : state === 'locked' ? { code: 1, stdout: '', stderr: 'Vault locked: private-vault-sentinel' }
        : state === 'partial' ? { code: 0, stdout: '[]', stderr: 'covers only the OS keychain (0 secrets)' }
          : state === 'unknown' ? { code: 1, stdout: '', stderr: 'private-failure-sentinel' }
            : ok(state === 'empty' ? [] : [{ name: 'OPENAI_API_KEY', value: 'private-entry-sentinel' }]));
    const plan = await detectEcosystem(options);
    expect(byId(plan, 'vault').state).toBe(state === 'partial' ? 'locked' : state);
    expect(byId(plan, 'vault').names).toEqual(state === 'populated' ? ['OPENAI_API_KEY'] : []);
    expect(JSON.stringify(plan)).not.toMatch(/private-.*-sentinel/);
    if (state === 'locked') expect(byId(plan, 'vault').next).toMatch(/Unlock/);
  });

  it('refuses unsupported vault status and malformed names rather than claiming empty', async () => {
    await cli('phantom');
    options.run = vi.fn(async () => ok({ initialized: true }));
    expect(byId(await detectEcosystem(options), 'vault').state).toBe('unknown');
    expect(options.run).toHaveBeenCalledTimes(1);
    options.run = vi.fn(async (_cmd, args) => args[0] === 'status' ? ok({ schema_version: 1, initialized: true }) : ok([{ name: 'sk-' + 'a'.repeat(32) }]));
    expect(byId(await detectEcosystem(options), 'vault').state).toBe('unknown');
    expect(metadataName('sk-' + 'a'.repeat(32))).toBe(false);
  });

  it('reads Locus aliases only and confines Codex config to a regular lane home', async () => {
    await cli('locus');
    options.run = vi.fn(async () => ok([{ alias: 'personal', credential: 'locus-private-sentinel' }]));
    const lane = join(home, '.ashlr-runs', 'codex-personal');
    await file(join(lane, 'config.toml'), '[mcp_servers.github]\ncommand = "gh"\n');
    options.env!.CODEX_HOME = lane;
    expect(byId(await detectEcosystem(options), 'connected-mcps').names).toEqual(['github']);
    expect(byId(await detectEcosystem(options), 'locus').names).toEqual(['personal']);
    await rm(lane, { recursive: true });
    await file(join(home, '.codex', 'config.toml'), '[mcp_servers.forbidden]\ncommand = "private"\n');
    await symlink(join(home, '.codex'), lane, 'dir');
    const plan = await detectEcosystem(options);
    expect(byId(plan, 'connected-mcps').names).toEqual([]);
    expect(JSON.stringify(plan)).not.toContain('locus-private-sentinel');
  });

  it('uses the real bounded names-only subprocess transport against stub CLIs', async () => {
    await cli('phantom', bin, 'case "$1" in status) printf \'{"schema_version":1,"initialized":true}\';; list) printf \'[{"name":"FIXTURE_BINDING"}]\';; *) exit 90;; esac');
    const plan = await detectEcosystem({ ...options, run: undefined });
    expect(byId(plan, 'vault')).toMatchObject({ state: 'populated', names: ['FIXTURE_BINDING'] });
  });

  it('refuses non-loopback URLs and redirects without exposing response content', async () => {
    const fetch = vi.fn(async () => ({ ok: true, body: { cancel: vi.fn() } }));
    vi.stubGlobal('fetch', fetch);
    for (const url of ['https://example.com/v1/models', 'http://localhost:8123/v1/models', 'http://127.0.0.1:8123test@evil.test/v1/models']) expect(await probeEcosystemLoopback(url)).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    expect(await probeEcosystemLoopback('http://127.0.0.1:8123/v1/models')).toBe(true);
    expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:8123/v1/models', expect.objectContaining({ redirect: 'error' }));
  });

  it('rejects symlink and oversized metadata files', async () => {
    const target = join(home, 'metadata'); await file(target, 'private-file');
    await symlink(target, join(home, 'alias'));
    expect(await readMetadataFile(join(home, 'alias'))).toBeNull();
    await file(target, 'x'.repeat(262_145));
    expect(await readMetadataFile(target)).toBeNull();
  });
});

describe('ecosystem bundle grants', () => {
  it('rejects stale, duplicate, unknown, empty and secret-shaped requests before any wiring or state writes', async () => {
    const plan = await detectEcosystem(options);
    const wire = vi.fn();
    for (const input of [
      { planId: '0'.repeat(64), selected: ['vault'] },
      { planId: plan.planId, selected: ['vault', 'vault'] },
      { planId: plan.planId, selected: ['unknown'] },
      { planId: plan.planId, selected: [] },
      { planId: plan.planId, selected: ['sk-' + 'a'.repeat(32)] },
      { planId: plan.planId, selected: ['vault'], credentials: 'never-accept-values' },
    ]) await expect(grantEcosystem(input, { ...options, wire })).rejects.toThrow();
    expect(wire).not.toHaveBeenCalled();
    expect(await readdir(home)).not.toContain('.phantom');
  });

  it('runs only the approved bundle, continues after failure, scrubs private errors and replays a receipt', async () => {
    const plan = await detectEcosystem(options);
    const wire = vi.fn(async (row) => {
      if (row.id === 'vault') throw new Error('private-action-sentinel');
      return { id: row.id, status: 'configured' as const, detail: 'Configured.', next: null };
    });
    const input = { planId: plan.planId, selected: ['vault', 'lexicon'] };
    const receipt = await grantEcosystem(input, { ...options, wire });
    expect(receipt.phase).toBe('incomplete');
    expect(receipt.results.map(row => row.status)).toEqual(['failed', 'configured']);
    expect(JSON.stringify(receipt)).not.toContain('private-action-sentinel');
    expect(await grantEcosystem(input, { ...options, wire })).toEqual(receipt);
    expect(wire.mock.calls.map(([row]) => row.id)).toEqual(['vault', 'lexicon']);
  });

  it('serializes grants to prevent concurrent wiring', async () => {
    const plan = await detectEcosystem(options);
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const wire = vi.fn(async row => { entered(); await pending; return { id: row.id, status: 'configured' as const, detail: 'Configured.', next: null }; });
    const input = { planId: plan.planId, selected: ['vault'] };
    const first = grantEcosystem(input, { ...options, wire });
    await started;
    try { await expect(grantEcosystem(input, { ...options, wire })).rejects.toThrow(/running/); }
    finally { release(); await first; }
    expect(wire).toHaveBeenCalledTimes(1);
  });

  it('wires installed CLI and MCP companions and seeds Lexicon through their native interfaces', async () => {
    for (const name of ['claude', 'locus', 'locus-mcp', 'stack', 'ashlr-stack-mcp', 'lexicon', 'ashlr-mcp']) await cli(name);
    const plan = await detectEcosystem(options);
    const receipt = await grantEcosystem({ planId: plan.planId, selected: ['cli:claude:0', 'locus', 'stack', 'plugin', 'lexicon'] }, options);
    expect(receipt.phase).toBe('complete');
    const settings = JSON.parse(await readFile(join(home, '.ashlr', 'settings.json'), 'utf8'));
    expect(Object.keys(settings.mcpServers)).toEqual(['locus', 'stack', 'ashlr']);
    expect(settings.mcpServers.stack.command).toBe(join(bin, 'ashlr-stack-mcp'));
    expect(await readFile(join(home, '.phantom', 'connectors', 'profile.toml'), 'utf8')).toContain('onboard-claude-0');
    expect(options.run).toHaveBeenCalledWith(join(bin, 'lexicon'), ['add', 'example-repo', '--project', '--json']);
    expect(options.run).toHaveBeenCalledWith(join(bin, 'lexicon'), ['add', 'example-org', '--project', '--json']);
  });

  it('configures a detected loopback endpoint without starting or downloading a model', async () => {
    options.probe = vi.fn(async url => url.includes(':8123/'));
    const plan = await detectEcosystem(options);
    const receipt = await grantEcosystem({ planId: plan.planId, selected: ['local:8123'] }, options);
    expect(receipt.results[0]?.status).toBe('configured');
    const config = JSON.parse(await readFile(join(home, '.ashlr', 'config.json'), 'utf8'));
    expect(config.models.lmstudio).toBe('http://127.0.0.1:8123');
    expect(options.run).not.toHaveBeenCalled();
  });

  it('preserves conflicting MCP registrations and offers imports/unlock instead of extracting secrets', async () => {
    await cli('ashlr-mcp'); await cli('phantom');
    const existing = JSON.stringify({ mcpServers: { ashlr: { command: 'existing-owner-command' } } });
    await file(join(home, '.ashlr', 'settings.json'), existing);
    options.run = vi.fn(async (_cmd, args) => args[0] === 'status' ? ok({ schema_version: 1, initialized: true }) : { code: 1, stdout: '', stderr: 'Vault locked: private-unlock-sentinel' });
    const plan = await detectEcosystem(options);
    const receipt = await grantEcosystem({ planId: plan.planId, selected: ['plugin', 'vault', 'import:1password', 'import:grokbot', 'ashlr-md'] }, options);
    expect(receipt.results.every(row => row.status === 'needs-you')).toBe(true);
    expect(receipt.results.find(row => row.id === 'import:1password')?.next).toContain('phantom import --from 1password');
    expect(await readFile(join(home, '.ashlr', 'settings.json'), 'utf8')).toBe(existing);
    expect(JSON.stringify(receipt)).not.toContain('private-unlock-sentinel');
    expect((options.run as ReturnType<typeof vi.fn>).mock.calls.every(([, args]) => ['status', 'list'].includes(args[0]))).toBe(true);
  });

  it('installs the pinned plugin only behind its explicit selection and does not run lifecycle scripts', async () => {
    for (const name of ['npm', 'bun', 'rg']) await cli(name);
    options.run = vi.fn(async (command, args) => {
      expect(basename(command)).toBe('npm');
      const prefix = args[args.indexOf('--prefix') + 1]!;
      await cli('ashlr-mcp', join(prefix, 'node_modules', '.bin'));
      return ok({});
    });
    const plan = await detectEcosystem(options);
    expect(byId(plan, 'plugin').selected).toBe(false);
    expect(options.run).not.toHaveBeenCalled();
    const receipt = await grantEcosystem({ planId: plan.planId, selected: ['plugin'] }, options);
    expect(receipt.results[0]?.status).toBe('configured');
    expect(options.run).toHaveBeenCalledWith(join(bin, 'npm'), expect.arrayContaining(['--ignore-scripts', 'ashlr-plugin@1.36.4']));
  });
});

describe('ecosystem HTTP grant gate', () => {
  it('requires dispatch, the mutation token and JSON before any grant execution', async () => {
    const { handleApi } = await import('../src/core/web/api.js');
    const { defaultConfig } = await import('../src/core/config.js');
    const request = async (allowDispatch: boolean, headers: Record<string, string>) => {
      const req = Readable.from(['{}']) as IncomingMessage;
      req.method = 'POST'; req.url = '/api/onboard/ecosystem/grant'; req.headers = headers;
      let status = 0; let body = '';
      const res = { writeHead: (code: number) => { status = code; }, end: (text: string) => { body = text; } } as unknown as ServerResponse;
      await handleApi(req, res, defaultConfig(), { token: 'fixture-mutation-token', allowDispatch });
      return { status, body };
    };
    expect((await request(false, {})).status).toBe(404);
    expect((await request(true, {})).status).toBe(401);
    expect((await request(true, { 'x-ashlr-token': 'fixture-mutation-token' })).status).toBe(415);
    const invalid = await request(true, { 'x-ashlr-token': 'fixture-mutation-token', 'content-type': 'application/json' });
    expect(invalid.status).toBe(400);
    expect(invalid.body).toContain('planId');
    expect(await readdir(home)).not.toContain('.phantom');
  }, 20_000);
});
