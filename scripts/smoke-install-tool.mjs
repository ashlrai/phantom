#!/usr/bin/env node
// Real public-package dogfood. All tool state and registration stay in a disposable project.
// Run: node --import tsx scripts/smoke-install-tool.mjs
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { performance } from 'node:perf_hooks';
import { clearTimeout, setTimeout } from 'node:timers';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = await mkdtemp(join(tmpdir(), 'phantom-install-smoke-'));
const home = join(root, 'home');
const project = join(root, 'project');
const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, LEXICON_PATH: join(home, 'lexicon.yaml') };
const run = promisify(execFile);
const cli = fileURLToPath(new URL('../src/cli/index.ts', import.meta.url));
const repository = fileURLToPath(new URL('..', import.meta.url));
const execute = async args => {
  const start = performance.now();
  const { stdout } = await run(process.execPath, args, { cwd: repository, env, timeout: 120_000, maxBuffer: 1024 * 1024 });
  return { data: JSON.parse(stdout), elapsedMs: Math.round(performance.now() - start) };
};
const install = extra => execute(['--import', 'tsx', cli, 'install', 'lexicon', '--dir', project, '--json', ...extra]);
const client = new Client({ name: 'phantom-install-smoke', version: '1.0.0' });
let timer;
try {
  await mkdir(home); await mkdir(project);
  const preview = await install(['--dry-run']);
  if (preview.data.status !== 'planned') throw new Error('Preview failed.');
  const first = await install([]);
  const before = await stat(join(project, '.mcp.json'));
  const second = await install([]);
  const after = await stat(join(project, '.mcp.json'));
  if (first.data.status !== 'installed' || second.data.status !== 'unchanged' || before.mtimeMs !== after.mtimeMs) throw new Error('Idempotence failed.');
  const entry = JSON.parse(await readFile(join(project, '.mcp.json'), 'utf8')).mcpServers.lexicon;
  const lexiconCli = entry.args[0].replace('/dist/mcp/server.js', '/dist/cli/index.js');
  await execute([lexiconCli, 'terms', 'add', 'Ashlr.AI', '--heard', 'Ashler', '--json']);
  timer = setTimeout(() => { void client.close(); }, 15_000);
  await client.connect(new StdioClientTransport({ ...entry, cwd: project, env, stderr: 'pipe' }));
  const tools = await client.listTools();
  const call = await client.callTool({ name: 'normalize_transcript', arguments: { text: 'ask Ashler to ship it' } });
  const content = call.content.find(item => item.type === 'text');
  const normalized = JSON.parse(content?.text ?? '{}');
  if (call.isError || normalized.output !== 'ask Ashlr.AI to ship it') throw new Error('MCP correction failed.');
  console.log(JSON.stringify({
    ok: true, repository: 'ashlrai/lexicon', version: first.data.manifest.install.version,
    dryRunMs: preview.elapsedMs, installMs: first.elapsedMs, repeatMs: second.elapsedMs,
    repeatStatus: second.data.status, configUnchanged: before.mtimeMs === after.mtimeMs,
    mcpInitialized: true, toolCount: tools.tools.length, correction: normalized.output,
  }));
} catch {
  console.error('Install smoke failed; private child diagnostics withheld.');
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  await client.close();
  await rm(root, { recursive: true, force: true });
}
