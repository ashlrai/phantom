/**
 * report-export.ts — the deterministic twice-daily EO report builder
 * (RQ-REPORTS-NO-GROK-1). Mason's Nov 9 02:14 ET order: the 7:30 AM and
 * 8:00 PM ET reports must not depend on Grok. This module builds
 * ~/.ashlr-runs/export/report-0730.md and report-2000.md from recorded state
 * only — the world model, the jobs ledger, the leader's in-force intents and
 * a bounded `gh run list` evidence read. No model call anywhere: when every
 * relay is down, the files remain the source of truth.
 *
 * Slots are named for the read times (07:30 / 20:00 ET); the dispatcher fires
 * the build five minutes early (07:25 / 19:55). A report embeds a
 * `day=YYYY-MM-DD` marker in America/New_York so rebuilds are idempotent per
 * local day unless forced.
 *
 * Every field degrades on its own: a missing world snapshot, a truncated
 * ledger, an absent `gh` or an unreadable intents store produces an explicit
 * 'unavailable'/'incomplete' line, never a zero. All rendered text passes
 * through scrubSecrets; no tokens, chat ids or addresses can appear.
 */

import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { listGoalsDetailed, type ListGoalsDetailedResult } from '../goals/store.js';
import { summarizeOpenGoals } from '../goals/open-goals.js';
import { listProposalsDetailed, type ProposalsReadResult } from '../inbox/store.js';
import { scrubSecrets } from '../util/scrub.js';
import { defaultGitRunner, type GitRunner } from '../verse/git-ops.js';
import { ensurePrivateDirectory, readPrivateFileCapped, writePrivateFileAtomic } from '../verse/preferences.js';
import { listOperatorDirectives } from '../vision/leader-operator.js';
import { listSelfDirectives } from '../vision/leader-powers.js';
import { readWorldModel } from '../world/read.js';
import type { Field, WorldModel } from '../world/types.js';
import { readFleetQueue, type FleetQueueV1 } from './runs-parked-queue.js';

export const REPORT_EXPORT_SCHEMA = 'ashlr.report-export/v1' as const;
export const REPORT_SLOTS = ['0730', '2000'] as const;
export type ReportSlot = (typeof REPORT_SLOTS)[number];
/** Build times (America/New_York) and the read-time label the file is named for. */
export const REPORT_SLOT_TIMES: Readonly<Record<ReportSlot, { buildHour: number; buildMinute: number; label: string }>> = {
  '0730': { buildHour: 7, buildMinute: 25, label: '07:30' },
  '2000': { buildHour: 19, buildMinute: 55, label: '20:00' },
};
const REPORT_TZ = 'America/New_York';
/** Both slots read the same trailing window, matching the leader brief's 12 h. */
export const REPORT_WINDOW_MS = 12 * 3_600_000;

const JOBS_TAIL_BYTES = 2 * 1024 * 1024;
const REPORT_READ_BYTES = 8 * 1024;
const REPORT_MAX_ITEMS = 12;
const MAX_ACTION_REPOS = 4;
const MAX_ACTION_RUNS_PER_REPO = 3;
const GH_TIMEOUT_MS = 20_000;
const GH_MAX_STDOUT = 256 * 1024;
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const REPO_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const GH_PR_URL = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9][0-9]*\/?$/i;
const GH_RUN_URL = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/runs\/[1-9][0-9]*\/?$/i;
const MARKER = /^<!--\s*ashlr\.report-export\/v1\s+slot=(\d{4})\s+day=(\d{4}-\d{2}-\d{2})\s*-->/;

// ---------------------------------------------------------------------------
// Slot math (America/New_York)
// ---------------------------------------------------------------------------

const ET_FORMAT = new Intl.DateTimeFormat('en-CA', {
  timeZone: REPORT_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

/** The local day and minutes-after-midnight in America/New_York for `now`. */
export function reportClockEt(now: Date): { day: string; minutes: number } {
  const parts = ET_FORMAT.formatToParts(now);
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';
  const hour = Number(get('hour'));
  const minute = Number(get('minute'));
  return {
    day: `${get('year')}-${get('month')}-${get('day')}`,
    minutes: (Number.isFinite(hour) ? hour : 0) * 60 + (Number.isFinite(minute) ? minute : 0),
  };
}

/** Slots whose ET build time has already passed today, in order. */
export function dueReportSlots(now: Date): ReportSlot[] {
  const { minutes } = reportClockEt(now);
  return REPORT_SLOTS.filter((slot) => {
    const at = REPORT_SLOT_TIMES[slot];
    return minutes >= at.buildHour * 60 + at.buildMinute;
  });
}

export function reportPath(runsDir: string, slot: ReportSlot): string {
  return join(runsDir, 'export', `report-${slot}.md`);
}

/** The ET day a built report covers, from its marker comment; null when absent. */
export function reportMarkerDay(content: string): string | null {
  const match = MARKER.exec(content.split('\n', 3).join('\n'));
  return match?.[2] ?? null;
}

// ---------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------

export interface ReportLedgerRow {
  job: string;
  lane: string | null;
  url: string | null;
  at: string | null;
  ttmSeconds: number | null;
}

export interface ReportGrowth {
  windowHours: number;
  /** 'incomplete' when the retained ledger tail does not reach the window start. */
  ledger: 'available' | 'unavailable' | 'incomplete';
  launches: number;
  finishes: number;
  empty: number;
  publishes: number;
  merges: number;
  tokens: number;
  byLane: Array<{ lane: string; launches: number; finishes: number; merges: number }>;
  published: ReportLedgerRow[];
  merged: ReportLedgerRow[];
}

export interface ReportActionsRuns {
  status: 'ok' | 'unavailable';
  reason: string | null;
  runs: Array<{ repo: string; id: number; url: string | null; conclusion: string | null; title: string | null }>;
}

export interface ReportIntents {
  operatorDirectives: Array<{ id: string; kind: string; text: string }>;
  selfDirectives: Array<{ id: string; text: string }>;
  goals: { open: number; total: number; complete: boolean; unreadable: number | null; titles: string[] } | null;
  pendingProposals: { complete: boolean; items: Array<{ id: string; title: string }> } | null;
  /** Per-lane queue rows the dispatcher will run next. */
  queueNextUp: Array<{ lane: string; jobs: string[] }> | null;
}

export interface ReportFacts {
  schema: typeof REPORT_EXPORT_SCHEMA;
  slot: ReportSlot;
  day: string;
  generatedAt: string;
  world: WorldModel | null;
  growth: ReportGrowth;
  actionsRuns: ReportActionsRuns;
  intents: ReportIntents;
}

export interface ReportFactsDeps {
  world?: () => Promise<WorldModel>;
  jobsText?: () => Promise<{ text: string | null; truncated: boolean }>;
  queue?: () => Promise<FleetQueueV1>;
  goals?: () => ListGoalsDetailedResult;
  proposals?: () => ProposalsReadResult;
  operatorDirectives?: () => Array<{ id: string; kind: string; text: string }>;
  selfDirectives?: () => Array<{ id: string; text: string }>;
  gh?: GitRunner;
}

/**
 * One ledger row's event time (ms). dispatchd stamps ISO strings with `+0000`
 * offsets and `Z`; naive strings read as UTC. Unparseable → NaN.
 */
function rowTs(row: Record<string, unknown>): number {
  const raw = row['ts'] ?? row['timestamp'] ?? row['at'];
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw !== 'string') return Number.NaN;
  const trimmed = raw.trim();
  if (!trimmed) return Number.NaN;
  const withZone = trimmed.replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  const parsed = Date.parse(withZone);
  if (Number.isFinite(parsed)) return parsed;
  return Date.parse(`${trimmed}Z`);
}

function rowJob(row: Record<string, unknown>): string | null {
  const value = row['job'] ?? row['job_id'] ?? row['jobId'] ?? row['id'];
  return typeof value === 'string' && JOB_ID.test(value) ? value : null;
}

function rowUrl(row: Record<string, unknown>): string | null {
  const value = row['url'] ?? row['prUrl'] ?? row['pr_url'] ?? row['pr'];
  return typeof value === 'string' && GH_PR_URL.test(value.trim()) ? value.trim().replace(/\/$/, '') : null;
}

function pick(row: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

/** Fold the bounded jobs-ledger tail into windowed growth. Never throws. */
export function summarizeJobsLedger(text: string, truncated: boolean, nowMs: number, windowMs = REPORT_WINDOW_MS): ReportGrowth {
  const growth: ReportGrowth = {
    windowHours: Math.round(windowMs / 3_600_000),
    ledger: 'available',
    launches: 0, finishes: 0, empty: 0, publishes: 0, merges: 0, tokens: 0,
    byLane: [], published: [], merged: [],
  };
  const since = nowMs - windowMs;
  const lanes = new Map<string, { launches: number; finishes: number; merges: number }>();
  const published = new Map<string, ReportLedgerRow>();
  const merged = new Map<string, ReportLedgerRow>();
  let sawAny = false;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let row: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue;
      row = parsed as Record<string, unknown>;
    } catch { continue; }
    const ts = rowTs(row);
    if (!Number.isFinite(ts) || ts < since || ts > nowMs + 86_400_000) continue;
    sawAny = true;
    const event = typeof row['event'] === 'string' ? row['event'] : typeof row['type'] === 'string' ? row['type'] : null;
    const job = rowJob(row) ?? 'unknown';
    const lane = pick(row, ['lane', 'actualLane', 'pool']);
    const at = pick(row, ['ts', 'timestamp', 'at']);
    if (event === 'launch') {
      growth.launches += 1;
      const entry = lanes.get(lane ?? 'unknown') ?? { launches: 0, finishes: 0, merges: 0 };
      entry.launches += 1;
      lanes.set(lane ?? 'unknown', entry);
    } else if (event === 'finish') {
      growth.finishes += 1;
      if (row['empty'] === true) growth.empty += 1;
      const tokens = row['tokens_total'] ?? row['tokens'];
      if (typeof tokens === 'number' && Number.isFinite(tokens) && tokens > 0) growth.tokens += tokens;
      const entry = lanes.get(lane ?? 'unknown') ?? { launches: 0, finishes: 0, merges: 0 };
      entry.finishes += 1;
      lanes.set(lane ?? 'unknown', entry);
    } else if (event === 'publish') {
      growth.publishes += 1;
      const url = rowUrl(row);
      if (url && !published.has(url)) published.set(url, { job, lane, url, at, ttmSeconds: null });
    } else if (event === 'outcome' || event === 'pr-merge') {
      const state = pick(row, ['state', 'outcome', 'status'])?.toUpperCase();
      if (state !== 'MERGED') continue;
      growth.merges += 1;
      const entry = lanes.get(lane ?? 'unknown') ?? { launches: 0, finishes: 0, merges: 0 };
      entry.merges += 1;
      lanes.set(lane ?? 'unknown', entry);
      const url = rowUrl(row);
      const ttm = row['ttm_s'];
      const key = url ?? job;
      if (!merged.has(key)) {
        merged.set(key, {
          job, lane, url,
          at: pick(row, ['mergedAt', 'merged_at', 'ts', 'timestamp', 'at']),
          ttmSeconds: typeof ttm === 'number' && Number.isFinite(ttm) && ttm >= 0 ? ttm : null,
        });
      }
    }
  }
  if (!sawAny) growth.ledger = text.trim() ? 'incomplete' : 'unavailable';
  else if (truncated) growth.ledger = 'incomplete';
  growth.byLane = [...lanes.entries()].map(([lane, counts]) => ({ lane, ...counts }))
    .sort((a, b) => b.merges - a.merges || b.launches - a.launches || a.lane.localeCompare(b.lane));
  growth.published = [...published.values()].sort((a, b) => (b.at ?? '').localeCompare(a.at ?? '')).slice(0, REPORT_MAX_ITEMS);
  growth.merged = [...merged.values()].sort((a, b) => (b.at ?? '').localeCompare(a.at ?? '')).slice(0, REPORT_MAX_ITEMS);
  return growth;
}

/** Last JOBS_TAIL_BYTES of the ledger, first partial line dropped. */
async function readJobsTail(path: string): Promise<{ text: string | null; truncated: boolean }> {
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await file.stat();
      if (!info.isFile()) return { text: null, truncated: false };
      const start = Math.max(0, info.size - JOBS_TAIL_BYTES);
      const bytes = Buffer.alloc(info.size - start);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, start + offset);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      const text = bytes.subarray(0, offset).toString('utf8');
      return { text: start ? text.slice(text.indexOf('\n') < 0 ? text.length : text.indexOf('\n') + 1) : text, truncated: start > 0 };
    } finally { await file.close(); }
  } catch { return { text: null, truncated: false }; }
}

/** Bounded `gh run list` evidence per measured repo. Fails closed per repo, never throws. */
async function readActionsRuns(repos: readonly string[], gh: GitRunner): Promise<ReportActionsRuns> {
  const targets = [...new Set(repos)].filter((repo) => REPO_NAME.test(repo)).slice(0, MAX_ACTION_REPOS);
  if (targets.length === 0) return { status: 'unavailable', reason: 'no measured repos', runs: [] };
  const runs: ReportActionsRuns['runs'] = [];
  let failures = 0;
  let lastError: string | null = null;
  for (const repo of targets) {
    try {
      const result = await gh('gh', [
        'run', 'list', '--repo', repo, '--limit', String(MAX_ACTION_RUNS_PER_REPO),
        '--json', 'databaseId,url,displayTitle,conclusion,createdAt',
      ], { cwd: tmpdir(), timeoutMs: GH_TIMEOUT_MS, maxStdoutBytes: GH_MAX_STDOUT });
      if (result.missing || result.timedOut || result.code !== 0) {
        failures += 1;
        lastError = result.missing ? 'gh not installed' : result.timedOut ? 'gh timed out' : 'gh exited nonzero';
        continue;
      }
      const parsed: unknown = JSON.parse(result.stdout);
      if (!Array.isArray(parsed)) { failures += 1; lastError = 'unparseable gh output'; continue; }
      for (const entry of parsed) {
        if (typeof entry !== 'object' || entry === null) continue;
        const row = entry as Record<string, unknown>;
        const id = row['databaseId'];
        if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) continue;
        const url = typeof row['url'] === 'string' && GH_RUN_URL.test(row['url'].trim()) ? row['url'].trim().replace(/\/$/, '') : null;
        runs.push({
          repo, id, url,
          conclusion: pick(row, ['conclusion'])?.slice(0, 40) ?? null,
          title: pick(row, ['displayTitle']) ? scrubSecrets(row['displayTitle'] as string).slice(0, 120) : null,
        });
      }
    } catch {
      failures += 1;
      lastError = 'gh failed';
    }
  }
  if (runs.length === 0 && failures > 0) return { status: 'unavailable', reason: lastError, runs: [] };
  return { status: 'ok', reason: failures > 0 ? `${failures} repo(s) unavailable` : null, runs: runs.slice(0, REPORT_MAX_ITEMS) };
}

/**
 * Assemble the facts; every source is independently guarded. Exported so the
 * CLI and tests share one composition path.
 */
export async function gatherReportFacts(slot: ReportSlot, runsDir: string, opts: { now?: Date; deps?: ReportFactsDeps } = {}): Promise<ReportFacts> {
  const now = opts.now ?? new Date();
  const deps = opts.deps ?? {};
  const { day } = reportClockEt(now);

  const world = await (async () => {
    try { return await (deps.world ?? (() => readWorldModel()))(); } catch { return null; }
  })();

  const jobs = await (async () => {
    try {
      const read = deps.jobsText ?? (() => readJobsTail(join(runsDir, 'metrics', 'jobs.jsonl')));
      return await read();
    } catch { return { text: null, truncated: false }; }
  })();
  const growth: ReportGrowth = jobs.text === null
    ? {
      windowHours: Math.round(REPORT_WINDOW_MS / 3_600_000), ledger: 'unavailable',
      launches: 0, finishes: 0, empty: 0, publishes: 0, merges: 0, tokens: 0,
      byLane: [], published: [], merged: [],
    }
    : summarizeJobsLedger(jobs.text, jobs.truncated, now.getTime());

  const queue = await (async () => {
    try { return await (deps.queue ?? (() => readFleetQueue({ runsDir })))(); } catch { return null; }
  })();

  const goals = (() => {
    try { return (deps.goals ?? (() => listGoalsDetailed()))(); } catch { return null; }
  })();

  const proposals = (() => {
    try { return (deps.proposals ?? (() => listProposalsDetailed({ status: 'pending' })))(); } catch { return null; }
  })();

  const readDirectives = <T>(read: (() => T[]) | undefined, fallback: () => T[], cap: number, map: (item: T) => { id: string; text: string }): Array<{ id: string; text: string }> => {
    try { return (read ?? fallback)().slice(0, cap).map(map); } catch { return []; }
  };

  const intents: ReportIntents = {
    operatorDirectives: (() => {
      try {
        const rows = (deps.operatorDirectives ?? (() => listOperatorDirectives()))();
        return rows.slice(0, REPORT_MAX_ITEMS).map((d) => ({ id: d.id, kind: d.kind, text: scrubSecrets(d.text).slice(0, 200) }));
      } catch { return []; }
    })(),
    selfDirectives: readDirectives(
      deps.selfDirectives, () => listSelfDirectives(), 6,
      (d) => ({ id: d.id, text: scrubSecrets(d.text).slice(0, 200) }),
    ),
    goals: goals === null ? null : (() => {
      const summary = summarizeOpenGoals({ goals: goals.goals, complete: goals.complete, unreadable: goals.unreadableFiles });
      return {
        open: summary.open, total: summary.total, complete: summary.complete,
        unreadable: summary.unreadable,
        titles: summary.openGoals.slice(0, 5).map((goal) => scrubSecrets(goal.objective).slice(0, 120)),
      };
    })(),
    pendingProposals: proposals === null ? null : {
      complete: proposals.complete,
      items: proposals.proposals.slice(0, 5).map((p) => ({ id: p.id, title: scrubSecrets(p.title).slice(0, 120) })),
    },
    queueNextUp: queue === null ? null
      : (queue.nextUp ?? []).slice(0, REPORT_MAX_ITEMS).map((row) => ({
        lane: row.lane, jobs: row.jobs.slice(0, 6).map((job) => scrubSecrets(job).slice(0, 80)),
      })),
  };

  // Evidence repos: the world model's measured repos first; when the snapshot
  // is absent the ledger's published PR urls still name the repos in play.
  const worldRepos = world?.outcomes.repos.map((repo) => repo.repo) ?? [];
  const ledgerRepos = [...growth.published, ...growth.merged]
    .map((row) => row.url?.match(/^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\//)?.[1])
    .filter((repo): repo is string => typeof repo === 'string');
  const actionsRuns = await readActionsRuns([...worldRepos, ...ledgerRepos], deps.gh ?? defaultGitRunner);

  return {
    schema: REPORT_EXPORT_SCHEMA,
    slot, day,
    generatedAt: now.toISOString(),
    world, growth, actionsRuns, intents,
  };
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function field<T>(f: Field<T>, suffix = ''): string {
  if (f.value === null) return `unknown (${f.freshness})`;
  return `${f.value}${suffix}${f.freshness === 'fresh' ? '' : `, ${f.freshness}`}`;
}

/** Render the markdown report. Pure — all inputs already gathered. */
export function renderReportMarkdown(facts: ReportFacts): string {
  const slotTime = REPORT_SLOT_TIMES[facts.slot];
  const lines: string[] = [
    `<!-- ${REPORT_EXPORT_SCHEMA} slot=${facts.slot} day=${facts.day} -->`,
    `# Fleet report — ${slotTime.label} ET · ${facts.day}`,
    '',
    `Deterministic build at ${facts.generatedAt}; no LLM and no Grok. When the relays`,
    'are down this file is the source of truth. Recorded events cover the trailing',
    `${facts.growth.windowHours} h; unknown readings are marked, never zero.`,
    '',
    '## World',
  ];
  const world = facts.world;
  if (world === null) {
    lines.push('', 'World model: unavailable (no snapshot could be read).');
  } else {
    lines.push(
      '',
      `Snapshot ${world.generatedAt} · cache ${world.cache.hit ? 'hit' : 'miss'} (${world.cache.ageMs} ms)`,
      '',
      '| lane | used/limit | remaining | burn/h | runway h | required pace/h |',
      '|------|-----------|-----------|--------|----------|-----------------|',
    );
    for (const lane of world.sensors.lanes) {
      lines.push(`| ${lane.lane} | ${field(lane.used)}/${field(lane.limit)} | ${field(lane.remaining)} | ${field(lane.burnRate)} | ${field(lane.runwayHours)} | ${field(lane.requiredPacePerHour)} |`);
    }
    lines.push(
      '',
      `Roster sessions: ${field(world.roster.sessions)} · live claims: ${field(world.claims.live)} · queue ready ${field(world.queue.ready)} / claimed ${field(world.queue.claimed)}`,
      `CI: ${field(world.ci.repos)} repo(s), median daily time-to-green ${field(world.ci.medianDailyTtgSeconds, ' s')} · releases: update check ${field(world.releases.updateCheck)} · train ${field(world.releases.train)}`,
      `Bottlenecks: ${field(world.bottlenecks.count)} · human steps remaining: ${field(world.humanSteps.remaining)}`,
    );
    if (world.outcomes.repos.length > 0) {
      lines.push('', 'Outcomes per repo:');
      for (const repo of world.outcomes.repos) {
        lines.push(`- ${repo.repo}: ${field(repo.mergedPerDay)} merged/day · change-failure ${field(repo.changeFailureRate)}`);
      }
    }
    if (world.blindSpots.length > 0) {
      lines.push('', `Blind spots (${world.blindSpots.length}):`);
      for (const spot of world.blindSpots.slice(0, 8)) {
        lines.push(`- ${spot.path}: ${scrubSecrets(spot.need).slice(0, 160)}`);
      }
    }
  }

  const growth = facts.growth;
  lines.push('', `## Growth (recorded, last ${growth.windowHours} h)`, '');
  if (growth.ledger === 'unavailable') {
    lines.push('Jobs ledger: unavailable (metrics/jobs.jsonl missing or unreadable).');
  } else {
    lines.push(
      `Launches ${growth.launches} · finishes ${growth.finishes} (empty ${growth.empty}) · publishes ${growth.publishes} · merges ${growth.merges} · tokens ${growth.tokens}`,
    );
    if (growth.ledger === 'incomplete') {
      lines.push('Ledger coverage incomplete: the retained tail does not reach the window start.');
    }
    for (const lane of growth.byLane) {
      lines.push(`- ${lane.lane}: ${lane.launches} launched, ${lane.finishes} finished, ${lane.merges} merged`);
    }
  }

  lines.push('', '## Evidence', '');
  const prs = new Map<string, { url: string; kind: 'merged' | 'published'; job: string; at: string | null }>();
  for (const row of growth.merged) {
    if (row.url && !prs.has(row.url)) prs.set(row.url, { url: row.url, kind: 'merged', job: row.job, at: row.at });
  }
  for (const row of growth.published) {
    if (row.url && !prs.has(row.url)) prs.set(row.url, { url: row.url, kind: 'published', job: row.job, at: row.at });
  }
  if (prs.size === 0) {
    lines.push('PRs: none recorded in the window (or the ledger was unavailable).');
  } else {
    lines.push('PRs:');
    for (const pr of [...prs.values()].slice(0, REPORT_MAX_ITEMS)) {
      lines.push(`- ${pr.url} — ${pr.kind} · ${pr.job}${pr.at ? ` · ${pr.at}` : ''}`);
    }
  }
  if (facts.actionsRuns.status === 'ok') {
    if (facts.actionsRuns.runs.length === 0) {
      lines.push('', 'Actions runs: none returned by gh run list.');
    } else {
      lines.push('', 'Actions runs:');
      for (const run of facts.actionsRuns.runs) {
        lines.push(`- ${run.repo} run ${run.id}${run.conclusion ? ` — ${run.conclusion}` : ''}${run.url ? ` · ${run.url}` : ''}${run.title ? ` · ${run.title}` : ''}`);
      }
    }
  } else {
    lines.push('', `Actions runs: unavailable (${facts.actionsRuns.reason ?? 'gh could not be read'}).`);
  }
  if (facts.actionsRuns.reason && facts.actionsRuns.status === 'ok') {
    lines.push(`(partial evidence: ${facts.actionsRuns.reason})`);
  }

  const intents = facts.intents;
  lines.push('', '## Intents', '');
  if (intents.operatorDirectives.length === 0) {
    lines.push('Operator directives: none in force (or store unreadable).');
  } else {
    lines.push('Operator directives (in force):');
    for (const d of intents.operatorDirectives) lines.push(`- [${d.kind}] ${d.text} (${d.id})`);
  }
  if (intents.selfDirectives.length > 0) {
    lines.push('', 'Leader self-directives:');
    for (const d of intents.selfDirectives) lines.push(`- ${d.text} (${d.id})`);
  }
  if (intents.goals === null) {
    lines.push('', 'Goals: unavailable (store read failed).');
  } else {
    const suffix = intents.goals.complete ? '' : ` · read incomplete${intents.goals.unreadable !== null ? ` (${intents.goals.unreadable} unreadable)` : ''}`;
    lines.push('', `Open goals: ${intents.goals.open} of ${intents.goals.total}${suffix}`);
    for (const title of intents.goals.titles) lines.push(`- ${title}`);
  }
  if (intents.pendingProposals === null) {
    lines.push('', 'Pending proposals: unavailable (inbox read failed).');
  } else {
    const suffix = intents.pendingProposals.complete ? '' : ' (incomplete read)';
    lines.push('', `Pending proposals: ${intents.pendingProposals.items.length}${suffix}`);
    for (const p of intents.pendingProposals.items) lines.push(`- ${p.title} (${p.id})`);
  }
  if (intents.queueNextUp === null) {
    lines.push('', 'Queue next-up: unavailable (queue projection unreadable).');
  } else if (intents.queueNextUp.length === 0) {
    lines.push('', 'Queue next-up: empty.');
  } else {
    lines.push('', 'Queue next-up:');
    for (const row of intents.queueNextUp) lines.push(`- ${row.lane}: ${row.jobs.join(', ')}`);
  }
  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

export type ReportWriteOutcome = 'wrote' | 'skipped' | 'failed';

export interface ReportWriteEntry {
  slot: ReportSlot;
  path: string;
  outcome: ReportWriteOutcome;
  /** 'already-built-today' or scrubbed error text. */
  reason: string | null;
  bytes: number | null;
}

export interface BuildScheduledReportsOptions {
  runsDir: string;
  /** 'auto' builds every slot due today not yet built; a slot name builds it now. */
  slot?: ReportSlot | 'auto';
  force?: boolean;
  now?: Date;
  deps?: ReportFactsDeps;
}

/**
 * Build the due reports under <runsDir>/export/. Idempotent per ET day unless
 * `force`. Never throws; per-slot failures land in the entry, not the caller.
 */
export async function buildScheduledReports(opts: BuildScheduledReportsOptions): Promise<{ schema: typeof REPORT_EXPORT_SCHEMA; day: string; entries: ReportWriteEntry[] }> {
  const now = opts.now ?? new Date();
  const { day } = reportClockEt(now);
  const wanted: ReportSlot[] = opts.slot === undefined || opts.slot === 'auto'
    ? dueReportSlots(now)
    : [opts.slot];
  const entries: ReportWriteEntry[] = [];
  for (const slot of wanted) {
    const path = reportPath(opts.runsDir, slot);
    const existing = readPrivateFileCapped(path, REPORT_READ_BYTES);
    const existingDay = existing === null || existing.truncated ? null : reportMarkerDay(existing.text);
    if (!opts.force && existingDay === day) {
      entries.push({ slot, path, outcome: 'skipped', reason: 'already-built-today', bytes: existing?.bytes ?? null });
      continue;
    }
    try {
      const facts = await gatherReportFacts(slot, opts.runsDir, { now, deps: opts.deps });
      const body = renderReportMarkdown(facts);
      ensurePrivateDirectory(join(opts.runsDir, 'export'));
      writePrivateFileAtomic(path, body);
      entries.push({ slot, path, outcome: 'wrote', reason: null, bytes: Buffer.byteLength(body) });
    } catch (err) {
      const reason = scrubSecrets(err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').slice(0, 200);
      entries.push({ slot, path, outcome: 'failed', reason, bytes: null });
    }
  }
  return { schema: REPORT_EXPORT_SCHEMA, day, entries };
}
