/**
 * runs-job-activity.ts — RQ-RADAR-DESKTOP-ACTIVITY: one searchable activity
 * stream per fleet job (`fleet.job.activity.v1`), served by
 * GET /api/fleet/job/activity?id=<JOB> on the loopback dashboard and rendered
 * by the desktop app's worker-log pane.
 *
 * The stream merges four guarded, independently-degrading sources into one
 * ordered entry list:
 *
 *   event     lifecycle rows for this job from the metrics ledger
 *             (<runsDir>/metrics/jobs.jsonl, bounded tail read) — queued,
 *             launch, finish, publish, outcome, backoff holds
 *   command   shell commands observed in the worker log's bounded scan
 *             window (scanJobLog — same lstat/no-follow/scrub rules as the
 *             job detail). Only lines that START with a known command verb
 *             or an explicit `$`/`›`/`❯` prompt are listed; prose is never
 *             promoted to a command.
 *   files     the job's changed files, projected by runs-job-changes.ts
 *             (one entry carrying the whole bounded list + totals)
 *   report    the worker's own reports — J.notes.md (fallback J.body.md)
 *             and J.prompt — text already scrubbed and byte-capped by
 *             runs-job-texts.ts, for inline Markdown rendering
 *
 * READ-ONLY GUARDRAILS (same contract as runs-job-detail.ts): bounded fs
 * reads only, lstat before every read, symlinks never followed, only the
 * whitelisted J.<suffix> files plus metrics/jobs.jsonl are ever opened, and
 * every text field is scrubbed before it leaves this module. A missing or
 * corrupt source degrades only its own slice — the stream never fabricates
 * entries and never throws on fs input.
 *
 * ORDERING. `event` entries carry real ledger timestamps and come first,
 * oldest to newest. `command`, `files` and `report` entries have no
 * trustworthy timestamps (the log has no per-line clock, the worktree diff
 * and report files are point-in-time snapshots), so they follow in stream
 * order: commands in log order, then the files entry, then reports. Clients
 * must not invent times for the untimestamped kinds.
 */

import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import { scrubSecrets, redactHomePaths } from '../util/scrub.js';
import {
  getFleetJobDetail,
  isFleetJobId,
  scanJobLog,
  type FleetJobState,
  type JobLogScanOptions,
} from './runs-job-detail.js';
import { getFleetJobChanges, type FleetJobChangesV1, type FleetJobChangesOptions } from './runs-job-changes.js';
import { getFleetJobText, type FleetJobTextV1 } from './runs-job-texts.js';
import { readSource, type Source } from './runs-parked-queue.js';

// ---------------------------------------------------------------------------
// Wire shape — fleet.job.activity.v1
// ---------------------------------------------------------------------------

export type FleetJobActivitySourceState = 'healthy' | 'missing' | 'degraded';

export interface FleetJobActivityEventEntry {
  kind: 'event';
  /** Ledger timestamp (row ts/timestamp/at) when the row carried one. */
  at: string | null;
  /** The metric row's `event` name (launch, finish, publish, ...). */
  event: string;
  /** Allowlisted scalar fields as `key=value` pairs, scrubbed. */
  summary: string;
}

export interface FleetJobActivityCommandEntry {
  kind: 'command';
  /** The command line as observed in the log, scrubbed and capped. */
  text: string;
  /** 1-based line number inside the scanned window (not the whole log). */
  line: number;
}

export interface FleetJobActivityFilesEntry {
  kind: 'files';
  state: FleetJobChangesV1['state'];
  baseSha: string | null;
  comparisonBase?: 'HEAD';
  files: FleetJobChangesV1['files'];
  totals: FleetJobChangesV1['totals'];
  truncated: boolean;
  refusals: { path: string; rule: string }[];
}

export interface FleetJobActivityReportEntry {
  kind: 'report';
  name: 'notes' | 'brief';
  state: FleetJobTextV1['state'];
  /** Which artifact answered: notes.md, or the body.md fallback. */
  source: FleetJobTextV1['source'];
  bytes: number | null;
  truncated: boolean;
  /** Scrubbed, byte-capped report text for inline rendering. */
  text: string;
}

export type FleetJobActivityEntry =
  | FleetJobActivityEventEntry
  | FleetJobActivityCommandEntry
  | FleetJobActivityFilesEntry
  | FleetJobActivityReportEntry;

export interface FleetJobActivityV1 {
  schema: 'fleet.job.activity.v1';
  generatedAt: string;
  job: string;
  state: FleetJobState;
  lane: string | null;
  tier: string | null;
  model: string | null;
  /** Per-source honesty: which slice of the stream is real evidence. */
  sources: {
    events: FleetJobActivitySourceState;
    commands: FleetJobActivitySourceState;
    files: FleetJobActivitySourceState;
    reports: FleetJobActivitySourceState;
  };
  counts: { events: number; commands: number; files: number; reports: number };
  /** True when any source clipped its window or a kind hit its entry cap. */
  truncated: boolean;
  entries: FleetJobActivityEntry[];
}

export interface FleetJobActivityOptions {
  runsDir?: string;
  homeDir?: string;
  now?: () => Date;
  /** Ledger tail read bound. Default 512 KiB. */
  ledgerBytes?: number;
  /** Cap on event entries kept (the NEWEST matches). Default 200. */
  maxEvents?: number;
  /** Cap on command entries. Default 200. */
  maxCommands?: number;
  /** Log scan window — forwarded to scanJobLog. */
  scan?: JobLogScanOptions;
  /** Changes projection options — forwarded to getFleetJobChanges. */
  changes?: FleetJobChangesOptions;
}

// ---------------------------------------------------------------------------
// Bounds and allowlists
// ---------------------------------------------------------------------------

const DEFAULT_LEDGER_BYTES = 512 * 1024;
const MAX_EVENTS = 200;
const MAX_COMMANDS = 200;
const MAX_COMMAND_CHARS = 400;
const MAX_SUMMARY_CHARS = 400;
const MAX_SUMMARY_FIELD_CHARS = 80;
const MAX_EVENT_CHARS = 80;
const MAX_REPORT_TEXT_CHARS = 64 * 1024;

/** Ledger row fields allowed into a summary — scalars only, never free text. */
const SUMMARY_FIELDS = new Set([
  'lane', 'sublane', 'repo', 'tier', 'model', 'arm', 'ab', 'batch', 'batch_size',
  'wall_s', 'exit_code', 'diff_files', 'diff_lines', 'empty', 'outcome', 'url',
  'pr_url', 'pr', 'reason', 'cost', 'pool_error', 'failure_class', 'mem_free_pct',
  'swap_gb', 'pid', 'src', 'pattern', 'until', 'count', 'auth_failures',
]);

const JOB_KEYS = ['job', 'job_id', 'jobId'] as const;
const AT_KEYS = ['ts', 'timestamp', 'at', 'time'] as const;

// ---------------------------------------------------------------------------
// Command extraction — conservative: a line is a command only when it starts
// with `$`/`›`/`❯` or a known lowercase command verb. Prose never matches.
// ---------------------------------------------------------------------------

const PROMPT_COMMAND = /^\s*[$›❯]\s+(\S.{0,600})$/;

const COMMAND_VERBS = new Set([
  'cd', 'npm', 'npx', 'pnpm', 'yarn', 'bun', 'node', 'deno', 'python', 'python3',
  'pip', 'pip3', 'uv', 'git', 'gh', 'make', 'cmake', 'ninja', 'meson', 'bazel',
  'cargo', 'rustc', 'go', 'docker', 'podman', 'kubectl', 'helm', 'terraform',
  'tofu', 'ansible', 'vault', 'aws', 'gcloud', 'az', 'flyctl', 'supabase',
  'vercel', 'wrangler', 'netlify', 'curl', 'wget', 'bash', 'sh', 'zsh', 'fish',
  'pwsh', 'env', 'printenv', 'mkdir', 'rm', 'rmdir', 'cp', 'mv', 'ln', 'chmod',
  'chown', 'chgrp', 'tar', 'unzip', 'zip', 'gzip', 'gunzip', 'bzip2', 'xz',
  'diff', 'patch', 'sed', 'awk', 'gawk', 'jq', 'yq', 'sqlite3', 'psql', 'mysql',
  'redis-cli', 'mongosh', 'ps', 'kill', 'pkill', 'killall', 'launchctl',
  'systemctl', 'brew', 'mas', 'port', 'xcodebuild', 'xcode-select', 'swift',
  'swiftc', 'clang', 'gcc', 'g++', 'cc', 'java', 'javac', 'mvn', 'mvnd',
  'gradle', 'gradlew', 'dotnet', 'nuget', 'php', 'composer', 'ruby', 'gem',
  'bundle', 'perl', 'cpanm', 'Rscript', 'julia', 'lua', 'luajit', 'tclsh',
  'vim', 'vi', 'nvim', 'nano', 'emacs', 'code', 'cursor', 'claude', 'codex',
  'devin', 'phm', 'ashlr', 'agy', 'gemini', 'grok', 'aider', 'amp', 'opencode',
  'llm', 'sgpt', 'nvm', 'volta', 'mise', 'asdf', 'pyenv', 'rbenv', 'bundler',
  'ssh', 'scp', 'rsync', 'nc', 'sftp', 'tmux', 'screen', 'nohup', 'tee', 'xargs',
]);

const BARE_COMMAND = /^\s{0,8}(?:sudo\s+|time\s+|nice\s+-?\d*\s+|env\s+)*([a-z][a-z0-9._+-]*)(?=\s|$)/;

function cleanField(value: string, max: number): string {
  // eslint-disable-next-line no-control-regex -- stripping control bytes is the point.
  return value.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function commandText(line: string): string | null {
  const prompt = PROMPT_COMMAND.exec(line);
  if (prompt) {
    const text = cleanField(prompt[1]!, MAX_COMMAND_CHARS);
    return text === '' ? null : text;
  }
  const bare = BARE_COMMAND.exec(line);
  if (!bare || !COMMAND_VERBS.has(bare[1]!)) return null;
  // A bare verb alone ("git") is noise; require at least one argument.
  if (line.slice(bare[0].length).trim() === '') return null;
  const text = cleanField(line, MAX_COMMAND_CHARS);
  return text === '' ? null : text;
}

/**
 * Extract command entries from scanned log lines. Pure; exported for tests.
 * Keeps the NEWEST `max` commands (the scan window is already the log tail,
 * so the most recent commands are the ones an operator wants first).
 */
export function extractJobCommands(lines: readonly string[], max: number = MAX_COMMANDS): FleetJobActivityCommandEntry[] {
  if (max <= 0) return [];
  const out: FleetJobActivityCommandEntry[] = [];
  for (let i = 0; i < lines.length; i++) {
    const text = commandText(lines[i]!);
    if (text !== null) out.push({ kind: 'command', text, line: i + 1 });
  }
  return out.slice(-max);
}

// ---------------------------------------------------------------------------
// Ledger events — metrics/jobs.jsonl rows for this job
// ---------------------------------------------------------------------------

function rowJob(row: Record<string, unknown>): string | null {
  for (const key of JOB_KEYS) {
    const value = row[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return null;
}

function rowAt(row: Record<string, unknown>): string | null {
  for (const key of AT_KEYS) {
    const value = row[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return null;
}

function summarizeRow(row: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(row)) {
    if (!SUMMARY_FIELDS.has(key) || parts.length >= 12) continue;
    if (value === null || value === undefined) continue;
    if (typeof value === 'object') continue;
    const text = cleanField(String(value), MAX_SUMMARY_FIELD_CHARS);
    if (text !== '') parts.push(`${key}=${text}`);
  }
  return cleanField(parts.join(' '), MAX_SUMMARY_CHARS);
}

function ledgerEvents(text: string, job: string, max: number): { events: FleetJobActivityEventEntry[]; matched: number; clipped: boolean } {
  const matched: FleetJobActivityEventEntry[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.length > 64 * 1024) continue;
    let row: unknown;
    try { row = JSON.parse(line); } catch { continue; }
    if (typeof row !== 'object' || row === null || Array.isArray(row)) continue;
    const record = row as Record<string, unknown>;
    if (rowJob(record) !== job) continue;
    const event = typeof record['event'] === 'string' ? cleanField(record['event'], MAX_EVENT_CHARS) : '';
    if (event === '') continue;
    matched.push({ kind: 'event', at: rowAt(record), event, summary: summarizeRow(record) });
  }
  const clipped = matched.length > max;
  return { events: clipped ? matched.slice(-max) : matched, matched: matched.length, clipped };
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

function sourceStateOf(scanSource: string): FleetJobActivitySourceState {
  return scanSource === 'missing' ? 'missing' : scanSource === 'degraded' ? 'degraded' : 'healthy';
}

function changesSourceState(state: FleetJobChangesV1['state']): FleetJobActivitySourceState {
  return state === 'live' ? 'healthy' : state === 'missing' ? 'missing' : 'degraded';
}

function reportsSourceState(results: FleetJobTextV1[]): FleetJobActivitySourceState {
  if (results.some((r) => r.state === 'unreadable')) return 'degraded';
  if (results.every((r) => r.state === 'missing')) return 'missing';
  return 'healthy';
}

function ledgerSourceState(state: Source): FleetJobActivitySourceState {
  return state === 'healthy' ? 'healthy' : state === 'missing' ? 'missing' : 'degraded';
}

function reportEntry(name: 'notes' | 'brief', text: FleetJobTextV1): FleetJobActivityReportEntry {
  return {
    kind: 'report',
    name,
    state: text.state,
    source: text.source,
    bytes: text.bytes,
    truncated: text.truncated || text.text.length > MAX_REPORT_TEXT_CHARS,
    text: text.text.slice(0, MAX_REPORT_TEXT_CHARS),
  };
}

/**
 * The merged per-job activity stream. Every source is independently
 * guarded; a failure degrades only its own slice (see `sources`).
 */
export async function getFleetJobActivity(job: string, options: FleetJobActivityOptions = {}): Promise<FleetJobActivityV1> {
  if (!isFleetJobId(job)) throw new Error('invalid fleet job id');
  const runsDir = options.runsDir ?? join(homedir(), '.ashlr-runs');
  if (!isAbsolute(runsDir)) throw new Error('runsDir must be an absolute path');
  const now = options.now?.() ?? new Date();
  const maxEvents = options.maxEvents ?? MAX_EVENTS;
  const maxCommands = options.maxCommands ?? MAX_COMMANDS;

  const [detail, scan, changes, notes, brief, ledger] = await Promise.all([
    getFleetJobDetail(job, { runsDir, now: () => now }),
    scanJobLog(job, { runsDir, ...options.scan }),
    getFleetJobChanges(job, { runsDir, homeDir: options.homeDir, ...options.changes }).catch((): FleetJobChangesV1 => ({
      schema: 'fleet.job.changes.v1', generatedAt: now.toISOString(), job, state: 'degraded', baseSha: null,
      files: [], totals: { files: 0, added: 0, removed: 0 }, truncated: false, refusals: [],
    })),
    getFleetJobText(job, 'notes', { runsDir }).catch((): FleetJobTextV1 => ({
      v: 1, job, kind: 'notes', state: 'unreadable', source: null, bytes: null, truncated: false, text: '',
    })),
    getFleetJobText(job, 'prompt', { runsDir }).catch((): FleetJobTextV1 => ({
      v: 1, job, kind: 'prompt', state: 'unreadable', source: null, bytes: null, truncated: false, text: '',
    })),
    readSource(join(runsDir, 'metrics', 'jobs.jsonl'), options.ledgerBytes ?? DEFAULT_LEDGER_BYTES, true),
  ]);

  const { events, clipped: eventsClipped } = ledgerEvents(ledger.text, job, maxEvents);
  // One extra probe row tells us whether the cap clipped real commands.
  const commandProbe = extractJobCommands(scan.lines, maxCommands + 1);
  const commandsClipped = commandProbe.length > maxCommands;
  const commands = commandsClipped ? commandProbe.slice(1) : commandProbe;

  const filesEntry: FleetJobActivityFilesEntry = {
    kind: 'files',
    state: changes.state,
    baseSha: changes.baseSha,
    ...(changes.comparisonBase ? { comparisonBase: changes.comparisonBase } : {}),
    files: changes.files,
    totals: changes.totals,
    truncated: changes.truncated,
    refusals: changes.refusals ?? [],
  };

  const entries: FleetJobActivityEntry[] = [
    ...events,
    ...commands,
    filesEntry,
    reportEntry('notes', notes),
    reportEntry('brief', brief),
  ];

  const truncated =
    eventsClipped || scan.truncated || changes.truncated ||
    notes.truncated || brief.truncated || commandsClipped;

  return {
    schema: 'fleet.job.activity.v1',
    generatedAt: now.toISOString(),
    job: scrubSecrets(redactHomePaths(job)),
    state: detail.state,
    lane: detail.lane,
    tier: detail.tier,
    model: detail.model,
    sources: {
      events: ledgerSourceState(ledger.state),
      commands: sourceStateOf(scan.source),
      files: changesSourceState(changes.state),
      reports: reportsSourceState([notes, brief]),
    },
    counts: {
      events: events.length,
      commands: commands.length,
      files: changes.totals.files,
      reports: [notes, brief].filter((r) => r.state !== 'missing').length,
    },
    truncated,
    entries,
  };
}
