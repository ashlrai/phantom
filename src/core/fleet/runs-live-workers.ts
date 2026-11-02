/**
 * Live fleet process listing — what is actually running on this host.
 *
 * The dispatcher starts fleet workers as
 *   ~/.ashlr-runs/bin/launch.sh <job> <repo> <lane> <tier>
 * and Leader passes as
 *   ~/.ashlr-runs/bin/orch-pass.sh <args>
 * while the agent children those scripts spawn (`codex exec`, `claude -p`,
 * `devin`) carry the worktree path, which names the job they belong to.
 *
 * `listLiveWorkers` reads ONE process table
 * (`/bin/ps -axo pid=,etime=,command=`) and reports the workers, leader
 * passes and orchestrator-level agents on the box. The process runner is
 * injectable, so tests never spawn anything; any runner failure degrades to
 * `sourceState: 'unavailable'` with empty arrays — the function never throws.
 *
 * Nothing a command line carries other than the typed fields below leaves
 * this module: no cwd, no prompt text, no environment. Every emitted string
 * still passes through scrubSecrets.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { scrubSecrets } from '../util/scrub.js';

const execFileAsync = promisify(execFile);

const PS_BIN = '/bin/ps';
const PS_ARGS = ['-axo', 'pid=,etime=,command='] as const;
const PS_TIMEOUT_MS = 5_000;
const PS_MAX_BUFFER = 8 * 1024 * 1024;

const LABEL_MAX_CHARS = 80;

const JOB_RE = /^[A-Za-z0-9._-]{1,80}$/;
const REPO_RE = /^[a-z0-9._-]{1,64}$/;
const LANE_RE = /^[a-z0-9-]{1,32}$/;
const TIERS = new Set(['frontier', 'work', 'mid', 'fast', 'low']);

/** `bin/launch.sh` (not `sbin`/`xbin`) followed by the four positional tokens. */
const LAUNCH_RE = /(?<!\w)bin\/launch\.sh\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)/;
const ORCH_PASS_RE = /(?<!\w)bin\/orch-pass\.sh(?=\s|$)/;
const LEADER_LOOP_RE = /(?<!\w)opus-leader-loop\.sh(?=\s|$)/;
/** `ps | grep X` self-matches; a grep invocation is never a fleet process. */
const GREP_RE = /(?:^|\s)grep(?:\s|$)/;
const CODEX_EXEC_RE = /^codex exec(?:\s|$)/;
const CLAUDE_PRINT_RE = /^claude -p(?:\s|$)/;

const PS_ROW_RE = /^\s*(\d+)\s+(\S+)\s+(\S.*)$/;
/** `[[dd-]hh:]mm:ss` — ps etime. */
const ETIME_RE = /^(?:(\d+)-)?(?:(\d{1,2}):)?(\d{1,2}):(\d{2})$/;

export interface LiveWorker {
  pid: number;
  job: string;
  repo: string;
  lane: string;
  tier: string;
  ageSeconds: number | null;
}

export interface LeaderPass {
  pid: number;
  label: string;
  ageSeconds: number | null;
}

export interface LiveWorkersSnapshot {
  v: 1;
  generatedAt: string;
  sourceState: 'healthy' | 'unavailable';
  workers: LiveWorker[];
  leaders: LeaderPass[];
  orchestratorAgents: number;
}

export interface ListLiveWorkersOptions {
  /** Runs the process table read; defaults to /bin/ps. Injectable for tests. */
  runPs?: () => Promise<string>;
  /** Clock for `generatedAt`; defaults to Date.now. */
  now?: () => number;
}

/** Elapsed-time text (`[[dd-]hh:]mm:ss`) to whole seconds.
 *
 * Returns null when parsed day/hour/minute/second components are not all
 * non-negative safe integers, or when the total seconds exceed
 * Number.MAX_SAFE_INTEGER (hundreds-of-digits day fields, totals above 2⁵³-1).
 * Valid formats — "05:12" → 312, "02:03:04" → 7384, "1-02:03:04" → 93784 —
 * are preserved exactly.
 */
export function parseEtime(text: string): number | null {
  const m = ETIME_RE.exec(text.trim());
  if (!m) return null;
  const minutes = Number(m[3]);
  const seconds = Number(m[4]);
  if (minutes >= 60 || seconds >= 60) return null;
  const days = m[1] === undefined ? 0 : Number(m[1]);
  const hours = m[2] === undefined ? 0 : Number(m[2]);
  if (!Number.isSafeInteger(days) || !Number.isSafeInteger(hours)) return null;
  if (days < 0 || hours < 0) return null;
  const total = days * 86_400 + hours * 3_600 + minutes * 60 + seconds;
  if (!Number.isSafeInteger(total)) return null;
  return total;
}

/** A token that looks like a filesystem path (`/…`, `~/…`, `--out=/…`, `x=/Users/…`). */
function isPathLikeToken(token: string): boolean {
  return token.startsWith('/') || token.startsWith('~') ||
    /[=~]\//.test(token) || /\/(?:Users|home)\//.test(token);
}

/** A job id embedded in a worktree path or other token, on token boundaries. */
function jobIdInCommand(job: string): RegExp {
  const escaped = job.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\w.-])${escaped}(?![\\w.-])`);
}

interface PsRow {
  pid: number;
  ageSeconds: number | null;
  command: string;
}

/**
 * Classify every row of a `ps -axo pid=,etime=,command=` table. Malformed
 * lines are skipped; grep invocations never count as fleet processes.
 * Duplicate launch.sh rows for one job keep the oldest (lowest) pid, and an
 * orchestrator-agent row carrying a known worker's job id is attributed to
 * that worker instead of being counted.
 */
export function parsePsTable(text: string): Omit<LiveWorkersSnapshot, 'v' | 'generatedAt' | 'sourceState'> {
  const rows: PsRow[] = [];
  for (const line of text.split('\n')) {
    const m = PS_ROW_RE.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    rows.push({ pid, ageSeconds: parseEtime(m[2]!), command: m[3]! });
  }

  const workerByJob = new Map<string, LiveWorker>();
  const jobMatchers: RegExp[] = [];
  const leaders: LeaderPass[] = [];
  const agentCandidates: PsRow[] = [];

  for (const row of rows) {
    const { command } = row;
    if (GREP_RE.test(command)) continue;
    const launch = LAUNCH_RE.exec(command);
    if (launch) {
      const [job, repo, lane, tier] = [launch[1]!, launch[2]!, launch[3]!, launch[4]!];
      if (JOB_RE.test(job) && REPO_RE.test(repo) && LANE_RE.test(lane) && TIERS.has(tier)) {
        const existing = workerByJob.get(job);
        if (!existing || row.pid < existing.pid) {
          workerByJob.set(job, {
            pid: row.pid,
            job: scrubSecrets(job),
            repo: scrubSecrets(repo),
            lane: scrubSecrets(lane),
            tier: scrubSecrets(tier),
            ageSeconds: row.ageSeconds,
          });
        }
        jobMatchers.push(jobIdInCommand(job));
      }
      continue;
    }
    const orch = ORCH_PASS_RE.exec(command);
    if (orch) {
      const label = scrubSecrets(
        command.slice(orch.index + orch[0].length)
          .split(/\s+/)
          .filter((token) => token.length > 0 && !isPathLikeToken(token))
          .join(' '),
      ).slice(0, LABEL_MAX_CHARS).trim();
      leaders.push({ pid: row.pid, label, ageSeconds: row.ageSeconds });
      continue;
    }
    if (CODEX_EXEC_RE.test(command) || CLAUDE_PRINT_RE.test(command) || LEADER_LOOP_RE.test(command)) {
      agentCandidates.push(row);
    }
  }

  const workers = [...workerByJob.values()].sort((a, b) => a.pid - b.pid);
  leaders.sort((a, b) => a.pid - b.pid);
  const orchestratorAgents = agentCandidates
    .filter((row) => !jobMatchers.some((re) => re.test(row.command)))
    .length;
  return { workers, leaders, orchestratorAgents };
}

async function defaultRunPs(): Promise<string> {
  const { stdout } = await execFileAsync(PS_BIN, [...PS_ARGS], { timeout: PS_TIMEOUT_MS, maxBuffer: PS_MAX_BUFFER });
  return stdout;
}

function unavailable(generatedAt: string): LiveWorkersSnapshot {
  return { v: 1, generatedAt, sourceState: 'unavailable', workers: [], leaders: [], orchestratorAgents: 0 };
}

/**
 * One snapshot of live fleet processes. Never throws: a failed or malformed
 * process-table read yields `sourceState: 'unavailable'` with empty arrays.
 */
export async function listLiveWorkers(options: ListLiveWorkersOptions = {}): Promise<LiveWorkersSnapshot> {
  const now = options.now ?? Date.now;
  let generatedAt: string;
  try {
    generatedAt = new Date(now()).toISOString();
  } catch {
    generatedAt = new Date(0).toISOString();
  }
  let text: string;
  try {
    text = await (options.runPs ?? defaultRunPs)();
  } catch {
    return unavailable(generatedAt);
  }
  try {
    const parsed = parsePsTable(text);
    return { v: 1, generatedAt, sourceState: 'healthy', ...parsed };
  } catch {
    return unavailable(generatedAt);
  }
}
