import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DROP_QUEUE_REPOS, extractAllGaps, extractGaps, JOB_GAPS_SCHEMA, maxNewFromEnv, readJobGaps, sameWork } from '../src/core/fleet/job-gaps.js';
import { cmdJobsGaps } from '../src/cli/jobs-gaps.js';

const NOW = Date.parse('2026-11-19T12:00:00Z');
const iso = (hoursAgo: number) => new Date(NOW - hoursAgo * 3_600_000).toISOString();
let root: string, wt: string;
beforeEach(async () => { vi.stubEnv('ASHLR_GAPS_MAX', ''); root = await mkdtemp(join(tmpdir(), 'gaps-')); wt = join(root, 'wt'); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

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
    expect(first.proposed).toMatchObject([{ queued: true, skipped: null, refused: null, path: expect.stringMatching(/RQ-PHX-[A-Z0-9]+\.md$/) }]);
    const files = await readdir(join(root, 'leader', 'drop', 'claude'));
    expect(files).toHaveLength(1);
    const body = await readFile(join(root, 'leader', 'drop', 'claude', files[0]!), 'utf8');
    expect(body.split('\n')[0]).toBe('#job repo=phantom lane=claude tier=work');
    expect(body).toContain('Goal: Wire the digest into the weekly report');
    const second = await readJobGaps(24, { runsDir: root, wtDir: wt, now: NOW, propose: true, ...none });
    // The proposer's own 24 h record now catches the repeat before the writer's "already queued" check.
    expect(second.candidates).toEqual([]);
    expect(second.dropped).toMatchObject([{ reason: 'proposed-24h' }]);
    expect(second.proposed).toEqual([]);
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
    expect(out.join('\n')).toMatch(/1 new gap from 1 no-change job and 0 published jobs in the last 6 hours[\s\S]*Queue them: phm jobs gaps --propose/);
    vi.restoreAllMocks(); out = capture();
    expect(await cmdJobsGaps([], () => readJobGaps(24, { runsDir: join(root, 'nope'), wtDir: wt, now: NOW, ...none }))).toBe(1);
    expect(out.join('\n')).toContain('unknown');
    expect(await cmdJobsGaps(['--since', 'soon'])).toBe(2);
    expect(await cmdJobsGaps(['extra'])).toBe(2);
  });
});

describe('prose gaps and the drop queue', () => {
  const dropDir = join('leader', 'drop', 'claude');
  const dropFiles = async () => (await readdir(join(root, dropDir)).catch(() => [])).filter(f => f.endsWith('.md'));
  const headerOf = async (file: string) => (await readFile(join(root, dropDir, file), 'utf8')).split('\n')[0];
  const seedRepos = async (rows: Record<string, string>) => {
    await writeFile(join(root, 'metrics', 'jobs.jsonl'), `${Object.entries(rows).map(([job, repo]) =>
      JSON.stringify({ event: 'outcome', lane: 'claude', empty: true, ts: iso(2), job, repo })).join('\n')}\n`);
  };
  it('extracts a final-message prose gap and a heading gap, one candidate per sentence, trimmed to 120 characters', async () => {
    await seed({ JOBA: '# Notes\n\n## Remaining gaps\n- Show unknown sizes as unknown in the report\n' });
    await writeFile(join(root, 'JOBA.log'), 'working\n\nThe one gap is the retry flag on the export command. Everything else is done.\n');
    const report = await readJobGaps(24, { runsDir: root, wtDir: wt, now: NOW, ...none });
    expect(report.candidates.map(c => c.title)).toEqual(['Show unknown sizes as unknown in the report', 'The one gap is the retry flag on the export command.']);
    const long = extractAllGaps('', `The gap is ${'very '.repeat(40)}long.`);
    expect(long[0]!.title.length).toBeLessThanOrEqual(120);
    expect(extractAllGaps('', 'There are no gaps. Nothing is missing here.')).toEqual([]);
  });
  it('reads the final message in the job log too', async () => {
    await seed({ JOBB: null });
    await writeFile(join(root, 'JOBB.log'), 'working\n\nTwo parts of your spec aren\'t there: the sort flag and the page size.\n');
    const report = await readJobGaps(24, { runsDir: root, wtDir: wt, now: NOW, ...none });
    expect(report.candidates).toHaveLength(1);
    expect(report.candidates[0]!.sourceJob).toBe('JOBB');
  });
  it('ignores a "missing" sentence outside a gap section, in the notes and in earlier log lines', async () => {
    await seed({ JOBN: '# Notes\nThe retry flag is missing from the export command.\n\n## Commands\n- The cache gap is missing too\n' });
    await writeFile(join(root, 'JOBN.log'), 'step 1: a config file is missing, using defaults\nthe gap in coverage is noted\n\nAll done, nothing else to report.\n');
    const report = await readJobGaps(24, { runsDir: root, wtDir: wt, now: NOW, ...none });
    expect(report.candidates).toEqual([]);
    expect(report.jobsWithoutGaps).toEqual(['JOBN']);
  });
  it('drops a duplicate gap and queues a gap with the repo named in its header', async () => {
    await seed({ JOBC: '## Remaining gaps\nWe left it for you to decide: the retry flag name.\n', JOBE: '## Remaining gaps\nI left it for you to decide: the retry flag name.\n',
      JOBD: '## Remaining gaps\n- Add the sort flag to the list command\n' });
    await seedRepos({ JOBC: 'phantom', JOBE: 'phantom', JOBD: 'locus' });
    const report = await readJobGaps(24, { runsDir: root, wtDir: wt, now: NOW, propose: true, ...none });
    expect(report.dropped.filter(d => d.reason === 'duplicate-gap')).toHaveLength(1);
    expect(report.proposed!.filter(p => p.queued)).toHaveLength(2);
    const files = await dropFiles();
    expect((await Promise.all(files.map(headerOf))).sort()).toEqual(['#job repo=locus lane=claude tier=work', '#job repo=phantom lane=claude tier=work']);
    expect(report.schema).toBe(JOB_GAPS_SCHEMA);
    expect(JOB_GAPS_SCHEMA).toBe('jobs.gaps.v1');
  });
  it('reads repo attribution from jobs-ledger dialect job ids', async () => {
    await seed({ JOBD: '## Remaining gaps\n- Add the sort flag to the list command\n' });
    await writeFile(join(root, 'metrics', 'jobs.jsonl'), `${JSON.stringify({ event: 'outcome', lane: 'claude', empty: true, ts: iso(2), job_id: 'JOBD', repo: 'locus' })}\n`);
    const report = await readJobGaps(24, { runsDir: root, wtDir: wt, now: NOW, propose: true, ...none });
    expect(report.proposed!.filter(p => p.queued)).toHaveLength(1);
    const files = await dropFiles();
    expect(files).toHaveLength(1);
    expect(await headerOf(files[0]!)).toBe('#job repo=locus lane=claude tier=work');
  });
  it('allows all seven repos and skips an unknown repo with a reason', async () => {
    expect([...DROP_QUEUE_REPOS]).toEqual(['phantom', 'phantom-secrets', 'ashlr-plugin', 'ashlr-stack', 'locus', 'lexicon', 'ashlr-md']);
    await seed({ JOBX: '## Remaining gaps\n- Wire the digest into the weekly report\n' });
    await seedRepos({ JOBX: 'elsewhere' });
    const report = await readJobGaps(24, { runsDir: root, wtDir: wt, now: NOW, propose: true, ...none });
    expect(report.proposed).toMatchObject([{ queued: false, skipped: 'repo elsewhere is not a known repo' }]);
    expect(await dropFiles()).toHaveLength(0);
  });
  it('falls back to 3 gaps without lane readings and still deduplicates on the next tick', async () => {
    const titles = ['Wire the digest into the weekly report', 'Cover the stale lock case in tests', 'Print queue depth in the status line', 'Rename the legacy sweep flag', 'Show unknown sizes as unknown'];
    await seed({ JOBP: `## Remaining gaps\n${titles.map(t => `- ${t}`).join('\n')}\n` });
    await seedRepos({ JOBP: 'lexicon' });
    const first = await readJobGaps(24, { runsDir: root, wtDir: wt, now: NOW, propose: true, ...none });
    expect(first.proposed!.filter(p => p.queued)).toHaveLength(3);
    expect(first.proposed!.filter(p => p.skipped === 'already 3 new jobs this tick')).toHaveLength(2);
    expect(await dropFiles()).toHaveLength(3);
    const second = await readJobGaps(24, { runsDir: root, wtDir: wt, now: NOW, propose: true, ...none, queuedWork: undefined });
    // The three already written are caught as queued work; the other two go through now.
    expect(second.dropped.filter(d => d.reason === 'queued')).toHaveLength(3);
    expect(second.proposed!.filter(p => p.queued)).toHaveLength(2);
    expect(await dropFiles()).toHaveLength(5);
  });
});

describe('gaps from published jobs', () => {
  const dropDir = join('leader', 'drop');
  const dropFiles = async (lane: string) => (await readdir(join(root, dropDir, lane)).catch(() => [])).filter(f => f.endsWith('.md'));
  const run = (extra: Record<string, unknown> = {}) => readJobGaps(24, { runsDir: root, wtDir: wt, now: NOW, propose: true, ...none, ...extra });
  async function publish(id: string, log: string): Promise<void> {
    await mkdir(join(root, 'metrics'), { recursive: true });
    await writeFile(join(root, 'metrics', 'jobs.jsonl'), `${JSON.stringify({ event: 'outcome', job: id, lane: 'claude', empty: false, repo: 'phantom', ts: iso(2) })}\n`);
    await writeFile(join(root, `${id}.publish`), 'RESULT PR https://github.com/example/phantom/pull/1\n');
    await writeFile(join(root, `${id}.log`), log);
    await utimes(join(root, `${id}.publish`), (NOW - 3_600_000) / 1000, (NOW - 3_600_000) / 1000);
  }
  const LOG = 'did the work\n\n**Remaining gaps**\n- Add a retry flag to the export command\n- Show unknown sizes as unknown in the report\n- Cover the stale lock case in the tests\n\nAll done.\n';

  it('queues one valid drop per bullet under a bold gaps line and finds none the second time', async () => {
    await publish('JOBP', LOG);
    const first = await run();
    expect(first.publishedScanned).toBe(1);
    expect(first.bySource).toEqual({ 'no-change': 0, published: 3 });
    expect(first.proposed!.filter(p => p.queued)).toHaveLength(3);
    expect(first.proposed!.every(p => p.refused === null)).toBe(true);
    expect(await dropFiles('claude')).toHaveLength(3);
    const second = await run({ queuedWork: undefined });
    expect(second.candidates).toEqual([]);
    expect(second.proposed).toEqual([]);
    expect(await dropFiles('claude')).toHaveLength(3);
  });

  it('caps new drops per tick, with a flag value that wins over the default', async () => {
    await publish('JOBP', LOG);
    const capped = await run({ maxNew: 2 });
    expect(capped.proposed!.filter(p => p.queued)).toHaveLength(2);
    expect(capped.proposed!.find(p => !p.queued)!.skipped).toBe('already 2 new jobs this tick');
    expect(maxNewFromEnv({ ASHLR_GAPS_MAX: '5' })).toBe(5);
    expect(maxNewFromEnv({ ASHLR_GAPS_MAX: 'lots' })).toBe(3);
    expect(maxNewFromEnv({})).toBe(3);
  });

  it('reads the notes of a published job, and skips a job whose publish record is empty', async () => {
    await publish('JOBN', 'quiet\n');
    await mkdir(join(wt, 'JOBN'), { recursive: true });
    await writeFile(join(wt, 'JOBN', 'BRIDGE_NOTES.md'), '## Not done\n- Wire the digest into the weekly report\n');
    await writeFile(join(root, 'JOBE.publish'), 'RESULT EMPTY\n');
    await utimes(join(root, 'JOBE.publish'), (NOW - 3_600_000) / 1000, (NOW - 3_600_000) / 1000);
    await writeFile(join(root, 'JOBE.log'), '**Remaining gaps**\n- Print the queue depth in the status line\n');
    const report = await run();
    expect(report.publishedScanned).toBe(1);
    expect(report.candidates.map(c => [c.sourceJob, c.source])).toEqual([['JOBN', 'published']]);
  });

  it('never writes lane claude for a gap that names a gh command', async () => {
    await publish('JOBG', '**Remaining gaps**\n- Check open work with `gh pr list` before the next run\n');
    const report = await run();
    expect(report.proposed).toMatchObject([{ queued: true, refused: null }]);
    const files = await dropFiles('claude');
    expect(files).toHaveLength(1);
    // The drop directory is shared; the header line carries the lane.
    expect((await readFile(join(root, dropDir, 'claude', files[0]!), 'utf8')).split('\n')[0]).toBe('#job repo=phantom lane=codex-personal tier=work');
  });

  it('skips a gap whose title the host ingest already accepted', async () => {
    await publish('JOBP', LOG);
    const report = await run({ ingestedTitles: async () => ['Goal: Add a retry flag to the export command'] });
    expect(report.dropped.filter(d => d.reason === 'ingested')).toHaveLength(1);
    expect(report.proposed!.filter(p => p.queued)).toHaveLength(2);
  });

  it('takes --max on the command line and rejects a bad one', async () => {
    const seen: unknown[] = [];
    const read = async (_h: number, _p: boolean, max?: number) => { seen.push(max); return readJobGaps(24, { runsDir: join(root, 'nope'), wtDir: wt, now: NOW, ...none }); };
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await cmdJobsGaps(['--propose', '--max', '2'], read);
    expect(seen).toEqual([2]);
    expect(await cmdJobsGaps(['--max', 'many'], read)).toBe(2);
  });
});

describe('gaps and lanes that can run them', () => {
  const dropDir = join('leader', 'drop', 'claude');
  const lane = (name: string, over: Record<string, unknown> = {}) => ({ lane: name, running: 0, target: 8, queued: 0, held: false, remainingPct: 68, resetAt: null, ...over });
  const titles = ['Wire the digest into the weekly report', 'Cover the stale lock case in tests', 'Print queue depth in the status line', 'Rename the legacy sweep flag', 'Show unknown sizes as unknown'];
  const seedFive = () => seed({ 'RQ-A': `## Gaps\n${titles.map(t => `- ${t}`).join('\n')}\n` });
  const stuckLanes = [lane('codex-personal', { queued: 10, remainingPct: 0, resetAt: '2026-11-21T20:30:00Z' }), lane('claude', { remainingPct: 68 })];
  const dropFiles = async () => (await readdir(join(root, dropDir)).catch(() => [])).filter(f => f.endsWith('.md'));
  const fillPrompts = async (n: number) => {
    await mkdir(join(root, 'queue', 'prompts'), { recursive: true });
    for (let i = 0; i < n; i++) await writeFile(join(root, 'queue', 'prompts', `RQ-PHX-FULL${String(i).padStart(3, '0')}.md`), 'waiting\n');
  };
  const run = (lanes: readonly unknown[] | undefined) => readJobGaps(24, { runsDir: root, wtDir: wt, now: NOW, propose: true, ...none, ...(lanes ? { lanes: lanes as never } : {}) });

  it('fills more than three free slots from one repo and deduplicates on the next tick', async () => {
    await seedFive();
    const first = await run([lane('claude')]);
    expect(first.proposed!.filter(p => p.queued)).toHaveLength(5);
    expect(await dropFiles()).toHaveLength(5);
    const second = await run([lane('claude')]);
    expect(second.proposed).toEqual([]);
    expect(second.dropped).toHaveLength(5);
    expect(await dropFiles()).toHaveLength(5);
  });

  it('subtracts running and queued work and fills multiple eligible lanes without exceeding their slots', async () => {
    await seedFive();
    const lanes = [lane('claude', { target: 4, running: 1, queued: 2 }), lane('codex-local', { target: 2 }), lane('codex-personal', { target: 1 })];
    const report = await run(lanes);
    expect(report.proposed!.filter(p => p.queued).map(p => p.lane)).toEqual(['claude', 'codex-local', 'codex-local', 'codex-personal']);
    expect(report.proposed!.find(p => !p.queued)!.skipped).toBe('no lane has free slots and usage left');
    expect(lanes[0]!.queued).toBe(2);
  });

  it.each([
    { env: '', maxNew: undefined, expected: 5 },
    { env: 'lots', maxNew: undefined, expected: 5 },
    { env: '2', maxNew: undefined, expected: 2 },
    { env: '0', maxNew: undefined, expected: 0 },
    { env: '4', maxNew: 2, expected: 2 },
    { env: '4', maxNew: 0, expected: 0 },
  ])('honors explicit caps with known capacity: $env / $maxNew -> $expected', async ({ env, maxNew, expected }) => {
    vi.stubEnv('ASHLR_GAPS_MAX', env);
    await seedFive();
    const report = await readJobGaps(24, { runsDir: root, wtDir: wt, now: NOW, propose: true, lanes: [lane('claude')], ...none, maxNew });
    expect(report.proposed!.filter(p => p.queued)).toHaveLength(expected);
    expect(await dropFiles()).toHaveLength(expected);
  });

  it('allows an explicit max above three for one repo without lane readings', async () => {
    await seedFive();
    const report = await readJobGaps(24, { runsDir: root, wtDir: wt, now: NOW, propose: true, maxNew: 5, ...none });
    expect(report.proposed!.filter(p => p.queued)).toHaveLength(5);
  });

  it('keeps the three-job fallback with pace alone and no lane readings', async () => {
    await seedFive();
    const pace = new Map([['claude', { pool: 'claude', state: 'unknown' as const, usedPct: null, hoursToReset: null, emptyAt: null, evenPacePerHour: null, recentPerHour: null, resetAt: null }]]);
    const report = await readJobGaps(24, { runsDir: root, wtDir: wt, now: NOW, propose: true, pace, ...none });
    expect(report.proposed!.filter(p => p.queued)).toHaveLength(3);
  });

  it('stops at the remaining ready-queue headroom even when more slots are free', async () => {
    await seedFive();
    await mkdir(join(root, 'queue'), { recursive: true });
    await writeFile(join(root, 'queue', 'ready.tsv'), Array.from({ length: 39 }, (_, i) => `RQ-RDY${i}\tphantom\tclaude\twork\tplain row ${i}`).join('\n') + '\n');
    const report = await run([lane('claude')]);
    expect(report.proposed!.filter(p => p.queued)).toHaveLength(1);
    expect(report.proposed!.filter(p => !p.queued).every(p => p.skipped === 'the job queue is full (40 launchable rows, limit 40)')).toBe(true);
    expect(await dropFiles()).toHaveLength(1);
  });

  it('queues gaps for the idle lane when only rows on a used-up pool fill the queue', async () => {
    await seed({ 'RQ-A': '## Gaps\n- Wire the digest into the weekly report\n' });
    await fillPrompts(40);
    const report = await run(stuckLanes);
    expect(report.proposed).toMatchObject([{ queued: true, lane: 'claude', skipped: null }]);
    expect(await dropFiles()).toHaveLength(1);
    expect(report.parked).toBe(10);
  });

  it('parks rows on a lane whose slots are all busy, and queues for the starved lane', async () => {
    await seed({ 'RQ-A': '## Gaps\n- Wire the digest into the weekly report\n' });
    await fillPrompts(40);
    const report = await run([lane('codex-local', { running: 2, target: 2, queued: 12 }), lane('claude')]);
    expect(report.parked).toBe(12);
    expect(report.proposed).toMatchObject([{ queued: true, lane: 'claude' }]);
  });

  it('gives a lane at 100% no gap rows', async () => {
    await seed({ 'RQ-A': '## Gaps\n- Wire the digest into the weekly report\n' });
    const report = await run([lane('claude', { remainingPct: 0, resetAt: '2026-11-21T20:30:00Z' })]);
    expect(report.proposed).toMatchObject([{ queued: false, skipped: 'no lane has free slots and usage left' }]);
    expect(await dropFiles()).toHaveLength(0);
  });

  it('never queues the same gap twice', async () => {
    await seed({ 'RQ-A': '## Gaps\n- Wire the digest into the weekly report\n' });
    await run(stuckLanes);
    await run(stuckLanes);
    expect(await dropFiles()).toHaveLength(1);
  });

  it('skips with the full reason when the rows can launch', async () => {
    await seed({ 'RQ-A': '## Gaps\n- Wire the digest into the weekly report\n' });
    await mkdir(join(root, 'queue'), { recursive: true });
    await writeFile(join(root, 'queue', 'ready.tsv'), Array.from({ length: 40 }, (_, i) => `RQ-RDY${i}\tphantom\tclaude\twork\tplain row ${i}`).join('\n') + '\n');
    const report = await run([lane('claude', { queued: 1, running: 1 })]);
    expect(report.proposed).toMatchObject([{ queued: false, skipped: 'the job queue is full (40 launchable rows, limit 40)' }]);
    expect(await dropFiles()).toHaveLength(0);
  });

  it('moves gap work to the next lane with room and skips when no lane has any', async () => {
    await seed({ 'RQ-A': '## Gaps\n- Wire the digest into the weekly report\n' });
    expect((await run([lane('claude', { held: true }), lane('codex-local', { running: 2, target: 7 })])).proposed).toMatchObject([{ queued: true, lane: 'codex-local' }]);
    await rm(join(root, 'metrics', 'gap-proposed.jsonl'), { force: true });
    await rm(join(root, dropDir), { recursive: true, force: true });
    expect((await run([lane('claude', { running: 8 })])).proposed).toMatchObject([{ queued: false, skipped: 'no lane has free slots and usage left' }]);
  });

  it('keeps the old routing when the lanes are unknown', async () => {
    await seed({ 'RQ-A': '## Gaps\n- Wire the digest into the weekly report\n' });
    expect((await run(undefined)).proposed).toMatchObject([{ queued: true }]);
    expect((await readFile(join(root, dropDir, (await dropFiles())[0]!), 'utf8')).split('\n')[0]).toBe('#job repo=phantom lane=claude tier=work');
  });
});
