import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const backend = vi.hoisted(() => ({ read: vi.fn(), inspect: vi.fn(), compatibility: vi.fn() }));
vi.mock('../src/core/resources/pool-runtime.js', () => ({ readResourceJson: backend.read }));
vi.mock('../src/core/resources/launcher-capabilities.js', () => ({ inspectNativeLauncherCapabilities: backend.inspect }));
vi.mock('../src/core/resources/launcher-compatibility.js', () => ({ checkResourceLauncherCompatibility: backend.compatibility }));
import { cmdResources } from '../src/cli/resources.js';
import { AGENT_COMMANDS } from '../src/cli/help.js';
const fixtureRoot = resolve(tmpdir(), 'phm-capabilities-cli-fixture');
const commandPath = join(fixtureRoot, 'command.json');
const cwd = join(fixtureRoot, 'cwd');
const launcher = join(fixtureRoot, 'launcher');
const args = ['launcher', 'capabilities', '--provider', 'codex', '--command', commandPath, '--cwd', cwd];
let output: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.clearAllMocks();
  output = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  backend.read.mockReturnValue([launcher]);
  backend.inspect.mockResolvedValue({ schemaVersion: 1, scope: 'native-launcher-capability-discovery', provider: 'codex', status: 'observed',
    reason: 'launcher-capabilities-observed', version: null, runtimeReadiness: 'not-inspected', sessionsInspected: false, controlEnabled: false,
    probeEffects: 'Help/version requested; vendor startup/cache effects are not attested.', capabilities: [{ id: 'session-observation', upstream: 'unverified', phantomTransport: 'not-implemented' }] });
});
afterEach(() => { vi.restoreAllMocks(); });

describe('native launcher capabilities CLI', () => {
  it.each(['codex', 'claude'])('uses only the explicit %s command and bounded scope', async (provider) => {
    const selected = [...args]; selected[3] = provider;
    expect(await cmdResources([...selected, '--json'])).toBe(0);
    expect(backend.read).toHaveBeenCalledWith(commandPath);
    expect(backend.inspect).toHaveBeenCalledWith({ provider, command: [launcher], cwd, timeoutMs: 10000, signal: expect.any(AbortSignal) });
    expect(backend.compatibility).not.toHaveBeenCalled();
    const result = JSON.parse(output.mock.calls[0]![0]);
    expect(result).toMatchObject({ sessionsInspected: false, controlEnabled: false, runtimeReadiness: 'not-inspected' });
    expect(output.mock.calls[0]![0]).not.toContain(fixtureRoot);
  });
  it('describes unverified capability and vendor startup effects in plain output', async () => {
    expect(await cmdResources(args)).toBe(0);
    expect(output.mock.calls[0]![0]).toContain('session-observation: unverified; Phantom transport: not-implemented');
    expect(output.mock.calls[0]![0]).toContain('Existing permissions remain unchanged');
    expect(output.mock.calls[0]![0]).not.toContain('undefined');
  });
  it.each([['launcher', 'capabilities', '--help'], ['launcher', 'capabilities', '-h'], ['launcher', '--help']])('help %j reads no input or provider state', async (...argv) => {
    expect(await cmdResources(argv)).toBe(0);
    expect(output.mock.calls[0]![0]).toContain('launcher capabilities --provider codex|claude');
    expect(backend.read).not.toHaveBeenCalled(); expect(backend.inspect).not.toHaveBeenCalled();
  });
  it.each([['--provider', 'grok'], ['--timeout-ms', '30001'], ['--session-id', 'private'], ['--json', '--json'], ['--connect'], ['--cwd', '/']])('rejects unsupported/duplicate fields %j before reading configuration', async (...extra) => {
    const invalid = extra[0] === '--provider' ? [...args.slice(0, 2), ...extra, ...args.slice(4)] : [...args, ...extra];
    expect(await cmdResources([...invalid, '--json'])).toBe(2);
    expect(backend.read).not.toHaveBeenCalled(); expect(backend.inspect).not.toHaveBeenCalled();
  });
  it('returns unavailable without leaking unexpected input/probe errors', async () => {
    backend.inspect.mockRejectedValue(new Error('SECRET socket and private credentials'));
    const before = [process.listeners('SIGINT'), process.listeners('SIGTERM')];
    expect(await cmdResources([...args, '--json'])).toBe(1);
    expect(JSON.stringify(output.mock.calls)).not.toContain('SECRET');
    expect([process.listeners('SIGINT'), process.listeners('SIGTERM')]).toEqual(before);
  });
  it('waits for cancelled inspection and removes its signal listeners', async () => {
    const before = [process.listeners('SIGINT'), process.listeners('SIGTERM')];
    backend.inspect.mockImplementation(async ({ signal }: { signal: AbortSignal }) => {
      process.listeners('SIGTERM').find((entry) => !before[1]!.includes(entry))!();
      await Promise.resolve();
      expect(signal.aborted).toBe(true);
      return { status: 'unavailable', reason: 'launcher-cancelled' };
    });
    expect(await cmdResources([...args, '--json'])).toBe(130);
    expect([process.listeners('SIGINT'), process.listeners('SIGTERM')]).toEqual(before);
  });
  it('registers the command as inspection rather than control authority', () => {
    const doc = AGENT_COMMANDS.find((entry) => entry.usage.startsWith('phm resources launcher capabilities'))!;
    expect(doc.safety).toBe('read');
    expect(doc.description).toContain('reads no sessions and grants no control');
    expect(doc.jsonShape).toContain('controlEnabled false');
  });
});
