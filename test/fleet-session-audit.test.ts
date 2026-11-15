/** Hermetic tests for `phm fleet session-audit` — every reader is injected. */
import { describe, expect, it } from 'vitest';
import {
  buildSlugJobMap, claudeSlug, codexSessionCwd, formatSessionAudit,
  formatSessionPrunePlan, jobForCwd, parseDevinTaskEvidence,
  publishedEvidence, readSessionAudit,
  SESSION_AUDIT_SCHEMA, type SessionAuditDeps, type SessionAuditFs,
} from '../src/core/fleet/session-audit.js';
import { cmdFleetSessionAudit } from '../src/cli/fleet-session-audit.js';

const NOW = Date.parse('2026-11-08T12:00:00Z');
const DAY = 86_400_000;
const HOME = '/home/test';
const ASHLR = `${HOME}/.ashlr`;
const RUNS = `${HOME}/.ashlr-runs`;
const WT = `${HOME}/Projects/ashlrai/wt`;
const PROFILES = `${ASHLR}/native-profiles`;

const iso = (ms: number) => new Date(ms).toISOString();
const launch = (job: string, days: number) => ({ event: 'launch', job, ts: iso(NOW - days * DAY) });
const finish = (job: string, days: number, empty = false) =>
  ({ event: 'finish', job, empty, ts: iso(NOW - days * DAY) });
const outcome = (job: string, state: string, days = 1, url?: string) =>
  ({ event: 'outcome', job, state, ts: iso(NOW - days * DAY), ...(url ? { url } : {}) });
const publish = (job: string, cls: string, days = 1, url?: string) =>
  ({ event: 'publish', job, class: cls, ts: iso(NOW - days * DAY), ...(url ? { url } : {}) });
const jobsText = (rows: unknown[]) => rows.map(r => JSON.stringify(r)).join('\n') + '\n';

const devinTask = (id: string, state: string, opts: { pr?: unknown; report?: unknown; updatedDays?: number } = {}) =>
  JSON.stringify({
    v: 1, id, repo: 'ashlrai/phantom', baseBranch: 'main', branch: `ashlr-devin/${id}`,
    title: 't', prompt: 'p', origin: 'fleet', requestedBy: 'fleet',
    sessionId: 'sess-1', sessionUrl: 'https://app.devin.ai/sessions/sess-1',
    state, stateReason: null, failure: null,
    createdAt: iso(NOW - 90 * DAY), launchedAt: iso(NOW - 89 * DAY),
    updatedAt: iso(NOW - (opts.updatedDays ?? 40) * DAY),
    session: null, maxAcu: 10, devinMode: 'normal',
    pr: opts.pr ?? null, headSha: null, report: opts.report ?? null, backlogItemId: null,
  });

interface FakeSpec {
  /** dir -> child entries; 'degraded' marks an unreadable listing. */
  entries?: Record<string, Array<{ name: string; isDir: boolean; isFile: boolean }> | 'degraded' | 'missing'>;
  /** path -> {mtimeMs,size,isFile,isDir}; 'degraded' marks an unreadable probe. */
  stats?: Record<string, { mtimeMs: number; size: number; isFile: boolean; isDir: boolean } | 'degraded' | 'missing'>;
  /** file -> text content for head reads. */
  files?: Record<string, string>;
}

const fakeFs = (spec: FakeSpec): SessionAuditFs => ({
  entries: async path => (spec.entries && Object.hasOwn(spec.entries, path) ? spec.entries[path]! : 'missing'),
  stat: async path => spec.stats?.[path] ?? 'missing',
  head: async path => spec.files?.[path] ?? null,
});

const dir = (name: string) => ({ name, isDir: true, isFile: false });
const file = (name: string) => ({ name, isDir: false, isFile: true });
const st = (days: number, size = 1000, isDir = false): { mtimeMs: number; size: number; isFile: boolean; isDir: boolean } =>
  ({ mtimeMs: NOW - days * DAY, size, isFile: !isDir, isDir });

interface FakeOptions extends SessionAuditDeps {
  rows?: unknown[];
  jobsState?: 'healthy' | 'missing' | 'degraded';
}

const healthyDeps = (spec: FakeSpec, options: FakeOptions = {}): SessionAuditDeps => {
  const { rows = [], jobsState = 'healthy', ...rest } = options;
  const entries: NonNullable<FakeSpec['entries']> = {
    [PROFILES]: [],
    ...spec.entries,
  };
  const stats: NonNullable<FakeSpec['stats']> = { ...spec.stats };
  // Every directory named in spec.entries gets a directory stat; explicit
  // stats still win.
  for (const path of Object.keys(entries)) {
    if (!Object.hasOwn(stats, path)) stats[path] = st(100, 0, true);
  }
  return {
    now: NOW,
    roots: { home: HOME, ashlrDir: ASHLR, runsDir: RUNS, wtDir: WT },
    env: {},
    fs: fakeFs({ entries, stats, files: spec.files }),
    readJobs: async () => ({ state: jobsState, text: jobsText(rows) }),
    ...rest,
  };
};

const codexRollout = (cwd: string, id = 'thread-1') =>
  `${JSON.stringify({ timestamp: iso(NOW - 60 * DAY), type: 'session_meta', payload: { originator: 'codex_cli_rs', cli_version: '0.55.0', cwd } })}\n`
  + `${JSON.stringify({ timestamp: iso(NOW - 60 * DAY), type: 'event_msg', payload: { type: 'task_started' } })}\n`;

const lane = (report: Awaited<ReturnType<typeof readSessionAudit>>, name: string) =>
  report.lanes.find(l => l.lane === name);

describe('pure helpers', () => {
  it('claudeSlug maps every non-alphanumeric to -', () => {
    expect(claudeSlug('/Users/me/Projects/ashlrai/wt/RQ-A-1')).toBe('-Users-me-Projects-ashlrai-wt-RQ-A-1');
    expect(claudeSlug('/a_b/c.d')).toBe('-a-b-c-d');
  });

  it('buildSlugJobMap maps ledger ids under both roots and drops collisions', () => {
    const map = buildSlugJobMap(['RQ-A-1', 'RQ-A-2'], [WT, `${RUNS}/wt`]);
    expect(map.get(claudeSlug(`${WT}/RQ-A-1`))).toBe('RQ-A-1');
    expect(map.get(claudeSlug(`${RUNS}/wt/RQ-A-2`))).toBe('RQ-A-2');
    // 'RQ_A.1' and 'RQ-A-1' slug-collide -> the slug matches nothing.
    const colliding = buildSlugJobMap(['RQ_A.1', 'RQ-A-1'], [WT]);
    expect(colliding.get(claudeSlug(`${WT}/RQ-A-1`))).toBeUndefined();
  });

  it('jobForCwd accepts direct children of wt roots only', () => {
    const roots = [WT, `${RUNS}/wt`];
    expect(jobForCwd(`${WT}/RQ-FOO-1`, roots)).toBe('RQ-FOO-1');
    expect(jobForCwd(`${RUNS}/wt/RQ-BAR-2`, roots)).toBe('RQ-BAR-2');
    expect(jobForCwd(`${WT}/RQ-X/deeper`, roots)).toBeNull();
    expect(jobForCwd(`${HOME}/elsewhere/RQ-X`, roots)).toBeNull();
    expect(jobForCwd('relative/path', roots)).toBeNull();
    expect(jobForCwd(`${WT}/bad id!`, roots)).toBeNull();
    expect(jobForCwd(null, roots)).toBeNull();
  });

  it('codexSessionCwd reads session_meta.cwd from the head', () => {
    expect(codexSessionCwd(codexRollout(`${WT}/RQ-X-1`))).toBe(`${WT}/RQ-X-1`);
    expect(codexSessionCwd(codexRollout('relative/path'))).toBeNull();
    expect(codexSessionCwd('{"type":"event_msg","payload":{}}\n')).toBeNull();
    expect(codexSessionCwd(null)).toBeNull();
    expect(codexSessionCwd('not json\n{"type":"session_meta","payload":{"cwd":"/abs/dir"}}\n')).toBe('/abs/dir');
  });

  it('publishedEvidence maps merged/publish/empty only', () => {
    expect(publishedEvidence(undefined)).toBeNull();
    expect(publishedEvidence({ outcomeState: 'merged' } as never)).toBe('merged');
    expect(publishedEvidence({ outcomeState: 'open', publishClass: 'pr' } as never)).toBe('published-pr');
    expect(publishedEvidence({ publishClass: 'empty' } as never)).toBe('published-empty');
    expect(publishedEvidence({ finishSeen: true, finishEmpty: true } as never)).toBe('finished-empty');
    expect(publishedEvidence({ outcomeState: 'denied', finishSeen: true } as never)).toBeNull();
  });

  it('parseDevinTaskEvidence requires real pr/report content', () => {
    expect(parseDevinTaskEvidence(null)).toBeNull();
    expect(parseDevinTaskEvidence('not json')).toBeNull();
    const closed = parseDevinTaskEvidence(devinTask('dv_20260928T2129_1d4itm', 'closed'))!;
    expect(closed).toMatchObject({ state: 'closed', hasPr: false, hasReport: false });
    const merged = parseDevinTaskEvidence(devinTask('dv_x', 'merged', {
      pr: { number: 4100, url: 'https://github.com/ashlrai/phantom/pull/4100', state: 'merged', draft: false, title: 't' },
    }))!;
    expect(merged.hasPr).toBe(true);
    const reported = parseDevinTaskEvidence(devinTask('dv_y', 'closed', {
      report: { status: 'done', summary: 's', testsRun: [], risks: [] },
    }))!;
    expect(reported.hasReport).toBe(true);
    expect(parseDevinTaskEvidence(devinTask('dv_z', 'merged', { pr: {} }))!.hasPr).toBe(false);
  });
});

describe('readSessionAudit', () => {
  it('reports per-lane session counts, ages and sizes', async () => {
    const tasks = `${ASHLR}/devin/tasks`;
    const projects = `${HOME}/.claude/projects`;
    const slug = claudeSlug(`${WT}/RQ-OLD-1`);
    const report = await readSessionAudit(healthyDeps({
      entries: {
        [`${ASHLR}/devin`]: [dir('tasks'), file('budget.json')],
        [tasks]: [file('dv_20260928T2129_1d4itm.json'), file('dv_20261101T1200_abcdef.json')],
        [`${HOME}/.claude`]: [dir('projects'), file('.credentials.json'), file('settings.json')],
        [projects]: [dir(slug), dir('-Users-me-Downloads')],
        [`${projects}/${slug}`]: [file('sess-1.jsonl'), file('sess-2.jsonl')],
        [`${projects}/-Users-me-Downloads`]: [file('personal.jsonl')],
      },
      stats: {
        [tasks + '/dv_20260928T2129_1d4itm.json']: st(60, 4000),
        [tasks + '/dv_20261101T1200_abcdef.json']: st(45, 2000),
        [`${projects}/${slug}/sess-1.jsonl`]: st(50, 10_000),
        [`${projects}/${slug}/sess-2.jsonl`]: st(35, 5_000),
        [`${projects}/-Users-me-Downloads/personal.jsonl`]: st(500, 9_000),
      },
      files: {
        [tasks + '/dv_20260928T2129_1d4itm.json']: devinTask('dv_20260928T2129_1d4itm', 'closed', {
          report: { status: 'done', summary: 's', testsRun: [], risks: [] },
        }),
        [tasks + '/dv_20261101T1200_abcdef.json']: devinTask('dv_20261101T1200_abcdef', 'running'),
      },
    }, { rows: [launch('RQ-OLD-1', 90), finish('RQ-OLD-1', 80), outcome('RQ-OLD-1', 'MERGED', 70)] }));
    expect(report.schema).toBe(SESSION_AUDIT_SCHEMA);
    expect(report.readOnly).toBe(true);

    const devin = lane(report, 'devin')!;
    expect(devin.sessions).toBe(2);
    expect(devin.bytes).toBe(6000);
    // updatedAt (40d) outranks file mtime (60d/45d): the record is fresher than the file.
    expect(devin.oldestAgeDays).toBe(40);
    expect(devin.stores.map(s => s.store)).toEqual(['tasks']);
    // budget.json is never a session.
    expect(devin.sessions).toBe(2);

    const claude = lane(report, 'claude')!;
    expect(claude.sessions).toBe(3);
    expect(claude.bytes).toBe(24_000);
    expect(claude.published.sessions).toBe(2); // both wt-correlated, MERGED
    expect(claude.pruneable.sessions).toBe(2); // 50d and 35d >= 30d
    // The personal transcript is a session but has no job linkage.
    expect(claude.pruneable.bytes).toBe(15_000);

    expect(report.totals.sessions).toBe(5);
    expect(report.totals.pruneable.sessions).toBe(3); // 2 claude + 1 devin task-report
    expect(lane(report, 'codex-cmp')!.state).toBe('missing');
    expect(lane(report, 'codex-personal')!.state).toBe('missing');
  });

  it('lists prune-plan entries only for old sessions with published results', async () => {
    const tasks = `${ASHLR}/devin/tasks`;
    const projects = `${HOME}/.claude/projects`;
    const slug = claudeSlug(`${WT}/RQ-OLD-1`);
    const report = await readSessionAudit(healthyDeps({
      entries: {
        [`${ASHLR}/devin`]: [dir('tasks')],
        [tasks]: [file('dv_a.json'), file('dv_b.json'), file('dv_c.json'), file('dv_d.json')],
        [`${HOME}/.claude`]: [dir('projects')],
        [projects]: [dir(slug)],
        [`${projects}/${slug}`]: [file('old.jsonl'), file('young.jsonl')],
      },
      stats: {
        [tasks + '/dv_a.json']: st(60, 100),
        [tasks + '/dv_b.json']: st(60, 100),
        [tasks + '/dv_c.json']: st(60, 100),
        [tasks + '/dv_d.json']: st(60, 100),
        [`${projects}/${slug}/old.jsonl`]: st(50, 10_000),
        [`${projects}/${slug}/young.jsonl`]: st(5, 10_000),
      },
      files: {
        // terminal + pr -> eligible
        [tasks + '/dv_a.json']: devinTask('dv_a', 'merged', { pr: { number: 1, url: 'https://github.com/o/r/pull/1', state: 'merged', draft: false, title: 't' } }),
        // terminal + report -> eligible
        [tasks + '/dv_b.json']: devinTask('dv_b', 'failed', { report: { status: 'blocked', summary: 's', testsRun: [], risks: [] } }),
        // terminal, nothing published -> held
        [tasks + '/dv_c.json']: devinTask('dv_c', 'closed'),
        // still running -> resumable, never eligible
        [tasks + '/dv_d.json']: devinTask('dv_d', 'running', { pr: { number: 2, url: 'https://github.com/o/r/pull/2', state: 'open', draft: false, title: 't' } }),
      },
    }, {
      rows: [launch('RQ-OLD-1', 90), finish('RQ-OLD-1', 80), outcome('RQ-OLD-1', 'MERGED', 70)],
      wantPlan: true,
    }));
    const plan = report.prunePlan!;
    const paths = plan.entries.map(e => e.rel).sort();
    expect(paths).toEqual([
      'projects/-home-test-Projects-ashlrai-wt-RQ-OLD-1/old.jsonl',
      'tasks/dv_a.json', 'tasks/dv_b.json',
    ].sort());
    const old = plan.entries.find(e => e.rel.endsWith('old.jsonl'))!;
    expect(old).toMatchObject({ action: 'delete-file', job: 'RQ-OLD-1', evidence: 'merged', lane: 'claude' });
    const dvA = plan.entries.find(e => e.rel === 'tasks/dv_a.json')!;
    expect(dvA).toMatchObject({ evidence: 'task-pr', state: 'merged', provider: 'devin' });
    // young.jsonl is fresh, dv_c has no result, dv_d is still resumable.
    expect(plan.count).toBe(3);
    expect(plan.bytes).toBe(10_200);
  });

  it('correlates codex rollouts via session_meta cwd, reading heads only for aged files', async () => {
    const codex = `${HOME}/.codex`;
    const dayDir = `${codex}/sessions/2026/09/10`;
    const heads: string[] = [];
    const base = healthyDeps({
      entries: {
        [codex]: [dir('sessions'), file('auth.json'), file('config.toml')],
        [`${codex}/sessions`]: [dir('2026')],
        [`${codex}/sessions/2026`]: [dir('09'), dir('11')],
        [`${codex}/sessions/2026/09`]: [dir('10'), dir('11')],
        [`${codex}/sessions/2026/11`]: [dir('05')],
        [dayDir]: [file('rollout-2026-09-10T12-00-00-t1.jsonl'), file('rollout-2026-09-11T00-00-00-t3.jsonl')],
        [`${codex}/sessions/2026/11/05`]: [file('rollout-2026-11-05T00-00-00-t2.jsonl')],
      },
      stats: {
        [`${dayDir}/rollout-2026-09-10T12-00-00-t1.jsonl`]: st(59, 8000),
        [`${codex}/sessions/2026/11/05/rollout-2026-11-05T00-00-00-t2.jsonl`]: st(3, 9000),
        [`${dayDir}/rollout-2026-09-11T00-00-00-t3.jsonl`]: st(58, 7000),
      },
      files: {
        [`${dayDir}/rollout-2026-09-10T12-00-00-t1.jsonl`]: codexRollout(`${WT}/RQ-CX-9`, 't1'),
        [`${codex}/sessions/2026/11/05/rollout-2026-11-05T00-00-00-t2.jsonl`]: codexRollout(`${WT}/RQ-CX-9`, 't2'),
        [`${dayDir}/rollout-2026-09-11T00-00-00-t3.jsonl`]: codexRollout(`${HOME}/personal/dir`, 't3'),
      },
    }, {
      rows: [launch('RQ-CX-9', 90), finish('RQ-CX-9', 80), publish('RQ-CX-9', 'pr', 75, 'https://github.com/o/r/pull/9')],
      wantPlan: true,
    });
    const fs = base.fs!;
    base.fs = {
      ...fs,
      head: async (path, max) => { heads.push(path); return fs.head(path, max); },
    };
    const report = await readSessionAudit(base);
    const cmp = lane(report, 'codex-cmp')!;
    expect(cmp.sessions).toBe(3);
    expect(cmp.bytes).toBe(24_000);
    // Heads are only opened for sessions old enough to prune.
    expect(heads.map(h => h.split('/').pop()!)).toEqual([
      'rollout-2026-09-10T12-00-00-t1.jsonl', 'rollout-2026-09-11T00-00-00-t3.jsonl',
    ]);
    // t1's job published RESULT PR -> pruneable; t3's cwd is not a job
    // worktree -> never eligible; t2 is fresh and never opened.
    const plan = report.prunePlan!;
    expect(plan.count).toBe(1);
    expect(plan.entries[0]).toMatchObject({ job: 'RQ-CX-9', evidence: 'published-pr', rel: 'sessions/2026/09/10/rollout-2026-09-10T12-00-00-t1.jsonl' });
    // auth.json / config.toml are never session entries.
    expect(cmp.sessions).toBe(3);
  });

  it('scans grok session dirs and decodes the percent-encoded cwd', async () => {
    const native = `${PROFILES}/grok-a/native-state`;
    const enc = encodeURIComponent(`${WT}/RQ-GK-3`);
    const sessionDir = `${native}/sessions/${enc}/sess-uuid-1`;
    const report = await readSessionAudit(healthyDeps({
      entries: {
        [PROFILES]: [dir('grok-a'), dir('grok-a-recovery-20261011')],
        [`${PROFILES}/grok-a`]: [dir('native-state'), file('profile.json'), file('launcher.mjs')],
        [`${PROFILES}/grok-a-recovery-20261011`]: [dir('native-state')],
        [native]: [dir('sessions'), file('auth.json')],
        [`${native}/sessions`]: [dir(enc)],
        [`${native}/sessions/${enc}`]: [dir('sess-uuid-1'), file('prompt_history.jsonl')],
        [sessionDir]: [file('summary.json'), file('transcript.jsonl')],
        [`${sessionDir}`]: [file('summary.json'), file('transcript.jsonl')],
      },
      stats: {
        [sessionDir]: st(50, 0, true),
        [`${sessionDir}/summary.json`]: st(50, 500),
        [`${sessionDir}/transcript.jsonl`]: st(50, 5000),
      },
      files: {
        [`${PROFILES}/grok-a/profile.json`]: JSON.stringify({
          schemaVersion: 1, provider: 'grok', directory: `${PROFILES}/grok-a`,
          nativeStatePath: native,
        }),
      },
    }, {
      rows: [launch('RQ-GK-3', 90), finish('RQ-GK-3', 80, true)],
      wantPlan: true,
    }));
    const grok = lane(report, 'grok-a')!;
    expect(grok.provider).toBe('grok');
    expect(grok.sessions).toBe(1);
    expect(grok.bytes).toBe(5500);
    expect(report.prunePlan!.count).toBe(1);
    expect(report.prunePlan!.entries[0]).toMatchObject({
      kind: 'session-dir', action: 'delete-dir', job: 'RQ-GK-3', evidence: 'finished-empty', lane: 'grok-a',
    });
    // The recovery copy is never treated as a lane.
    expect(lane(report, 'grok-a-recovery-20261011')).toBeUndefined();
  });

  it('scans a codex native-profile seat and refuses manifests pointing elsewhere', async () => {
    const native = `${PROFILES}/codex-a/native-state`;
    const dayDir = `${native}/sessions/2026/08/15`;
    const report = await readSessionAudit(healthyDeps({
      entries: {
        [PROFILES]: [dir('codex-a'), dir('rogue')],
        [`${PROFILES}/codex-a`]: [dir('native-state'), file('profile.json')],
        [native]: [dir('sessions')],
        [`${native}/sessions`]: [dir('2026')],
        [`${native}/sessions/2026`]: [dir('08')],
        [`${native}/sessions/2026/08`]: [dir('15')],
        [dayDir]: [file('rollout-2026-08-15T00-00-00-tx.jsonl')],
        [`${PROFILES}/rogue`]: [dir('native-state'), file('profile.json')],
      },
      stats: { [`${dayDir}/rollout-2026-08-15T00-00-00-tx.jsonl`]: st(85, 3000) },
      files: {
        [`${PROFILES}/codex-a/profile.json`]: JSON.stringify({
          schemaVersion: 1, provider: 'codex', directory: `${PROFILES}/codex-a`, nativeStatePath: native,
        }),
        // A manifest whose native-state names a different tree is refused.
        [`${PROFILES}/rogue/profile.json`]: JSON.stringify({
          schemaVersion: 1, provider: 'codex', directory: `${PROFILES}/rogue`, nativeStatePath: `${HOME}/elsewhere`,
        }),
        [`${dayDir}/rollout-2026-08-15T00-00-00-tx.jsonl`]: codexRollout(`${WT}/RQ-CX-A`),
      },
    }, { rows: [launch('RQ-CX-A', 90), finish('RQ-CX-A', 80), outcome('RQ-CX-A', 'MERGED', 70)], wantPlan: true }));
    const seat = lane(report, 'codex-a')!;
    expect(seat.source).toBe('profile');
    expect(seat.provider).toBe('codex');
    expect(seat.sessions).toBe(1);
    expect(report.prunePlan!.entries[0]).toMatchObject({ lane: 'codex-a', job: 'RQ-CX-A', evidence: 'merged' });
    expect(lane(report, 'rogue')).toBeUndefined();
  });

  it('never lists a CLI session when the jobs ledger is unreadable', async () => {
    const projects = `${HOME}/.claude/projects`;
    const slug = claudeSlug(`${WT}/RQ-OLD-1`);
    const report = await readSessionAudit(healthyDeps({
      entries: {
        [`${HOME}/.claude`]: [dir('projects')],
        [projects]: [dir(slug)],
        [`${projects}/${slug}`]: [file('old.jsonl')],
      },
      stats: { [`${projects}/${slug}/old.jsonl`]: st(50, 10_000) },
    }, { jobsState: 'degraded', wantPlan: true }));
    expect(report.sources.jobs).toBe('degraded');
    expect(report.prunePlan!.count).toBe(0);
    expect(lane(report, 'claude')!.pruneable.sessions).toBe(0);
  });

  it('a relaunched job loses its old outcome evidence', async () => {
    const projects = `${HOME}/.claude/projects`;
    const slug = claudeSlug(`${WT}/RQ-REL-1`);
    const report = await readSessionAudit(healthyDeps({
      entries: {
        [`${HOME}/.claude`]: [dir('projects')],
        [projects]: [dir(slug)],
        [`${projects}/${slug}`]: [file('t.jsonl')],
      },
      stats: { [`${projects}/${slug}/t.jsonl`]: st(60, 500) },
    }, {
      rows: [launch('RQ-REL-1', 100), finish('RQ-REL-1', 90), outcome('RQ-REL-1', 'MERGED', 85), launch('RQ-REL-1', 70)],
      wantPlan: true,
    }));
    expect(report.prunePlan!.count).toBe(0);
  });

  it('missing homes report state missing and degrade nothing', async () => {
    const report = await readSessionAudit(healthyDeps({}));
    expect(report.totals.sessions).toBe(0);
    expect(report.totals.lanes).toBe(4); // devin, codex-cmp, claude, codex-personal
    expect(report.lanes.every(l => l.state === 'missing')).toBe(true);
    expect(report.sources.profiles).toBe('healthy');
  });

  it('dedupes a pool home that is also a native-profile seat', async () => {
    const codex = `${HOME}/.codex`;
    const dayDir = `${codex}/sessions/2026/09/01`;
    const report = await readSessionAudit(healthyDeps({
      entries: {
        [PROFILES]: [dir('codex-cmp')],
        [`${PROFILES}/codex-cmp`]: [dir('native-state'), file('profile.json')],
        [codex]: [dir('sessions')],
        [`${codex}/sessions`]: [dir('2026')],
        [`${codex}/sessions/2026`]: [dir('09')],
        [`${codex}/sessions/2026/09`]: [dir('01')],
        [dayDir]: [file('rollout-2026-09-01T00-00-00-t.jsonl')],
      },
      stats: { [`${dayDir}/rollout-2026-09-01T00-00-00-t.jsonl`]: st(60, 100) },
      files: {
        // The profile's native-state IS the pool home.
        [`${PROFILES}/codex-cmp/profile.json`]: JSON.stringify({
          schemaVersion: 1, provider: 'codex', directory: `${PROFILES}/codex-cmp`, nativeStatePath: codex,
        }),
      },
    }));
    expect(lane(report, 'codex-cmp')!.sessions).toBe(1);
    expect(report.totals.sessions).toBe(1);
    expect(report.lanes.filter(l => l.home === codex)).toHaveLength(1);
  });

  it('--older-than-days rescales the gate', async () => {
    const tasks = `${ASHLR}/devin/tasks`;
    const report = await readSessionAudit(healthyDeps({
      entries: {
        [`${ASHLR}/devin`]: [dir('tasks')],
        [tasks]: [file('dv_old.json'), file('dv_new.json')],
      },
      stats: {
        [tasks + '/dv_old.json']: st(90, 100),
        [tasks + '/dv_new.json']: st(45, 100),
      },
      files: {
        [tasks + '/dv_old.json']: devinTask('dv_old', 'merged', { pr: { number: 1, url: 'https://github.com/o/r/pull/1', state: 'merged', draft: false, title: 't' }, updatedDays: 85 }),
        [tasks + '/dv_new.json']: devinTask('dv_new', 'merged', { pr: { number: 2, url: 'https://github.com/o/r/pull/2', state: 'merged', draft: false, title: 't' } }),
      },
    }, { wantPlan: true, olderThanDays: 60 }));
    expect(report.prunePlan!.count).toBe(1);
    expect(report.prunePlan!.entries[0]!.rel).toBe('tasks/dv_old.json');
    expect(report.olderThanDays).toBe(60);
  });

  it('a devin record whose updatedAt is newer than the file stays young', async () => {
    const tasks = `${ASHLR}/devin/tasks`;
    const report = await readSessionAudit(healthyDeps({
      entries: {
        [`${ASHLR}/devin`]: [dir('tasks')],
        [tasks]: [file('dv_touched.json')],
      },
      stats: { [tasks + '/dv_touched.json']: st(90, 100) },
      files: {
        // File mtime is old but the record says it was updated yesterday.
        [tasks + '/dv_touched.json']: devinTask('dv_touched', 'merged', {
          pr: { number: 1, url: 'https://github.com/o/r/pull/1', state: 'merged', draft: false, title: 't' },
          updatedDays: 1,
        }),
      },
    }, { wantPlan: true }));
    expect(report.prunePlan!.count).toBe(0);
  });

  it('marks the lane degraded when a session listing fails', async () => {
    const projects = `${HOME}/.claude/projects`;
    const report = await readSessionAudit(healthyDeps({
      entries: {
        [`${HOME}/.claude`]: [dir('projects')],
        [projects]: [dir('-x')],
        [`${projects}/-x`]: 'degraded', // unreadable listing
      },
    }));
    expect(lane(report, 'claude')!.state).toBe('degraded');
  });

  it('native-profiles unreadable still scans pool lanes', async () => {
    const tasks = `${ASHLR}/devin/tasks`;
    const report = await readSessionAudit(healthyDeps({
      entries: {
        [PROFILES]: 'degraded',
        [`${ASHLR}/devin`]: [dir('tasks')],
        [tasks]: [file('dv_a.json')],
      },
      stats: { [tasks + '/dv_a.json']: st(60, 100) },
      files: { [tasks + '/dv_a.json']: devinTask('dv_a', 'closed', { report: { status: 'done', summary: 's', testsRun: [], risks: [] } }) },
    }, { wantPlan: true }));
    expect(report.sources.profiles).toBe('degraded');
    expect(lane(report, 'devin')!.sessions).toBe(1);
    expect(report.prunePlan!.count).toBe(1);
  });
});

describe('cmdFleetSessionAudit', () => {
  const run = async (args: string[], spec: FakeSpec, options: FakeOptions = {}) => {
    const logs: string[] = [];
    const errors: string[] = [];
    const code = await cmdFleetSessionAudit(args, {
      ...healthyDeps(spec, options),
      output: { log: m => logs.push(m), error: m => errors.push(m) },
    });
    return { code, logs, errors };
  };

  it('--help prints usage and exits 0', async () => {
    const { code, logs } = await run(['--help'], {});
    expect(code).toBe(0);
    expect(logs[0]).toMatch(/^Usage: phm fleet session-audit/);
  });

  it('rejects unknown, duplicate and non-absolute options', async () => {
    expect((await run(['--bogus'], {})).code).toBe(2);
    expect((await run(['--json', '--json'], {})).code).toBe(2);
    expect((await run(['--wt-dir', 'relative/path'], {})).code).toBe(2);
    expect((await run(['--older-than-days', 'nope'], {})).code).toBe(2);
    expect((await run(['--older-than-days', '0'], {})).code).toBe(2);
    expect((await run(['positional'], {})).code).toBe(2);
  });

  it('--json prints the report with home paths redacted to ~', async () => {
    const tasks = `${ASHLR}/devin/tasks`;
    const { code, logs } = await run(['--json'], {
      entries: {
        [`${ASHLR}/devin`]: [dir('tasks')],
        [tasks]: [file('dv_a.json')],
      },
      stats: { [tasks + '/dv_a.json']: st(60, 100) },
      files: { [tasks + '/dv_a.json']: devinTask('dv_a', 'closed') },
    });
    expect(code).toBe(0);
    const report = JSON.parse(logs[0]!);
    expect(report.schema).toBe(SESSION_AUDIT_SCHEMA);
    // sanitizePublicJson collapses this user's real home only; the fake
    // /home/test survives unchanged.
    expect(report.lanes.find((l: { lane: string }) => l.lane === 'devin').home).toBe(`${ASHLR}/devin`);
  });

  it('human output lists lanes and the pruneable summary', async () => {
    const tasks = `${ASHLR}/devin/tasks`;
    const { code, logs } = await run([], {
      entries: {
        [`${ASHLR}/devin`]: [dir('tasks')],
        [tasks]: [file('dv_a.json')],
      },
      stats: { [tasks + '/dv_a.json']: st(60, 100) },
      files: { [tasks + '/dv_a.json']: devinTask('dv_a', 'closed', { report: { status: 'done', summary: 's', testsRun: [], risks: [] } }) },
    });
    expect(code).toBe(0);
    expect(logs[0]).toMatch(/reads only, deletes nothing/);
    expect(logs.join('\n')).toMatch(/devin \(devin\): 1 sessions/);
    expect(logs.join('\n')).toMatch(/pruneable now: 1 sessions.*--prune-plan/);
  });

  it('--prune-plan prints only eligible sessions', async () => {
    const tasks = `${ASHLR}/devin/tasks`;
    const { code, logs } = await run(['--prune-plan', '--older-than-days', '30'], {
      entries: {
        [`${ASHLR}/devin`]: [dir('tasks')],
        [tasks]: [file('dv_a.json'), file('dv_b.json')],
      },
      stats: { [tasks + '/dv_a.json']: st(60, 100), [tasks + '/dv_b.json']: st(60, 100) },
      files: {
        [tasks + '/dv_a.json']: devinTask('dv_a', 'closed', { report: { status: 'done', summary: 's', testsRun: [], risks: [] } }),
        [tasks + '/dv_b.json']: devinTask('dv_b', 'closed'),
      },
    });
    expect(code).toBe(0);
    const text = logs.join('\n');
    expect(text).toMatch(/tasks\/dv_a\.json: delete-file.*evidence task-report/);
    expect(text).not.toMatch(/dv_b\.json: delete-file/);
    expect(text).toMatch(/total: 1 session/);
  });

  it('exits 1 when the native-profiles root cannot be listed', async () => {
    const { code } = await run(['--json'], { entries: { [PROFILES]: 'degraded' } });
    expect(code).toBe(1);
  });
});

describe('format helpers', () => {
  it('formatSessionAudit / formatSessionPrunePlan stay pure and bounded', async () => {
    const report = await readSessionAudit(healthyDeps({}, { wantPlan: true }));
    expect(formatSessionAudit(report)[0]).toMatch(/deletes nothing/);
    expect(formatSessionPrunePlan(report).join('\n')).toMatch(/no session is provably safe/);
  });
});
