import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cmdFleet } from '../src/cli/fleet.js';
import { cmdFleetRecordedConfig } from '../src/cli/fleet-recorded-config.js';
import { resolveFleetSubcommand } from '../src/cli/fleet-subcommand-resolve.js';
import {
  inspectRecordedSchedulerConfig, parseRecordedSchedulerConfig, RecordedConfigError,
  type RecordedConfigInspection,
} from '../src/core/providers/coding-cli/recorded-config-inspection.js';

// Recovered from PR #5952 (3d6c8fb7c7f7d52655fb3e0f13ef239686f7b886). All values are synthetic.
type Obj = Record<string, unknown>;

function fixture(): Obj {
  return {
    version: 1,
    source: 'synthetic-operator-note',
    sourceDate: '2026-01-01T00:00:00.000Z',
    note: 'free text the projection must not echo',
    diskFloorGb: 5,
    canaryPercent: 0,
    posthog: { enabled: true, host: 'https://example.invalid/fake-host', apiKey: 'fake-api-key-value' },
    grokUltraWeekly: { id: 'grok-ultra-weekly', plan: 'synthetic plan', usedFraction: 0, orchestrationReserveFraction: 0.15, label: 'synthetic label' },
    pools: {
      claude: {
        billing: 'subscription', tier: 'frontier', host: 'mac', concurrency: 0, preferencePenalty: 0.04,
        live: true, remaining: 0, expiresAt: null, command: 'synthetic-command-string', apiKey: 'fake-pool-secret',
      },
      local: { billing: 'loopback', tier: 'cheap', host: 'mac', concurrency: 1, unlimited: true },
    },
  };
}

/** Path of the RecordedConfigError raised by fn, or a failure. */
function errorPath(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof RecordedConfigError) return err.path;
    throw err;
  }
  throw new Error('expected RecordedConfigError');
}

describe('inspectRecordedSchedulerConfig', () => {
  it('reports only supplied scalars, keeps zero, and fills no absent field from a default', () => {
    const out = inspectRecordedSchedulerConfig({ diskFloorGb: 5, canaryPercent: 0 });
    expect(out.scalars).toEqual({ diskFloorGb: 5, canaryPercent: 0 });
    expect(out.unsuppliedScalars).toEqual(expect.arrayContaining(['batteryFloorPercent', 'paceTickMs']));
    expect(out.unsuppliedScalars).not.toContain('diskFloorGb');
    expect(out.unsuppliedPools).toHaveLength(8);
    expect(out).toMatchObject({
      state: 'recorded-input-only', currentAvailability: 'not-current-availability',
      policy: 'no-policy-applied', postIssues: false, grokUltraWeekly: null, posthog: null, obsoleteReserve: null,
    });
  });

  it('reports source and sourceDate as supplied attribution, and identifies a reserve without applying it', () => {
    const out = inspectRecordedSchedulerConfig(fixture());
    expect(out.provenance).toMatchObject({ sourcePr: 5952, suppliedSource: 'synthetic-operator-note', suppliedSourceDate: '2026-01-01T00:00:00.000Z' });
    expect(out.obsoleteReserve).toEqual({ orchestrationReserveFraction: 0.15, status: 'recorded-obsolete', automaticReserveApplied: false });
    const bare = fixture();
    delete (bare['grokUltraWeekly'] as Obj)['orchestrationReserveFraction'];
    const without = inspectRecordedSchedulerConfig(bare);
    expect(without.obsoleteReserve).toBeNull();
    expect(without.pools).toEqual(out.pools);
    expect(without.scalars).toEqual(out.scalars);
  });

  it('keeps zero reserve, remaining, and concurrency, and lists unsupplied pool fields with null as supplied', () => {
    const out = inspectRecordedSchedulerConfig({ grokUltraWeekly: { orchestrationReserveFraction: 0 }, pools: { claude: { concurrency: 0, remaining: 0, resetAt: null } } });
    expect(out.obsoleteReserve?.orchestrationReserveFraction).toBe(0);
    expect(out.pools.claude).toMatchObject({ supplied: { concurrency: 0, remaining: 0, resetAt: null } });
    expect(out.pools.claude?.unsuppliedFields).toContain('softCapPerDay');
  });

  it('accepts inclusive bounds and rejects out-of-range or wrong-typed values with the failing path', () => {
    expect(inspectRecordedSchedulerConfig({ batteryFloorPercent: 100 }).scalars.batteryFloorPercent).toBe(100);
    expect(inspectRecordedSchedulerConfig({ batteryFloorPercent: 0 }).scalars.batteryFloorPercent).toBe(0);
    expect(errorPath(() => inspectRecordedSchedulerConfig({ batteryFloorPercent: 101 }))).toBe('batteryFloorPercent');
    expect(errorPath(() => inspectRecordedSchedulerConfig({ diskFloorGb: '5' }))).toBe('diskFloorGb');
    expect(errorPath(() => inspectRecordedSchedulerConfig({ pools: { claude: { concurrency: -1 } } }))).toBe('pools.claude.concurrency');
    expect(errorPath(() => inspectRecordedSchedulerConfig({ pools: { claude: { billing: 'cloud' } } }))).toBe('pools.claude.billing');
    expect(errorPath(() => inspectRecordedSchedulerConfig({ pools: { claude: { live: 'yes' } } }))).toBe('pools.claude.live');
    expect(errorPath(() => inspectRecordedSchedulerConfig({ grokUltraWeekly: { usedFraction: 1.5 } }))).toBe('grokUltraWeekly.usedFraction');
    expect(errorPath(() => inspectRecordedSchedulerConfig({ pools: { 'made-up': {} } }))).toBe('pools.made-up');
    expect(errorPath(() => inspectRecordedSchedulerConfig({ posthog: 'on' }))).toBe('posthog');
    expect(errorPath(() => inspectRecordedSchedulerConfig([]))).toBe('$');
    expect(errorPath(() => inspectRecordedSchedulerConfig({ postIssues: true }))).toBe('postIssues');
    expect(errorPath(() => inspectRecordedSchedulerConfig({ version: 2 }))).toBe('version');
  });

  it('reduces posthog to booleans and drops unknown, note, command, and credential fields with counts only', () => {
    const out = inspectRecordedSchedulerConfig(fixture());
    expect(out.posthog).toEqual({ suppliedEnabled: true, hostConfigured: true, apiKeyConfigured: true });
    const serialized = JSON.stringify(out);
    for (const secret of ['fake-api-key-value', 'example.invalid', 'free text the projection must not echo', 'synthetic-command-string', 'fake-pool-secret', 'synthetic label']) {
      expect(serialized).not.toContain(secret);
    }
    expect(out.omittedTopLevelCount).toBe(1);
    expect(out.grokUltraWeekly?.omittedFieldCount).toBe(2);
  });

  it('reports malformed JSON at the root path and never mutates a deeply frozen input', () => {
    expect(errorPath(() => parseRecordedSchedulerConfig('{"diskFloorGb": '))).toBe('$');
    const frozen = fixture();
    const deepFreeze = (v: unknown): void => {
      if (typeof v === 'object' && v !== null) { Object.values(v).forEach(deepFreeze); Object.freeze(v); }
    };
    deepFreeze(frozen);
    const before = JSON.stringify(frozen);
    expect(() => inspectRecordedSchedulerConfig(frozen)).not.toThrow();
    expect(JSON.stringify(frozen)).toBe(before);
  });
});

describe('fleet recorded-config CLI', () => {
  let dir: string;
  let fetchSpy: ReturnType<typeof vi.fn>;
  let logs: string[];
  let errors: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'recorded-config-673s-'));
    writeFileSync(join(dir, 'sentinel.json'), '{"diskFloorGb": 99}');
    fetchSpy = vi.fn(() => { throw new Error('network must not be used'); });
    vi.stubGlobal('fetch', fetchSpy);
    logs = [];
    errors = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.join(' ')); });
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(a.join(' ')); });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });

  const write = (name: string, body: unknown): string => {
    const file = join(dir, name);
    writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body));
    return file;
  };

  it('prints a JSON projection for a partial file, and a human summary with the obsolete-reserve line', async () => {
    expect(await cmdFleetRecordedConfig(['--file', write('partial.json', { diskFloorGb: 5, pools: { claude: { concurrency: 0 } } }), '--json'])).toBe(0);
    const out = JSON.parse(logs.at(-1)!) as RecordedConfigInspection;
    expect(out.scalars).toEqual({ diskFloorGb: 5 });
    expect(out.pools.claude?.supplied).toEqual({ concurrency: 0 });
    logs = [];
    expect(await cmdFleetRecordedConfig(['--file', write('full.json', fixture())])).toBe(0);
    const text = logs.join('\n');
    expect(text).toContain('Obsolete reserve recorded: orchestrationReserveFraction 0.15; automaticReserveApplied false.');
    expect(text).not.toContain('fake-api-key-value');
  });

  it('exits 1 with a path-specific JSON error for an invalid value, 1 for malformed JSON, and 1 for a missing file', async () => {
    expect(await cmdFleetRecordedConfig(['--file', write('bad.json', { pools: { claude: { concurrency: 10001 } } }), '--json'])).toBe(1);
    expect(JSON.parse(logs.at(-1)!)).toMatchObject({ error: 'invalid-recorded-config', path: 'pools.claude.concurrency' });
    expect(await cmdFleetRecordedConfig(['--file', write('malformed.json', '{"diskFloorGb": ')])).toBe(1);
    expect(errors.join('\n')).toContain('is not valid JSON');
    expect(await cmdFleetRecordedConfig(['--file', join(dir, 'absent.json'), '--json'])).toBe(1);
    expect(JSON.parse(logs.at(-1)!)).toEqual({ error: 'unreadable-file', file: join(dir, 'absent.json') });
  });

  it('exits 2 for invalid arguments without reading a file, and prints usage for --help', async () => {
    const readText = vi.fn(() => '{}');
    for (const bad of [[], ['--file'], ['--file', '--json'], ['--file', 'a.json', '--file', 'b.json'], ['--file', 'a.json', '--bogus']]) {
      expect(await cmdFleetRecordedConfig(bad, { readText })).toBe(2);
    }
    expect(readText).not.toHaveBeenCalled();
    expect(await cmdFleetRecordedConfig(['--help'])).toBe(0);
    expect(logs.join('\n')).toContain('Usage: ashlr fleet recorded-config --file <path> [--json]');
  });

  it('dispatches through cmdFleet by convention with an injected loader', async () => {
    const loaders = { 'recorded-config': () => import('../src/cli/fleet-recorded-config.js') };
    expect(await cmdFleet(['recorded-config', '--file', write('dispatch.json', { canaryPercent: 10 }), '--json'], loaders)).toBe(0);
    expect(JSON.parse(logs.at(-1)!).scalars).toEqual({ canaryPercent: 10 });
    expect(resolveFleetSubcommand('recorded-config')).toEqual({ module: './fleet-recorded-config.js', exportName: 'cmdFleetRecordedConfig' });
  });

  it('reads only the named file, with no network call and no new files', async () => {
    const file = write('only.json', { diskFloorGb: 7 });
    const before = readdirSync(dir).sort();
    const readText = vi.fn((absolute: string) => readFileSync(absolute, 'utf8'));
    expect(await cmdFleetRecordedConfig(['--file', file, '--json'], { readText })).toBe(0);
    expect(readText).toHaveBeenCalledOnce();
    expect(readText).toHaveBeenCalledWith(file);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(readdirSync(dir).sort()).toEqual(before);
  });

  it('keeps the new modules free of HOME, env, network, process, and write access', () => {
    for (const path of ['../src/core/providers/coding-cli/recorded-config-inspection.ts', '../src/cli/fleet-recorded-config.ts']) {
      const source = readFileSync(new URL(path, import.meta.url), 'utf8');
      for (const spec of [...source.matchAll(/from '([^']+)'/g)].map((m) => m[1])) {
        expect(['node:fs', 'node:path', '../core/providers/coding-cli/recorded-config-inspection.js']).toContain(spec);
      }
      for (const banned of ['homedir', 'process.env', 'fetch(', 'child_process', 'writeFile', 'mkdirSync', 'http']) {
        expect(source.includes(banned), `${path} must not reference ${banned}`).toBe(false);
      }
    }
  });
});
