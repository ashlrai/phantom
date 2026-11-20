import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { extractGaps, JOB_GAPS_SCHEMA, readJobGaps, sameWork } from '../src/core/fleet/job-gaps.js';
import { cmdJobsGaps } from '../src/cli/jobs-gaps.js';

const NOW = Date.parse('2026-11-19T12:00:00Z');
const iso = (hoursAgo: number) => new Date(NOW - hoursAgo * 3_600_000).toISOString();
let root: string, wt: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'gaps-')); wt = join(root, 'wt'); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); vi.restoreAllMocks(); });

async function seed(jobs: Record<string, string | null>): Promise<void> {
  await mkdir(join(root, 'metrics'), { recursive: true });
  const rows = Object.keys(jobs).map(job => JSON.stringify({ event: 'outcome', job, lane: 'claude', empty: true, repo: 'phantom', ts: iso(2) }));
  await writeFile(join(root, 'metrics', 'jobs.jsonl'), `${rows.join('\n')}\n`);
  for (const [job, notes] of Object.entries(jobs)) {
    if (notes === null) continue;
    await mkdir(join(wt, job), { recursive: true });
    await writeFile(join(wt, job, 'BRIDGE_NOTES.md'), notes);
  }
}
const none = { openIdeas: async () => [], queuedWork: async () => [], mergedTitles: async () => [] };

describe('extractGaps', () => {
  it('reads bullets under a gaps heading and stops at the next heading', () => {
    const gaps = extractGaps('# Notes\n\n## Remaining gaps\n\n- Add a --since flag to the export command: it only takes hours today\n- Show unknown tokens as unknown\n\n## Commands\n- npm test\n');
    expect(gaps.map(g => g.title)).toEqual(['Add a --since flag to the export command', 'Show unknown tokens as unknown']);
    expect(gaps[0]!.why).toContain('only takes hours today');
  });
  it('treats a paragraph under a single Gap heading as one gap and none as no gap', () => {
    expect(extractGaps('## Gap\nNo test runs help on every verb.\n\n## Solution\nDone.')).toHaveLength(1);
    expect(extractGaps('## Gaps\n- None\n')).toEqual([]);
    expect(extractGaps('just text')).toEqual([]);
  });
});

describe('sameWork', () => {
  it('matches reworded titles but not a single shared word', () => {
    expect(sameWork('Add --since flag to export command', 'export command gets a since flag')).toBe(true);
    expect(sameWork('Add export command', 'Add import command')).toBe(false);
  });
});

describe('readJobGaps', () => {
  it('extracts two gaps from one job and reports a job with no gaps', async () => {
    await seed({ 'RQ-A': '## Remaining gaps\n- Wire the digest into the weekly report\n- Cover the stale lock case in tests\n', 'RQ-B': '## Summary\nAlready on master.\n' });
    const report = await readJobGaps(24, { runsDir: root, wtDir: wt, now: NOW, ...none });
    expect(report.schema).toBe(JOB_GAPS_SCHEMA);
    expect(report.known).toBe(true);
    expect(report.candidates.map(c => [c.title, c.repo, c.sourceJob])).toEqual([
      ['Cover the stale lock case in tests', 'phantom', 'RQ-A'], ['Wire the digest into the weekly report', 'phantom', 'RQ-A']]);
    expect(report.jobsWithoutGaps).toEqual(['RQ-B']);
    expect(report.proposed).toBeNull();
  });

  it('drops gaps already open, queued, merged or repeated by another job', async () => {
    await seed({ 'RQ-A': '## Gaps\n- Wire the digest into the weekly report\n- Cover the stale lock case in tests\n- Print queue depth in the status line\n- Rename the legacy sweep flag\n', 'RQ-B': '## Gaps\n- Print the queue depth in status line\n' });
    const report = await readJobGaps(24, { runsDir: root, wtDir: wt, now: NOW,
      openIdeas: async () => ['Digest wired into weekly report'], queuedWork: async () => ['Cover stale lock case tests'],
      mergedTitles: async () => ['feat: rename legacy sweep flag'] });
    expect(report.candidates.map(c => c.title)).toEqual(['Print queue depth in the status line']);
    expect(report.dropped.map(d => d.reason).sort()).toEqual(['duplicate-gap', 'open-idea', 'queued', 'recent-merge']);
  });

  it('with propose writes survivors once as drop jobs and finds them again', async () => {
    await seed({ 'RQ-A': '## Gaps\n- Wire the digest into the weekly report\n' });
    const first = await readJobGaps(24, { runsDir: root, wtDir: wt, now: NOW, propose: true, ...none });
    expect(first.proposed).toMatchObject([{ queued: true, skipped: null }]);
    const files = await readdir(join(root, 'leader', 'drop', 'claude'));
    expect(files).toHaveLength(1);
    const body = await readFile(join(root, 'leader', 'drop', 'claude', files[0]!), 'utf8');
    expect(body.split('\n')[0]).toBe('#job repo=phantom lane=claude tier=work');
    expect(body).toContain('Goal: Wire the digest into the weekly report');
    const second = await readJobGaps(24, { runsDir: root, wtDir: wt, now: NOW, propose: true, ...none });
    expect(second.proposed).toMatchObject([{ queued: false, skipped: 'already queued' }]);
  });

  it('reports an unknown store as unknown and an unreadable source by name', async () => {
    const missing = await readJobGaps(24, { runsDir: join(root, 'nope'), wtDir: wt, now: NOW, ...none });
    expect(missing).toMatchObject({ known: false, candidates: [], jobsScanned: 0 });
    await seed({ 'RQ-A': '## Gaps\n- Wire the digest into the weekly report\n' });
    const report = await readJobGaps(24, { runsDir: root, wtDir: wt, now: NOW, ...none, mergedTitles: async () => { throw new Error('no git'); } });
    expect(report.unknownSources).toEqual(['recent merges']);
    expect(report.candidates).toHaveLength(1);
  });
});

describe('phm jobs gaps', () => {
  const capture = () => {
    const out: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((l: unknown) => { out.push(String(l)); });
    vi.spyOn(console, 'error').mockImplementation((l: unknown) => { out.push(String(l)); });
    return out;
  };
  it('prints typed JSON, plain words, and exits 1 for an unknown store and 2 for bad usage', async () => {
    await seed({ 'RQ-A': '## Gaps\n- Wire the digest into the weekly report\n' });
    const read = (hours: number, propose: boolean) => readJobGaps(hours, { runsDir: root, wtDir: wt, now: NOW, propose, ...none });
    let out = capture();
    expect(await cmdJobsGaps(['--json'], read)).toBe(0);
    expect(JSON.parse(out.join('\n')).schema).toBe(JOB_GAPS_SCHEMA);
    vi.restoreAllMocks(); out = capture();
    expect(await cmdJobsGaps(['--since', '6h'], read)).toBe(0);
    expect(out.join('\n')).toMatch(/1 new gap from 1 no-change job in the last 6 hours[\s\S]*Queue them: phm jobs gaps --propose/);
    vi.restoreAllMocks(); out = capture();
    expect(await cmdJobsGaps([], () => readJobGaps(24, { runsDir: join(root, 'nope'), wtDir: wt, now: NOW, ...none }))).toBe(1);
    expect(out.join('\n')).toContain('unknown');
    expect(await cmdJobsGaps(['--since', 'soon'])).toBe(2);
    expect(await cmdJobsGaps(['extra'])).toBe(2);
  });
});
