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
    };
    const [idea] = rankBottlenecks(signals, NOW).ideas;
    expect(idea!.evidence.projectedLeftAtResetPct).toBeNull();
    expect(idea!.task).not.toMatch(/will expire at the current pace/);
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
    expect(JSON.stringify(rankBottlenecks(reversed, NOW))).toBe(first);
    expect(Object.keys(JSON.parse(first))).toEqual(['schema', 'generatedAt', 'ideas', 'signals']);
    expect(Object.keys(JSON.parse(first).ideas[0])).toEqual(['id', 'signal', 'title', 'evidence', 'payoff', 'task']);
  });

  it('ties break by id so equal scores never swap', () => {
    const lane = (name: string) => ({ lane: name, status: 'red' as const, running: 0, target: 1, queued: 1 });
    const signals: BottleneckSignals = {
      emptyLaunches: { ok: false, reason: 'x' }, guardianFixups: { ok: false, reason: 'x' }, disk: { ok: false, reason: 'x' }, unspentUsage: { ok: false, reason: 'x' },
      idleLanes: { ok: true, data: [lane('zeta'), lane('alpha')] },
    };
    expect(rankBottlenecks(signals, NOW).ideas.map(idea => idea.id)).toEqual(['idle-lanes:alpha', 'idle-lanes:zeta']);
  });
});

describe('queue it', () => {
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
      expect(out.join('\n')).toMatch(/^Nothing to fix right now\.\nNot checked: empty-launches/);
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
});
