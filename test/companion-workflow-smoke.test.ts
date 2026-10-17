/**
 * The cross-tool smoke harness (scripts/companion-workflow-smoke.mjs) must
 * classify real seams correctly. Fake stdio MCP servers stand in for the
 * companion binaries; the real ones are exercised by running the script.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

// @ts-expect-error -- plain ESM script without type declarations
import * as smoke from '../scripts/companion-workflow-smoke.mjs';

const dir = mkdtempSync(join(tmpdir(), 'phm-smoke-test-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function fakeServer(name: string, { tools, answer, noise = false }: { tools: string[]; answer?: string; noise?: boolean }): string {
  const path = join(dir, `${name}.mjs`);
  writeFileSync(path, `
import { createInterface } from 'node:readline';
${noise ? "process.stdout.write('starting server...\\n');" : ''}
createInterface({ input: process.stdin }).on('line', line => {
  const msg = JSON.parse(line);
  if (msg.id === undefined) return;
  const result = msg.method === 'initialize'
    ? { protocolVersion: ${answer ? JSON.stringify(answer) : 'msg.params.protocolVersion'}, capabilities: { tools: {} }, serverInfo: { name: ${JSON.stringify(name)}, version: '1.0.0' } }
    : { tools: ${JSON.stringify(tools)}.map(name => ({ name, inputSchema: { type: 'object' } })) };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n');
});
`);
  return path;
}

const lexicon = smoke.MCP_SERVERS.find((server: { id: string }) => server.id === 'lexicon');

async function handshake(path: string, protocolVersion = '2025-06-18') {
  const env = smoke.smokeEnv(dir);
  const result = await smoke.mcpHandshake(path, { env, cwd: dir, protocolVersion, timeoutMs: 10_000 });
  return smoke.evaluateHandshake(lexicon, protocolVersion, result);
}

describe('companion workflow smoke', () => {
  it('passes a server that echoes the client protocol and lists the required tools', async () => {
    const path = fakeServer('good', { tools: ['normalize_transcript', 'serve_status', 'extra'] });
    await expect(handshake(path)).resolves.toMatchObject({ status: 'pass' });
  });

  it('warns, without failing, when a server answers an older accepted protocol', async () => {
    const path = fakeServer('older', { tools: ['normalize_transcript', 'serve_status'], answer: '2024-11-05' });
    await expect(handshake(path)).resolves.toMatchObject({ status: 'warn' });
  });

  it('fails a server that writes non-protocol text to stdout', async () => {
    const path = fakeServer('noisy', { tools: ['normalize_transcript', 'serve_status'], noise: true });
    const check = await handshake(path);
    expect(check.status).toBe('fail');
    expect(check.detail).toContain('non-JSON');
  });

  it('fails a server missing a tool agents rely on, or answering an unknown protocol', async () => {
    const missing = await handshake(fakeServer('missing', { tools: ['normalize_transcript'] }));
    expect(missing).toMatchObject({ status: 'fail' });
    expect(missing.detail).toContain('serve_status');
    const unknown = await handshake(fakeServer('future', { tools: ['normalize_transcript', 'serve_status'], answer: '2099-01-01' }));
    expect(unknown).toMatchObject({ status: 'fail' });
  });

  it('reports a server that exits during the handshake instead of hanging', async () => {
    const path = join(dir, 'crash.mjs');
    writeFileSync(path, "process.stderr.write('boom'); process.exit(3);\n");
    await expect(smoke.mcpHandshake(path, { env: smoke.smokeEnv(dir), cwd: dir, protocolVersion: '2025-06-18', timeoutMs: 10_000 }))
      .rejects.toThrow(/exited 3|boom/u);
  });

  it('records a server that exits before reading stdin as a failure, not an EPIPE crash', async () => {
    const path = join(dir, 'gone.mjs');
    writeFileSync(path, 'process.exit(0);\n');
    await expect(smoke.mcpHandshake(path, { env: smoke.smokeEnv(dir), cwd: dir, protocolVersion: '2025-06-18', timeoutMs: 10_000 }))
      .rejects.toThrow(/exited|EPIPE|stdin/u);
    // A large input written to a process that never reads it must not crash the smoke.
    const result = await smoke.run(path, [], { env: smoke.smokeEnv(dir), cwd: dir, input: 'x'.repeat(8 * 1024 * 1024), timeoutMs: 10_000 });
    expect(result).toMatchObject({ code: 0, timedOut: false });
  });

  it.skipIf(process.platform === 'win32')('bounds a timeout even when a grandchild holds stdout open', async () => {
    const result = await smoke.run('/bin/sh', ['-c', 'sleep 8 & wait'], { env: smoke.smokeEnv(dir), cwd: dir, timeoutMs: 500 });
    expect(result.timedOut).toBe(true);
    expect(result.ms).toBeLessThan(4_000);
  });

  it.skipIf(process.platform === 'win32')('returns once the child exits even if a background grandchild keeps stdout', async () => {
    const result = await smoke.run('/bin/sh', ['-c', 'sleep 8 & echo done'], { env: smoke.smokeEnv(dir), cwd: dir, timeoutMs: 20_000 });
    expect(result).toMatchObject({ code: 0, timedOut: false });
    expect(result.stdout).toContain('done');
    expect(result.ms).toBeLessThan(4_000);
  });

  it('treats a newer companion release as drift, not a broken seam', () => {
    const reviewedRelease = { version: '0.5.4', sourceCommit: 'x', url: 'u', contract: 'c' };
    expect(smoke.evaluateCompanion({ status: 'known-interface', version: '0.5.4', reviewedRelease, guidance: '' }).status).toBe('pass');
    expect(smoke.evaluateCompanion({ status: 'unsupported-version', version: '0.5.5', reviewedRelease, guidance: '' }).status).toBe('warn');
    expect(smoke.evaluateCompanion({ status: 'wrong-product', version: null, reviewedRelease, guidance: 'g' }).status).toBe('fail');
  });

  it('runs Node entrypoints under this Node and parses explicit binary flags only', () => {
    expect(smoke.commandFor('/x/server.mjs', ['a'])).toEqual([process.execPath, ['/x/server.mjs', 'a']]);
    expect(smoke.commandFor('/x/locus', [])).toEqual(['/x/locus', []]);
    expect(smoke.parseArgs(['--json', '--locus-bin', '/x/locus'])).toMatchObject({ json: true, locusBin: '/x/locus' });
    expect(() => smoke.parseArgs(['--nope'])).toThrow('Unknown argument');
    expect(() => smoke.parseArgs(['--stack-bin'])).toThrow('requires a path');
  });

  it('never inherits credentials or the real home into companion processes', () => {
    const env = smoke.smokeEnv(dir);
    expect(env.HOME).toBe(dir);
    expect(env.LOCUS_HOME).toBe(join(dir, '.locus'));
    for (const key of ['OPENAI_API_KEY', 'GITHUB_TOKEN', 'LOCUS_CONTROL_CAPABILITY', 'PHANTOM_VAULT_PASSPHRASE']) {
      expect(env[key]).toBeUndefined();
    }
  });

  it('resolves published binaries from an npm prefix, keeps explicit flags, and names every gap', () => {
    const prefix = join(dir, 'prefix');
    const pkg = (name: string, version: string, files: string[] = []) => {
      const root = join(prefix, 'node_modules', ...name.split('/'));
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, 'package.json'), JSON.stringify({ name, version }));
      for (const file of files) { mkdirSync(join(root, file, '..'), { recursive: true }); writeFileSync(join(root, file), ''); }
    };
    const bin = join(prefix, 'node_modules', '.bin');
    mkdirSync(bin, { recursive: true });
    const exe = (name: string) => process.platform === 'win32' ? `${name}.cmd` : name;
    for (const name of ['phm', 'phantom', 'lexicon', 'lexicon-mcp', 'stack']) writeFileSync(join(bin, exe(name)), '');
    pkg('@ashlr/phantom', '3.0.0');
    pkg('phantom-secrets', '0.7.9');
    pkg('@ashlr/lexicon', '0.5.4', ['plugin/hook.mjs']);
    pkg('@ashlr/stack', '0.1.1');
    const resolved = smoke.resolvePublished(prefix, { stackBin: '/explicit/stack' });
    expect(resolved.options).toMatchObject({ phm: join(bin, exe('phm')), secretsBin: join(bin, exe('phantom')),
      lexiconBin: join(bin, exe('lexicon')), lexiconMcp: join(bin, exe('lexicon-mcp')),
      lexiconHook: join(prefix, 'node_modules', '@ashlr', 'lexicon', 'plugin', 'hook.mjs') });
    expect(resolved.options.stackBin).toBeUndefined();
    expect(resolved.skipReasons.stackBin).toBeUndefined();
    expect(resolved.skipReasons.locusBin).toBe('locus-cli is not installed');
    expect(resolved.skipReasons.stackMcp).toBe('ashlr-stack-mcp is not installed');
    expect(resolved.skipReasons.mdopen).toBe('Ashlr MD release was not installed');
    expect(resolved.packages).toContainEqual({ name: 'ashlrai/ashlr-md (GitHub release)', version: null });
    expect(resolved.packages).toContainEqual({ name: '@ashlr/stack', version: '0.1.1' });
    expect(resolved.packages).toContainEqual({ name: 'locus-cli', version: null });
    expect(smoke.parseArgs(['--prefix', prefix])).toMatchObject({ published: true, prefix });
  });

  it('resolves Ashlr MD from its unpacked GitHub release, or names why it could not', () => {
    const prefix = join(dir, 'md-prefix');
    const lib = join(prefix, 'ashlr-md', 'root', 'usr', 'lib', 'Ashlr MD');
    mkdirSync(lib, { recursive: true });
    writeFileSync(join(lib, 'mdopen'), '');
    const found = smoke.resolvePublished(prefix, { mdRelease: { version: '0.4.0' } });
    expect(found.options.mdopen).toBe(join(lib, 'mdopen'));
    expect(found.skipReasons.mdopenerMcp).toBe('Ashlr MD 0.4.0 release ships no mdopener-mcp');
    expect(found.packages).toContainEqual({ name: 'ashlrai/ashlr-md (GitHub release)', version: '0.4.0' });
    const failed = smoke.resolvePublished(prefix, { mdRelease: { reason: 'curl exit 6' } });
    expect(failed.options.mdopen).toBeUndefined();
    expect(failed.skipReasons.mdopen).toBe('curl exit 6');
  });

  it('carries published skip reasons and package versions into the report', async () => {
    const report = await smoke.runSmoke({ skipReasons: { mdopen: 'Ashlr MD has no npm package' }, packages: [{ name: 'x', version: '1' }] });
    expect(report.checks.find((check: { id: string }) => check.id === 'md:mdopen')).toMatchObject({ status: 'skip', detail: 'Ashlr MD has no npm package' });
    expect(report.published.packages).toEqual([{ name: 'x', version: '1' }]);
  });

  it('drives the Ashlr.AI Plugin router the way its manifest does and checks an ashlr__grep match', async () => {
    const plugin = join(dir, 'plugin');
    mkdirSync(join(plugin, 'scripts'), { recursive: true });
    // Stands in for scripts/bootstrap.mjs: answers with the files under CLAUDE_PROJECT_DIR that hold the pattern.
    writeFileSync(join(plugin, 'scripts', 'bootstrap.mjs'), `
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
if (process.argv[2] !== 'servers/_router.ts' || process.env.ASHLR_NO_AUTO_INSTALL !== '1') process.exit(4);
createInterface({ input: process.stdin }).on('line', line => {
  const msg = JSON.parse(line);
  if (msg.id === undefined) return;
  let result;
  if (msg.method === 'initialize') result = { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'ashlr-router', version: 'dev' } };
  else if (msg.method === 'tools/list') result = { tools: ['ashlr__grep', 'ashlr__read', 'ashlr__tree'].map(name => ({ name, inputSchema: { type: 'object' } })) };
  else {
    const { pattern, cwd } = msg.params.arguments;
    const hits = cwd === process.env.CLAUDE_PROJECT_DIR ? readdirSync(cwd).filter(file => readFileSync(join(cwd, file), 'utf8').includes(pattern)) : [];
    result = { content: [{ type: 'text', text: hits.map(file => file + ': ' + pattern).join('\\n') || 'no matches for ' + pattern }] };
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n');
});
`);
    const report = await smoke.runSmoke({ pluginDir: plugin });
    const byId = Object.fromEntries(report.checks.map((check: { id: string; status: string }) => [check.id, check.status]));
    expect(byId).toMatchObject({ 'plugin:mcp:2025-06-18': 'pass', 'plugin:mcp:2025-03-26': 'pass', 'plugin:grep': 'pass' });
    expect(smoke.parseArgs(['--plugin-dir', plugin]).pluginDir).toBe(plugin);
    const missing = await smoke.runSmoke({ pluginDir: dir });
    expect(missing.checks.find((check: { id: string }) => check.id === 'plugin:mcp')).toMatchObject({ status: 'fail' });
  });

  it('fails an ashlr__grep result that only echoes the pattern or reports an error', () => {
    const text = (value: string, isError = false) => ({ result: { content: [{ type: 'text', text: value }], ...(isError ? { isError } : {}) } });
    expect(smoke.evaluatePluginGrep(text('no matches for phm_plugin_smoke_needle'))).toMatchObject({ status: 'fail' });
    expect(smoke.evaluatePluginGrep(text('smoke.py: phm_plugin_smoke_needle', true))).toMatchObject({ status: 'fail' });
    expect(smoke.evaluatePluginGrep({ error: { code: -32602 } })).toMatchObject({ status: 'fail' });
    expect(smoke.evaluatePluginGrep(text('{"path":"smoke.py","line":"phm_plugin_smoke_needle = 1"}'))).toMatchObject({ status: 'pass' });
  });

  it('resolves the published ashlr-plugin package as the plugin directory', () => {
    const prefix = join(dir, 'plugin-prefix');
    const root = join(prefix, 'node_modules', 'ashlr-plugin');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'ashlr-plugin', version: '1.36.4' }));
    const resolved = smoke.resolvePublished(prefix);
    expect(resolved.options.pluginDir).toBe(join(root, '.'));
    expect(resolved.packages).toContainEqual({ name: 'ashlr-plugin', version: '1.36.4' });
  });

  it('accepts --cortex-url only as an http(s) URL, kept verbatim', () => {
    expect(smoke.parseArgs(['--cortex-url', 'https://cortex.example/api/mcp'])).toMatchObject({ cortexUrl: 'https://cortex.example/api/mcp' });
    expect(() => smoke.parseArgs(['--cortex-url', 'cortex.example'])).toThrow('http(s) URL');
  });

  it('passes Cortex only on a non-cacheable 401 Bearer challenge that never echoes the token', async () => {
    const { createServer } = await import('node:http');
    let reply = (_auth: string | undefined) => ({ status: 401, headers: { 'www-authenticate': 'Bearer realm="cortex"', 'cache-control': 'no-store' }, body: { jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null } as unknown });
    const server = createServer((req, res) => {
      const answer = reply(req.headers.authorization);
      res.writeHead(answer.status, { 'content-type': 'application/json', ...answer.headers });
      res.end(JSON.stringify(answer.body));
    });
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/mcp`;
    try {
      expect(await smoke.cortexMcpAuth(url)).toMatchObject({ status: 'pass' });
      const base = reply;
      reply = auth => ({ ...base(auth), body: { error: { code: -32001, message: `bad ${auth}` } } });
      expect((await smoke.cortexMcpAuth(url)).detail).toContain('echoed the token');
      reply = auth => ({ ...base(auth), headers: { 'cache-control': 'no-store' } });
      expect((await smoke.cortexMcpAuth(url)).detail).toContain('no Bearer challenge');
      reply = () => ({ status: 503, headers: {}, body: { error: { code: -32002, message: 'no database' } } });
      expect(await smoke.cortexMcpAuth(url)).toMatchObject({ status: 'fail', detail: expect.stringContaining('503 no database') });
      reply = () => ({ status: 200, headers: {}, body: { jsonrpc: '2.0', id: 1, result: {} } });
      expect((await smoke.cortexMcpAuth(url)).detail).toContain('HTTP 200, expected 401');
    } finally {
      server.close();
    }
  });

  it('reads a Locus exec section as resolved only when the child saw the stored value', () => {
    expect(smoke.evaluateLocusCredential('PHM_SMOKE_CRED match\n', 'phm:')).toMatchObject({ status: 'pass' });
    expect(smoke.evaluateLocusCredential('error: credential resolve failed: provider=github source=phantom code=unavailable\nPHM_SMOKE_EXIT 1\n', 'phm:'))
      .toEqual({ status: 'fail', detail: 'the phm: credential did not resolve: error: credential resolve failed: provider=github source=phantom code=unavailable' });
    expect(smoke.evaluateLocusCredential('PHM_SMOKE_CRED different\n', 'env:')).toMatchObject({ status: 'fail', detail: expect.stringContaining('as different') });
    expect(smoke.evaluateLocusCredential('PHM_SMOKE_CRED match\n', 'phm:', 'sk-smoke-NEVER-IN-AGENT-ENV-0123456789abcdef')).toMatchObject({ status: 'fail' });
  });

  it('wires Stack to the Phantom Secrets vault and checks its env diff through CLI and MCP', async () => {
    const bin = join(dir, 'vault-bins');
    mkdirSync(bin, { recursive: true });
    const write = (name: string, body: string) => { writeFileSync(join(bin, name), `#!/usr/bin/env node\n${body}`, { mode: 0o755 }); return join(bin, name); };
    const phantom = write('phantom', `const fs = require('node:fs');
if (process.argv[2] === 'init') fs.writeFileSync('.phantom.toml', '');
if (process.argv[2] === 'add') fs.writeFileSync('.env', process.argv[3] + '=phm_x\\n');`);
    const diff = 'SUPABASE_URL\\nSUPABASE_ANON_KEY\\n';
    const stack = write('stack', `const [cmd, sub] = process.argv.slice(2);
if (cmd === 'status') console.log(JSON.stringify({ phantom: { installed: true, secret_count: require('node:fs').existsSync('.env') ? 1 : 0 } }));
else if (cmd === 'env' && sub === 'diff') { process.stdout.write('${diff}'); process.exit(1); }`);
    const stackMcp = fakeServer('stack-vault', { tools: ['stack_env_diff'] });
    if (process.platform === 'win32') return;
    const report = await smoke.runSmoke({ stackBin: stack, secretsBin: phantom, stackMcp });
    const byId = (id: string) => report.checks.find((check: { id: string }) => check.id === id);
    expect(byId('stack:phantom-vault')).toMatchObject({ status: 'pass' });
    expect(byId('stack:env-diff')).toMatchObject({ status: 'pass' });
    // The fake MCP server answers tools/call with nothing, which is not an env diff.
    expect(byId('stack:mcp-env-diff')).toMatchObject({ status: 'fail' });
    expect(smoke.evaluateEnvDiff('SUPABASE_URL SUPABASE_ANON_KEY OPENAI_API_KEY', 'x')).toMatchObject({ status: 'fail' });
    expect(smoke.evaluateEnvDiff('SUPABASE_URL SUPABASE_ANON_KEY sk-smoke-NEVER-IN-AGENT-ENV-0123456789abcdef', 'x').detail).toContain('printed the stored value');
  });

  it('skips every check, and passes, when no companion binary is given', async () => {
    const report = await smoke.runSmoke({ json: true });
    expect(report.schema).toBe('phm.companion-workflow-smoke/v1');
    expect(report.ok).toBe(true);
    expect(report.checks.length).toBeGreaterThan(0);
    expect(report.checks.every((check: { status: string }) => check.status === 'skip')).toBe(true);
  });
});
