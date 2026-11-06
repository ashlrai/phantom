import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({ legacy: 0, imports: 0, collector: [] as unknown[], paths: [] as string[] }));
vi.mock('../src/core/config.js', () => { calls.legacy++; throw new Error('legacy config loaded'); });
vi.mock('../src/core/fabric/resource-monitor.js', () => { calls.legacy++; throw new Error('legacy monitor loaded'); });
vi.mock('../src/core/fleet/codex-session-usage.js', async (importOriginal) => {
  calls.imports++;
  const actual = await importOriginal<typeof import('../src/core/fleet/codex-session-usage.js')>();
  return { ...actual, collectCodexSessionUsages: (opts: unknown) => {
    calls.collector.push(opts);
    return actual.collectCodexSessionUsages(opts as Parameters<typeof actual.collectCodexSessionUsages>[0]);
  } };
});
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const lstatSync = ((...args: Parameters<typeof actual.lstatSync>) => {
    calls.paths.push(String(args[0])); return actual.lstatSync(...args);
  }) as typeof actual.lstatSync;
  const readdirSync = ((...args: Parameters<typeof actual.readdirSync>) => {
    calls.paths.push(String(args[0])); return actual.readdirSync(...args);
  }) as typeof actual.readdirSync;
  const openSync = ((...args: Parameters<typeof actual.openSync>) => {
    calls.paths.push(String(args[0])); return actual.openSync(...args);
  }) as typeof actual.openSync;
  return { ...actual, lstatSync, readdirSync, openSync };
});

import { cmdResources } from '../src/cli/resources.js';
import type { CodexResourceReport } from '../src/core/fleet/codex-session-usage.js';

const NOW = '2036-06-14T12:00:00.000Z';
let root: string;
let previousHome: string | undefined;
let output: ReturnType<typeof vi.spyOn>;

function rollout(home: string, rateLimits: unknown, timestamp = NOW): void {
  const dir = join(home, 'sessions', '2036', '06', '14');
  mkdirSync(dir, { recursive: true });
  const lines = [
    { type: 'session_meta', timestamp, payload: { id: 'private-session-id', cwd: '/private/project', originator: '/private/path', cli_version: 'private-session-id' } },
    { type: 'response_item', payload: { content: 'private prompt' } },
    { type: 'event_msg', timestamp, payload: { type: 'token_count', rate_limits: rateLimits, api_key: 'private-credential' } },
  ];
  writeFileSync(join(dir, 'rollout-2036-06-14-test.jsonl'), lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
}
function limits(session: unknown, weekly: unknown): unknown {
  return { limit_id: 'private-session-id', limit_name: 'private prompt', normal_model_slug: '/private/path', primary: session, secondary: weekly, plan_type: 'pro' };
}
function window(used: number, minutes: number, reset: string): unknown {
  return { used_percent: used, window_minutes: minutes, resets_at: Date.parse(reset) / 1000 };
}
function report(): CodexResourceReport {
  return JSON.parse(String(output.mock.calls.at(-1)![0]));
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'personal-usage-')));
  previousHome = process.env['HOME'];
  process.env['HOME'] = root;
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  output = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  calls.paths.length = 0; calls.collector.length = 0; calls.legacy = 0;
});
afterEach(() => {
  if (previousHome === undefined) delete process.env['HOME']; else process.env['HOME'] = previousHome;
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe('phm resources personal', () => {
  it('handles help and rejects malformed arguments before collection', async () => {
    const imports = calls.imports;
    for (const args of [['personal', '--help'], ['--help']]) expect(await cmdResources(args)).toBe(0);
    expect(output.mock.calls.map((call) => call[0]).join('\n')).toContain('phm resources personal');
    for (const args of [
      ['--json', '--json'], ['--help', '-h'], ['extra'], ['--watch'], ['--home'], ['--home', 'relative'],
      ['--home', '/tmp/x', '--home', '/tmp/y'], ['--home', '/tmp/\0bad'], ['--home', '/'], ['--home', '/tmp/../home'], ['--home', join(root, '.codex')],
      ['--help', '--bad'], ['--home', '--json'], ['--home=/tmp/x'],
    ]) expect(await cmdResources(['personal', ...args])).toBe(2);
    expect(calls.imports).toBe(imports);
    expect(calls.collector).toHaveLength(0);
    expect(calls.paths).toHaveLength(0);
    expect(calls.legacy).toBe(0);
  });

  it('reports only personal windows and never reads other account or private files', async () => {
    const personal = join(root, '.codex-2');
    rollout(personal, limits(window(21, 300, '2036-06-14T17:00:00Z'), window(46, 10080, '2036-06-21T12:00:00Z')));
    rollout(join(root, '.codex'), limits(window(99, 300, '2036-06-14T17:00:00Z'), null));
    writeFileSync(join(personal, 'auth.json'), 'private-credential');
    calls.paths.length = 0;
    expect(await cmdResources(['personal', '--json'])).toBe(0);
    const result = report();
    expect(result.v).toBe('resource.v1');
    expect(result.resources).toHaveLength(1);
    expect(result.resources[0]).toMatchObject({ id: 'codex-personal', slot: 'secondary', state: 'current', observedAt: NOW,
      session: { usedPct: 21, resetsAt: '2036-06-14T17:00:00.000Z', burnPctPerHour: null },
      weekly: { usedPct: 46, resetsAt: '2036-06-21T12:00:00.000Z', burnPctPerHour: null } });
    const json = JSON.stringify(result);
    for (const secret of [root, '/private/path', 'private-session-id', 'private prompt', 'private-credential', '99']) expect(json).not.toContain(secret);
    expect(calls.collector).toEqual([{ env: { CODEX_HOME: personal, CODEX_HOME_ALT: personal }, homeDir: root }]);
    expect(calls.paths.some((path) => (path === join(root, '.codex') || path.startsWith(join(root, '.codex') + '/')) || /auth\.json|fleet\.json/.test(path))).toBe(false);
    expect(calls.legacy).toBe(0);
  });

  it('renders separate windows with freshness and timestamps', async () => {
    rollout(join(root, '.codex-2'), limits(window(12, 300, '2036-06-14T17:00:00Z'), window(46, 10080, '2036-06-21T12:00:00Z')));
    expect(await cmdResources(['personal'])).toBe(0);
    const text = output.mock.calls.map((call) => call[0]).join('\n');
    expect(text).toContain(`Freshness: current | observed: ${NOW}`);
    expect(text).toContain('Session: 12% used | resets: 2036-06-14T17:00:00.000Z');
    expect(text).toContain('Weekly: 46% used | resets: 2036-06-21T12:00:00.000Z');
  });

  it('reports missing, invalid and stale evidence honestly', async () => {
    expect(await cmdResources(['personal', '--json'])).toBe(0);
    expect(report().resources[0]).toMatchObject({ state: 'unavailable', observedAt: null, session: null, weekly: null });
    const personal = join(root, '.codex-2');
    rollout(personal, limits(window(-1, 300, '2036-06-14T17:00:00Z'), null));
    expect(await cmdResources(['personal', '--json'])).toBe(0);
    expect(report().resources[0]).toMatchObject({ state: 'unavailable', session: null, weekly: null });
    rollout(personal, limits(window(46, 300, '2036-06-12T17:00:00Z'), null), '2036-06-12T12:00:00Z');
    expect(await cmdResources(['personal', '--json'])).toBe(0);
    expect(report().resources[0]).toMatchObject({ state: 'stale', session: { usedPct: 46 }, weekly: null });
    expect(await cmdResources(['personal'])).toBe(0);
    expect(output.mock.calls.map((call) => call[0]).join('\n')).toContain('Weekly: unavailable');
  });

  it('uses an explicit absolute home and ignores inherited provider overrides', async () => {
    vi.stubEnv('CODEX_HOME', join(root, '.codex'));
    vi.stubEnv('CODEX_HOME_ALT', join(root, 'unrelated'));
    const custom = join(root, 'custom');
    rollout(custom, limits(null, window(46, 10080, '2036-06-21T12:00:00Z')));
    expect(await cmdResources(['personal', '--home', custom, '--json'])).toBe(0);
    expect(report().resources[0]).toMatchObject({ id: 'codex-personal', weekly: { usedPct: 46 } });
    expect(calls.collector[0]).toEqual({ env: { CODEX_HOME: custom, CODEX_HOME_ALT: custom }, homeDir: root });
  });


});
