import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdFleet } from '../src/cli/fleet.js';
// Load the implementation during collection so cold module transformation is
// outside fixture lifetimes and cannot leak a timed-out write into the next case.
import '../src/core/fleet/status.js';

vi.mock('../src/core/config.js', () => ({
  loadConfig: () => ({
    version: 1, roots: [], editor: 'cursor', staleDays: 30,
    categories: {}, tidyRules: [], keepers: [],
    models: { lmstudio: '', ollama: '', providerChain: [] },
    telemetry: {}, tools: {},
  }),
}));
// Keep host integrations out of the fixture; all persisted status readers are real.
vi.mock('../src/core/phantom.js', () => ({
  getCachedFleetPhantomStatus: () => { throw new Error('fixture companion unavailable'); },
}));
vi.mock('../src/core/fabric/resource-monitor.js', () => ({
  getResourceSnapshot: () => ({ backends: [] }),
}));
vi.mock('../src/core/build-identity.js', () => ({
  readBuildIdentity: () => ({ schemaVersion: 1, packageVersion: null, revision: null, dirty: null, provenance: 'unavailable' }),
}));
vi.mock('../src/core/mcp-registry.js', () => ({ discoverMcpServers: () => [] }));

// Captured from the original status.ts before the module split. Compare the
// actual CLI write, including property order, formatting and final newline.
describe('fleet status --json byte contract', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'fleet-json-'));
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    vi.stubEnv('ASHLR_HOME', join(home, '.ashlr'));
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-07-14T12:00:00.000Z'));
    mkdirSync(join(home, '.ashlr'), { recursive: true });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  it.each(['empty', 'paused', 'corrupt-daemon'] as const)('%s fixture', async (fixture) => {
    if (fixture === 'paused') writeFileSync(join(home, '.ashlr', 'KILL'), 'fixture pause\n');
    if (fixture === 'corrupt-daemon') writeFileSync(join(home, '.ashlr', 'daemon.json'), '{broken');
    const output: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { output.push(String(chunk)); return true; });
    expect(await cmdFleet(['status', '--json'])).toBe(0);
    const golden = readFileSync(new URL(`./fixtures/fleet-status-json/${fixture}.json`, import.meta.url), 'utf8');
    // Expand the fixture root in the expected bytes only. Actual CLI output is
    // neither parsed, reordered, nor normalized. All other bytes are fixed.
    const expected = golden.replaceAll(/<fixture-home>([^"]*)/g, (_match, suffix: string) =>
      JSON.stringify(join(home, ...suffix.split('/'))).slice(1, -1));
    expect(output.join('')).toBe(expected);
  }, 60_000);

  it('includes current advisory pool budget observations in the status snapshot', async () => {
    const directory = join(home, '.ashlr', 'fleet', 'budgets');
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, '00000000-0000-0000-0000-000000000000.json'), JSON.stringify([{
      pool: 'codex-cmp', bucket: 'credits', remaining: 42, resetAt: null,
      timestamp: '2026-07-14T11:00:00.000Z', source: 'manual',
    }]));
    const output: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { output.push(String(chunk)); return true; });
    expect(await cmdFleet(['status', '--json'])).toBe(0);
    expect(JSON.parse(output.join('')).budgets).toMatchObject({
      timestamp: '2026-07-14T12:00:00.000Z', sourceState: 'healthy',
      pools: { 'codex-cmp': { remainingCredits: 42 } },
    });
  }, 60_000);
});
