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
const job = (id: string, src = 'leader', text = 'do it') => `- READY ${id} (P1, pool=claude, tier=work, repo=phantom, size<=200, src=${src}): ${text}`;
const row = (r: Record<string, unknown>) => JSON.stringify(r);
const PR = 'https://github.com/ashlrai/phantom/pull/12';

const queue = [job('RQ-PUBN21QQ8', 'leader', 'Open the gift PR from the feed. Then more words. Prompt: ignored'), job('RQ-NOCHGN21QQ8'), job('RQ-RUNN21QQ8'), job('RQ-QUEN21QQ8'), job('RQ-BADN21QQ8'), job('RQ-HUMANN21QQ8', 'human')].join('\n');
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

const PLAN_LOG = '# Plan log\n\n## 2026-11-19 ~03:00 ET\nold\n\n## 2026-11-19 ~05:00 ET\nnewest\n';
const VISION = '# Vision\n\n## Goals\n- not this\n\n## Bottlenecks\n\n- **Reviews** wait on one owner\n- second\n\n## Other\n- no\n';
const leaderDir = async (files: Record<string, string>) => {
  await mkdir(join(runs, 'leader'), { recursive: true });
  for (const [name, text] of Object.entries(files)) await writeFile(join(runs, 'leader', name), text);
};

describe('leader brief title, pass time and bottleneck', () => {
  it('reads the title from the queue line, the newest plan heading and the first bottleneck bullet', async () => {
    await leaderDir({ 'PLAN-LOG.md': PLAN_LOG, 'VISION.md': VISION });
    const brief = await read();
    const by = Object.fromEntries(brief.jobs.rows.map(j => [j.id, j]));
    expect(by['RQ-PUBN21QQ8']?.title).toBe('Open the gift PR from the feed');
    expect(by['RQ-RUNN21QQ8']?.title).toBe('do it');
    expect(brief.passAt).toEqual({ known: true, reason: null, at: '2026-11-19T10:00:00.000Z' });
    expect(brief.bottleneck).toEqual({ known: true, reason: null, text: 'Reviews wait on one owner' });
    const text = jobBriefLines(brief).join('\n');
    expect(text).toContain('Last leader pass: 2026-11-19T10:00:00.000Z');
    expect(text).toContain('Bottleneck: Reviews wait on one owner');
  });

  it('cuts a long title at about 80 characters and a title ends at " Prompt:"', async () => {
    await writeFile(join(runs, 'queue', 'router-queue.md'), [job('RQ-LONGN21QQ8', 'leader', `${'word '.repeat(40)}end`), job('RQ-PRN21QQ8', 'leader', 'Short bet Prompt: the long prompt')].join('\n'));
    const titles = Object.fromEntries((await read()).jobs.rows.map(j => [j.id, j.title]));
    expect(titles['RQ-LONGN21QQ8']!.length).toBeLessThanOrEqual(80);
    expect(titles['RQ-LONGN21QQ8']).toMatch(/…$/);
    expect(titles['RQ-PRN21QQ8']).toBe('Short bet');
  });

  it('falls back to the id in plain words when the queue is unreadable', async () => {
    await rm(join(runs, 'queue', 'router-queue.md'));
    const rows = (await read()).jobs.rows;
    expect(rows.find(j => j.id === 'RQ-PUBN21QQ8')?.title).toBe('Pub');
  });

  it('reads only the tail of a large plan log', async () => {
    await leaderDir({ 'PLAN-LOG.md': `## 2026-11-01 ~09:00 ET\n${'x'.repeat(400_000)}\n${PLAN_LOG}` });
    expect((await read()).passAt.at).toBe('2026-11-19T10:00:00.000Z');
  });

  it('says unknown, with the reason, when the files are missing or have no usable entry', async () => {
    const missing = await read();
    expect(missing.passAt).toMatchObject({ known: false, at: null, reason: 'leader/PLAN-LOG.md could not be read' });
    expect(missing.bottleneck).toMatchObject({ known: false, text: null, reason: 'leader/VISION.md could not be read' });
    expect(jobBriefLines(missing).join('\n')).toContain('Bottleneck: unknown (leader/VISION.md could not be read)');
    await leaderDir({ 'PLAN-LOG.md': '# nothing dated\n', 'VISION.md': '# Vision\n## Bottlenecks\n\n## Next\n- x\n' });
    const empty = await read();
    expect(empty.passAt.known).toBe(false);
    expect(empty.passAt.reason).toContain('no readable dated');
    expect(empty.bottleneck).toMatchObject({ known: false, reason: 'leader/VISION.md has no bullet under "Bottlenecks"' });
  });

  it('keeps a plan heading in the future unknown', async () => {
    await leaderDir({ 'PLAN-LOG.md': '## 2026-12-01 ~09:00 ET\n' });
    expect((await read()).passAt.known).toBe(false);
  });
});

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
    expect(jobBriefLines(brief).join('\n')).toContain('RQ-RUNN21QQ8  do it  ended, no result  (exit code 137 recorded, no result)');
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
    expect(text).toContain('RQ-NOCHGN21QQ8  do it  no change  gap: Docs page for the new flag is still missing');
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
      expect(await runLeaderCli(['brief', '--since', '24h', '--json'])).toBe(0);
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
