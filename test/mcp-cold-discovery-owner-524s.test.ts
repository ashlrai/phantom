// RQ-PHX-MCPCOLDOWNER524S: opt-in `--lazy` gateway, cold cache, fake stdio downstream.
// Source-level evidence only; says nothing about CPU savings or installed adoption.
import { afterEach, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdMcp } from '../src/cli/mcp.js';

const homes: string[] = [];
const clients: Client[] = [];
const gatewayUrl = new URL('../src/core/mcp-gateway.ts', import.meta.url).href;

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'mcp-cold-'));
  homes.push(home);
  const script = join(home, 'peer.cjs');
  const log = join(home, 'events');
  // One line per spawn / initialize / tools/list / tools/call, plus shutdown.
  writeFileSync(script, `
    const fs = require('node:fs');
    const note = (t) => fs.appendFileSync(${JSON.stringify(log)}, t + '\\n');
    note('spawn'); note('pid ' + process.pid);
    require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
      const m = JSON.parse(line);
      if (m.id === undefined) return;
      note(m.method);
      const result = m.method === 'initialize'
        ? { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'stub', version: '1' } }
        : m.method === 'tools/list' ? { tools: [{ name: 'echo', inputSchema: { type: 'object' } }] }
        : { content: [{ type: 'text', text: 'ok' }] };
      setTimeout(() => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n'), 50);
    });
    process.stdin.on('end', () => process.exit(0));`);
  const spec = { name: 'stub', command: process.execPath, args: [script], source: 'test' };
  const entry = (lazy: boolean) => `import { startGateway } from ${JSON.stringify(gatewayUrl)};
    await startGateway({ servers: [${JSON.stringify(spec)}] }, 5000, { lazy: ${lazy} });`;
  const env = { PATH: process.env.PATH!, HOME: home, ASHLR_HOME: join(home, '.ashlr'), ASHLR_NO_HEAL: '1' };
  const events = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []);
  const pids = () => events().filter(e => e.startsWith('pid ')).map(e => Number(e.slice(4)));
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const count = (name: string) => events().filter(e => e === name).length;
  return { home, entry, env, events, count, pids, alive };
}

async function open(f: ReturnType<typeof fixture>, lazy: boolean) {
  const client = new Client({ name: 'test', version: '1' });
  clients.push(client);
  const transport = new StdioClientTransport({ command: process.execPath,
    args: ['--import', 'tsx', '--input-type=module', '-e', f.entry(lazy)], env: f.env, stderr: 'pipe' });
  let stderr = '';
  transport.stderr?.on('data', chunk => { stderr += String(chunk); });
  try { await client.connect(transport); }
  catch (error) { throw new Error(`Gateway failed: ${stderr}`, { cause: error }); }
  return client;
}

const text = (r: unknown): string => JSON.stringify((r as { content?: unknown }).content);

afterEach(async () => {
  await Promise.all(clients.splice(0).map(client => client.close()));
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

it('cold lazy gateway spawns nothing until discover, then routes tool calls', async () => {
  const f = fixture();
  const client = await open(f, true);
  const listed = (await client.listTools()) as { tools: { name: string }[]; _meta?: Record<string, any> };
  expect(f.count('spawn')).toBe(0);
  expect(listed.tools.map(t => t.name)).toContain('ashlr__discover');
  expect(listed.tools.some(t => t.name === 'stub__echo')).toBe(false);
  expect(listed._meta?.['ashlr/discovery'].servers).toEqual([{ name: 'stub', status: 'deferred', lastKnownToolCount: null }]);

  // Bad discover arguments are rejected without starting anything.
  await expect(client.callTool({ name: 'ashlr__discover', arguments: { server: 'nope' } })).rejects.toThrow(/configured server/);
  await expect(client.callTool({ name: 'ashlr__discover', arguments: { server: 'stub', extra: 1 } })).rejects.toThrow(/configured server/);
  expect(f.count('spawn')).toBe(0);

  const discovered = await client.callTool({ name: 'ashlr__discover', arguments: { server: 'stub' } });
  expect(discovered.isError).not.toBe(true);
  expect([f.count('spawn'), f.count('initialize'), f.count('tools/list')]).toEqual([1, 1, 1]);
  expect((await client.listTools()).tools.map(t => t.name)).toContain('stub__echo');
  expect([f.count('spawn'), f.count('initialize')]).toEqual([1, 1]); // a later list may refresh, never respawn

  expect(text(await client.callTool({ name: 'stub__echo' }))).toContain('ok');
  expect([f.count('spawn'), f.count('tools/call')]).toEqual([1, 1]);

  await client.close();
  await expect.poll(() => f.pids().some(f.alive), { timeout: 10_000 }).toBe(false);
  expect(f.pids().length).toBe(1);
}, 60_000);

it('concurrent discover requests share one downstream initialization', async () => {
  const f = fixture();
  const client = await open(f, true);
  const results = await Promise.all(Array.from({ length: 5 }, () => client.callTool({ name: 'ashlr__discover', arguments: { server: 'stub' } })));
  expect(results.every(r => !r.isError)).toBe(true);
  expect([f.count('spawn'), f.count('initialize'), f.count('tools/list')]).toEqual([1, 1, 1]);
  await client.close();
  await expect.poll(() => f.pids().some(f.alive), { timeout: 10_000 }).toBe(false);
  expect(f.pids().length).toBe(1);
}, 60_000);

it('a lazy gateway closed before discovery never spawns the downstream', async () => {
  const f = fixture();
  const client = await open(f, true);
  await client.listTools();
  await client.close();
  await new Promise(r => setTimeout(r, 300));
  expect(f.events()).toEqual([]);
}, 60_000);

it('default (non-lazy) gateway is unchanged: eager cold discovery, no discover tool', async () => {
  const f = fixture();
  const client = await open(f, false);
  const names = (await client.listTools()).tools.map(t => t.name);
  expect(names).toContain('stub__echo');
  expect(names).not.toContain('ashlr__discover');
  expect(f.count('spawn')).toBe(1); // startup discovery; list refreshes eagerly again
  await expect(client.callTool({ name: 'ashlr__discover', arguments: { server: 'stub' } })).rejects.toThrow();
}, 60_000);

it('rejects invalid and duplicate mcp flags before starting a gateway', async () => {
  const writes: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown) => { writes.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try {
    for (const argv of [['--lazy', '--lazy'], ['run', '--lazy', '--lazy'], ['run', '--bogus'], ['run', '--lazy', 'extra']]) {
      expect(await cmdMcp(argv), argv.join(' ')).toBe(2);
    }
  } finally { process.stderr.write = orig; }
  expect(writes.filter(w => w.includes('Usage: phm mcp [run] [--lazy]')).length).toBe(4);
}, 30_000);
