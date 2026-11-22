import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { listNativeTools, registerNativeTools } from '../src/core/mcp-native.js';
import { registerFleetNativeTools } from '../src/core/mcp-native-fleet.js';

const transports = vi.hoisted(() => ({ append: vi.fn(), read: vi.fn(), inspect: vi.fn() }));
vi.mock('../src/core/fleet/bus-inbox.js', () => ({
  appendBusInbox: transports.append,
  listBusInboxAfter: transports.read,
  inspectBusInbox: transports.inspect,
}));

it('lists registered schemas and reads the contract without invoking handlers or bus transports', () => {
  const handler = vi.fn(async () => ({ ok: true }));
  registerNativeTools([{ name: 'contract_test_sentinel_794s', description: 'test sentinel',
    inputSchema: { type: 'object', properties: {} }, safety: 'append', handler }]);
  registerFleetNativeTools();
  const tools = listNativeTools();
  const document = readFileSync(join(process.cwd(), 'docs/MCP-BUS-INTENT-INPUTS.md'), 'utf8');
  expect(tools.find(tool => tool.name === 'contract_test_sentinel_794s')?.inputSchema).toEqual({ type: 'object', properties: {} });
  for (const name of ['phantom_agent_bus_post', 'phantom_agent_bus_read', 'intent_ship']) {
    expect(tools.find(tool => tool.name === name)?.inputSchema).toBeDefined();
    expect(document).toContain(`| \`${name}\` |`);
  }
  expect(handler).not.toHaveBeenCalled();
  expect(transports.append).not.toHaveBeenCalled();
  expect(transports.read).not.toHaveBeenCalled();
  expect(transports.inspect).not.toHaveBeenCalled();
});
