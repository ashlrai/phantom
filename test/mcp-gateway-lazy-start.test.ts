import { afterEach, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const homes: string[] = [];
const clients: Client[] = [];
const registryUrl = new URL('../src/core/verse/process-registry.ts', import.meta.url).href;
const gatewayUrl = new URL('../src/core/mcp-gateway.ts', import.meta.url).href;
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'mcp-lazy-'));
  homes.push(home);
  const script = join(home, 'peer.cjs');
  const log = join(home, 'starts');
  const fail = join(home, 'fail');
  const counts = join(home, 'counts');
  writeFileSync(script, `
    const fs = require('node:fs');
    fs.appendFileSync(${JSON.stringify(log)}, process.pid + '\\n');
    if (fs.existsSync(${JSON.stringify(fail)})) process.exit(1);
    require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
      const m = JSON.parse(line);
      if (m.id === undefined) return;
      const result = m.method === 'initialize'
        ? { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'stub', version: '1' } }
        : m.method === 'tools/list' ? { tools: [{ name: 'echo', inputSchema: { type: 'object' } }] }
        : { content: [{ type: 'text', text: 'ok' }] };
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n');
    });
    process.stdin.on('end', () => process.exit(0));`);
  const spec = { name: 'stub', command: process.execPath, args: [script], source: 'test' };
  const entry = (changed = false) => `import { startGateway } from ${JSON.stringify(gatewayUrl)};
    import { sessionChildPids } from ${JSON.stringify(registryUrl)};
    import { appendFileSync } from 'node:fs';
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk, ...args) => {
      if (String(chunk).includes('gateway ready')) appendFileSync(${JSON.stringify(counts)}, sessionChildPids('mcp:stub').length + '\\n');
      return write(chunk, ...args);
    };
    await startGateway({ servers: [${JSON.stringify({ ...spec, args: changed ? [script, 'changed'] : [script] })}] }, 2000);`;
  const env = { PATH: process.env.PATH!, HOME: home, ASHLR_HOME: join(home, '.ashlr'), ASHLR_NO_HEAL: '1' };
  return { home, script, fail, entry, env, counts: () => readFileSync(counts, 'utf8').trim().split('\n').map(Number), starts: () => readFileSync(log, 'utf8').trim().split('\n').length };
}
async function open(f: ReturnType<typeof fixture>, changed = false) {
  const client = new Client({ name: 'test', version: '1' });
  clients.push(client);
  const transport = new StdioClientTransport({ command: process.execPath,
    args: ['--import', 'tsx', '--input-type=module', '-e', f.entry(changed)], env: f.env, stderr: 'pipe' });
  let stderr = '';
  transport.stderr?.on('data', chunk => { stderr += String(chunk); });
  try { await client.connect(transport); }
  catch (error) { throw new Error(`Stub gateway failed: ${stderr}`, { cause: error }); }
  return client;
}
async function prime(f: ReturnType<typeof fixture>) {
  const client = await open(f);
  expect((await client.listTools()).tools.some(t => t.name === 'stub__echo')).toBe(true);
  await client.close();
  expect(f.starts()).toBe(1);
  const dir = join(f.home, '.ashlr/cache/mcp-tools');
  const cached = JSON.parse(readFileSync(join(dir, readdirSync(dir)[0]!), 'utf8'));
  expect(Object.keys(cached).sort()).toEqual(['tools', 'writtenAt']);
  expect(cached.tools).toEqual([{ name: 'echo', inputSchema: { type: 'object' } }]);
}
afterEach(async () => {
  await Promise.all(clients.splice(0).map(client => client.close()));
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
it('lists cached tools without spawning and shares the first connection across concurrent calls', async () => {
  const f = fixture();
  await prime(f);
  const client = await open(f);
  expect((await client.listTools()).tools.find(t => t.name === 'stub__echo')?.inputSchema).toEqual({ type: 'object' });
  expect(f.starts()).toBe(1);
  expect(f.counts()).toEqual([process.platform === 'win32' ? 1 : 2, 0]);
  const results = await Promise.all(Array.from({ length: 5 }, () => client.callTool({ name: 'stub__echo' })));
  expect(results.every(r => !r.isError)).toBe(true);
  expect(f.starts()).toBe(2);
}, 60_000);
it('rediscovers a changed downstream spec and an updated server file', async () => {
  const f = fixture();
  await prime(f);
  await (await open(f, true)).close();
  expect(f.starts()).toBe(2);
  appendFileSync(f.script, '\n// server version 2\n');
  await open(f, true);
  expect(f.starts()).toBe(3);
}, 60_000);
it('rediscovers an expired cache', async () => {
  const f = fixture();
  await prime(f);
  const dir = join(f.home, '.ashlr/cache/mcp-tools');
  for (const file of readdirSync(dir)) {
    const path = join(dir, file);
    const entry = JSON.parse(readFileSync(path, 'utf8'));
    entry.writtenAt = 0;
    writeFileSync(path, JSON.stringify(entry));
  }
  await open(f);
  expect(f.starts()).toBe(2);
}, 60_000);
it('returns a tool error on failed lazy startup and retries on the next call', async () => {
  const f = fixture();
  await prime(f);
  writeFileSync(f.fail, 'fail');
  const client = await open(f);
  expect((await client.callTool({ name: 'stub__echo' })).isError).toBe(true);
  rmSync(f.fail);
  expect((await client.callTool({ name: 'stub__echo' })).isError).not.toBe(true);
  expect(f.starts()).toBe(3);
}, 60_000);
it('exits on stdin EOF with no spawned downstream', async () => {
  const f = fixture();
  await prime(f);
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', f.entry()], { env: { ...getDefaultEnvironment(), ...f.env }, stdio: ['pipe', 'ignore', 'pipe'] });
  const done = once(child, 'exit', { signal: AbortSignal.timeout(30_000) });
  child.stderr.resume();
  child.stdin.end();
  expect(await done).toEqual([0, null]);
  expect(f.starts()).toBe(1);
}, 60_000);
