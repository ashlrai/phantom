import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdMetrics } from '../src/cli/metrics.js';
import { metricsFile, readTelemetry, recordEvent, type TelemetryInput } from '../src/core/metrics/telemetry.js';
import { gatherProposals, renderPublicProposal } from '../src/core/improve/loop.js';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'phm-metrics-boundary-'));
  vi.stubEnv('ASHLR_HOME', home);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });
const usage: TelemetryInput = { sessionId: 's', agent: 'codex', kind: 'usage', inputTokens: 10, outputTokens: 2 };

describe('telemetry boundary', () => {
  it.each([
    null, [], {}, { ...usage, v: 2 }, { ...usage, id: 'forged' }, { ...usage, kind: 'unknown' },
    { ...usage, inputTokens: -1 }, { ...usage, outputTokens: Infinity }, { ...usage, costUsd: NaN },
    { ...usage, ts: 'tomorrow' }, { ...usage, owner: 'client:' }, { ...usage, prompt: 'private text' },
    { sessionId: 's', agent: 'x', kind: 'pr.merged', pr: { repo: 'a/b', number: 0 } },
    { sessionId: 's', agent: 'x', kind: 'pr.rated', rating: 9, rater: 'human', pr: { repo: 'a/b', number: 1 } },
  ])('rejects invalid input before creating the log (%#)', (input) => {
    expect(() => recordEvent(input as TelemetryInput)).toThrow();
    expect(existsSync(metricsFile())).toBe(false);
  });

  it('preserves variant payloads, normalizes timestamps and keeps files private', () => {
    const ev = recordEvent({ ...usage, ts: '2026-10-13T12:00:00+02:00' });
    expect(ev.ts).toBe('2026-10-13T10:00:00.000Z');
    expect(readTelemetry()).toEqual([ev]);
    if (process.platform !== 'win32') expect(statSync(metricsFile()).mode & 0o777).toBe(0o600);
  });

  it('ignores corrupt, unrecognized, incomplete and secret-shaped saved records', () => {
    const ev = recordEvent(usage);
    appendFileSync(metricsFile(), '\ninvalid\n' + JSON.stringify({ ...ev, inputTokens: -1 }) + '\n' + JSON.stringify({ ...ev, v: 2 }) + '\n' + JSON.stringify({ ...ev, agent: 'sk-ant-api03-' + 'a'.repeat(90) }) + '\n');
    expect(readTelemetry()).toEqual([ev]);
  });

  it('refuses a linked telemetry file without changing its target', () => {
    recordEvent(usage);
    rmSync(metricsFile());
    const target = join(home, 'target'); writeFileSync(target, 'unchanged');
    symlinkSync(target, metricsFile());
    expect(() => recordEvent(usage)).toThrow();
    expect(readFileSync(target, 'utf8')).toBe('unchanged');
  });
});

describe('metrics CLI and proposal privacy', () => {
  it('generates a default dashboard before any telemetry exists', async () => {
    expect(await cmdMetrics(['dashboard'])).toBe(0);
    expect(readFileSync(join(home, 'metrics', 'dashboard.html'), 'utf8')).toContain('No data yet.');
    expect(existsSync(metricsFile())).toBe(false);
  });

  it.each([['--help'], ['record', '--help'], ['-h']])('help has no filesystem effects (%s)', async (...args) => {
    expect(await cmdMetrics(args)).toBe(0);
    expect(existsSync(join(home, 'metrics'))).toBe(false);
  });

  it.each([['summary', '--bad'], ['dashboard', '--out'], ['dashboard', '--out', '--bad'], ['record'], ['record', '{}', 'extra'], ['unknown']])('rejects invalid command arguments (%#)', async (...args) => {
    expect(await cmdMetrics(args)).toBe(2);
    expect(existsSync(join(home, 'metrics'))).toBe(false);
  });

  it('does not echo malformed JSON or credential-shaped input in diagnostics', async () => {
    const credential = 'sk-ant-api03-' + 'a'.repeat(90);
    expect(await cmdMetrics(['record', `{"agent":"${credential}`])).toBe(2);
    expect(await cmdMetrics(['record', JSON.stringify({ ...usage, agent: credential })])).toBe(1);
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(credential);
  });

  it('records and summarizes using --json before the subcommand', async () => {
    expect(await cmdMetrics(['--json', 'record', JSON.stringify(usage)])).toBe(0);
    expect(await cmdMetrics(['--json', 'summary'])).toBe(0);
    expect(JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)?.[0])).totals.tokens).toBe(12);
  });

  it('keeps agent identity and scores out of public improvement proposals', () => {
    for (let number = 1; number <= 3; number++) recordEvent({ kind: 'pr.merged', sessionId: `s${number}`, agent: 'private-client-worker', pr: { repo: 'private/client', number, deployedToProduction: true, followUpFixes: 3 } });
    const p = gatherProposals('default').find((p) => p.kind === 'metrics-quality');
    expect(p).toBeDefined();
    expect(p!.local?.title).toContain('private-client-worker');
    expect(renderPublicProposal(p!)).not.toMatch(/private-client-worker|private\/client|value\/1M tok|mean quality/);
    expect(renderPublicProposal(p!)).toContain('private evidence');
  });
});
