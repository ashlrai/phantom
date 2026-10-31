import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CodexResourceReport, CodexSessionUsage } from '../src/core/fleet/codex-session-usage.js';

const mocks = vi.hoisted(() => ({ collect: vi.fn(), report: vi.fn() }));
vi.mock('../src/core/fleet/codex-session-usage.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/core/fleet/codex-session-usage.js')>(),
  collectCodexSessionUsages: mocks.collect,
  buildCodexResourceReport: mocks.report,
}));

import { cmdResourcePersonalUsage } from '../src/cli/resource-personal-usage.js';
import { buildCodexResourceReport } from '../src/core/fleet/codex-session-usage.js';

const now = '2036-06-14T12:00:00.000Z';
const exhaustion = '2036-06-16T12:00:00.000Z';
const usage: CodexSessionUsage = {
  accountId: 'fake-personal', slot: 'secondary', observedAt: now,
  planType: null, limitId: null, limitName: null, rateLimitReachedType: null,
  spendControlReached: null, individualLimit: null, model: null, originator: null,
  cliVersion: null,
  primary: { usedPercent: 20, windowMinutes: 300, resetsAt: Date.parse('2036-06-14T17:00:00Z') / 1000 },
  secondary: { usedPercent: 40, windowMinutes: 10080, resetsAt: Date.parse('2036-06-21T12:00:00Z') / 1000 },
  credits: null,
};

let home: string;
let output: ReturnType<typeof vi.spyOn>;
let actualBuild: typeof buildCodexResourceReport;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'personal-burn-'));
  vi.useFakeTimers();
  vi.setSystemTime(new Date(now));
  mocks.collect.mockReset().mockReturnValue([usage]);
  mocks.report.mockReset();
  actualBuild = (await vi.importActual<typeof import('../src/core/fleet/codex-session-usage.js')>(
    '../src/core/fleet/codex-session-usage.js',
  )).buildCodexResourceReport;
  output = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
});

function fixture(): CodexResourceReport {
  const report = actualBuild([usage], [], Date.parse(now));
  Object.assign(report.resources[0]!.session!, { burnPctPerHour: 99, projectedExhaustionAt: '2036-06-14T13:00:00.000Z' });
  Object.assign(report.resources[0]!.weekly!, { burnPctPerHour: 1.25, projectedExhaustionAt: exhaustion });
  return report;
}

function runText(report: CodexResourceReport): string {
  mocks.report.mockReturnValue(report);
  cmdResourcePersonalUsage({ json: false, home });
  return output.mock.calls.map((call) => call[0]).join('\n');
}

describe('personal weekly burn text', () => {
  it('uses the measured weekly values and labels current evidence', () => {
    const text = runText(fixture());
    expect(text).toContain(`Weekly measured burn: 1.25%/hour | projected exhaustion: ${exhaustion} | evidence: current`);
    expect(text).not.toContain('99%/hour');
    expect(text).not.toContain('2036-06-14T13:00:00.000Z');
  });

  it('labels stale values as stale', () => {
    const report = fixture();
    report.resources[0]!.state = 'stale';
    const text = runText(report);
    expect(text).toContain(`Weekly measured burn: 1.25%/hour | projected exhaustion: ${exhaustion} | evidence: stale`);
  });

  it('shows unknown when the weekly window is missing, even if the session has burn', () => {
    const report = fixture();
    report.resources[0]!.weekly = null;
    const text = runText(report);
    expect(text).toContain('Weekly: unavailable');
    expect(text).toContain('Weekly measured burn: unknown | projected exhaustion: unknown | evidence: current');
  });

  it('renders each null independently and preserves a measured zero', () => {
    const report = fixture();
    report.resources[0]!.weekly!.burnPctPerHour = null;
    expect(runText(report)).toContain(`Weekly measured burn: unknown | projected exhaustion: ${exhaustion}`);
    output.mockClear();
    report.resources[0]!.weekly!.burnPctPerHour = 0;
    report.resources[0]!.weekly!.projectedExhaustionAt = null;
    expect(runText(report)).toContain('Weekly measured burn: 0%/hour | projected exhaustion: unknown');
  });

  it('does not estimate from a single reading or write history', () => {
    mocks.report.mockImplementation(actualBuild);
    expect(cmdResourcePersonalUsage({ json: false, home })).toBe(0);
    expect(output.mock.calls.map((call) => call[0]).join('\n')).toContain(
      'Weekly measured burn: unknown | projected exhaustion: unknown | evidence: current',
    );
    expect(mocks.report).toHaveBeenCalledWith([expect.objectContaining({ accountId: 'codex-personal' })], [], Date.parse(now));
    expect(readdirSync(home)).toEqual([]);
  });

  it('preserves the JSON report without adding or changing fields', () => {
    const report = fixture();
    mocks.report.mockReturnValue(report);
    expect(cmdResourcePersonalUsage({ json: true, home })).toBe(0);
    expect(output).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(output.mock.calls[0]![0]))).toEqual(report);
    expect(mocks.report).toHaveBeenCalledWith([expect.objectContaining({ accountId: 'codex-personal' })], [], Date.parse(now));
    expect(readdirSync(home)).toEqual([]);
  });
});
