/**
 * M31 — gateway integration: the real `ashlr mcp` gateway (this repo's built
 * CLI) must advertise every native tool with ZERO downstream servers.
 *
 * Uses a direct SDK client: spawn the gateway as a child under an
 * isolated tmp HOME (so no real downstream MCP servers are discovered), list
 * its tools, tear down. Requires a prior `npm run build` and never builds
 * dist/ itself: a lazy in-suite build rewrites the shared dist/ while sibling
 * files in the parallel unit lane spawn or hash it (see cli-tidy-json).
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeFixture, type H1Fixture } from './helpers/h1-fixture.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { probeServer } from '../src/core/mcp-gateway.js';
import { listNativeTools } from '../src/core/mcp-native.js';
import type { McpServerSpec } from '../src/core/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const cliEntry = join(repoRoot, 'dist', 'cli', 'index.js');

let fx: H1Fixture;

beforeAll(() => {
  if (!existsSync(cliEntry)) {
    throw new Error(`${cliEntry} is missing; run \`npm run build\` before this suite`);
  }
});

beforeEach(() => {
  expect.hasAssertions();
  fx = makeFixture();
  // Minimal config so the gateway's loadConfig() finds a valid file.
  mkdirSync(join(fx.ashlrDir), { recursive: true });
  writeFileSync(join(fx.ashlrDir, 'config.json'), JSON.stringify({ version: 1 }));
});

afterEach(() => {
  fx.cleanup();
});

function gatewaySpec(): McpServerSpec {
  return {
    name: 'ashlr-under-test',
    command: process.execPath,
    args: [cliEntry, 'mcp'],
    // Override the config bridge's module-load paths as well as the live HOME.
    env: gatewayEnv(),
    source: 'test',
  };
}

function gatewayEnv(): Record<string, string> {
  return {
    HOME: fx.home,
    USERPROFILE: fx.home,
    ASHLR_HOME: fx.ashlrDir,
    ASHLR_CONFIG: join(fx.ashlrDir, 'config.json'),
    ASHLR_GENOME_DIR: join(fx.ashlrDir, 'genome'),
    PATH: process.env.PATH ?? '',
  };
}

describe('gateway serves native tools', () => {
  it('persists private proactive profiles through the built CLI protocol without provider calls', async () => {
    const client = new Client({ name: 'proactive-profile-test', version: '1.0.0' });
    const transport = new StdioClientTransport({ command: process.execPath, args: [cliEntry, 'mcp'],
      cwd: fx.home, stderr: 'pipe', env: gatewayEnv() });
    transport.stderr?.on('data', () => undefined);
    const call = async (name: string, args: Record<string, unknown>) => {
      const reply = await client.callTool({ name, arguments: args });
      expect(reply.isError).not.toBe(true);
      const content = reply.content as Array<{ type: string; text?: string }>;
      return JSON.parse(content.filter(item => item.type === 'text').map(item => item.text).join('\n'));
    };
    try {
      await client.connect(transport, { timeout: 30_000 });
      const created = await call('phm_proactive_agents_create', { profile: {
        identity: { provider: 'openai-dot', accountId: 'isolated-account', agentId: 'isolated-dot' }, displayName: 'Scout' } });
      expect(created.profile.operations.dispatch.state).toBe('unverified');
      const page = await call('phm_proactive_agents_list', { accountId: 'isolated-account' });
      expect(page.profiles.map((profile: { id: string }) => profile.id)).toEqual([created.profile.id]);
      const updated = await call('phm_proactive_agents_update', { id: created.profile.id,
        patch: { expectedVersion: 1, displayName: 'Research Scout' } });
      expect(updated.profile).toMatchObject({ version: 2, displayName: 'Research Scout' });
      // A separate CLI process must read the saved metadata from this fixture,
      // rather than merely returning the first process's in-memory state.
      const reader = new Client({ name: 'proactive-profile-reader', version: '1.0.0' });
      const readerTransport = new StdioClientTransport({ command: process.execPath, args: [cliEntry, 'mcp'],
        cwd: fx.home, stderr: 'pipe', env: gatewayEnv() });
      readerTransport.stderr?.on('data', () => undefined);
      try {
        await reader.connect(readerTransport, { timeout: 30_000 });
        const reply = await reader.callTool({ name: 'phm_proactive_agents_list', arguments: {} });
        expect(reply.isError).not.toBe(true);
        const content = reply.content as Array<{ type: string; text?: string }>;
        const saved = JSON.parse(content.filter(item => item.type === 'text').map(item => item.text).join('\n'));
        expect(saved.profiles).toEqual([updated.profile]);
      } finally { await reader.close(); await readerTransport.close(); }
      await call('phm_proactive_agents_delete', { id: created.profile.id, expectedVersion: 2 });
      expect((await call('phm_proactive_agents_list', {})).profiles).toEqual([]);
    } finally { await client.close(); await transport.close(); }
  }, 60_000);

  it('advertises all native tools with zero downstreams', async () => {
    const client = new Client({ name: 'native-inventory-test', version: '1.0.0' });
    const transport = new StdioClientTransport({ command: process.execPath, args: [cliEntry, 'mcp'],
      cwd: repoRoot, stderr: 'pipe', env: { HOME: fx.home, USERPROFILE: fx.home,
        ASHLR_HOME: fx.ashlrDir, PATH: process.env.PATH ?? '' } });
    transport.stderr?.on('data', () => undefined);
    try {
      await client.connect(transport, { timeout: 20_000 });
      const listed = await client.listTools({}, { timeout: 20_000 });
      const tools = listed.tools.map((tool) => tool.name);
      const expected = listNativeTools().map((tool) => tool.name);
      for (const name of expected) expect(tools).toContain(name);
      // tmp HOME discovers no downstream servers — only natives are present.
      expect(tools).toHaveLength(expected.length);
    } finally {
      await client.close();
      await transport.close();
    }
  }, 30_000);

  it('refuses a nested native gateway launched as a downstream probe', async () => {
    const health = await probeServer(gatewaySpec(), 20_000);
    expect(health).toMatchObject({ ok: false, toolCount: 0, tools: [] });
  }, 30_000);
});
