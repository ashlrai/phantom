import { describe, expect, it, vi } from 'vitest';
import { dirname } from 'node:path';
import { listNativeTools } from '../src/core/mcp-native.js';

// Descriptions may be edited, but every schema keyword, constraint and field
// remains part of the client-facing contract.
function schemaContract(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(schemaContract);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [
    key, key === 'description' && typeof child === 'string' ? '<description>' : schemaContract(child),
  ]));
}

describe('native MCP tool inventory', () => {
  it('preserves the complete input schema contract for every listed tool', () => {
    const tools = listNativeTools();
    expect(tools.every(tool => typeof tool.description === 'string' && tool.description.length > 0)).toBe(true);
    expect(tools.map(({ name, inputSchema }) => ({ name, inputSchema: schemaContract(inputSchema) }))).toMatchSnapshot();
  });

  it('keeps native tools/list below the pre-audit byte count', () => {
    const response = { jsonrpc: '2.0', id: 1, result: { tools: listNativeTools(), _meta: { 'ashlr/discovery': { servers: [], rejectedRoutes: [] } } } };
    expect(Buffer.byteLength(JSON.stringify(response) + '\n')).toBeLessThan(24205);
  });
});

describe('MCP CLI JSON inventory', () => {
  it('keeps the inventory fields and native classifications in compact JSON', async () => {
    vi.stubEnv('PATH', dirname(process.execPath));
    const { cmdMcp } = await import('../src/cli/mcp.js');
    const chunks: string[] = [];
    const write = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      expect(await cmdMcp(['list', '--json'])).toBe(0);
    } finally {
      process.stdout.write = write;
      vi.unstubAllEnvs();
    }
    const output = chunks.join('');
    const parsed = JSON.parse(output) as { servers: unknown[]; tools: { tools: Record<string, unknown>[]; installedCount: number }; native: unknown[] };
    expect(output).toBe(JSON.stringify(parsed) + '\n');
    expect(parsed.tools.tools.length).toBeGreaterThan(0);
    expect({ fields: Object.keys(parsed), registryFields: Object.keys(parsed.tools), toolFields: Object.keys(parsed.tools.tools[0]!), native: parsed.native }).toMatchSnapshot();
  });
});
