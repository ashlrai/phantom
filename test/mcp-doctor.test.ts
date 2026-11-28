/**
 * Tests for `phm mcp doctor` and `src/core/mcp-doctor.ts` (docs/AGENT-MCP-CLI.md).
 * Pure unit tests with injected seams + temp-HOME CLI tests (no real child processes).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { McpServerHealth, McpServerSpec } from '../src/core/types.js';
import { GATEWAY_ENV_MARKER } from '../src/core/mcp-gateway.js';
import {
  REQUIRED_MCP_DOCTOR_SERVERS,
  diagnoseMcpServer,
  diagnoseMcpServers,
  hasRequiredMcpServerDown,
  resolveSelfGatewayLauncher,
  type McpDoctorDeps,
} from '../src/core/mcp-doctor.js';

const DIST_ENTRY = fileURLToPath(new URL('../dist/cli/index.js', import.meta.url));
const SRC_ENTRY = fileURLToPath(new URL('../src/cli/index.ts', import.meta.url));
const makeSpec = (overrides: Partial<McpServerSpec> = {}): McpServerSpec =>
  ({ name: 'ashlr-hub', command: 'ashlr', args: ['mcp'], source: '/tmp/.claude.json', ...overrides });

describe('resolveSelfGatewayLauncher', () => {
  it.each([
    ['ashlr', ['mcp'], []],
    ['/opt/homebrew/bin/phm', ['mcp'], []],
    ['C:\\tools\\phm.cmd', ['mcp', '--lazy'], []],
    ['ashlr', ['mcp', 'run'], []],
    ['phm', ['mcp', 'run', '--lazy'], []],
    ['node', ['/repo/bin/ashlr', 'mcp'], ['/repo/bin/ashlr']],
    ['node', [DIST_ENTRY, 'mcp', '--lazy'], [DIST_ENTRY]],
    ['tsx', [SRC_ENTRY, 'mcp'], [SRC_ENTRY]],
    ['node', ['--import', 'tsx', SRC_ENTRY, 'mcp'], ['--import', 'tsx', SRC_ENTRY]],
  ] as Array<[string, string[], string[]]>)('recognizes %s %j', (command, args, prefixArgs) => {
    expect(resolveSelfGatewayLauncher(makeSpec({ command, args }))).toEqual({ kind: 'recognized', command, prefixArgs });
  });

  it.each([
    ['ashlr', ['mcp', '--bogus']],
    ['phm', ['mcp', 'run', '--bogus']],
    ['phm', ['--_worker', 'mcp']],
    ['node', [DIST_ENTRY, '--flag', 'mcp']],
    ['node', [DIST_ENTRY, 'mcp', 'unknown']],
  ] as Array<[string, string[]]>)('rejects invalid gateway args for %s %j', (command, args) => {
    expect(resolveSelfGatewayLauncher(makeSpec({ command, args })).kind).toBe('invalid-args');
  });

  it('treats opaque custom wrappers as opaque', () => {
    expect(resolveSelfGatewayLauncher(makeSpec({ name: 'ashlr', command: '/custom/wrapper', args: ['mcp'] }))).toEqual({ kind: 'opaque' });
    expect(resolveSelfGatewayLauncher(makeSpec({ name: 'ashlr', command: 'node', args: ['/other/server.js', 'mcp'] }))).toEqual({ kind: 'opaque' });
  });
});

describe('diagnoseMcpServer', () => {
  it('verifies wired ashlr-hub via --version without calling probeServer and enforces recursion marker', async () => {
    const probe = vi.fn(async (): Promise<McpServerHealth> => { throw new Error('must not probe'); });
    const runVersionCheck = vi.fn(async () => ({ ok: true, version: '3.30.75' }));
    const runNativeList = vi.fn(async () => ({ ok: true, tools: [] }));
    const result = await diagnoseMcpServer(makeSpec({ env: { [GATEWAY_ENV_MARKER]: '0' } }), 8000, {
      probe, runVersionCheck, runNativeList, currentVersion: () => '3.30.75', nativeTools: () => ['ashlr_orient', 'ashlr_status'],
    });
    expect(probe).not.toHaveBeenCalled();
    expect(runNativeList).not.toHaveBeenCalled();
    const [cmd, args, env] = runVersionCheck.mock.calls[0]!;
    expect([cmd, args, env[GATEWAY_ENV_MARKER], env['NO_COLOR']]).toEqual(['ashlr', ['--version'], '1', '1']);
    expect(result).toEqual({ selfGateway: true, gatewayVersion: '3.30.75', health: { name: 'ashlr-hub', ok: true, toolCount: 2, tools: ['ashlr_orient', 'ashlr_status'] } });
  });

  it('queries the configured binary own native tools on version mismatch and fails honestly on error', async () => {
    const nativeTools = vi.fn(() => ['a', 'b', 'c']);
    const runNativeList = vi.fn(async () => ({ ok: true, tools: ['ashlr_orient'] }));
    const ok = await diagnoseMcpServer(makeSpec(), 8000, {
      runVersionCheck: async () => ({ ok: true, version: '3.30.74' }), runNativeList, currentVersion: () => '3.30.75', nativeTools,
    });
    expect(nativeTools).not.toHaveBeenCalled();
    expect(runNativeList.mock.calls[0]![1]).toEqual(['mcp', 'list', '--json']);
    expect(runNativeList.mock.calls[0]![2][GATEWAY_ENV_MARKER]).toBe('1');
    expect(ok).toEqual({ selfGateway: true, gatewayVersion: '3.30.74', versionMismatch: '3.30.75', health: { name: 'ashlr-hub', ok: true, toolCount: 1, tools: ['ashlr_orient'] } });

    const bad = await diagnoseMcpServer(makeSpec(), 8000, {
      runVersionCheck: async () => ({ ok: true, version: '3.30.74' }),
      runNativeList: async () => ({ ok: false, tools: [], error: 'gateway launcher "ashlr" returned non-JSON from mcp list --json' }),
      currentVersion: () => '3.30.75',
    });
    expect(bad.health).toMatchObject({ name: 'ashlr-hub', ok: false, toolCount: 0, error: expect.stringContaining('non-JSON') });
  });

  it('reports ok:false with actionable error when launcher fails, refuses unsafe/invalid args, and skips opaque wrappers', async () => {
    const unbuilt = await diagnoseMcpServer(makeSpec({ command: '/repo/bin/ashlr' }), 8000, {
      runVersionCheck: async () => ({ ok: false, error: 'gateway launcher "/repo/bin/ashlr" cannot load dist/cli/index.js (run npm run build)' }),
    });
    expect(unbuilt.health).toMatchObject({ name: 'ashlr-hub', ok: false, error: expect.stringContaining('npm run build') });
    expect(hasRequiredMcpServerDown([unbuilt.health])).toBe(true);

    const runVersionCheck = vi.fn(async () => ({ ok: true, version: '3.30.75' }));
    const secret = 'ghp_' + 'A'.repeat(36);
    const sec = await diagnoseMcpServer(makeSpec({ args: ['mcp', '--token', secret] }), 8000, { runVersionCheck });
    expect(sec.health.ok).toBe(false);
    expect(sec.health.error).toContain('unsafe MCP argv refused');
    expect(sec.health.error).not.toContain(secret);

    const inv = await diagnoseMcpServer(makeSpec({ args: ['mcp', '--bogus'] }), 8000, { runVersionCheck });
    expect(inv.health).toMatchObject({ ok: false, error: expect.stringContaining('invalid gateway args') });

    const probe = vi.fn(async (s: McpServerSpec): Promise<McpServerHealth> =>
      ({ name: s.name, ok: false, toolCount: 0, tools: [], error: 'MCP gateway self-spawn refused: would recurse' }));
    const opaque = await diagnoseMcpServer(makeSpec({ name: 'ashlr', command: '/custom/wrapper' }), 8000, { runVersionCheck, probe });
    expect(runVersionCheck).not.toHaveBeenCalled();
    expect(probe).toHaveBeenCalledTimes(1);
    expect(opaque.health).toMatchObject({ ok: false, error: expect.stringContaining('recurse') });
  });

  it('probes isolated phantom-fleet and companions via probeServer and enforces required server set', async () => {
    const probe = vi.fn(async (s: McpServerSpec): Promise<McpServerHealth> =>
      ({ name: s.name, ok: true, toolCount: 2, tools: ['fleet_status', 'fleet_loop'] }));
    const runVersionCheck = vi.fn(async () => ({ ok: true, version: '3.30.75' }));
    const results = await diagnoseMcpServers([
      makeSpec({ name: 'ashlr-hub', command: 'ashlr', args: ['mcp'] }),
      makeSpec({ name: 'phantom-fleet', command: 'phm', args: ['mcp', 'fleet'] }),
      makeSpec({ name: 'phantom-secrets', command: 'phantom', args: ['mcp', 'serve'] }),
    ], 8000, { probe, runVersionCheck, currentVersion: () => '3.30.75', nativeTools: () => ['ashlr_orient'] });
    expect(results.map((r) => [r.health.name, r.selfGateway, r.health.ok])).toEqual([
      ['ashlr-hub', true, true], ['phantom-fleet', false, true], ['phantom-secrets', false, true],
    ]);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(runVersionCheck).toHaveBeenCalledTimes(1);
    expect([...REQUIRED_MCP_DOCTOR_SERVERS].sort()).toEqual(['ashlr', 'ashlr-hub', 'locus', 'phantom-secrets']);
    expect(hasRequiredMcpServerDown([
      { name: 'ashlr-hub', ok: true, toolCount: 1, tools: ['a'] },
      { name: 'phantom-fleet', ok: false, toolCount: 0, tools: [], error: 'down' },
      { name: 'ashlr-md', ok: false, toolCount: 0, tools: [], error: 'down' },
    ])).toBe(false);
  });
});

describe('CLI: phm mcp doctor with wired Claude config', () => {
  const realHome = process.env['HOME'];
  let home = '';
  let cmdMcp: (args: string[]) => Promise<number>;
  let cmdWire: (args: string[]) => Promise<number>;
  const mockDiagnose = vi.fn<(servers: readonly McpServerSpec[], timeoutMs?: number, deps?: McpDoctorDeps) => ReturnType<typeof diagnoseMcpServers>>();

  beforeAll(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'phm-mcp-doctor-cli-'));
    process.env['HOME'] = home;
    vi.resetModules();
    vi.doMock('../src/core/mcp-doctor.js', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../src/core/mcp-doctor.js')>()),
      diagnoseMcpServers: mockDiagnose,
    }));
    ({ cmdWire } = await import('../src/cli/wire.js') as { cmdWire: (args: string[]) => Promise<number> });
    ({ cmdMcp } = await import('../src/cli/mcp.js') as { cmdMcp: (args: string[]) => Promise<number> });
  });

  afterAll(() => {
    vi.doUnmock('../src/core/mcp-doctor.js');
    if (realHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = realHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  beforeEach(() => {
    mockDiagnose.mockReset();
    for (const entry of fs.readdirSync(home)) fs.rmSync(path.join(home, entry), { recursive: true, force: true });
  });

  afterEach(() => { vi.restoreAllMocks(); });

  it('wire claude followed by mcp doctor --json reports ashlr-hub healthy (exit 0) and fails when missing (exit 1)', async () => {
    let stdout = '';
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...parts: unknown[]) => { logs.push(parts.join(' ')); });
    vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => { stdout += String(c); return true; });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    expect(await cmdWire(['claude'])).toBe(0);
    mockDiagnose.mockImplementationOnce(async (servers, timeoutMs, deps) => diagnoseMcpServers(servers, timeoutMs, {
      ...deps, runVersionCheck: async () => ({ ok: true, version: '3.30.75' }), currentVersion: () => '3.30.75', nativeTools: () => ['ashlr_orient', 'ashlr_status'],
    }));
    stdout = '';
    expect(await cmdMcp(['doctor', '--json'])).toBe(0);
    expect(JSON.parse(stdout)).toEqual([{ name: 'ashlr-hub', ok: true, toolCount: 2, tools: ['ashlr_orient', 'ashlr_status'] }]);

    mockDiagnose.mockImplementation(async (servers, timeoutMs, deps) => diagnoseMcpServers(servers, timeoutMs, {
      ...deps, runVersionCheck: async () => ({ ok: false, error: 'gateway launcher "ashlr" not found on PATH (install @ashlr/phantom or run ./install.sh)' }),
    }));
    stdout = '';
    expect(await cmdMcp(['doctor', '--json'])).toBe(1);
    expect((JSON.parse(stdout) as McpServerHealth[])[0]).toMatchObject({ name: 'ashlr-hub', ok: false, error: expect.stringContaining('not found on PATH') });

    logs.length = 0;
    expect(await cmdMcp(['doctor'])).toBe(1);
    expect(logs.join('\n')).toMatch(/ashlr-hub[\s\S]*DOWN[\s\S]*not found on PATH/);
  });
});
