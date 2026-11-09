import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetActivity } from '../src/cli/fleet-activity.js';
import { readAgentActivity, summarizeAgentActivity } from '../src/core/fleet/agent-activity.js';

const now = Date.parse('2026-11-03T12:00:00Z');
const at = (hour: number) => `2026-11-03T${String(hour).padStart(2, '0')}:00:00Z`;
const row = (event: string | null, hour: number, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ ...(event ? { event } : {}), job: 'RQ-PRESERVE-1', ts: at(hour), ...extra });
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

it('keeps delayed eventless and explicit terminal rows on the earlier attempt across reader and CLI', async () => {
  const url = 'https://github.com/ashlrai/phantom/pull/11';
  const ledger = [
    row('launch', 6), row('finish', 7, { exit_code: 0, wall_s: 3600 }),
    row(null, 8, { state: 'PUBLISHED', url }),
    row('enqueue', 10), row('launch', 11),
    row('finish', 9, { exit_code: 0, wall_s: 99, tokens_total: 123 }),
    row(null, 9, { outcome: 'MERGED', url }),
  ].join('\n');
  const dir = mkdtempSync(join(tmpdir(), 'activity-preservation-')); dirs.push(dir);
  const path = join(dir, 'jobs.jsonl'); writeFileSync(path, ledger);
  const fold = summarizeAgentActivity(ledger, now);
  const report = await readAgentActivity({ jobsPath: path, now: () => now });
  const expected = {
    stage: 'running', queuedAt: '2026-11-03T10:00:00.000Z', launchedAt: '2026-11-03T11:00:00.000Z',
    finishedAt: null, publishedAt: null, outcomeAt: null, outcome: null, url: null,
    queueWaitS: 3600, runS: null, publishLagS: null, wallS: null, tokensTotal: null, exitCode: null, ageS: 3600,
  };
  expect(fold.jobs[0]).toMatchObject(expected);
  expect(report.jobs[0]).toMatchObject(expected);
  expect(report.verified).toEqual(fold.verified);
  expect(report.verified).toMatchObject({ schema: 'fleet.verified-completion.v1', sourceState: 'healthy' });
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdFleetActivity(['--jobs', path, '--json'], readAgentActivity, () => now)).toBe(0);
  const cli = JSON.parse(log.mock.calls[0]![0] as string);
  expect(cli.jobs[0]).toMatchObject(expected);
  expect(cli.verified).toEqual(report.verified);
});

it('reports a missing ledger as missing with an unresolved verification rate', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'activity-missing-')); dirs.push(dir);
  const path = join(dir, 'missing.jsonl');
  const report = await readAgentActivity({ jobsPath: path, now: () => now });
  expect(report).toMatchObject({ sourceState: 'missing', jobs: [], verified: { sourceState: 'missing', rate: null } });
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdFleetActivity(['--jobs', path, '--json'], readAgentActivity, () => now)).toBe(0);
  expect(JSON.parse(log.mock.calls[0]![0] as string)).toMatchObject({ sourceState: 'missing', verified: { sourceState: 'missing', rate: null } });
});
