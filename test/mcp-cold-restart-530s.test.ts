// Restart qualification of #6428's lazy MCP slice, recovered by merged #6632.
import { expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

it('retains explicitly discovered inventory across a complete lazy gateway restart', async () => {
  const home = mkdtempSync(join(tmpdir(), 'mcp-restart-530s-'));
  const cache = join(home, '.ashlr/cache/mcp-tools');
  const starts = join(home, 'starts');
  const peer = join(home, 'peer.cjs');
  const sessions: { client: Client; transport: StdioClientTransport; pid: number | null }[] = [];
  const pids = () => existsSync(starts) ? readFileSync(starts, 'utf8').trim().split('\n').map(Number) : [];
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const allPids = () => [...sessions.flatMap(s => s.pid === null ? [] : [s.pid]), ...pids()];
  try {
    writeFileSync(peer, `
      const fs = require('node:fs');
      fs.appendFileSync(${JSON.stringify(starts)}, process.pid + '\\n');
      require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
        const m = JSON.parse(line);
        if (m.id === undefined) return;
        const result = m.method === 'initialize'
          ? { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'restart', version: '1' } }
          : m.method === 'tools/list' ? { tools: [{ name: 'echo', inputSchema: { type: 'object' } }] }
          : m.method === 'tools/call' && m.params.name === 'echo'
            ? { content: [{ type: 'text', text: m.params.arguments.message }] } : undefined;
        const reply = result ? { result } : { error: { code: -32601, message: 'Unknown method' } };
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, ...reply }) + '\\n');
      });
      process.stdin.on('end', () => process.exit(0));`);
    const spec = { name: 'restart', command: process.execPath, args: [peer], source: 'test' };
    const gateway = new URL('../src/core/mcp-gateway.ts', import.meta.url).href;
    const entry = `import { startGateway } from ${JSON.stringify(gateway)};
      await startGateway({ servers: [${JSON.stringify(spec)}] }, 5000, { lazy: true });`;
    const open = async () => {
      const client = new Client({ name: 'restart-qualification', version: '1' });
      const transport = new StdioClientTransport({ command: process.execPath,
        args: ['--import', 'tsx', '--input-type=module', '-e', entry], stderr: 'pipe',
        env: { PATH: process.env.PATH!, HOME: home, ASHLR_HOME: join(home, '.ashlr'), ASHLR_NO_HEAL: '1' } });
      const session = { client, transport, pid: null as number | null };
      sessions.push(session);
      let stderr = '';
      transport.stderr?.on('data', chunk => { stderr += String(chunk); });
      try { await client.connect(transport, { timeout: 10_000 }); }
      catch (error) { throw new Error(`Gateway initialization failed: ${stderr}`, { cause: error }); }
      finally { session.pid = transport.pid; }
      expect(session.pid).not.toBeNull();
      return session;
    };
    const call = (client: Client, name: string, args: Record<string, string>) =>
      client.callTool({ name, arguments: args }, undefined, { timeout: 5_000 });
    const close = async (session: typeof sessions[number]) => {
      await session.client.close();
      await expect.poll(() => allPids().some(alive), { timeout: 10_000 }).toBe(false);
    };

    expect(existsSync(cache)).toBe(false);
    const a = await open();
    const cold = await a.client.listTools({}, { timeout: 5_000 });
    expect(cold.tools.map(t => t.name)).toContain('ashlr__discover');
    expect(cold.tools.map(t => t.name)).not.toContain('restart__echo');
    expect(pids()).toHaveLength(0);
    expect((await call(a.client, 'ashlr__discover', { server: 'restart' })).isError).not.toBe(true);
    const first = await call(a.client, 'restart__echo', { message: 'session A' });
    expect(first.isError).not.toBe(true);
    expect(first.content).toEqual([{ type: 'text', text: 'session A' }]);
    expect(pids()).toHaveLength(1);
    expect(readdirSync(cache)).toHaveLength(1);
    await close(a); // A and its downstream must be gone before B starts.

    const priorStarts = pids().length;
    const b = await open();
    expect(b.pid).not.toBe(a.pid);
    const warm = await b.client.listTools({}, { timeout: 5_000 });
    expect(warm.tools.find(t => t.name === 'restart__echo')?.inputSchema).toEqual({ type: 'object' });
    expect(pids().length - priorStarts).toBe(0);
    const second = await call(b.client, 'restart__echo', { message: 'session B' });
    expect(second.isError).not.toBe(true);
    expect(second.content).toEqual([{ type: 'text', text: 'session B' }]);
    expect(pids().length - priorStarts).toBe(1);
    expect(new Set(pids()).size).toBe(2);
    await close(b);
  } finally {
    // Close even after a failed assertion; force only leftover synthetic processes.
    try {
      for (const { client, transport } of sessions) {
        try { await client.close(); } finally { await transport.close(); }
      }
    } finally {
      try {
        const remaining = allPids();
        for (const pid of remaining.filter(alive)) process.kill(pid, 'SIGKILL');
        await expect.poll(() => remaining.some(alive), { timeout: 10_000 }).toBe(false);
      } finally {
        rmSync(home, { recursive: true, force: true });
        expect(existsSync(home)).toBe(false);
      }
    }
  }
}, 60_000);
