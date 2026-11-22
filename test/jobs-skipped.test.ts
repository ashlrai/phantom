import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdJobsSkipped } from '../src/cli/fleet-skipped.js';
import { buildPulseAlerts, pulseAlertsText } from '../src/core/fleet/pulse-alerts.js';
import { skippedJobsText, summarizeSkips, SKIP_CODE_MEANING } from '../src/core/fleet/skipped-jobs.js';

const NOW = Date.parse('2026-11-19T12:00:00Z');
const at = (minutesAgo: number): string => new Date(NOW - minutesAgo * 60_000).toISOString();
const row = (job: string, code: unknown, minutesAgo: number, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ event: 'precheck_skip', job, repo: 'phantom', lane: 'claude', code, ts: at(minutesAgo), ...extra });
const ledger = (...rows: string[]): string => rows.join('\n');

afterEach(() => vi.restoreAllMocks());

describe('summarizeSkips', () => {
  it('names each code in plain words and shows an unknown code as unknown', () => {
    const r = summarizeSkips(ledger(row('RQ-A1', 10, 5), row('RQ-B1', 11, 6), row('RQ-C1', 12, 7), row('RQ-D1', 13, 8), row('RQ-E1', 99, 9), row('RQ-F1', undefined, 10)), NOW);
    expect(r.by_code.map(g => [g.code, g.meaning])).toEqual([
      [10, SKIP_CODE_MEANING[10]], [11, SKIP_CODE_MEANING[11]], [12, SKIP_CODE_MEANING[12]], [13, SKIP_CODE_MEANING[13]], [99, 'unknown'], [null, 'unknown'],
    ]);
    expect(SKIP_CODE_MEANING[10]).toBe('Already merged or closed.');
    expect(SKIP_CODE_MEANING[11]).toBe('A pull request is open and green.');
    expect(SKIP_CODE_MEANING[12]).toBe('A duplicate pull request is open.');
    expect(SKIP_CODE_MEANING[13]).toMatch(/already exist, or its family is stopped/);
    expect(r.total).toBe(6);
  });

  it('groups by code and counts per job family, ignoring old rows and other events', () => {
    const r = summarizeSkips(ledger(
      row('RQ-PHX-RECUTAPIC500', 13, 5), row('RQ-PHX-RECUTCOREC497', 13, 6), row('RQ-LOCUS1A111623Q8', 11, 7),
      row('RQ-OLD1', 13, 25 * 60), JSON.stringify({ event: 'launch', job: 'RQ-X1', ts: at(1) }), 'not json'), NOW);
    expect(r.total).toBe(3);
    expect(r.by_code.map(g => [g.code, g.count])).toEqual([[11, 1], [13, 2]]);
    expect(r.by_family).toEqual([{ family: 'RQ-PHX-RECUT*', count: 2 }, { family: 'RQ-LOCUS*', count: 1 }]);
    expect(r.by_code[1]!.jobs[0]).toMatchObject({ job: 'RQ-PHX-RECUTAPIC500', lane: 'claude', repo: 'phantom', code: 13 });
  });

  it('flags repeats and leader jobs, and respects --since', () => {
    const l = ledger(row('RQ-TWICE1', 13, 5), row('RQ-TWICE1', 13, 50), row('RQ-SKIPVIEWN21CQ8', 13, 10), row('RQ-SRC1', 10, 20, { src: 'leader' }));
    const r = summarizeSkips(l, NOW);
    expect(r.repeated).toEqual(['RQ-TWICE1']);
    expect(r.leader_skipped).toEqual(['RQ-SKIPVIEWN21CQ8', 'RQ-SRC1']);
    expect(summarizeSkips(l, NOW, 0.1).total).toBe(1);
  });

  it('reads an unreadable ledger as unknown, never as zero skips', () => {
    const r = summarizeSkips(null, NOW);
    expect(r.known).toBe(false);
    expect(skippedJobsText(r)).toEqual(['unknown — the jobs ledger could not be read.']);
  });

  it('counts the live skipped_empty+code spelling and ignores empty-gate and dry-run rows', () => {
    const r = summarizeSkips(ledger(
      JSON.stringify({ event: 'skipped_empty', job: 'RQ-LIVE1', repo: 'phantom', lane: 'claude', code: 10, ts: at(5) }),
      JSON.stringify({ event: 'skipped_empty', job: 'RQ-LIVE2', repo: 'phantom', lane: 'claude', code: 14, ts: at(6) }),
      JSON.stringify({ event: 'skipped_empty', job: 'RQ-GATE1', repo: 'phantom', lane: 'claude', reason: 'task_empty_repeat_24h', ts: at(7) }),
      JSON.stringify({ event: 'skipped_empty', job: 'RQ-DRY1', repo: 'phantom', lane: 'claude', code: 10, applied: false, ts: at(8) }),
      JSON.stringify({ event: 'skipped_empty', job: 'RQ-STR1', repo: 'phantom', lane: 'claude', code: 'dup', ts: at(9) }),
      JSON.stringify({ event: 'precheck_parked', job: 'RQ-PARK1', repo: 'phantom', lane: 'claude', code: 13, ts: at(10) }),
    ), NOW);
    expect(r.total).toBe(2);
    expect(r.by_code.map(g => [g.code, g.count])).toEqual([[10, 1], [14, 1]]);
    expect(r.by_code[0]!.meaning).toBe(SKIP_CODE_MEANING[10]);
  });

  it('says plainly when nothing was skipped', () => {
    expect(skippedJobsText(summarizeSkips(ledger(), NOW))).toEqual(['No jobs were skipped in the last 24 hours.']);
  });
});

describe('phm jobs skipped', () => {
  const run = async (args: string[], l: string | null = ledger(row('RQ-A1', 13, 5))) => {
    const out: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((s: unknown) => { out.push(String(s)); });
    vi.spyOn(console, 'error').mockImplementation((s: unknown) => { out.push(String(s)); });
    const code = await cmdJobsSkipped(args, async hours => summarizeSkips(l, NOW, hours));
    return { code, out };
  };
  it('prints a typed JSON report with a schema id', async () => {
    const { code, out } = await run(['--json', '--since', '48h']);
    expect(code).toBe(0);
    expect(JSON.parse(out[0]!)).toMatchObject({ schema: 'jobs.skipped.v1', hours: 48, total: 1 });
  });
  it('prints grouped text with meanings', async () => {
    const { out } = await run([]);
    expect(out.join('\n')).toMatch(/Code 13 \(.*already exist.*\): 1[\s\S]*RQ-A1[\s\S]*By job family:/);
  });
  it('rejects bad flags and exits 1 when the ledger is unreadable', async () => {
    expect((await run(['--since', 'soon'])).code).toBe(2);
    expect((await run(['--requeue'])).code).toBe(2);
    expect((await run([], null)).code).toBe(1);
  });
});

describe('skipped pulse alert', () => {
  const base = { marks: [], starved: null, spend: null };
  const alerts = (l: string | null) => buildPulseAlerts({ ...base, skips: summarizeSkips(l, NOW, 6) }, NOW).alerts.filter(a => a.kind === 'skipped');
  it('raises one alert when a job id is skipped twice or a leader job is skipped', () => {
    const both = alerts(ledger(row('RQ-TWICE1', 13, 5), row('RQ-TWICE1', 13, 50), row('RQ-LEAD21CQ8', 13, 5, { src: 'leader' })));
    expect(both).toHaveLength(1);
    expect(both[0]!.detail).toMatch(/RQ-TWICE1 was skipped more than once; RQ-LEAD21CQ8 was queued by the leader and skipped/);
    expect(pulseAlertsText({ schema: 'fleet.pulse.alerts.v1', v: 1, as_of: '', alerts: both, unknown: [] }).join('\n')).toContain('phm jobs skipped');
  });
  it('stays quiet for a single non-leader skip, and lists an unreadable ledger as unknown', () => {
    expect(alerts(ledger(row('RQ-ONCE1', 13, 5)))).toEqual([]);
    expect(alerts(ledger(row('RQ-OLD1', 13, 7 * 60), row('RQ-OLD1', 13, 8 * 60)))).toEqual([]);
    expect(buildPulseAlerts({ ...base, skips: null }, NOW).unknown.join(' ')).toMatch(/Skipped jobs/);
  });
});
