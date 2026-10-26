/**
 * `phm wire claude` and `phm mcp install claude` must converge on ONE Phantom
 * gateway entry in ~/.claude.json, in either order, while preserving unrelated
 * user servers (including a foreign "ashlr" entry such as ashlr-plugin's).
 *
 * Runs against a temp HOME: both commands resolve ~/.claude.json from
 * os.homedir() at module load, so modules are imported after HOME is set.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  GATEWAY_MCP_SERVER,
  isOwnGatewayEntry,
  legacyGatewayKeys,
} from '../src/core/integrations/gateway-entry.js';
import { ASHLR_HUB_MCP_SERVER } from '../src/core/integrations/editors.js';

type CmdWire = (args: string[]) => Promise<number>;
type CmdMcp = (args: string[]) => Promise<number>;

const REPO_BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'ashlr');
const realHome = process.env['HOME'];
let home = '';
let cmdWire: CmdWire;
let cmdMcp: CmdMcp;

function claudeJson(): string {
  return path.join(home, '.claude.json');
}

function servers(): Record<string, Record<string, unknown>> {
  const parsed = JSON.parse(fs.readFileSync(claudeJson(), 'utf8')) as {
    mcpServers?: Record<string, Record<string, unknown>>;
  };
  return parsed.mcpServers ?? {};
}

function phantomKeys(): string[] {
  return Object.entries(servers())
    .filter(([, entry]) => isOwnGatewayEntry(entry))
    .map(([key]) => key);
}

const USER_SERVER = { command: 'python', args: ['-m', 'my_server'], env: { TOKEN: 'x' } };

beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'phm-mcp-dedupe-home-'));
  process.env['HOME'] = home;
  expect(os.homedir()).toBe(home);
  vi.resetModules();
  ({ cmdWire } = await import('../src/cli/wire.js') as { cmdWire: CmdWire });
  ({ cmdMcp } = await import('../src/cli/mcp.js') as { cmdMcp: CmdMcp });
});

afterAll(() => {
  if (realHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = realHome;
  fs.rmSync(home, { recursive: true, force: true });
});

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  for (const name of fs.readdirSync(home)) fs.rmSync(path.join(home, name), { recursive: true, force: true });
  fs.writeFileSync(claudeJson(), JSON.stringify({ firstStartVersion: '2.1.0', mcpServers: { mine: USER_SERVER } }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('gateway entry identity', () => {
  it('shares the canonical key with editor wiring', () => {
    expect(GATEWAY_MCP_SERVER).toBe(ASHLR_HUB_MCP_SERVER);
  });

  it('recognises bare and this-package absolute commands, nothing else', () => {
    expect(isOwnGatewayEntry({ command: 'ashlr', args: ['mcp'] })).toBe(true);
    expect(isOwnGatewayEntry({ type: 'stdio', command: 'phm', args: ['mcp'], env: {} })).toBe(true);
    expect(isOwnGatewayEntry({ command: REPO_BIN, args: ['mcp'] })).toBe(true);
    expect(isOwnGatewayEntry({ command: '/opt/elsewhere/bin/ashlr', args: ['mcp'] })).toBe(false);
    expect(isOwnGatewayEntry({ command: 'ashlr', args: ['mcp', 'serve'] })).toBe(false);
    expect(isOwnGatewayEntry({ command: 'ashlr', args: ['mcp'], env: { A: '1' } })).toBe(false);
    expect(isOwnGatewayEntry({ command: 'node', args: ['/x/ashlr-plugin/server.js'] })).toBe(false);
    expect(legacyGatewayKeys({ ashlr: { command: 'legacy-plugin', args: ['mcp'] } })).toEqual([]);
    expect(legacyGatewayKeys({ ashlr: { command: REPO_BIN, args: ['mcp'] } })).toEqual(['ashlr']);
  });
});

describe('wire claude + mcp install claude converge on one entry', () => {
  it('wire then mcp install leaves exactly one Phantom entry', async () => {
    expect(await cmdWire(['claude'])).toBe(0);
    expect(await cmdMcp(['install', 'claude'])).toBe(0);

    expect(phantomKeys()).toEqual([GATEWAY_MCP_SERVER]);
    expect(servers()['mine']).toEqual(USER_SERVER);
    expect(servers()['ashlr']).toBeUndefined();
  });

  it('mcp install then wire leaves exactly one Phantom entry', async () => {
    expect(await cmdMcp(['install', 'claude'])).toBe(0);
    expect(servers()[GATEWAY_MCP_SERVER]).toEqual({ command: REPO_BIN, args: ['mcp'] });
    expect(await cmdWire(['claude'])).toBe(0);

    expect(phantomKeys()).toEqual([GATEWAY_MCP_SERVER]);
    expect(servers()[GATEWAY_MCP_SERVER]).toEqual({ command: REPO_BIN, args: ['mcp'] });
    expect(servers()['mine']).toEqual(USER_SERVER);
  });

  it('is stable when the commands are repeated and alternated', async () => {
    await cmdWire(['claude']);
    await cmdMcp(['install', 'claude']);
    const settled = fs.readFileSync(claudeJson(), 'utf8');
    await cmdWire(['claude']);
    await cmdMcp(['install', 'claude']);
    expect(fs.readFileSync(claudeJson(), 'utf8')).toBe(settled);
    expect(phantomKeys()).toEqual([GATEWAY_MCP_SERVER]);
  });

  it.each([
    ['wire', async () => cmdWire(['claude'])],
    ['mcp install', async () => cmdMcp(['install', 'claude'])],
  ])('%s migrates a legacy "ashlr" gateway entry written by old mcp install', async (_label, run) => {
    fs.writeFileSync(claudeJson(), JSON.stringify({
      mcpServers: { mine: USER_SERVER, ashlr: { command: REPO_BIN, args: ['mcp'] } },
    }));

    expect(await run()).toBe(0);

    expect(phantomKeys()).toEqual([GATEWAY_MCP_SERVER]);
    expect(servers()['ashlr']).toBeUndefined();
    expect(servers()['mine']).toEqual(USER_SERVER);
  });

  it.each([
    ['wire', async () => cmdWire(['claude'])],
    ['mcp install', async () => cmdMcp(['install', 'claude'])],
  ])('%s never removes an unrelated "ashlr" server', async (_label, run) => {
    const plugin = { command: 'node', args: ['/plugins/ashlr-plugin/servers/main.js'] };
    fs.writeFileSync(claudeJson(), JSON.stringify({ mcpServers: { mine: USER_SERVER, ashlr: plugin } }));

    expect(await run()).toBe(0);

    expect(servers()['ashlr']).toEqual(plugin);
    expect(servers()['mine']).toEqual(USER_SERVER);
    expect(phantomKeys()).toEqual([GATEWAY_MCP_SERVER]);
  });

  it('mcp install refuses to overwrite a foreign "ashlr-hub" entry', async () => {
    const foreign = { command: 'something-else', args: [] };
    fs.writeFileSync(claudeJson(), JSON.stringify({ mcpServers: { [GATEWAY_MCP_SERVER]: foreign } }));

    expect(await cmdMcp(['install', 'claude'])).toBe(1);
    expect(servers()[GATEWAY_MCP_SERVER]).toEqual(foreign);
  });
});
