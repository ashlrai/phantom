/**
 * `--help` / `-h` anywhere in argv prints usage and exits 0 without touching
 * the command's effect layer.
 *
 * Companion to the spawned end-to-end guard in
 * test/cli-help-no-side-effects.test.ts — this file proves the same contract
 * in-process for the core commands that used to violate it, with the effect
 * boundary itself mocked: a help path that secretly reached the MCP registry
 * or gateway, the run orchestrator, or the setup wizard fails here even
 * before a byte lands on disk. (The inline index.ts commands — index, go,
 * status, ls, open, tidy, config, version — are not importable, so they are
 * covered by the spawned suite alone.)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const effects = vi.hoisted(() => ({
  discoverMcpServers: vi.fn(() => ({ servers: [] })),
  knownConfigPaths: vi.fn((): string[] => []),
  startGateway: vi.fn(async () => {}),
  probeServer: vi.fn(async () => ({ name: 'x', ok: true, toolCount: 0, tools: [] })),
  getToolsRegistry: vi.fn(() => ({ tools: [], installedCount: 0 })),
  nativeToolDefs: vi.fn((): unknown[] => []),
  companionExecutableCandidates: vi.fn((): string[] => []),
  companionExecutableKind: vi.fn(() => 'native' as const),
  runGoal: vi.fn(),
  loadRun: vi.fn(() => null),
  listRuns: vi.fn((): unknown[] => []),
  loadConfig: vi.fn(() => ({})),
  setupWizard: vi.fn(async () => ({ steps: [], ready: true, nextSteps: [] })),
}));

vi.mock('../src/core/mcp-registry.js', () => ({
  discoverMcpServers: effects.discoverMcpServers,
  knownConfigPaths: effects.knownConfigPaths,
}));
vi.mock('../src/core/mcp-gateway.js', () => ({
  startGateway: effects.startGateway,
  probeServer: effects.probeServer,
}));
vi.mock('../src/core/tools-registry.js', () => ({
  getToolsRegistry: effects.getToolsRegistry,
}));
vi.mock('../src/core/mcp-native.js', () => ({
  nativeToolDefs: effects.nativeToolDefs,
}));
vi.mock('../src/core/companion-inventory.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/core/companion-inventory.js')>()),
  companionExecutableCandidates: effects.companionExecutableCandidates,
  companionExecutableKind: effects.companionExecutableKind,
}));
vi.mock('../src/core/run/orchestrator.js', () => ({
  runGoal: effects.runGoal,
  loadRun: effects.loadRun,
  listRuns: effects.listRuns,
  // run.ts prints these in its --help Options table.
  DEFAULT_MAX_TOKENS: 50_000,
  DEFAULT_MAX_STEPS: 40,
  DEFAULT_PARALLEL: 2,
}));
vi.mock('../src/core/config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/core/config.js')>()),
  loadConfig: effects.loadConfig,
}));
vi.mock('../src/core/onboard.js', () => ({
  setupWizard: effects.setupWizard,
}));
// `../src/core/daemon/service-install-authority.js` is deliberately NOT
// mocked or named here: it is Tier-1 authority source, and importing it would
// make this file a `tier1-test` (G1 owner lane, CODEOWNERS-listed). `setup
// --help` returning before loadConfig/setupWizard is asserted below; the
// spawned suite covers the authority check end-to-end.

import { cmdMcp } from '../src/cli/mcp.js';
import { cmdRun, cmdRuns } from '../src/cli/run.js';
import { cmdSetup } from '../src/cli/setup.js';
import { cmdCompletions } from '../src/cli/completions.js';

let stdout = '';
let _stderr = '';

beforeEach(() => {
  for (const fn of Object.values(effects)) fn.mockClear();
  stdout = '';
  _stderr = '';
  vi.spyOn(console, 'log').mockImplementation((...parts: unknown[]) => { stdout += parts.join(' ') + '\n'; });
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => { stdout += String(chunk); return true; });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => { _stderr += String(chunk); return true; });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('mcp <verb> --help never runs the verb', () => {
  it.each([
    [['list', '--help']],
    [['list', '-h']],
    [['doctor', '--help']],
    [['ecosystem', '--help']],
    // `--write` merges detected servers into ~/.ashlr/settings.json — help
    // must win before that merge is even read.
    [['ecosystem', '--write', '--help']],
    [['install', '--help']],
    [['install', 'claude', '-h']],
    // `run` starts the stdio aggregation gateway.
    [['run', '--help']],
  ])('mcp %j prints usage and touches nothing', async (args) => {
    await expect(cmdMcp(args)).resolves.toBe(0);
    expect(stdout).toContain('Subcommands:');
    expect(effects.discoverMcpServers).not.toHaveBeenCalled();
    expect(effects.startGateway).not.toHaveBeenCalled();
    expect(effects.probeServer).not.toHaveBeenCalled();
    expect(effects.getToolsRegistry).not.toHaveBeenCalled();
    expect(effects.nativeToolDefs).not.toHaveBeenCalled();
    expect(effects.companionExecutableCandidates).not.toHaveBeenCalled();
  });

  it('mcp list still runs the inventory without --help', async () => {
    await expect(cmdMcp(['list'])).resolves.toBe(0);
    expect(effects.discoverMcpServers).toHaveBeenCalled();
  });
});

describe('run --help at any position prints usage', () => {
  it.each([
    [['--help']],
    [['-h']],
    [['help']],
    // `run show --help` used to look "--help" up as a run id and exit 1.
    [['show', '--help']],
    [['show', '-h']],
    [['fix the flaky test', '--help']],
  ])('run %j prints usage, exits 0 and never loads the orchestrator', async (args) => {
    await expect(cmdRun(args)).resolves.toBe(0);
    expect(stdout).toContain('Usage:');
    expect(effects.runGoal).not.toHaveBeenCalled();
    expect(effects.loadRun).not.toHaveBeenCalled();
    expect(effects.loadConfig).not.toHaveBeenCalled();
  });
});

describe('runs --help prints usage', () => {
  it.each([[['--help']], [['-h']], [['help']]])('runs %j prints usage and exits 0', async (args) => {
    await expect(cmdRuns(args)).resolves.toBe(0);
    expect(stdout).toContain('Usage:');
    expect(effects.listRuns).not.toHaveBeenCalled();
  });

  it('runs without --help still lists runs', async () => {
    await expect(cmdRuns([])).resolves.toBe(0);
    expect(effects.listRuns).toHaveBeenCalled();
  });
});

describe('setup --help prints usage', () => {
  it.each([[['--help']], [['-h']]])(
    'setup %j prints usage, exits 0 and never enters the wizard',
    async (args) => {
      await expect(cmdSetup(args)).resolves.toBe(0);
      expect(stdout).toContain('Usage:');
      expect(effects.setupWizard).not.toHaveBeenCalled();
      expect(effects.loadConfig).not.toHaveBeenCalled();
    },
  );
});

describe('completions <shell> --help prints usage, not the script', () => {
  it.each([
    // `completions zsh --help` used to dump the whole zsh script.
    [['zsh', '--help']],
    [['bash', '-h']],
    [['--help']],
    [['-h']],
    [[]],
  ])('completions %j prints usage and exits 0', async (args) => {
    await expect(cmdCompletions(args)).resolves.toBe(0);
    expect(stdout).toContain('Usage:');
    expect(stdout).not.toContain('COMPREPLY');
    expect(stdout).not.toContain('#compdef');
  });

  it('completions zsh still emits the script without --help', async () => {
    await expect(cmdCompletions(['zsh'])).resolves.toBe(0);
    expect(stdout).toContain('#compdef ashlr phm');
  });

  it('an unknown shell still prints usage and exits 2', async () => {
    await expect(cmdCompletions(['fish'])).resolves.toBe(2);
    expect(stdout).toContain('Usage:');
  });
});
