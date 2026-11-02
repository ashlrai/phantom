/**
 * core/fleet/recut-loop.ts — the merge-bottleneck recut loop. While the
 * desktop app is open it watches the open-PR merge backlog and drops a recut
 * job for every stale fleet PR itself, instead of a person running
 * `ashlr fleet backlog --recut-job` and dropping each prompt by hand.
 *
 * ONE TICK: readMergeBacklog already says which open PRs are DIRTY conflicts
 * worth recutting (suggestedAction 'recut'). A candidate is written only when
 * every guard below passes; each write is rendered by backlog-recut-job.ts's
 * renderBacklogRecutJob and published into the leader drop folder the ingest
 * sweeps every ~2 minutes.
 *
 * GUARDS (each failure is a named skip, never a silent drop):
 *   - title must start `bridge: RQ-PHX-` — only fleet bridge PRs;
 *   - findSupersededPrs — a merged job whose prompt already names this PR
 *     (this is the guard against recutting the same PR twice);
 *   - the recut ledger <runsDir>/queue/recut-loop.jsonl — a PR written within
 *     the last 24 h is skipped;
 *   - an in-flight recut — any RQ-PHX-*.prompt at the runs root or any
 *     RQ-PHX-*.md in a drop/queue folder whose body names `pull/<N>/head`
 *     (bounded: newest 300 files, 8000 bytes each);
 *   - caps — at most 2 writes per tick and 6 per rolling hour counted from
 *     the ledger; the overflow is skipped 'capped', outcome 'capped';
 *   - the head SHA — the merge-state record proves the tracked head (a moved
 *     head would classify 'pending', not 'conflicted'), and a bounded
 *     `gh pr view --json headRefOid` covers untracked PRs; no sha, no write.
 *
 * OFF: <runsDir>/queue/recut-loop.off, the fleet's <runsDir>/ORCH_OFF switch,
 * or the ORCH_OFF env var — the tick returns 'off' and writes nothing.
 *
 * THE WRITE differs from the drop-job API in one deliberate way: it composes
 * the file with drop-job-writer's composeDropJobFile and publishes it with
 * the same dot-temp + link(2) primitive (atomic, never clobbering — an
 * existing name fails EEXIST and the id bumps L1→L2→…). It does NOT call
 * writeDropJob because the mandated recut body references `.github/` and
 * `CODEOWNERS` as *exclusion instructions* and the writer's denied-content
 * scan — an accept filter for untrusted HTTP payloads — would refuse it.
 * Every other structural check (id shape, lane, tier, non-empty body,
 * control characters, the 8 KB file cap) still runs before publish.
 *
 * THE LOOP is opt-in per process: GET /api/verse/health arms it once when
 * dispatch is allowed (the desktop polls that route while the app is open)
 * and it never arms under Vitest. Every tick's outcome is kept in module
 * state for GET /api/verse/health/recut-loop; errors are kept, never thrown
 * out of the timer.
 */
import { randomBytes } from 'node:crypto';
import { constants, existsSync, type Stats } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readdir, link, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import type { CloudGh } from '../cloud/pr-actions.js';
import { defaultGitRunner } from '../verse/git-ops.js';
import { renderBacklogRecutJob } from './backlog-recut-job.js';
import { collectPrConflicts } from './dirty-union-collect.js';
import { classifyDiff3 } from './dirty-union-preview.js';
import {
  DROP_JOB_FILE,
  DROP_JOB_FILE_PREFIX,
  DROP_JOB_ID,
  DROP_JOB_MAX_FILE_BYTES,
  DropJobExistsError,
  DropJobValidationError,
  composeDropJobFile,
  dropJobExists,
  resolveDropJobRoot,
  validateDropJob,
} from './drop-job-writer.js';
import type { FleetMergeStateRead } from './fleet-merge-state.js';
import {
  readMergeBacklog,
  readMergeBacklogStates,
  type MergeBacklogReadV1,
} from './merge-backlog-read.js';
import { findSupersededPrs, type MergedFleetPr } from './superseded-prs.js';

export const RECUT_LOOP_LANE = 'codex-personal';
export const RECUT_LOOP_TIER = 'mid';
const RECUT_REPO = 'ashlrai/phantom';
const RECUT_LOOP_INTERVAL_MS = 10 * 60 * 1000;
const TICK_WRITE_CAP = 2;
const HOUR_WRITE_CAP = 6;
const HOUR_MS = 60 * 60 * 1000;
const RECENT_WINDOW_MS = 24 * HOUR_MS;
const LEDGER_TAIL_BYTES = 64 * 1024;
const SCAN_FILE_LIMIT = 300;
const SCAN_BYTES_PER_FILE = 8000;
const PROMPT_FILE_LIMIT = 1000;
const PROMPT_BYTES_PER_FILE = 128 * 1024;
const GH_LIST_TIMEOUT_MS = 60_000;
const GH_LIST_MAX_BYTES = 16 * 1024 * 1024;
const MERGED_PR_LIMIT = 1000;

const LEDGER_FILE = join('queue', 'recut-loop.jsonl');
const OFF_FILE = join('queue', 'recut-loop.off');
const BRIDGE_TITLE_RE = /^bridge: RQ-PHX-/;
const PULL_HEAD_RE = /pull\/(\d+)\/head/g;
const PROMPT_FILE_RE = /^(RQ-[A-Za-z0-9_-]+)\.(?:md|prompt)$/;
const ROOT_PROMPT_RE = /^RQ-PHX-[A-Z0-9]+\.prompt$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const DROP_JOB_DIRS = ['claude', 'codex-personal', 'devin', 'codex-local', 'done'] as const;

const enoent = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT';
const owned = (stat: Stats): boolean => typeof process.getuid !== 'function' || stat.uid === process.getuid();
const message = (error: unknown): string => error instanceof Error ? error.message : String(error);
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

export interface RecutLoopDeps {
  /** Fleet runs root; the ledger, off switch and drop folders live under it. */
  runsDir: string;
  /** Where job files land. Defaults to <runsDir>/leader/drop/claude. */
  dropDir?: string;
  /** The open-PR merge backlog read (same read the console's Merges pane uses). */
  readBacklog: () => Promise<MergeBacklogReadV1>;
  /** Merged PRs for superseded evidence. Defaults to the bounded `gh pr list` fleet-superseded.ts runs. */
  readMerged?: () => Promise<MergedFleetPr[]>;
  /** One candidate's observed head SHA. Defaults to the merge-state record, then a bounded `gh pr view`. */
  readHeadSha?: (pr: number) => Promise<string | null>;
  /**
   * Whether the union preview marks this head fully union-safe — then the
   * prompt names `ashlr fleet union-apply`. Defaults to the preview's
   * isolated inspection; a degraded read is `false`, never a skip.
   */
  readUnionSafe?: (pr: { number: number; headSha: string }) => Promise<boolean>;
  now?: () => number;
  /** Publish one job file (name + rendered body). Defaults to the drop-folder publish below. */
  writeJob?: (file: string, body: string) => Promise<void>;
}

export interface RecutLoopWritten {
  pr: number;
  id: string;
  file: string;
}

export interface RecutLoopSkipped {
  pr: number;
  /** superseded | recent | in-flight | capped | no-head | no-id | exists | write-failed */
  reason: string;
}

export interface RecutLoopTickResult {
  at: string;
  outcome: 'wrote' | 'nothing' | 'read-failed' | 'off' | 'capped';
  written: RecutLoopWritten[];
  skipped: RecutLoopSkipped[];
  /** Ledger writes inside the rolling hour after this tick finished. */
  hourCount: number;
}

/** One durable ledger line appended to queue/recut-loop.jsonl per write. */
export interface RecutLoopLedgerEntry {
  at: string;
  pr: number;
  id: string;
  headSha: string;
  file: string;
}

export interface RecutLoopState {
  v: 1;
  armed: boolean;
  lastTickAt: string | null;
  lastOutcome: RecutLoopTickResult['outcome'] | null;
  lastError: string | null;
  /** The last 20 written jobs, oldest first. */
  written: RecutLoopWritten[];
  /** Ledger writes inside the rolling hour at the last completed tick. */
  hourCount: number;
  off: boolean;
}

// ---------------------------------------------------------------------------
// Bounded gh — the same argv-only, bounded runner fleet-superseded.ts uses
// ---------------------------------------------------------------------------

const defaultGh: CloudGh = async (args) => {
  const result = await defaultGitRunner('gh', args, {
    cwd: tmpdir(), timeoutMs: GH_LIST_TIMEOUT_MS, maxStdoutBytes: GH_LIST_MAX_BYTES,
  });
  return { ok: result.code === 0 && !result.timedOut && !result.truncated, stdout: result.stdout, stderr: result.stderr };
};

const isMergedPr = (value: unknown): value is MergedFleetPr =>
  object(value) && Number.isSafeInteger(value['number']) && (value['number'] as number) > 0 && typeof value['title'] === 'string';

async function readMergedDefault(repo: string): Promise<MergedFleetPr[]> {
  const result = await defaultGh([
    'pr', 'list', '--repo', repo, '--state', 'merged', '--limit', String(MERGED_PR_LIMIT), '--json', 'number,title',
  ]);
  if (!result.ok) throw new Error('gh pr list failed');
  const rows: unknown = JSON.parse(result.stdout);
  if (!Array.isArray(rows)) throw new Error('gh pr list did not return a JSON array');
  return rows.filter(isMergedPr).slice(0, MERGED_PR_LIMIT);
}

/**
 * The observed head for one candidate. A merge-state record's tracked head is
 * authoritative for a 'recut' candidate — a moved head classifies 'pending',
 * never 'conflicted'. Untracked PRs fall back to one bounded `gh pr view`.
 */
function defaultReadHeadSha(repo: string, states: ReadonlyMap<number, FleetMergeStateRead>) {
  return async (pr: number): Promise<string | null> => {
    const read = states.get(pr);
    if (read?.state === 'ok' && read.record?.pr && SHA_RE.test(read.record.pr.headSha)) {
      return read.record.pr.headSha;
    }
    const result = await defaultGh(['pr', 'view', String(pr), '--repo', repo, '--json', 'headRefOid']);
    if (!result.ok) return null;
    try {
      const raw: unknown = JSON.parse(result.stdout);
      const sha = object(raw) ? raw['headRefOid'] : null;
      return typeof sha === 'string' && SHA_RE.test(sha) ? sha : null;
    } catch {
      return null;
    }
  };
}

/**
 * The preview verdict for one candidate: the same fetch + merge-tree +
 * classifyDiff3 pipeline `ashlr fleet union-preview` runs, inside a
 * disposable object store. The head SHA is re-observed first — a moved head
 * is never classified.
 */
function defaultReadUnionSafe(repo: string): (pr: { number: number; headSha: string }) => Promise<boolean> {
  const remote = `https://github.com/${repo}.git`;
  return async ({ number, headSha }) => {
    try {
      const view = await defaultGh(['pr', 'view', String(number), '--repo', repo, '--json', 'headRefOid,baseRefName,state']);
      if (!view.ok) return false;
      const row: unknown = JSON.parse(view.stdout);
      const baseRef = object(row) ? row['baseRefName'] : null;
      if (!object(row) || row['headRefOid'] !== headSha || row['state'] !== 'OPEN' ||
          typeof baseRef !== 'string' || baseRef === '') return false;
      const dir = await mkdtemp(join(tmpdir(), 'recut-union-'));
      try {
        const init = await defaultGitRunner('git', ['init', '--bare', '--quiet'],
          { cwd: dir, timeoutMs: 60_000, maxStdoutBytes: 1024 * 1024 });
        if (init.code !== 0) return false;
        await writeFile(join(dir, 'info', 'attributes'), '* merge\n');
        const found = await collectPrConflicts(dir, { number, headSha, baseRef }, remote);
        return found.ok && found.files.every(file => classifyDiff3(file.diff3) === 'union-safe');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    } catch {
      return false;
    }
  };
}

// ---------------------------------------------------------------------------
// Bounded filesystem readers — ledger, off switch, prompts, in-flight bodies
// ---------------------------------------------------------------------------

async function readBounded(path: string, cap: number): Promise<string> {
  const handle = await open(path, 'r');
  try {
    const info = await handle.stat();
    const buffer = Buffer.alloc(Math.min(info.size, cap));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

/** Append one audit line the same guarded way lane-target-changes.log is written. */
async function appendLine(path: string, line: string): Promise<void> {
  const handle = await open(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || !owned(stat) || stat.nlink !== 1) throw new Error('invalid sink');
    await handle.writeFile(line);
  } finally {
    await handle.close();
  }
}

const parseLedgerLine = (line: string): RecutLoopLedgerEntry | null => {
  if (!line.trim()) return null;
  let row: unknown;
  try { row = JSON.parse(line); } catch { return null; }
  if (!object(row) || !Number.isSafeInteger(row['pr']) || (row['pr'] as number) < 1) return null;
  const at = row['at'];
  if (typeof at !== 'string' || !Number.isFinite(Date.parse(at))) return null;
  return {
    at,
    pr: row['pr'] as number,
    id: typeof row['id'] === 'string' ? row['id'] : '',
    headSha: typeof row['headSha'] === 'string' ? row['headSha'] : '',
    file: typeof row['file'] === 'string' ? row['file'] : '',
  };
};

/** Newest-first: the last 64 KiB of the recut ledger, malformed lines skipped. */
export async function readRecutLoopLedger(runsDir: string): Promise<RecutLoopLedgerEntry[]> {
  let tail: string;
  try {
    const file = await open(join(runsDir, LEDGER_FILE), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await file.stat();
      if (!info.isFile()) throw new Error('invalid source');
      const start = Math.max(0, info.size - LEDGER_TAIL_BYTES);
      const bytes = Buffer.alloc(Math.min(info.size, LEDGER_TAIL_BYTES));
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, start + offset);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      tail = bytes.subarray(0, offset).toString('utf8');
      const firstNewline = tail.indexOf('\n');
      if (start && firstNewline >= 0) tail = tail.slice(firstNewline + 1);
    } finally {
      await file.close();
    }
  } catch (error) {
    if (enoent(error)) return [];
    throw error;
  }
  return tail.split(/\r?\n/).flatMap((line) => {
    const entry = parseLedgerLine(line);
    return entry === null ? [] : [entry];
  }).reverse();
}

/** The off switches: recut-loop.off, the fleet ORCH_OFF switch file, or the env var. */
async function recutLoopOff(runsDir: string): Promise<boolean> {
  if (process.env.ORCH_OFF) return true;
  for (const rel of [OFF_FILE, 'ORCH_OFF']) {
    try {
      await lstat(join(runsDir, rel));
      return true;
    } catch (error) {
      if (enoent(error)) continue;
      return true; // a degraded stat fails closed for an autonomous dispatcher
    }
  }
  return false;
}

interface ScanDir {
  dir: string;
  pattern: RegExp;
  strip: RegExp;
}

/** Files matching `pattern` under `dir`, newest first, with their job stems. */
async function collectMatching(spec: ScanDir[], limit: number): Promise<{ path: string; stem: string; mtimeMs: number }[]> {
  const files: { path: string; stem: string; mtimeMs: number }[] = [];
  const seen = new Set<string>();
  for (const { dir, pattern, strip } of spec) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (enoent(error)) continue;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !pattern.test(entry.name)) continue;
      const path = join(dir, entry.name);
      if (seen.has(path)) continue;
      let stat;
      try {
        stat = await lstat(path);
      } catch {
        continue; // swept between the listing and now — it is not waiting any more
      }
      if (!stat.isFile()) continue;
      seen.add(path);
      files.push({ path, stem: entry.name.replace(strip, ''), mtimeMs: stat.mtimeMs });
    }
  }
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, limit);
}

/** Job id → prompt text, from queue/prompts and launched .prompt files at the root. */
async function readPromptTexts(runsDir: string): Promise<ReadonlyMap<string, string>> {
  const files = await collectMatching([
    { dir: join(runsDir, 'queue', 'prompts'), pattern: PROMPT_FILE_RE, strip: /\.(?:md|prompt)$/ },
    { dir: runsDir, pattern: PROMPT_FILE_RE, strip: /\.(?:md|prompt)$/ },
  ], PROMPT_FILE_LIMIT);
  const prompts = new Map<string, string>();
  for (const file of files) {
    try {
      prompts.set(file.stem, await readBounded(file.path, PROMPT_BYTES_PER_FILE));
    } catch {
      // Unreadable between listing and read — it can no longer name a PR.
    }
  }
  return prompts;
}

/** PR numbers named `pull/<N>/head` by any in-flight prompt or drop body. */
async function readInflightPrs(runsDir: string, dropDir: string): Promise<Set<number>> {
  const spec: ScanDir[] = [
    { dir: runsDir, pattern: ROOT_PROMPT_RE, strip: /\.prompt$/ },
    { dir: join(runsDir, 'queue', 'prompts'), pattern: DROP_JOB_FILE, strip: /\.md$/ },
    ...DROP_JOB_DIRS.map((lane) => ({
      dir: join(runsDir, 'leader', 'drop', lane), pattern: DROP_JOB_FILE, strip: /\.md$/,
    })),
  ];
  if (!spec.some(({ dir }) => dir === dropDir)) spec.push({ dir: dropDir, pattern: DROP_JOB_FILE, strip: /\.md$/ });
  const files = await collectMatching(spec, SCAN_FILE_LIMIT);
  const prs = new Set<number>();
  for (const file of files) {
    let body: string;
    try {
      body = await readBounded(file.path, SCAN_BYTES_PER_FILE);
    } catch {
      continue;
    }
    for (const match of body.matchAll(PULL_HEAD_RE)) {
      const pr = Number(match[1]);
      if (Number.isSafeInteger(pr) && pr > 0) prs.add(pr);
    }
  }
  return prs;
}

/** First free RECUT<N>L<k> id: taken anywhere the ingest tracks it, or in the drop dir. */
async function nextFreeId(runsDir: string, dropDir: string, pr: number): Promise<string | null> {
  for (let level = 1; level <= 9; level += 1) {
    const id = `RECUT${pr}L${level}`;
    if (!DROP_JOB_ID.test(id)) continue;
    if (await dropJobExists(runsDir, id)) continue;
    try {
      await lstat(join(dropDir, `${DROP_JOB_FILE_PREFIX}${id}.md`));
      continue;
    } catch (error) {
      if (!enoent(error)) throw error;
    }
    return id;
  }
  return null;
}

/**
 * Publish `RQ-PHX-<id>.md` into the drop folder. Same contract as
 * writeDropJob — header line, 8 KB cap, dot-temp + link(2), never clobbering —
 * minus denied-content: the rendered recut body references `.github/` and
 * `CODEOWNERS` as paths to exclude, which the untrusted-input scan rejects.
 */
async function defaultWriteJob(file: string, body: string): Promise<void> {
  const name = basename(file);
  const id = DROP_JOB_FILE.exec(name)?.[1];
  if (id === undefined) throw new DropJobValidationError(['id-shape']);
  const verdict = validateDropJob({ id, lane: RECUT_LOOP_LANE, tier: RECUT_LOOP_TIER, body });
  if (!verdict.ok) {
    const reasons = verdict.reasons.filter((reason) => reason !== 'denied-content');
    if (reasons.length > 0) throw new DropJobValidationError(reasons);
  }
  const dir = dirname(file);
  await mkdir(dir, { recursive: true });
  const content = composeDropJobFile({ lane: RECUT_LOOP_LANE, tier: RECUT_LOOP_TIER, body });
  if (Buffer.byteLength(content, 'utf8') > DROP_JOB_MAX_FILE_BYTES) throw new DropJobValidationError(['too-large']);
  const temp = join(dir, `.${name}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`);
  const handle = await open(temp, 'wx', 0o600);
  try {
    await handle.writeFile(content, 'utf8');
  } finally {
    await handle.close();
  }
  try {
    await link(temp, file);
  } catch (error) {
    if (typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new DropJobExistsError(id);
    }
    throw error;
  } finally {
    await unlink(temp).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// The tick
// ---------------------------------------------------------------------------

export async function recutLoopTick(deps: RecutLoopDeps): Promise<RecutLoopTickResult> {
  const now = deps.now ?? Date.now;
  const nowMs = now();
  const at = new Date(nowMs).toISOString();
  const result: RecutLoopTickResult = { at, outcome: 'nothing', written: [], skipped: [], hourCount: 0 };

  const runsDir = resolveDropJobRoot(deps.runsDir);
  const dropDir = deps.dropDir ?? join(runsDir, 'leader', 'drop', 'claude');
  const writeJob = deps.writeJob ?? defaultWriteJob;

  if (await recutLoopOff(runsDir)) {
    result.outcome = 'off';
    return result;
  }

  let backlog: MergeBacklogReadV1;
  try {
    backlog = await deps.readBacklog();
  } catch {
    result.outcome = 'read-failed';
    return result;
  }
  if (backlog.source !== 'ok') {
    result.outcome = 'read-failed';
    return result;
  }

  const candidates = backlog.items.filter((item) =>
    item.suggestedAction === 'recut' && BRIDGE_TITLE_RE.test(item.title));
  if (candidates.length === 0) return result;

  let merged: MergedFleetPr[];
  try {
    merged = await (deps.readMerged ?? (() => readMergedDefault(backlog.repo)))();
  } catch {
    result.outcome = 'read-failed';
    return result;
  }

  // Every source a skip rule needs must read before any write: a degraded
  // read fails the whole tick rather than re-cutting a superseded PR.
  const guardReads = await Promise.all([
    readPromptTexts(runsDir),
    readRecutLoopLedger(runsDir),
    readInflightPrs(runsDir, dropDir),
  ]).catch(() => null);
  if (guardReads === null) {
    result.outcome = 'read-failed';
    return result;
  }
  const [prompts, ledger, inflight] = guardReads;

  const superseded = new Set(findSupersededPrs(backlog.items, merged, prompts).map((row) => row.pr.number));
  const recent = new Set(ledger.filter((entry) => Date.parse(entry.at) >= nowMs - RECENT_WINDOW_MS).map((entry) => entry.pr));
  const hourCount = ledger.filter((entry) => Date.parse(entry.at) >= nowMs - HOUR_MS).length;
  let states: ReadonlyMap<number, FleetMergeStateRead>;
  try {
    states = readMergeBacklogStates(backlog.repo);
  } catch {
    states = new Map(); // a degraded store just means every sha comes from the gh view
  }
  const readHeadSha = deps.readHeadSha ?? defaultReadHeadSha(backlog.repo, states);
  const readUnionSafe = deps.readUnionSafe ?? defaultReadUnionSafe(backlog.repo);

  let allowance = Math.min(TICK_WRITE_CAP, Math.max(0, HOUR_WRITE_CAP - hourCount));
  let capped = false;
  for (const item of candidates) {
    const pr = item.number;
    const skip = (reason: string): void => { result.skipped.push({ pr, reason }); };
    if (superseded.has(pr)) { skip('superseded'); continue; }
    if (recent.has(pr)) { skip('recent'); continue; }
    if (inflight.has(pr)) { skip('in-flight'); continue; }
    if (allowance <= 0) { skip('capped'); capped = true; continue; }
    const headSha = await readHeadSha(pr);
    if (headSha === null) { skip('no-head'); continue; }
    const id = await nextFreeId(runsDir, dropDir, pr);
    if (id === null) { skip('no-id'); continue; }
    const file = join(dropDir, `${DROP_JOB_FILE_PREFIX}${id}.md`);
    const unionSafe = await readUnionSafe({ number: pr, headSha }).catch(() => false);
    const body = renderBacklogRecutJob(pr, headSha, item.title, { unionSafe });
    try {
      await writeJob(file, body);
    } catch (error) {
      skip(error instanceof DropJobExistsError ? 'exists' : 'write-failed');
      continue;
    }
    allowance -= 1;
    result.written.push({ pr, id, file });
    try {
      await mkdir(join(runsDir, 'queue'), { recursive: true });
      await appendLine(join(runsDir, LEDGER_FILE), `${JSON.stringify({ at, pr, id, headSha, file } satisfies RecutLoopLedgerEntry)}\n`);
    } catch {
      // The in-flight scan still guards the next tick; only the 24 h window thins.
    }
  }

  result.hourCount = hourCount + result.written.length;
  result.outcome = capped ? 'capped' : result.written.length > 0 ? 'wrote' : 'nothing';
  return result;
}

// ---------------------------------------------------------------------------
// The in-process loop — one timer per process, armed by GET /api/verse/health
// ---------------------------------------------------------------------------

interface RecutLoopRuntime {
  armed: boolean;
  lastTickAt: string | null;
  lastOutcome: RecutLoopTickResult['outcome'] | null;
  lastError: string | null;
  written: RecutLoopWritten[];
  hourCount: number;
}

const loopState: RecutLoopRuntime = { armed: false, lastTickAt: null, lastOutcome: null, lastError: null, written: [], hourCount: 0 };
let timer: NodeJS.Timeout | null = null;
let tickInFlight: Promise<void> | null = null;
let armedRunsDir: string | null = null;

/** Idempotent: a second call while running is a no-op. The first tick runs now. */
export function startRecutLoop(opts: { runsDir?: string; now?: () => number; intervalMs?: number } = {}): void {
  if (process.env.VITEST) return; // never armed under Vitest
  if (loopState.armed) return;
  let runsDir: string;
  try {
    runsDir = resolveDropJobRoot(opts.runsDir);
  } catch (error) {
    loopState.lastError = message(error);
    return;
  }
  loopState.armed = true;
  armedRunsDir = runsDir;
  const intervalMs = typeof opts.intervalMs === 'number' && Number.isFinite(opts.intervalMs) && opts.intervalMs > 0
    ? opts.intervalMs
    : RECUT_LOOP_INTERVAL_MS;
  const fire = (): void => {
    if (tickInFlight) return;
    tickInFlight = recutLoopTick({
      runsDir,
      ...(opts.now !== undefined ? { now: opts.now } : {}),
      readBacklog: () => readMergeBacklog({ repo: RECUT_REPO }),
    })
      .then((run) => {
        loopState.lastTickAt = run.at;
        loopState.lastOutcome = run.outcome;
        loopState.hourCount = run.hourCount;
        if (run.written.length > 0) loopState.written = [...loopState.written, ...run.written].slice(-20);
        loopState.lastError = null;
      })
      .catch((error: unknown) => {
        loopState.lastError = message(error);
      })
      .finally(() => {
        tickInFlight = null;
      });
  };
  timer = setInterval(fire, intervalMs);
  timer.unref?.();
  fire();
}

function liveOff(): boolean {
  if (process.env.ORCH_OFF) return true;
  let runsDir: string;
  try {
    runsDir = armedRunsDir ?? resolveDropJobRoot();
  } catch {
    return false;
  }
  // existsSync on private control files under ~/.ashlr-runs — never an operator folder.
  return existsSync(join(runsDir, OFF_FILE)) || existsSync(join(runsDir, 'ORCH_OFF'));
}

export function getRecutLoopState(): RecutLoopState {
  return {
    v: 1,
    armed: loopState.armed,
    lastTickAt: loopState.lastTickAt,
    lastOutcome: loopState.lastOutcome,
    lastError: loopState.lastError,
    written: [...loopState.written],
    hourCount: loopState.hourCount,
    off: liveOff(),
  };
}

export function stopRecutLoopForTest(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
  tickInFlight = null;
  armedRunsDir = null;
  loopState.armed = false;
  loopState.lastTickAt = null;
  loopState.lastOutcome = null;
  loopState.lastError = null;
  loopState.written = [];
  loopState.hourCount = 0;
}
