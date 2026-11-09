/**
 * RQ-REPORTS-NO-GROK-1: the 07:30/20:00 ET reports build deterministically —
 * no LLM, no Grok — from the world model, the jobs ledger and leader intents,
 * with PR-URL and Actions-run-id evidence. Per-day idempotence comes from the
 * report's own `day=` marker. Hermetic: temp dirs and injected sources only.
 */
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  buildScheduledReports,
  dueReportSlots,
  gatherReportFacts,
  renderReportMarkdown,
  reportMarkerDay,
  reportPath,
  summarizeJobsLedger,
  type ReportFacts,
  type ReportFactsDeps,
} from '../src/core/fleet/report-export.js';
import { cmdFleetReportExport } from '../src/cli/fleet-report-export.js';
import type { WorldModel } from '../src/core/world/types.js';
import type { GitRunResult } from '../src/core/verse/git-ops.js';
import type { FleetQueueV1 } from '../src/core/fleet/runs-parked-queue.js';
import type { ListGoalsDetailedResult } from '../src/core/goals/store.js';
import type { ProposalsReadResult } from '../src/core/inbox/store.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const runsRoot = (): string => { const dir = mkdtempSync(join(tmpdir(), 'report-export-')); dirs.push(dir); return dir; };

// 2026-11-09 is EST (UTC-5). 12:25Z = 07:25 ET — the 0730 build time.
const at = (iso: string): Date => new Date(iso);

const fresh = <T>(value: T): { value: T; source: string; observedAt: string; freshness: 'fresh' } =>
  ({ value, source: 'fixture', observedAt: '2026-11-09T12:00:00Z', freshness: 'fresh' });
const unknown = <T>(): { value: null; source: null; observedAt: null; freshness: 'unknown' } =>
  ({ value: null, source: null, observedAt: null, freshness: 'unknown' });

function worldFixture(): WorldModel {
  return {
    schema: 'ashlr.world-model/v1',
    generatedAt: '2026-11-09T12:00:00Z',
    readOnly: true,
    cache: { hit: true, ageMs: 42, ttlMs: 15_000 },
    sensors: {
      lanes: [{
        lane: 'devin', headroom: fresh(3), used: fresh(5), limit: fresh(8),
        remaining: fresh(20), burnRate: fresh(4), idleIncludedWastedPerWeek: unknown(),
        pacePerHour: fresh(1), requiredPacePerHour: fresh(2), runwayHours: fresh(5),
      }],
    },
    roster: { sessions: fresh(11), sources: [] },
    claims: { live: fresh(7) },
    bus: { readable: fresh(true) },
    queue: { ready: fresh(31), claimed: fresh(5) },
    ci: { repos: fresh(2), medianDailyTtgSeconds: fresh(240) },
    releases: { updateCheck: fresh('current'), train: fresh('on-time') },
    bottlenecks: { count: fresh(0) },
    humanSteps: { remaining: fresh(1) },
    outcomes: {
      repos: [{ repo: 'ashlrai/phantom', mergedPerDay: fresh(9.5), changeFailureRate: fresh(0.05) }],
    },
    blindSpots: [{ id: 'ci-repos', path: 'ci.repos', freshness: 'unknown', need: 'A local ci-metrics.json' }],
  };
}

const jobsNow = '2026-11-09T11:55:00Z';
const jobsLedger = [
  { event: 'launch', job: 'RQ-A-1', lane: 'devin', ts: '2026-11-09T08:00:00Z' },
  { event: 'finish', job: 'RQ-A-1', lane: 'devin', tokens_total: 4000, empty: false, ts: '2026-11-09T09:00:00Z' },
  { event: 'publish', job: 'RQ-A-1', lane: 'devin', url: 'https://github.com/ashlrai/phantom/pull/4231', ts: '2026-11-09T09:30:00Z' },
  { event: 'outcome', job: 'RQ-A-1', lane: 'devin', state: 'MERGED', url: 'https://github.com/ashlrai/phantom/pull/4231', ttm_s: 3200, mergedAt: '2026-11-09T10:15:00Z', ts: '2026-11-09T10:15:00Z' },
  { event: 'launch', job: 'RQ-B-2', lane: 'claude', ts: '2026-11-09T10:00:00Z' },
  { event: 'finish', job: 'RQ-B-2', lane: 'claude', tokens_total: 800, empty: true, ts: '2026-11-09T11:00:00Z' },
  { event: 'publish', job: 'RQ-B-2', lane: 'claude', url: 'https://github.com/ashlrai/lexicon/pull/77', ts: '2026-11-09T11:20:00Z' },
  { event: 'finish', job: 'RQ-OLD-9', lane: 'devin', tokens_total: 99999, ts: '2026-11-08T20:00:00Z' }, // outside window
  'not json at all',
  JSON.stringify({ event: 'outcome', job: 'RQ-C-3', outcome: 'CLOSED', ts: '2026-11-09T11:10:00Z' }),
].map((row) => (typeof row === 'string' ? row : JSON.stringify(row))).join('\n');

const ghOk = async (): Promise<GitRunResult> => ({
  code: 0, timedOut: false, truncated: false, missing: false, stderr: '',
  stdout: JSON.stringify([
    { databaseId: 5123456789, url: 'https://github.com/ashlrai/phantom/actions/runs/5123456789', displayTitle: 'Merge Gate', conclusion: 'success', createdAt: '2026-11-09T11:40:00Z' },
    { databaseId: 5123456790, url: 'https://github.com/ashlrai/phantom/actions/runs/5123456790', displayTitle: 'Quick typecheck', conclusion: 'failure', createdAt: '2026-11-09T11:30:00Z' },
  ]),
});
const ghMissing = async (): Promise<GitRunResult> => ({ code: null, timedOut: false, truncated: false, missing: true, stdout: '', stderr: '' });

function deps(overrides: Partial<ReportFactsDeps> = {}): ReportFactsDeps {
  return {
    world: async () => worldFixture(),
    jobsText: async () => ({ text: jobsLedger, truncated: false }),
    queue: async () => queueFixture(),
    goals: () => goalsFixture(),
    proposals: () => proposalsFixture(),
    operatorDirectives: () => [{ id: 'od-20261109080000-abcdef', kind: 'focus', text: 'keep merges green' }],
    selfDirectives: () => [{ id: 'sd-20261109081000-abcdef', text: 'prefer measured claims' }],
    gh: ghOk,
    ...overrides,
  };
}

function queueFixture(): FleetQueueV1 {
  return {
    v: 1, generatedAt: '2026-11-09T12:00:00Z',
    sources: { ready: 'healthy', skips: 'healthy' },
    total: 2, ready: 2, parked: 0, malformed: 0,
    byLane: [{ lane: 'devin', ready: 2, parked: 0 }],
    nextUp: [{ lane: 'devin', jobs: ['RQ-NEXT-1', 'RQ-NEXT-2'] }],
    groups: [], skips: [], skipsLast24h: 0,
  };
}

function goalsFixture(): ListGoalsDetailedResult {
  return {
    goals: [{
      id: 'goal-1', objective: 'ship the report builder', project: null, status: 'active',
      milestones: [], createdAt: '2026-11-09T00:00:00Z', updatedAt: '2026-11-09T01:00:00Z',
    } as never],
    sourceState: 'healthy', sourcePresent: true, complete: true,
    scannedFiles: 1, unreadableFiles: 0, limitExceeded: false,
  };
}

function proposalsFixture(): ProposalsReadResult {
  return {
    proposals: [{ id: 'prop-1', title: 'apply the doc fix' } as never],
    sourceState: 'healthy', sourcePresent: true, complete: true,
    stopReasons: [], filesDiscovered: 1, filesRead: 1, bytesRead: 100,
    invalidFiles: 0, unreadableFiles: 0,
  };
}

describe('reportClockEt / dueReportSlots', () => {
  it('fires slots only after their ET build times', () => {
    expect(dueReportSlots(at('2026-11-09T12:24:00Z'))).toEqual([]);          // 07:24 ET
    expect(dueReportSlots(at('2026-11-09T12:25:00Z'))).toEqual(['0730']);     // 07:25 ET
    expect(dueReportSlots(at('2026-11-10T00:54:00Z'))).toEqual(['0730']);     // 19:54 ET
    expect(dueReportSlots(at('2026-11-10T00:55:00Z'))).toEqual(['0730', '2000']); // 19:55 ET
    expect(dueReportSlots(at('2026-11-10T05:00:00Z'))).toEqual([]);           // 00:00 ET — a new day
  });
});

describe('summarizeJobsLedger', () => {
  it('counts the window, dedupes by URL and skips malformed rows', () => {
    const growth = summarizeJobsLedger(jobsLedger, false, at(jobsNow).getTime());
    expect(growth.launches).toBe(2);
    expect(growth.finishes).toBe(2);
    expect(growth.empty).toBe(1);
    expect(growth.publishes).toBe(2);
    expect(growth.merges).toBe(1);
    expect(growth.tokens).toBe(4800);
    expect(growth.ledger).toBe('available');
    expect(growth.published.map((row) => row.url)).toContain('https://github.com/ashlrai/lexicon/pull/77');
    expect(growth.merged[0]).toMatchObject({ job: 'RQ-A-1', url: 'https://github.com/ashlrai/phantom/pull/4231', ttmSeconds: 3200 });
    const devin = growth.byLane.find((row) => row.lane === 'devin');
    expect(devin).toMatchObject({ launches: 1, finishes: 1, merges: 1 });
  });

  it('reports an empty or out-of-window ledger as unavailable/incomplete', () => {
    expect(summarizeJobsLedger('', false, at(jobsNow).getTime()).ledger).toBe('unavailable');
    expect(summarizeJobsLedger(jobsLedger, true, at(jobsNow).getTime()).ledger).toBe('incomplete');
    const stale = JSON.stringify({ event: 'launch', job: 'RQ-X', ts: '2026-11-01T00:00:00Z' });
    expect(summarizeJobsLedger(stale, false, at(jobsNow).getTime()).ledger).toBe('incomplete');
  });
});

describe('gatherReportFacts + renderReportMarkdown', () => {
  it('renders every section with evidence links', async () => {
    const facts = await gatherReportFacts('0730', runsRoot(), { now: at(jobsNow), deps: deps() });
    const md = renderReportMarkdown(facts);
    expect(md).toContain('<!-- ashlr.report-export/v1 slot=0730 day=2026-11-09 -->');
    expect(md).toContain('# Fleet report — 07:30 ET · 2026-11-09');
    expect(md).toContain('| devin | 5/8 | 20 | 4 | 5 | 2 |');
    expect(md).toContain('https://github.com/ashlrai/phantom/pull/4231 — merged · RQ-A-1');
    expect(md).toContain('https://github.com/ashlrai/lexicon/pull/77 — published · RQ-B-2');
    expect(md).toContain('ashlrai/phantom run 5123456789 — success · https://github.com/ashlrai/phantom/actions/runs/5123456789');
    expect(md).toContain('[focus] keep merges green (od-20261109080000-abcdef)');
    expect(md).toContain('prefer measured claims (sd-20261109081000-abcdef)');
    expect(md).toContain('Open goals: 1 of 1');
    expect(md).toContain('ship the report builder');
    expect(md).toContain('apply the doc fix (prop-1)');
    expect(md).toContain('devin: RQ-NEXT-1, RQ-NEXT-2');
    expect(md).toContain('no LLM');
  });

  it('degrades each missing source to an explicit line', async () => {
    const facts = await gatherReportFacts('2000', runsRoot(), {
      now: at(jobsNow),
      deps: deps({
        world: async () => { throw new Error('no snapshot'); },
        jobsText: async () => ({ text: null, truncated: false }),
        queue: async () => { throw new Error('no queue'); },
        goals: () => { throw new Error('no goals'); },
        proposals: () => { throw new Error('no inbox'); },
        operatorDirectives: () => { throw new Error('no directives'); },
        gh: ghMissing,
      }),
    });
    const md = renderReportMarkdown(facts);
    expect(md).toContain('World model: unavailable');
    expect(md).toContain('Jobs ledger: unavailable');
    expect(md).toContain('Actions runs: unavailable (no measured repos)');
    expect(md).toContain('Operator directives: none in force (or store unreadable)');
    expect(md).toContain('Goals: unavailable');
    expect(md).toContain('Pending proposals: unavailable');
    expect(md).toContain('Queue next-up: unavailable');
  });

  it('still probes Actions evidence from ledger PR repos when the world snapshot is absent', async () => {
    const facts = await gatherReportFacts('0730', runsRoot(), {
      now: at(jobsNow),
      deps: deps({ world: async () => { throw new Error('no snapshot'); }, gh: ghMissing }),
    });
    const md = renderReportMarkdown(facts);
    expect(md).toContain('World model: unavailable');
    expect(md).toContain('Actions runs: unavailable (gh not installed)');
  });
});

describe('buildScheduledReports', () => {
  it('writes the due report once per ET day, then skips', async () => {
    const root = runsRoot();
    const result = await buildScheduledReports({ runsDir: root, now: at('2026-11-09T12:30:00Z'), deps: deps() });
    expect(result.entries).toEqual([
      { slot: '0730', path: reportPath(root, '0730'), outcome: 'wrote', reason: null, bytes: expect.any(Number) },
    ]);
    const file = join(root, 'export', 'report-0730.md');
    expect(existsSync(file)).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const again = await buildScheduledReports({ runsDir: root, now: at('2026-11-09T13:00:00Z'), deps: deps() });
    expect(again.entries[0]).toMatchObject({ slot: '0730', outcome: 'skipped', reason: 'already-built-today' });
  });

  it('builds both slots late in the day, and a named slot on demand', async () => {
    const root = runsRoot();
    const evening = await buildScheduledReports({ runsDir: root, now: at('2026-11-10T01:30:00Z'), deps: deps() });
    expect(evening.entries.map((entry) => entry.slot)).toEqual(['0730', '2000']);
    expect(reportMarkerDay(
      (await import('node:fs')).readFileSync(join(root, 'export', 'report-2000.md'), 'utf8'),
    )).toBe('2026-11-09');
    const named = await buildScheduledReports({ runsDir: root, slot: '2000', now: at('2026-11-10T01:40:00Z'), deps: deps() });
    expect(named.entries[0]).toMatchObject({ outcome: 'skipped' });
    const forced = await buildScheduledReports({ runsDir: root, slot: '2000', force: true, now: at('2026-11-10T01:41:00Z'), deps: deps() });
    expect(forced.entries[0]).toMatchObject({ outcome: 'wrote' });
  });

  it('writes nothing before the first build time', async () => {
    const root = runsRoot();
    const result = await buildScheduledReports({ runsDir: root, now: at('2026-11-09T12:00:00Z'), deps: deps() });
    expect(result.entries).toEqual([]);
    expect(existsSync(join(root, 'export', 'report-0730.md'))).toBe(false);
  });

  it('records a failed entry instead of throwing when the export dir cannot be made', async () => {
    const root = runsRoot();
    writeFileSync(join(root, 'export'), 'occupied');
    const result = await buildScheduledReports({ runsDir: root, now: at('2026-11-09T12:30:00Z'), deps: deps() });
    expect(result.entries[0]).toMatchObject({ outcome: 'failed', reason: expect.any(String) });
  });
});

describe('cmdFleetReportExport', () => {
  it('prints per-slot results and honors --json', async () => {
    const root = runsRoot();
    const lines: string[] = [];
    const code = await cmdFleetReportExport(['--runs-dir', root], {
      now: () => at('2026-11-09T12:30:00Z'), facts: deps(), output: (text) => lines.push(text),
    });
    expect(code).toBe(0);
    expect(lines[0]).toContain('wrote');
    expect(lines[0]).toContain('report-0730.md');
    const jsonLines: string[] = [];
    await cmdFleetReportExport(['--runs-dir', root, '--json', '--slot', '2000'], {
      now: () => at('2026-11-09T12:30:00Z'), facts: deps(), output: (text) => jsonLines.push(text),
    });
    const parsed = JSON.parse(jsonLines[0]!);
    expect(parsed.schema).toBe('ashlr.report-export/v1');
    expect(parsed.day).toBe('2026-11-09');
    expect(parsed.entries[0]).toMatchObject({ slot: '2000', outcome: 'wrote' });
  });

  it('rejects bad flags and reports nothing-due', async () => {
    const root = runsRoot();
    const errors: string[] = [];
    expect(await cmdFleetReportExport(['--slot', 'bogus'], { error: (text) => errors.push(text) })).toBe(2);
    expect(await cmdFleetReportExport(['--slot', '0730', '--slot', '2000'], { error: (text) => errors.push(text) })).toBe(2);
    expect(await cmdFleetReportExport(['--wat'], { error: (text) => errors.push(text) })).toBe(2);
    const lines: string[] = [];
    expect(await cmdFleetReportExport(['--runs-dir', root], {
      now: () => at('2026-11-09T10:00:00Z'), facts: deps(), output: (text) => lines.push(text),
    })).toBe(0);
    expect(lines[0]).toContain('no report slot due');
  });
});
