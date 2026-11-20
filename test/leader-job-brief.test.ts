import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runLeaderCli } from '../src/cli/leader.js';
import { jobBriefLines, LEADER_BRIEF_SCHEMA, readJobBrief } from '../src/core/fleet/leader-job-brief.js';
import type { JobGapsReport } from '../src/core/fleet/job-gaps.js';
import type { PoolsViewV1 } from '../src/core/fleet/pools-view.js';

const NOW = Date.parse('2026-11-19T12:00:00Z');
const ago = (hours: number) => new Date(NOW - hours * 3_600_000).toISOString();
const job = (id: string, src = 'leader') => `- READY ${id} (P1, pool=claude, tier=work, repo=phantom, size<=200, src=${src}): do it`;
const row = (r: Record<string, unknown>) => JSON.stringify(r);
const PR = 'https://github.com/ashlrai/phantom/pull/12';

const queue = [job('RQ-PUBN21QQ8'), job('RQ-NOCHGN21QQ8'), job('RQ-RUNN21QQ8'), job('RQ-QUEN21QQ8'), job('RQ-BADN21QQ8'), job('RQ-HUMANN21QQ8', 'human')].join('\n');
const ledger = [
  row({ job: 'RQ-PUBN21QQ8', event: 'launch', ts: ago(3) }),
  row({ job: 'RQ-PUBN21QQ8', event: 'publish', url: PR, ts: ago(2) }),
  row({ job: 'RQ-NOCHGN21QQ8', event: 'launch', ts: ago(3) }),
  row({ job: 'RQ-NOCHGN21QQ8', event: 'finish', empty: true, empty_reason: 'already on main', ts: ago(2) }),
  row({ job: 'RQ-RUNN21QQ8', event: 'launch', ts: ago(1) }),
  row({ job: 'RQ-BADN21QQ8', event: 'launch', ts: ago(2) }),
  row({ job: 'RQ-BADN21QQ8', event: 'finish', empty: false, exit_code: 1, ts: ago(1) }),
  row({ job: 'RQ-HUMANN21QQ8', event: 'launch', ts: ago(1) }),
].join('\n');
const status = {
  schema: 'dispatchd.status.v1', paused: null,
  admission: { cap: 8, running: 3, load1: 1.5, reason: 'ok' },
  lanes: { claude: { running: 2, target: 4, queued: 5, held: false }, zai: { running: 0, target: 3, queued: 0, held: true } },
};
const pools = { schema: 'pools.v1', generatedAt: new Date(NOW).toISOString(), staleAfterMinutes: 30, gaps: [], pools: [
  { id: 'claude', usedPct: 62.4, hoursLeft: 40.2, wasteRisk: 'medium', summary: 'Claude: on pace' },
  { id: 'grok', usedPct: null, hoursLeft: null, wasteRisk: 'unknown', summary: 'Grok: no reading' },
] } as unknown as PoolsViewV1;
const gaps: JobGapsReport = { schema: 'jobs.gaps.v1', sinceHours: 24, known: true, unknownSources: [], jobsScanned: 1, jobsWithoutGaps: [], dropped: [], proposed: null,
  candidates: Array.from({ length: 7 }, (_, i) => ({ title: `Gap number ${i} to close`, repo: 'phantom', sourceJob: 'RQ-NOCHGN21QQ8', why: `Why ${i}` })) };

let runs = '', wt = '';
beforeEach(async () => {
  runs = await mkdtemp(join(tmpdir(), 'brief-runs-'));
  wt = await mkdtemp(join(tmpdir(), 'brief-wt-'));
  await mkdir(join(runs, 'queue'), { recursive: true });
  await mkdir(join(runs, 'metrics'), { recursive: true });
  await writeFile(join(runs, 'queue', 'router-queue.md'), queue);
  await writeFile(join(runs, 'metrics', 'jobs.jsonl'), ledger);
  await writeFile(join(runs, 'queue', 'status.json'), JSON.stringify(status));
  await mkdir(join(wt, 'RQ-NOCHGN21QQ8'), { recursive: true });
  await writeFile(join(wt, 'RQ-NOCHGN21QQ8', 'BRIDGE_NOTES.md'), '# Notes\n\n## Remaining gaps\n- Docs page for the new flag is still missing. Second sentence stays out.\n');
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all([runs, wt].map(d => rm(d, { recursive: true, force: true })));
});

const read = (extra: Parameters<typeof readJobBrief>[0] = {}) => readJobBrief({ runsDir: runs, wtDir: wt, now: NOW, hours: 24, pools: async () => pools, gaps: async () => gaps, ...extra });

describe('leader job brief', () => {
  it('shows published, no-change with its gap sentence, running, queued and failed leader jobs only', async () => {
    const brief = await read();
    expect(brief.schema).toBe(LEADER_BRIEF_SCHEMA);
    const by = Object.fromEntries(brief.jobs.rows.map(j => [j.id, j]));
    expect(Object.keys(by).sort()).toEqual(['RQ-BADN21QQ8', 'RQ-NOCHGN21QQ8', 'RQ-PUBN21QQ8', 'RQ-QUEN21QQ8', 'RQ-RUNN21QQ8']);
    expect(by['RQ-PUBN21QQ8']).toMatchObject({ result: 'published', pr_state: 'open', pr_url: PR });
    expect(by['RQ-NOCHGN21QQ8']).toMatchObject({ result: 'no_change', gap: 'Docs page for the new flag is still missing', reason: 'already on main' });
    expect(by['RQ-RUNN21QQ8']?.result).toBe('running');
    expect(by['RQ-QUEN21QQ8']?.result).toBe('queued');
    expect(by['RQ-BADN21QQ8']?.result).toBe('failed');
    expect(brief.summary).toContain('1 published, 1 no change, 1 failed, 1 running, 1 queued');
  });

  it('a job with an exit code sidecar and no publish is ended with no result, and the rule is named', async () => {
    await mkdir(join(runs, 'queue', 'run'), { recursive: true });
    await writeFile(join(runs, 'queue', 'run', 'RQ-RUNN21QQ8.rc'), '137\n');
    const brief = await read();
    expect(brief.jobs.rows.find(j => j.id === 'RQ-RUNN21QQ8')).toMatchObject({ result: 'ended_no_result', ended_rule: 'exit_code', reason: 'exit code 137 recorded, no result' });
    expect(brief.summary).toContain('1 ended with no result');
    expect(jobBriefLines(brief).join('\n')).toContain('RQ-RUNN21QQ8  ended, no result  (exit code 137 recorded, no result)');
  });

  it('a normal running job stays running, and --stale-after is honoured', async () => {
    await mkdir(join(runs, 'queue', 'run', 'resource-sessions'), { recursive: true });
    expect((await read()).jobs.rows.find(j => j.id === 'RQ-RUNN21QQ8')?.result).toBe('running');
    // Launched 1 h ago with no live process record: over a 30 m limit it is ended, not running.
    expect((await read({ staleAfterHours: 0.5 })).jobs.rows.find(j => j.id === 'RQ-RUNN21QQ8')).toMatchObject({ result: 'ended_no_result', ended_rule: 'stale' });
  });

  it('reports lanes, admission, pools and only the top 5 gaps', async () => {
    const brief = await read();
    expect(brief.lanes.rows).toEqual([{ lane: 'claude', running: 2, target: 4, queued: 5, held: false }, { lane: 'zai', running: 0, target: 3, queued: 0, held: true }]);
    expect(brief.admission).toMatchObject({ known: true, state: 'open' });
    expect(brief.pools.rows[0]).toMatchObject({ id: 'claude', used_pct: 62.4, hours_to_reset: 40.2, waste_risk: 'medium' });
    expect(brief.pools.rows[1]).toMatchObject({ used_pct: null, hours_to_reset: null, waste_risk: 'unknown' });
    expect(brief.gaps).toMatchObject({ known: true, total: 7 });
    expect(brief.gaps.top).toHaveLength(5);
    const text = jobBriefLines(brief).join('\n');
    expect(text).toContain('RQ-NOCHGN21QQ8  no change  gap: Docs page for the new flag is still missing');
    expect(text).toContain('claude  2/4  5 queued');
    expect(text).toContain('grok  used unknown, reset unknown, waste risk unknown');
  });

  it('says closed at the cap', async () => {
    await writeFile(join(runs, 'queue', 'status.json'), JSON.stringify({ ...status, admission: { ...status.admission, running: 8 } }));
    expect((await read()).admission).toMatchObject({ state: 'closed', why: 'closed at the global cap (8 of 8 running)' });
  });

  it('an unreadable status file is unknown with a reason, and the other sections still answer', async () => {
    await writeFile(join(runs, 'queue', 'status.json'), '{not json');
    const brief = await read();
    expect(brief.lanes).toMatchObject({ known: false, reason: 'queue/status.json is unreadable or invalid', rows: [] });
    expect(brief.admission).toMatchObject({ known: false, state: 'unknown' });
    expect(brief.jobs.known).toBe(true);
    expect(jobBriefLines(brief).join('\n')).toContain('Admission: unknown (queue/status.json is unreadable or invalid)');
  });

  it('a no-change job with no readable notes shows its gap as unknown, not blank', async () => {
    await rm(join(wt, 'RQ-NOCHGN21QQ8'), { recursive: true });
    const brief = await read();
    expect(brief.jobs.rows.find(j => j.id === 'RQ-NOCHGN21QQ8')?.gap).toBeNull();
    expect(jobBriefLines(brief).join('\n')).toContain('gap: unknown');
  });

  it('missing ledger, pools and gaps are each unknown without failing', async () => {
    await rm(join(runs, 'metrics', 'jobs.jsonl'));
    const brief = await read({ pools: async () => { throw new Error('boom'); }, gaps: async () => null });
    expect(brief.jobs).toMatchObject({ known: false, rows: [] });
    expect(brief.pools.known).toBe(false);
    expect(brief.gaps).toMatchObject({ known: false, total: null, top: [] });
  });

  describe('phm leader brief', () => {
    it('--json prints the schema id and exits 0 even when the status file is unreadable', async () => {
      await writeFile(join(runs, 'queue', 'status.json'), 'nope');
      vi.stubEnv('ASHLR_RUNS_DIR', runs);
      vi.stubEnv('ASHLR_WT_DIR', wt);
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      expect(await runLeaderCli(['brief', '--json'])).toBe(0);
      const out = JSON.parse(String(log.mock.calls[0]?.[0])) as { schema: string; lanes: { known: boolean; reason: string } };
      expect(out.schema).toBe('leader.brief.v1');
      expect(out.lanes).toMatchObject({ known: false, reason: 'queue/status.json is unreadable or invalid' });
    });

    it('rejects a bad --since with usage and exit 2', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      expect(await runLeaderCli(['brief', '--since', 'soon'])).toBe(2);
      expect(await runLeaderCli(['brief', '--since'])).toBe(2);
      expect(await runLeaderCli(['brief', 'extra'])).toBe(2);
    });
  });
});
