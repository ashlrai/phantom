import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleet } from '../src/cli/fleet.js';
import { cmdFleetStandby, findStandbyReadinessScript } from '../src/cli/fleet-standby.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
import { resolveFleetSubcommand } from '../src/cli/fleet-subcommand-resolve.js';

const BRIDGE = fileURLToPath(new URL('../scripts/mac-bridge/', import.meta.url));
const SCRIPT = join(BRIDGE, 'standby_readiness.py');
const locate = () => SCRIPT;

const FAKE_FILES: Record<string, string> = {
  'queue/router-queue.md': 'Q\n',
  'queue/ready.tsv': 'F\n',
  'queue/slots.json': '{}\n',
  'leader/VISION.md': 'FAKE vision\n',
  'leader/ORCHESTRATION.md': 'O\n',
  'metrics/jobs.jsonl': '{}\n',
};

function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'fleet-standby-'));
  const root = join(base, 'fleet-state');
  const store = join(base, 'snapshots');
  mkdirSync(store);
  for (const [rel, text] of Object.entries(FAKE_FILES)) {
    const path = join(root, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
  const db = join(base, 'leases.sqlite');
  // A real lease held by the primary, granted by the real host_lease.py.
  execFileSync('python3', ['-B', join(BRIDGE, 'host_lease.py'), '--db', db,
    'acquire', 'leader', '--host', 'primary', '--primary', 'primary',
    '--ttl', '30', '--grace', '0'], { timeout: 30_000 });
  // A real verified generation published by the real snapshot_publish.py.
  execFileSync('python3', ['-B', join(BRIDGE, 'snapshot_publish.py'),
    '--root', root, '--destination', store, '--once', '--reserve-bytes', '0'],
    { timeout: 30_000 });
  const flags = ['--db', db, '--snapshot-store', store, '--primary', 'primary',
    '--role', 'leader', '--host', 'standby'];
  return { base, db, store, flags };
}

afterEach(() => vi.restoreAllMocks());

describe('fleet standby', () => {
  it('refuses bad arguments with usage on stderr, exit 2, and never spawns', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exec = vi.fn();
    const good = fixture().flags;
    const swap = (flag: string, value: string) => {
      const args = [...good];
      args[args.indexOf(flag) + 1] = value;
      return args;
    };
    for (const args of [
      [],
      ['--db', '/tmp/x'],
      good.slice(0, 4),                          // required flags missing
      [...good, '--bogus'],
      [...good, '--json', '--json'],             // duplicate
      [...good, '--db'],                         // missing value
      [...good, '--max-age', '59'],
      [...good, '--max-age', '86401'],
      [...good, '--max-age', 'abc'],
      ['--db', '--json', '--snapshot-store', 'x', '--primary', 'p', '--role', 'r', '--host', 'h'],
      swap('--primary', 'bad host'),
      swap('--role', 'has space'),
      swap('--host', '-lead'),
    ]) {
      expect(await cmdFleetStandby(args, { exec, locateScript: locate }), JSON.stringify(args)).toBe(2);
    }
    expect(exec).not.toHaveBeenCalled();
    expect(err).toHaveBeenCalledWith(expect.stringContaining('Usage: ashlr fleet standby'));
  });

  it('prints its own help on --help and exits 0 without spawning', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exec = vi.fn();
    expect(await cmdFleetStandby(['--help'], { exec, locateScript: locate })).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Usage: ashlr fleet standby'));
    expect(exec).not.toHaveBeenCalled();
  });

  it('runs a real python3 child and passes the report through with --json', async () => {
    const { flags } = fixture();
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    expect(await cmdFleetStandby([...flags, '--json'], { locateScript: locate })).toBe(0);
    const report = JSON.parse(String(write.mock.calls[0]![0]));
    expect(report).toMatchObject({
      version: 1, tool: 'standby_readiness', ready: true, blockers: [],
      leaseHolder: 'primary',
    });
    expect(report.generation).toMatch(/^snap-\d{8}T\d{6}Z-[0-9a-f]{8}$/);
    expect(report.snapshotAgeSec).toBeGreaterThanOrEqual(0);
    expect(report.wouldLoseSec).toBe(report.snapshotAgeSec);
  });

  it('prints short plain sentences in human mode', async () => {
    const { flags } = fixture();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleetStandby(flags, { locateScript: locate })).toBe(0);
    const line = String(log.mock.calls[0]![0]);
    expect(line).toContain('Standby can take over.');
    expect(line).toContain('work would be lost');
    expect(line.split('. ').length).toBeLessThanOrEqual(3);
  });

  it('names the first blocker plainly when the standby cannot take over', async () => {
    const { base, flags } = fixture();
    const args = [...flags];
    args[args.indexOf('--db') + 1] = join(base, 'absent.sqlite');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleetStandby(args, { locateScript: locate })).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Standby cannot take over: no-lease-db.'));
  });

  it('reports the missing script and exits 1 without spawning', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exec = vi.fn();
    const { flags } = fixture();
    expect(await cmdFleetStandby(flags, { exec, locateScript: () => null })).toBe(1);
    expect(exec).not.toHaveBeenCalled();
    expect(err.mock.calls.flat().join('')).toContain('standby_readiness.py');
  });

  it('resolves through the real fleet registry and dispatches ashlr fleet standby --help', async () => {
    const resolved = resolveFleetSubcommand('standby');
    expect(resolved).toEqual({ module: './fleet-standby.js', exportName: 'cmdFleetStandby' });
    const loaded = await FLEET_SUBCOMMAND_LOADERS['standby']!();
    expect(typeof loaded[resolved!.exportName]).toBe('function');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleet(['standby', '--help'])).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Usage: ashlr fleet standby'));
  });

  it('locates the repo script with the default locator', async () => {
    const script = await findStandbyReadinessScript();
    expect(script).not.toBeNull();
    expect(script!).toMatch(/scripts[/\\]mac-bridge[/\\]standby_readiness\.py$/);
    expect(existsSync(script!)).toBe(true);
    expect(readFileSync(script!, 'utf8')).toContain('def evaluate');
  });
});
