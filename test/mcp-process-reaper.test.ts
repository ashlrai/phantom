import { describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SessionStdioClientTransport } from '../src/core/mcp-gateway.js';
import { sessionChildPids } from '../src/core/verse/process-registry.js';
import { waitForProcessExit } from './helpers/process-liveness.js';

function firstLine(child: ChildProcess): Promise<string> {
  return new Promise((resolveLine, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('MCP fixture did not become ready')), 30_000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.stdout!.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
      const newline = output.indexOf('\n');
      if (newline < 0) return;
      clearTimeout(timer);
      resolveLine(output.slice(0, newline));
    });
    child.once('exit', () => {
      clearTimeout(timer);
      reject(new Error('MCP fixture exited before readiness'));
    });
  });
}

// These are real POSIX process-group tests, independent of external MCP services.
describe.runIf(process.platform !== 'win32')('MCP session orphan guard', () => {
  it('preserves real SDK initialize/list/call and reaps the server and watchdog on close', async () => {
    const sessionId = 'mcp-protocol-reaper-fixture';
    const transport = new SessionStdioClientTransport({
      command: process.execPath,
      args: [resolve('test/fixtures/mock-mcp-server.mjs')],
      stderr: 'ignore',
    }, sessionId);
    const client = new Client({ name: 'reaper-fixture', version: '1.0.0' }, { capabilities: {} });
    let pids: readonly number[] = [];
    try {
      await client.connect(transport);
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(['ping', 'echo']);
      expect(await client.callTool({ name: 'ping', arguments: {} })).toMatchObject({
        content: [{ type: 'text', text: 'pong' }],
      });
      pids = sessionChildPids(sessionId);
      expect(pids).toHaveLength(2);
      expect(pids).toContain(transport.pid);
    } finally {
      await client.close();
      await transport.close();
    }
    expect(await waitForProcessExit(pids, { timeoutMs: 3_000 })).toBe(true);
    expect(sessionChildPids(sessionId)).toEqual([]);
  }, 20_000);

  it('reaps the MCP server, stubborn descendant and watchdog after Phantom is SIGKILLed', async () => {
    const server = String.raw`
      const { spawn } = require('node:child_process');
      process.on('SIGTERM', () => {});
      const descendant = spawn(process.execPath, ['-e',
        "process.on('SIGTERM', () => {}); console.log(process.pid); setInterval(() => {}, 1000);"],
        { stdio: ['ignore', 'pipe', 'ignore'] });
      descendant.stdout.once('data', chunk => process.stdout.write(JSON.stringify({
        jsonrpc: '2.0', method: 'fixture-ready',
        params: { serverPid: process.pid, descendantPid: Number(String(chunk).trim()) },
      }) + '\n'));
      setInterval(() => {}, 1000);
    `;
    const gatewayUrl = pathToFileURL(resolve('src/core/mcp-gateway.ts')).href;
    const registryUrl = pathToFileURL(resolve('src/core/verse/process-registry.ts')).href;
    const parentSource = `
      import { SessionStdioClientTransport } from ${JSON.stringify(gatewayUrl)};
      import { sessionChildPids } from ${JSON.stringify(registryUrl)};
      const sessionId = 'mcp-parent-death-fixture';
      const transport = new SessionStdioClientTransport({
        command: process.execPath, args: ['-e', ${JSON.stringify(server)}], stderr: 'ignore',
      }, sessionId);
      transport.onmessage = message => {
        if (message.method === 'fixture-ready') console.log(JSON.stringify({
          ...message.params, tracked: sessionChildPids(sessionId),
        }));
      };
      await transport.start();
    `;
    const parent = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', parentSource], {
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let owned: number[] = [];
    try {
      const ready = JSON.parse(await firstLine(parent)) as {
        serverPid: number; descendantPid: number; tracked: number[];
      };
      expect(ready.tracked).toHaveLength(2);
      expect(ready.tracked).toContain(ready.serverPid);
      owned = [...ready.tracked, ready.descendantPid];
      const exited = new Promise<void>((resolveExit) => parent.once('exit', () => resolveExit()));
      parent.kill('SIGKILL');
      await exited;
      expect(await waitForProcessExit(owned, { timeoutMs: 3_000 })).toBe(true);
    } finally {
      parent.kill('SIGKILL');
      for (const pid of owned) {
        try { process.kill(pid, 'SIGKILL'); } catch { /* fixture already reaped */ }
      }
    }
  }, 45_000);
});
