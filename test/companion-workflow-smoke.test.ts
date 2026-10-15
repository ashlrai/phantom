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
    expect(resolved.skipReasons.mdopen).toContain('no npm package');
    expect(resolved.packages).toContainEqual({ name: '@ashlr/stack', version: '0.1.1' });
    expect(resolved.packages).toContainEqual({ name: 'locus-cli', version: null });
    expect(smoke.parseArgs(['--prefix', prefix])).toMatchObject({ published: true, prefix });
  });

  it('carries published skip reasons and package versions into the report', async () => {
    const report = await smoke.runSmoke({ skipReasons: { mdopen: 'Ashlr MD has no npm package' }, packages: [{ name: 'x', version: '1' }] });
    expect(report.checks.find((check: { id: string }) => check.id === 'md:mdopen')).toMatchObject({ status: 'skip', detail: 'Ashlr MD has no npm package' });
    expect(report.published.packages).toEqual([{ name: 'x', version: '1' }]);
  });

  it('skips every check, and passes, when no companion binary is given', async () => {
    const report = await smoke.runSmoke({ json: true });
    expect(report.schema).toBe('phm.companion-workflow-smoke/v1');
    expect(report.ok).toBe(true);
    expect(report.checks.length).toBeGreaterThan(0);
    expect(report.checks.every((check: { status: string }) => check.status === 'skip')).toBe(true);
  });
});
