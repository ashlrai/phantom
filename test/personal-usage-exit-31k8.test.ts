import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CodexResourceReport, CodexSessionUsage } from '../src/core/fleet/codex-session-usage.js';

const mocks = vi.hoisted(() => ({
  collect: vi.fn(),
  report: vi.fn(),
}));

vi.mock('node:os', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:os')>(),
  homedir: () => '/fake-home',
}));
vi.mock('../src/core/fleet/codex-session-usage.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/fleet/codex-session-usage.js')>();
  mocks.report.mockImplementation(actual.buildCodexResourceReport);
  return { ...actual, collectCodexSessionUsages: mocks.collect, buildCodexResourceReport: mocks.report };
});

import { cmdResourcePersonalUsage } from '../src/cli/resource-personal-usage.js';

const now = '2036-06-14T12:00:00.000Z';
const reset = '2036-06-14T17:00:00.000Z';

function usage(overrides: Partial<CodexSessionUsage> = {}): CodexSessionUsage {
  return {
    accountId: 'codex-cmp', slot: 'primary', observedAt: now,
    planType: null, limitId: 'private', limitName: 'private', rateLimitReachedType: null,
    spendControlReached: null, individualLimit: null, model: 'private', originator: 'private', cliVersion: 'private',
    primary: { usedPercent: 23, windowMinutes: 300, resetsAt: Date.parse(reset) / 1000 },
    secondary: { usedPercent: 47, windowMinutes: 10080, resetsAt: Date.parse('2036-06-21T12:00:00Z') / 1000 },
    credits: null, ...overrides,
  };
}

let output: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(now));
  mocks.collect.mockReset();
  mocks.report.mockClear();
  output = vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function jsonOutput(): CodexResourceReport {
  expect(output).toHaveBeenCalledTimes(1);
  return JSON.parse(String(output.mock.calls[0]![0])) as CodexResourceReport;
}

describe('personal usage exit status', () => {
  it('succeeds for current evidence and preserves the resource.v1 report', () => {
    mocks.collect.mockReturnValue([usage()]);
    expect(cmdResourcePersonalUsage({ json: true })).toBe(0);
    const result = jsonOutput();
    expect(result).toEqual(mocks.report.mock.results[0]!.value);
    expect(result).toMatchObject({ v: 'resource.v1', resources: [{
      id: 'codex-personal', slot: 'secondary', state: 'current', observedAt: now,
      session: { usedPct: 23, leftPct: 77, resetsAt: reset },
      weekly: { usedPct: 47, leftPct: 53, resetsAt: '2036-06-21T12:00:00.000Z' },
      limitId: null, limitName: null, model: null, cli: { originator: null, version: null },
    }] });
    expect(mocks.collect).toHaveBeenCalledWith({
      env: { CODEX_HOME: join('/fake-home', '.codex-2'), CODEX_HOME_ALT: join('/fake-home', '.codex-2') },
      homeDir: '/fake-home',
    });
    expect(mocks.report).toHaveBeenCalledWith([expect.objectContaining({ accountId: 'codex-personal', slot: 'secondary' })], [], Date.parse(now));
  });

  it('returns 1 for stale evidence while retaining historical values and freshness', () => {
    const staleReset = '2036-06-12T17:00:00.000Z';
    mocks.collect.mockReturnValue([usage({ observedAt: '2036-06-12T12:00:00.000Z',
      primary: { usedPercent: 23, windowMinutes: 300, resetsAt: Date.parse(staleReset) / 1000 } })]);
    expect(cmdResourcePersonalUsage({ json: true })).toBe(1);
    expect(jsonOutput().resources[0]).toMatchObject({ state: 'stale', session: { usedPct: 23, leftPct: 77, resetsAt: staleReset } });
    output.mockClear();
    expect(cmdResourcePersonalUsage({ json: false })).toBe(1);
    const text = output.mock.calls.map((call) => call[0]).join('\n');
    expect(text).toContain('Freshness: stale | observed: 2036-06-12T12:00:00.000Z');
    expect(text).toContain(`Session: 23% used | resets: ${staleReset}`);
  });

  it('returns 1 and emits parseable unavailable JSON when no reading exists', () => {
    mocks.collect.mockReturnValue([]);
    expect(cmdResourcePersonalUsage({ json: true })).toBe(1);
    expect(jsonOutput()).toMatchObject({ v: 'resource.v1', resources: [{ state: 'unavailable', observedAt: null, session: null, weekly: null }] });
  });

  it('returns 1 for malformed windows and a reading without an observation time', () => {
    mocks.collect.mockReturnValue([usage({ primary: { usedPercent: -1, windowMinutes: 300, resetsAt: null }, secondary: null })]);
    expect(cmdResourcePersonalUsage({ json: true })).toBe(1);
    expect(jsonOutput().resources[0]).toMatchObject({ state: 'unavailable', session: null, weekly: null });
    output.mockClear();
    mocks.collect.mockReturnValue([usage({ observedAt: null })]);
    expect(cmdResourcePersonalUsage({ json: true })).toBe(1);
    expect(jsonOutput().resources[0]).toMatchObject({ state: 'stale', observedAt: null });
  });

  it('fails closed if the report contains no resource', () => {
    mocks.collect.mockReturnValue([]);
    mocks.report.mockReturnValueOnce({ v: 'resource.v1', generatedAt: now, resources: [] });
    expect(cmdResourcePersonalUsage({ json: true, home: '/fake-custom' })).toBe(1);
    expect(jsonOutput().resources).toEqual([]);
    expect(mocks.collect).toHaveBeenCalledWith({ env: { CODEX_HOME: '/fake-custom', CODEX_HOME_ALT: '/fake-custom' }, homeDir: '/fake-home' });
  });
});
