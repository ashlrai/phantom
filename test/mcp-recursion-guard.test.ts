import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import type { McpServerSpec } from '../src/core/types.js';

const state = vi.hoisted(() => ({
  transports: [] as Array<{ command: string; args: string[]; env: Record<string, string> }>,
}));
vi.mock('../src/core/config.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/core/config.js')>(),
  loadConfig: () => ({ models: {} }),
}));
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: class {
    constructor(options: { command: string; args: string[]; env: Record<string, string> }) {
      state.transports.push(options);
    }
    async close() {}
  },
}));
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    async connect() {}
    async listTools() { return { tools: [] }; }
    async close() {}
  },
}));

import { GATEWAY_ENV_MARKER, isSelfGateway, probeServer, startGateway } from '../src/core/mcp-gateway.js';

function spec(overrides: Partial<McpServerSpec> = {}): McpServerSpec {
  return { name: 'configured-server', command: 'server', args: [], source: 'test', ...overrides };
}

beforeEach(() => { state.transports.length = 0; });
afterEach(() => { vi.unstubAllEnvs(); });

describe('MCP recursion guard', () => {
  it.each([
    ['ashlr', ['mcp']],
    ['/usr/local/bin/phm', ['mcp']],
    ['C:\\tools\\phm.cmd', ['mcp']],
    ['node', ['/project/bin/ashlr', 'mcp']],
    ['node', ['/project/bin/phm', 'mcp']],
    ['bun', ['/project/bin/phm', 'mcp']],
    ['node', [fileURLToPath(new URL('../dist/cli/index.js', import.meta.url)), 'mcp']],
    ['tsx', [fileURLToPath(new URL('../src/cli/index.ts', import.meta.url)), 'mcp']],
  ] as Array<[string, string[]]>)('refuses direct probes of %s before creating a transport', async (command, args) => {
    const configured = spec({ command, args });
    expect(isSelfGateway(configured)).toBe(true);
    expect(await probeServer(configured)).toMatchObject({ ok: false, toolCount: 0, error: expect.stringContaining('recurse') });
    expect(state.transports).toEqual([]);
  });

  it.each(['ashlr', 'phm'])('recognizes a configured %s gateway behind an opaque wrapper', async (name) => {
    const configured = spec({ name, command: '/custom/wrapper', args: ['mcp'] });
    expect(isSelfGateway(configured)).toBe(true);
    expect((await probeServer(configured)).ok).toBe(false);
    expect(state.transports).toEqual([]);
  });

  it.each(['1', '0', ''])('refuses inherited gateway marker %j before any downstream starts', async (marker) => {
    vi.stubEnv(GATEWAY_ENV_MARKER, marker);
    await expect(startGateway({ servers: [spec()] })).rejects.toThrow('inherited gateway marker');
    expect(state.transports).toEqual([]);
  });

  it('sets the child marker after configured env overrides', async () => {
    const health = await probeServer(spec({ env: { [GATEWAY_ENV_MARKER]: '0' } }));
    expect(health.ok).toBe(true);
    expect(state.transports).toHaveLength(1);
    expect(state.transports[0]?.env[GATEWAY_ENV_MARKER]).toBe('1');
  });

  it.each(['phantom', 'phantom-secrets'])('allows the distinct legacy Phantom Secrets server named %s', async (name) => {
    const configured = spec({ name, command: 'phantom', args: ['mcp'] });
    expect(isSelfGateway(configured)).toBe(false);
    expect((await probeServer(configured)).ok).toBe(true);
    expect(state.transports).toHaveLength(1);
  });

  it('allows unrelated Node MCP servers and gateway commands without mcp', () => {
    expect(isSelfGateway(spec({ command: 'node', args: ['/project/server.js', 'mcp'] }))).toBe(false);
    expect(isSelfGateway(spec({ name: 'phm', command: 'phm', args: ['--version'] }))).toBe(false);
  });
});
