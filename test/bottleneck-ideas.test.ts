/**
 * bottleneck-ideas.test.ts: the Ideas loop engine (RQ-IDEASLOOPN17DQ8).
 * Ranking from fixture signals on disk, missing signals reported as unknown
 * (never invented), byte-stable JSON, and "Queue it" through the drop-job
 * writer. Every file lives in a temp runs dir; nothing touches the real home.
 */
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ideaJobId, IDEA_LIST_SCHEMA, QueueIdeaError, queueIdea, rankBottlenecks, readBottleneckSignals, readIdeaList, SIGNAL_NAMES,
  type BottleneckSignals,
} from '../src/core/fleet/bottleneck-ideas.js';
import { cmdIdeas } from '../src/cli/ideas.js';
import { DROP_JOB_QUEUE_LIMIT } from '../src/core/fleet/drop-job-writer.js';

const NOW = Date.parse('2026-11-17T12:00:00Z');
const iso = (hoursAgo: number) => new Date(NOW - hoursAgo * 3_600_000).toISOString();

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'ideas-list-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); vi.restoreAllMocks(); });

async function put(path: string, text: string): Promise<void> {
  await mkdir(join(root, path, '..'), { recursive: true });
  await writeFile(join(root, path), text);
}

/** One fixture per signal, each tripping its threshold once plus a decoy that must not. */
async function seedAllSignals(): Promise<void> {
  for (const path of ['leader/VISION.md', 'leader/MASON-INBOX.md', 'queue/router-queue.md']) await put(path, '');
  const rows: object[] = [];
  // RQ-PHX-RECUT*: 4 launches, 3 empty finishes. RQ-GOOD*: 2 launches, none empty.
  Array.from({ length: 4 }, (_, i) => `RQ-PHX-RECUTAPIC${i + 1}`).forEach((job, i) => {
    rows.push({ event: 'launch', job, lane: 'claude', tier: 'work', ts: iso(20 - i) });
    rows.push({ event: 'finish', job, empty: i < 3, ts: iso(19 - i) });
  });
  for (const job of ['RQ-GOOD-1', 'RQ-GOOD-2']) rows.push({ event: 'launch', job, lane: 'codex', tier: 'work', ts: iso(5) });
  // Outside the 72h window: ignored.
  rows.push({ event: 'launch', job: 'RQ-OLD-1', lane: 'claude', ts: iso(100) });
  await put('metrics/jobs.jsonl', rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  await put('supervisor/status-main-guardian.md', [
    '# Main guardian status (2026-11-17 11:50:00)',
    '| repo | branch | sha | state | checked | failing | fix jobs | nightly |',
    '|---|---|---|---|---|---|---|---|',
    '| phantom | master | abcdef1 | red | 2026-11-17 11:50:00 | lint | RQ-FIX1, RQ-FIX2 | |',
    '| locus | main | abcdef2 | green | 2026-11-17 11:50:00 | | | |',
    '| stack | main | abcdef3 | red | 2026-11-17 11:50:00 | build | RQ-FIX3 | |',
  ].join('\n'));
  // 200 GB → 180 GB over 10 hours: 2 GB/h, 15 hours to the 150 GB floor.
  await put('queue/disk-growth-history.json', JSON.stringify([{ at: (NOW - 10 * 3_600_000) / 1000, free_gb: 200 }, { at: NOW / 1000, free_gb: 180 }]));
  await put('queue/status.json', JSON.stringify({ lanes: {
    claude: { running: 0, target: 3, queued: 5, held: false },
    devin: { running: 0, target: 0, queued: 4, held: true },
    codex: { running: 2, target: 2, queued: 1, held: false },
  } }));
  await put('queue/usage-readings.log', [
    { pool: 'claude', pctUsed: 40, resetAt: new Date(NOW + 10 * 3_600_000).toISOString(), observedAt: iso(1), burnRatePctPerHour: 2 },
    { pool: 'codex', pctUsed: 10, resetAt: new Date(NOW + 100 * 3_600_000).toISOString(), observedAt: iso(1) },
  ].map(row => JSON.stringify(row)).join('\n'));
  // A readable hints report with no actionable content: the signal is ok, no idea.
  await put('metrics/selection-hints.json', JSON.stringify({
    schema: 'metrics.selection-hints.v1', at: iso(1), advisory: true,
    lanes: [], nodes_with_spare: [],
    top_constraint: { name: 'unknown', evidence: 'loop times missing; see loop report reasons' },
    loop_wait: { missing: 'loop stage times not collected' },
    bets_share: { missing: 'bets share not computed' },
  }));
}

const read = () => readIdeaList({ runsDir: root, usageLogPaths: [join(root, 'queue', 'usage-readings.log')], now: NOW });

describe('ideas list ranking', () => {
  it('ranks one idea per tripped signal by payoff, with evidence and a task line', async () => {
    await seedAllSignals();
    const report = await read();
    expect(report.schema).toBe(IDEA_LIST_SCHEMA);
    expect(report.signals.every(signal => signal.status === 'ok')).toBe(true);
    expect(report.ideas.map(idea => [idea.id, idea.payoff.score])).toEqual([
      ['disk-trend:runway', 75],
      ['guardian-fixups:phantom:lint', 70],
      ['idle-lanes:claude', 66],
      ['empty-launches:rq-phx-recut', 34],
      ['unspent-usage:claude', 30],
    ]);
    const byId = new Map(report.ideas.map(idea => [idea.id, idea]));
    expect(byId.get('empty-launches:rq-phx-recut')).toMatchObject({
      title: 'RQ-PHX-RECUT* jobs came back empty 3 of 4 times',
      evidence: { family: 'RQ-PHX-RECUT*', launched: 4, empty: 3, emptyRate: 0.75, windowHours: 72 },
    });
    expect(byId.get('guardian-fixups:phantom:lint')!.title).toBe('Main in phantom is still red on lint after 2 fix attempts');
    expect(byId.get('disk-trend:runway')).toMatchObject({ title: 'Disk will drop below 150 GB free in about 15 hours', evidence: { freeGb: 180, gbPerHour: 2, hoursUntilFloor: 15 } });
    expect(byId.get('idle-lanes:claude')!.title).toBe('claude has 5 jobs waiting but runs 0 of 3');
    expect(byId.get('unspent-usage:claude')).toMatchObject({ evidence: { usedPct: 40, hoursToReset: 10, readingAgeHours: 1, projectedLeftAtResetPct: 38 } });
    for (const idea of report.ideas) {
      expect(idea.title).not.toMatch(/\n/);
      expect(idea.task.length).toBeGreaterThan(20);
      expect(idea.payoff.text).toBeTruthy();
    }
  });

  it('keeps below-threshold signals out: one guardian attempt, held lanes, far resets, healthy families', async () => {
    await seedAllSignals();
    const ids = (await read()).ideas.map(idea => idea.id);
    expect(ids.some(id => id.includes('stack') || id.includes('devin') || id.includes('codex') || id.includes('good'))).toBe(false);
  });

  it('reports every missing signal as unknown and invents no idea', async () => {
    const report = await read();
    expect(report.ideas).toEqual([]);
    expect(report.signals.map(signal => [signal.name, signal.status])).toEqual(SIGNAL_NAMES.map(name => [name, 'unknown']));
    expect(report.signals.every(signal => typeof signal.reason === 'string' && signal.reason.length > 0)).toBe(true);
  });

  it('marks a signal unknown on bad input rather than guessing, while others still rank', async () => {
    await seedAllSignals();
    await put('queue/status.json', '{"lanes": {"claude": {"running": "many"}}}');
    await put('queue/disk-growth-history.json', '[{"at": 1, "free_gb": 200}]'.replace('1', String(NOW / 1000)));
    const report = await read();
    const status = Object.fromEntries(report.signals.map(signal => [signal.name, signal]));
    expect(status['idle-lanes']).toMatchObject({ status: 'unknown', reason: 'queue/status.json is not in the expected shape' });
    expect(report.ideas.some(idea => idea.signal === 'idle-lanes')).toBe(false);
    // One disk sample has no trend: the disk idea is absent, not projected.
    expect(report.ideas.some(idea => idea.signal === 'disk-trend')).toBe(false);
    expect(report.ideas.some(idea => idea.signal === 'guardian-fixups')).toBe(true);
  });

  it('shows null evidence as unknown values, never a made-up number', () => {
    const signals: BottleneckSignals = {
      emptyLaunches: { ok: false, reason: 'x' }, guardianFixups: { ok: false, reason: 'x' }, disk: { ok: false, reason: 'x' }, idleLanes: { ok: false, reason: 'x' },
      unspentUsage: { ok: true, data: [{ pool: 'claude', usedPct: 30, hoursToReset: 6, readingAgeHours: 0.5, projectedLeftPct: null }] },
      loopHints: { ok: false, reason: 'x' },
    };
    const [idea] = rankBottlenecks(signals, NOW).ideas;
    expect(idea!.evidence.projectedLeftAtResetPct).toBeNull();
    expect(idea!.task).not.toMatch(/will expire at the current pace/);
  });
});

describe('loop-hints signal', () => {
  const hintsDoc = (over: Record<string, unknown> = {}) => JSON.stringify({
    schema: 'metrics.selection-hints.v1', at: iso(2), advisory: true,
    lanes: [{ lane: 'claude', merged_per_lane_hour: 1.5, merged_6h: 9, held: false }],
    nodes_with_spare: [{ node: 'studio', spare: 2 }],
    top_constraint: { name: 'merge', evidence: '5 PRs opened and 0 merged in 6h' },
    loop_wait: { headline: 'Biggest wait: PR to merged, p50 95 min', slowest: { stage: 'pr_to_merged', p50_minutes: 95 }, since: iso(24), jobs_truncated: false },
    bets_share: { reserved: 1, usable: 1 },
    ...over,
  });

  it('turns the loop diagnosis into ranked ideas with the report stamp as evidence', async () => {
    await seedAllSignals();
    await put('metrics/selection-hints.json', hintsDoc());
    const report = await read();
    expect(report.signals.find(signal => signal.name === 'loop-hints')).toMatchObject({ status: 'ok', reason: null });
    const byId = new Map(report.ideas.map(idea => [idea.id, idea]));
    expect(byId.get('loop-constraint:merge')).toMatchObject({
      signal: 'loop-hints', payoff: { score: 75 },
      evidence: { constraint: 'merge', constraintEvidence: '5 PRs opened and 0 merged in 6h', hintsAt: iso(2), hintsAgeHours: 2 },
    });
    expect(byId.get('loop-wait:pr-to-merged')).toMatchObject({
      signal: 'loop-hints', payoff: { score: 48 },
      evidence: { stage: 'pr_to_merged', p50Minutes: 95, since: iso(24), jobsTruncated: 'false', hintsAgeHours: 2 },
    });
    expect(byId.get('loop-wait:pr-to-merged')!.title).toBe("The self-improvement loop's slowest stage is PR to merged (p50 95 min)");
  });

  it('emits no idea for unnamed or unknown constraints and stages under the wait floor', async () => {
    await put('metrics/selection-hints.json', hintsDoc({
      top_constraint: { name: 'unknown', evidence: 'loop times missing; see loop report reasons' },
      loop_wait: { headline: 'x', slowest: { stage: 'queued_to_launched', p50_minutes: 30 }, since: iso(24), jobs_truncated: null },
    }));
    const report = await read();
    expect(report.signals.find(signal => signal.name === 'loop-hints')).toMatchObject({ status: 'ok' });
    expect(report.ideas.filter(idea => idea.signal === 'loop-hints')).toEqual([]);
  });

  it('turns a measurement constraint into an idea but leaves unknown constraint names alone', async () => {
    await put('metrics/selection-hints.json', hintsDoc({ top_constraint: { name: 'measurement', evidence: 'jobs.jsonl unreadable: throughput unknown' } }));
    let report = await read();
    expect(report.ideas.map(idea => idea.id)).toEqual(['loop-constraint:measurement', 'loop-wait:pr-to-merged']);
    await put('metrics/selection-hints.json', hintsDoc({
      top_constraint: { name: 'unknown', evidence: 'loop times missing; see loop report reasons' },
      loop_wait: { missing: 'loop stage times not collected' },
    }));
    report = await read();
    expect(report.signals.find(signal => signal.name === 'loop-hints')).toMatchObject({ status: 'ok' });
    expect(report.ideas.filter(idea => idea.signal === 'loop-hints')).toEqual([]);
  });

  it('reports the signal unknown on missing, malformed, stale or wrong-schema files and invents nothing', async () => {
    let report = await read();
    expect(report.signals.find(signal => signal.name === 'loop-hints')).toMatchObject({ status: 'unknown', reason: 'metrics/selection-hints.json not found' });
    await put('metrics/selection-hints.json', '{not json');
    report = await read();
    expect(report.signals.find(signal => signal.name === 'loop-hints')).toMatchObject({ status: 'unknown', reason: 'metrics/selection-hints.json is not valid JSON' });
    await put('metrics/selection-hints.json', hintsDoc({ schema: 'metrics.other.v1' }));
    report = await read();
    expect(report.signals.find(signal => signal.name === 'loop-hints')).toMatchObject({ status: 'unknown' });
    expect(report.ideas.filter(idea => idea.signal === 'loop-hints')).toEqual([]);
    await put('metrics/selection-hints.json', hintsDoc({ at: iso(100) }));
    report = await read();
    expect(report.signals.find(signal => signal.name === 'loop-hints')).toMatchObject({ status: 'unknown', reason: 'metrics/selection-hints.json is older than 72 hours' });
    await put('metrics/selection-hints.json', hintsDoc({ at: iso(-3) }));
    report = await read();
    expect(report.signals.find(signal => signal.name === 'loop-hints')).toMatchObject({ status: 'unknown', reason: 'metrics/selection-hints.json is stamped in the future' });
    await put('metrics/selection-hints.json', hintsDoc({ advisory: false }));
    report = await read();
    expect(report.signals.find(signal => signal.name === 'loop-hints')).toMatchObject({ status: 'unknown' });
  });

  it('treats a Missing loop_wait and absent constraint fields as unknown detail, not zero', async () => {
    await put('metrics/selection-hints.json', hintsDoc({
      top_constraint: { name: 'idea-to-merge' },
      loop_wait: { missing: 'loop stage times not collected' },
    }));
    const report = await read();
    const idea = report.ideas.find(candidate => candidate.id === 'loop-constraint:idea-to-merge');
    expect(idea).toMatchObject({ payoff: { score: 50 }, evidence: { constraintEvidence: null } });
    expect(report.ideas.some(candidate => candidate.id.startsWith('loop-wait:'))).toBe(false);
  });
});

describe('stable JSON', () => {
  it('is byte-identical across reads and independent of input order', async () => {
    await seedAllSignals();
    const first = JSON.stringify(await read());
    expect(JSON.stringify(await read())).toBe(first);
    const signals = await readBottleneckSignals({ runsDir: root, usageLogPaths: [join(root, 'queue', 'usage-readings.log')], now: NOW });
    const reversed: BottleneckSignals = { ...signals };
    for (const key of ['emptyLaunches', 'guardianFixups', 'idleLanes', 'unspentUsage'] as const) {
      const signal = signals[key];
      if (signal.ok) (reversed as unknown as Record<string, unknown>)[key] = { ok: true, data: [...signal.data].reverse() };
    }
    expect(JSON.stringify(rankBottlenecks(reversed, NOW))).toBe(JSON.stringify(rankBottlenecks(signals, NOW)));
    expect(Object.keys(JSON.parse(first))).toEqual(['schema', 'generatedAt', 'ideas', 'signals']);
    expect(Object.keys(JSON.parse(first).ideas[0])).toEqual(['id', 'signal', 'title', 'evidence', 'payoff', 'task', 'why', 'lane', 'status']);
  });

  it('ties break by id so equal scores never swap', () => {
    const lane = (name: string) => ({ lane: name, status: 'red' as const, running: 0, target: 1, queued: 1 });
    const signals: BottleneckSignals = {
      emptyLaunches: { ok: false, reason: 'x' }, guardianFixups: { ok: false, reason: 'x' }, disk: { ok: false, reason: 'x' }, unspentUsage: { ok: false, reason: 'x' },
      loopHints: { ok: false, reason: 'x' },
      idleLanes: { ok: true, data: [lane('zeta'), lane('alpha')] },
    };
    expect(rankBottlenecks(signals, NOW).ideas.map(idea => idea.id)).toEqual(['idle-lanes:alpha', 'idle-lanes:zeta']);
  });
});

describe('queue it', () => {
  it('ignores retained prompts and parked rows when admitting an idea', async () => {
    await seedAllSignals();
    await Promise.all(Array.from({ length: DROP_JOB_QUEUE_LIMIT }, (_, i) => put(`queue/prompts/RQ-PHX-OLD${i}.md`, 'old')));
    const ready = Array.from({ length: DROP_JOB_QUEUE_LIMIT - 1 }, (_, i) => `RQ-WAIT${i}\tphantom\tclaude\twork\tWaiting ${i}`);
    const parked = Array.from({ length: DROP_JOB_QUEUE_LIMIT }, (_, i) => `RQ-HELD${i}\tphantom\tPARKED-HOLD.claude\twork\tHeld ${i}`);
    await put('queue/ready.tsv', [...ready, ...parked].join('\n'));
    expect(await queueIdea('idle-lanes:claude', { runsDir: root, now: NOW })).toMatchObject({ queued: true, existing: false });
  });

  it('refuses a full ready queue without prompt files, but still finds existing jobs', async () => {
    await seedAllSignals();
    const deps = { runsDir: root, now: NOW };
    const existing = await queueIdea('idle-lanes:claude', deps);
    await put('queue/ready.tsv', Array.from({ length: DROP_JOB_QUEUE_LIMIT }, (_, i) => `RQ-WAIT${i}\tphantom\tclaude\twork\tWaiting ${i}`).join('\n'));
    await expect(queueIdea('disk-trend:runway', deps)).rejects.toMatchObject({ status: 507 });
    expect(await queueIdea('idle-lanes:claude', deps)).toEqual({ ...existing, queued: false, existing: true });
    expect(await readdir(join(root, 'leader/drop/claude'))).toHaveLength(1);
  });

  it('writes one drop job per idea and finds it again on a second click', async () => {
    await seedAllSignals();
    const deps = { runsDir: root, usageLogPaths: [join(root, 'queue', 'usage-readings.log')], now: NOW };
    const first = await queueIdea('idle-lanes:claude', deps);
    expect(first).toEqual({ ideaId: 'idle-lanes:claude', jobId: ideaJobId('idle-lanes:claude'), queued: true, existing: false });
    const files = (await readdir(join(root, 'leader', 'drop', 'claude'))).filter(name => !name.startsWith('.'));
    expect(files).toEqual([`RQ-PHX-${first.jobId}.md`]);
    const body = await readFile(join(root, 'leader', 'drop', 'claude', files[0]!), 'utf8');
    expect(body.split('\n')[0]).toBe('#job repo=phantom lane=claude tier=work');
    expect(body).toContain('Goal: Find why lane claude launches nothing while 5 jobs wait');
    expect(body).toContain('Source: Ideas list, idea idle-lanes:claude.');
    expect(await queueIdea('idle-lanes:claude', deps)).toEqual({ ...first, queued: false, existing: true });
  });

  it('refuses ids that are malformed or no longer on the list', async () => {
    await expect(queueIdea('../etc', { runsDir: root, now: NOW })).rejects.toMatchObject({ status: 400 });
    await expect(queueIdea(42, { runsDir: root, now: NOW })).rejects.toBeInstanceOf(QueueIdeaError);
    await expect(queueIdea('idle-lanes:claude', { runsDir: root, usageLogPaths: [], now: NOW })).rejects.toMatchObject({ status: 404 });
  });
});

describe('phm ideas list / queue', () => {
  const capture = () => {
    const out: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => { out.push(String(line)); });
    vi.spyOn(console, 'error').mockImplementation((line: unknown) => { out.push(String(line)); });
    return out;
  };

  it('prints the JSON report by default and plain lines with --human', async () => {
    vi.stubEnv('ASHLR_RUNS_DIR', root);
    try {
      let out = capture();
      expect(await cmdIdeas(['list'])).toBe(0);
      const report = JSON.parse(out.join('\n'));
      expect(report.schema).toBe(IDEA_LIST_SCHEMA);
      expect(report.ideas).toEqual([]);
      vi.restoreAllMocks();
      out = capture();
      expect(await cmdIdeas(['list', '--human'])).toBe(0);
      expect(out.join('\n')).toMatch(/^No candidates from available sources\.\nNot checked: empty-launches/);
    } finally { vi.unstubAllEnvs(); }
  });

  it('rejects bad usage with exit 2 and queues through the same core path', async () => {
    vi.stubEnv('ASHLR_RUNS_DIR', root);
    try {
      const out = capture();
      expect(await cmdIdeas(['list', '--bogus'])).toBe(2);
      expect(await cmdIdeas(['queue'])).toBe(2);
      expect(await cmdIdeas(['queue', 'idle-lanes:nope', '--json'])).toBe(1);
      expect(JSON.parse(out.at(-1)!)).toEqual({ error: 'that idea is not on the current list' });
      expect(await cmdIdeas(['list', '--help'])).toBe(0);
    } finally { vi.unstubAllEnvs(); }
  });

  it('queues despite retained prompts and reports a full ready queue as an error', async () => {
    await seedAllSignals();
    await Promise.all(Array.from({ length: DROP_JOB_QUEUE_LIMIT }, (_, i) => put(`queue/prompts/RQ-PHX-OLD${i}.md`, 'old')));
    vi.stubEnv('ASHLR_RUNS_DIR', root);
    try {
      const out = capture();
      expect(await cmdIdeas(['queue', 'idle-lanes:claude', '--json'])).toBe(0);
      expect(JSON.parse(out.at(-1)!)).toMatchObject({ queued: true });
      await put('queue/ready.tsv', Array.from({ length: DROP_JOB_QUEUE_LIMIT }, (_, i) => `RQ-WAIT${i}\tphantom\tclaude\twork\tWaiting ${i}`).join('\n'));
      expect(await cmdIdeas(['queue', 'disk-trend:runway', '--json'])).toBe(1);
      expect(JSON.parse(out.at(-1)!)).toEqual({ error: 'the job queue is full' });
    } finally { vi.unstubAllEnvs(); }
  });
});

describe('next bets contract', () => {
  it('combines VISION and requests with queue and merged lifecycle evidence', async () => {
    await seedAllSignals();
    await put('leader/VISION.md', '- READY RQ-NEXT (pool=codex-personal): Build offline search\n- READY RQ-LIVE: Ship retries\n- READY RQ-DONE: Restore main');
    await put('queue/router-queue.md', '- READY RQ-LIVE: Ship retries\n- READY RQ-WAIT: Improve onboarding');
    await put('leader/MASON-INBOX.md', '2026-11-17T10:00:00Z [src:desktop id:ask1] Make the fleet more ambitious');
    await put('metrics/jobs.jsonl', [
      { event: 'concurrency', ts: iso(3), from: 1, to: 2 },
      { event: 'enqueue', job: 'RQ-WAIT', ts: NOW / 1000 - 7200 },
      { event: 'launch', job: 'RQ-LIVE', ts: iso(1) },
      { event: 'outcome', job_id: 'RQ-DONE', state: 'MERGED', ts: iso(2) },
    ].map(row => JSON.stringify(row)).join('\n'));
    const report = await read();
    expect(report.ideas[0]).toMatchObject({ signal: 'mason-inbox', status: 'proposed', payoff: { score: 85 } });
    const byId = new Map(report.ideas.map(idea => [idea.id, idea]));
    expect(byId.get('plan:rq-next')).toMatchObject({ title: 'Build offline search', lane: 'codex-personal', status: 'proposed', why: 'Leader VISION names RQ-NEXT.' });
    expect(byId.get('plan:rq-live')).toMatchObject({ status: 'running' });
    expect(byId.get('plan:rq-wait')).toMatchObject({ status: 'queued' });
    expect(byId.get('plan:rq-done')).toMatchObject({ status: 'shipped' });
    expect(JSON.stringify(await read())).toBe(JSON.stringify(report));
    const write = vi.fn();
    expect(await queueIdea('plan:rq-done', { runsDir: root, now: NOW, write })).toMatchObject({ existing: true, queued: false, jobId: 'RQ-DONE' });
    expect(write).not.toHaveBeenCalled();
    await queueIdea('plan:rq-next', { runsDir: root, now: NOW });
    const prompt = await readFile(join(root, 'leader/drop/claude', `RQ-PHX-${ideaJobId('plan:rq-next')}.md`), 'utf8');
    expect(prompt).toContain('lane=codex-personal');
    expect((await read()).ideas.find(idea => idea.id === 'plan:rq-next')?.status).toBe('queued');
    expect(await queueIdea('plan:rq-next', { runsDir: root, now: NOW })).toMatchObject({ jobId: ideaJobId('plan:rq-next'), queued: false });
  });

  it('marks malformed event lines unknown while retaining independent VISION evidence', async () => {
    await put('leader/VISION.md', '- READY RQ-NEXT: Build offline search');
    await put('metrics/jobs.jsonl', '{broken event\n' + [
      { event: 'launch', job: 'RQ-NEXT', ts: 'invalid' }, { event: 'launch', job: 'RQ-NEXT', ts: iso(-1) },
      { jobId: 'RQ-NEXT', outcome: 'MERGED', ts: iso(1) },
    ].map(row => JSON.stringify(row)).join('\n'));
    const report = await read();
    expect(report.ideas).toHaveLength(1);
    expect(report.ideas[0]?.status).toBe('shipped');
    expect(await queueIdea('plan:rq-next', { runsDir: root, now: NOW })).toMatchObject({ existing: true, queued: false });
    for (const name of ['job-events', 'empty-launches']) expect(report.signals.find(signal => signal.name === name)).toMatchObject({ status: 'unknown', reason: expect.stringContaining('malformed') });
  });

  it('does not turn an ended run or an unmerged outcome into shipped work', async () => {
    await put('leader/VISION.md', '- READY RQ-NEXT: Build offline search');
    await put('metrics/jobs.jsonl', ['launch', 'finish', 'publish', 'outcome'].map((event, i) => JSON.stringify({ event, job: 'RQ-NEXT', state: 'UNMERGED', ts: iso(4 - i) })).join('\n'));
    expect((await read()).ideas[0]).toMatchObject({ status: 'proposed', evidence: { existingJobId: 'RQ-NEXT' } });
    expect(await queueIdea('plan:rq-next', { runsDir: root, now: NOW })).toMatchObject({ existing: true, queued: false, jobId: 'RQ-NEXT' });
  });

  it('proposes investigating a stuck job without claiming the diagnosis has run', async () => {
    await put('metrics/jobs.jsonl', JSON.stringify({ event: 'launch', job: 'RQ-STUCK_1', ts: iso(8) }));
    expect((await read()).ideas[0]).toMatchObject({ id: 'stuck:rq-stuck_1', status: 'proposed', payoff: { score: 58 } });
    expect(await queueIdea('stuck:rq-stuck_1', { runsDir: root, now: NOW })).toMatchObject({ queued: true });
  });

  it('shares the default JSON report with list and supports --text', async () => {
    vi.stubEnv('ASHLR_RUNS_DIR', root);
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await put('leader/VISION.md', '- READY RQ-NEXT (pool=claude): Build offline search');
      expect(await cmdIdeas(['--json'])).toBe(0);
      expect(await cmdIdeas(['list', '--json'])).toBe(0);
      expect(out.mock.calls[0]).toEqual(out.mock.calls[1]);
      expect(await cmdIdeas(['--text'])).toBe(0);
      expect(out.mock.calls[2]?.[0]).toContain('Build offline search [proposed] · claude');
    } finally { vi.unstubAllEnvs(); }
  });
});
