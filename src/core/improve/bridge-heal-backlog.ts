/**
 * Bridge source-heal journal recurring failures → self-improvement backlog items.
 *
 * Every time the fleet bridges a job worktree's node_modules from the
 * repository's source checkout, scripts/bridge-worktree.mjs runs
 * scripts/bridge-heal.mjs first: it probes the source for working tsgo and
 * eslint, and — only when they are broken — repairs the source once with
 * `npm ci` under a lock. Every step appends one JSON line to
 * <source>/.git/bridge-source-repair.jsonl (or <source>/bridge-source-
 * repair.jsonl when the source has no .git directory), the same location
 * rule worktree-doctor's repairLogPath applies:
 *
 *   {schema: 'phm.bridge.source-heal/1', at, event, ok, reason, tsgo, eslint}
 *
 *   - event 'probe'    — tools already worked; the common healthy case.
 *   - event 'repaired' — the source's toolchain was broken and `npm ci`
 *     fixed it. A success, but recurring repairs mean the source keeps
 *     losing its node_modules (lockfile drift, a cleanup pass, a partial
 *     install) often enough to churn every bridged worktree.
 *   - event 'failed'   — a repair was attempted and the tools still do not
 *     start ('repair ran but tools still do not start' or 'repair command
 *     failed'): the source's dependency tree is genuinely broken.
 *   - event 'skipped'  — no repair ran because another held the lock past
 *     the wait or the hourly repair cap applied: repairs are frequent
 *     enough to thrash.
 *
 * Until now the journal's only reader was `phm doctor worktree`, a report
 * someone had to run and read — the newest five lines for a person. A
 * source whose self-heal keeps failing or skipping never became work, even
 * though every new worktree inherits the broken toolchain and dies at
 * typecheck/lint. bridgeHealBacklogItems carries the recorded events into
 * discoverBacklog, so `phm improve discover` and the scheduler's
 * autoDiscover queue them exactly like the gate, autofix and worktree-reap
 * feeds beside it.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. The journal is read through readLedgerTail's bounded
 *    no-follow tail (BRIDGE_HEAL_TAIL_BYTES); the source checkout is
 *    resolved read-only through worktree-doctor's findSource (git
 *    rev-parse --git-common-dir) and repoIdentityOfPath (the checkout's
 *    own git config). Nothing is written and no repair is attempted.
 *  - Degraded evidence yields no items. A missing journal, an unresolvable
 *    source checkout, a source that cannot be proven to belong to the
 *    backlog's repository, an unreadable file, or zero valid rows inside
 *    the window all return no items — unknown stays unknown rather than
 *    becoming a guessed failure tally.
 *  - Recurring means recorded. An event kind emits only after
 *    BRIDGE_HEAL_RECURRING_EVENTS rows of that kind inside the window —
 *    the fleet's RECURRING_FAILURES convention — so a single unlucky
 *    repair never queues a session, and 'probe' rows (the healthy path)
 *    never emit at all.
 *  - The three kinds stay separate because they need different fixes:
 *    'failed' (the source's npm ci cannot produce working tools — fix the
 *    source's dependency provisioning), 'skipped' (repairs are frequent
 *    enough to hit the lock/hourly cap — find why the source keeps
 *    breaking), 'repaired' (self-heal succeeds but churns — the source's
 *    node_modules is unstable often enough to matter).
 *  - Truncation is stated, never hidden. When the bounded tail cut older
 *    rows, the prompt says the counts are a lower bound (the fleet-
 *    controller feed's convention).
 *  - Dedup is downstream. The item id embeds a stable hash of the event
 *    kind (never the counts), so a refresh re-derives the same id and
 *    appendUserBacklogItems adds only what is new.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { readLedgerTail, type LedgerTailRead } from '../router/outcomes.js';

/** Items one call may emit; there are only three event kinds. */
export const BRIDGE_HEAL_MAX_ITEMS = 3;
/**
 * Events inside the window an event kind needs before it counts as
 * recurring — the same absolute-evidence bar the gate and autofix folds
 * apply to breakage.
 */
export const BRIDGE_HEAL_RECURRING_EVENTS = 3;
/** Rolling evidence window, matching the autofix fold's 7-day convention. */
export const BRIDGE_HEAL_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Bounded tail of the repair journal; a `probe` row is small and heal events are infrequent. */
export const BRIDGE_HEAL_TAIL_BYTES = 256 * 1024;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** The fleet's own repository label: the bridge heals this repo's worktree source checkout. */
const FLEET_REPO_NAME = 'phantom';
/** Journal file name, relative to the resolved source checkout. */
const BRIDGE_HEAL_JOURNAL = 'bridge-source-repair.jsonl';
/** Event kinds that carry backlog signal, worst first. */
const SIGNAL_KINDS = ['failed', 'skipped', 'repaired'] as const;
type SignalKind = (typeof SIGNAL_KINDS)[number];

export interface BridgeHealItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Checkout the source is resolved from (default: process.cwd()). */
  root?: string;
  /** Direct journal path override (tests); skips source resolution and the repo match. */
  journalPath?: string;
  /** Bounded tail reader override (tests). */
  readTail?: (path: string) => Promise<LedgerTailRead>;
  /** Evaluation instant for the window (default: Date.now()). */
  now?: number;
  /** Most items one call emits (default BRIDGE_HEAL_MAX_ITEMS). */
  limit?: number;
}

interface HealRow {
  atMs: number;
  event: string;
}

/** The repository name both vocabularies record: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

/** One journal row, validated: a known event, a parseable timestamp, bounded reason text. */
function parseHealEntry(value: unknown): HealRow | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.schema !== 'phm.bridge.source-heal/1') return null;
  if (typeof row.event !== 'string' || row.event.length < 1 || row.event.length > 32) return null;
  if (typeof row.at !== 'string') return null;
  const atMs = Date.parse(row.at);
  if (!Number.isFinite(atMs)) return null;
  return { atMs, event: row.event };
}

/** Parse the bounded journal tail into validated rows inside the window. */
function parseHealJournal(text: string, now: number): { rows: HealRow[]; invalidRows: number } {
  const rows: HealRow[] = [];
  let invalidRows = 0;
  const cutoff = now - BRIDGE_HEAL_WINDOW_MS;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let value: unknown;
    try { value = JSON.parse(line); } catch { invalidRows++; continue; }
    const row = parseHealEntry(value);
    if (row === null) { invalidRows++; continue; }
    if (row.atMs >= cutoff) rows.push(row);
  }
  return { rows, invalidRows };
}

const KIND_TITLE: Record<SignalKind, string> = {
  failed: "Bridge source self-heal keeps failing",
  skipped: 'Bridge source self-heal keeps getting skipped',
  repaired: 'Bridge source keeps needing repair',
};

const KIND_PROMPT: Record<SignalKind, string> = {
  failed: 'the repair ran but tsgo/eslint still do not start in the source checkout — its dependency tree is genuinely broken',
  skipped: 'repairs are frequent enough to hit the lock wait or the hourly cap — the source keeps breaking faster than heal can fix it',
  repaired: 'self-heal succeeds but the source loses its working node_modules often enough to churn — find what keeps corrupting it',
};

function bridgeHealItem(kind: SignalKind, count: number, repo: string, truncated: boolean): CloudBacklogItem {
  const id = `bridge-heal-${createHash('sha256').update(`bridge-heal:${kind}`).digest('hex').slice(0, 16)}`;
  const bound = truncated ? ' (counts are a lower bound — the bounded journal tail cut older rows)' : '';
  const prompt = [
    `Phantom's worktree bridge source-checkout self-heal journal shows '${kind}' events recurring — every bridged worktree inherits the source's node_modules, so a chronically broken or unstable source toolchain is self-improvement work this backlog exists for.`,
    '',
    `${count} '${kind}' event(s) recorded inside the ${Math.round(BRIDGE_HEAL_WINDOW_MS / 86400000)}-day window${bound}: ${KIND_PROMPT[kind]}.`,
    '',
    `The journal is bridge-source-repair.jsonl inside the fleet source checkout's .git directory (or its root when there is no .git), written by scripts/bridge-heal.mjs on each bridge; \`phm doctor worktree\` reads the same file. Find whether the source checkout's dependency provisioning is at fault — a package-lock drift, a cleanup pass removing node_modules, a partial npm ci, or a heal lock/hourly cap set too tight — and fix the cause in this repository or the fleet's source-checkout maintenance. If the events were a transient window that no longer reproduces, report no-change and name the evidence.`,
  ].join('\n');
  return {
    id,
    title: KIND_TITLE[kind].slice(0, MAX_TITLE_CHARS),
    prompt,
    area: 'bridge-heal',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/** `owner/name` from a GitHub remote URL (https, ssh, git@), or null. */
function githubOwnerName(url: string): string | null {
  const m = /github\.com[:/]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

/** The checkout that owns `root`'s git data — its common dir's parent when that is a `.git`. */
function sourceCheckout(root: string): string | null {
  let common: string;
  try {
    common = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd: root, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch { return null; }
  if (common === '') return null;
  const dir = isAbsolute(common) ? common : resolve(root, common);
  return basename(dir) === '.git' ? dirname(dir) : null;
}

/** The source checkout's `owner/name` from its own git config, or null when unproven. */
function sourceRepoName(source: string): string | null {
  const config = join(source, '.git', 'config');
  let text: string;
  try {
    const stat = statSync(config);
    if (!stat.isFile() || stat.size > 1024 * 1024) return null;
    text = readFileSync(config, 'utf8');
  } catch { return null; }
  let inOrigin = false;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('[')) { inOrigin = /^\[remote\s+"origin"\]$/.test(line); continue; }
    if (!inOrigin) continue;
    const kv = /^url\s*=\s*(.+)$/.exec(line);
    if (kv) { const name = githubOwnerName(kv[1]!.trim()); if (name !== null) return name; }
  }
  return null;
}

/** Same location rule as scripts/bridge-heal.mjs healPaths(): inside .git when the source has one. */
function repairJournalPath(source: string): string {
  const git = join(source, '.git');
  try { return join(statSync(git).isDirectory() ? git : source, BRIDGE_HEAL_JOURNAL); }
  catch { return join(source, BRIDGE_HEAL_JOURNAL); }
}

/**
 * Resolve the fleet source checkout's repair journal for `repo`, or null when
 * it cannot be proven. The source is the checkout that owns this working
 * tree's git data; its identity is proven from its own git config, never
 * guessed from a path name.
 */
function resolveJournalPath(repo: string, opts: BridgeHealItemsOptions): string | null {
  if (opts.journalPath !== undefined) return opts.journalPath;
  const source = sourceCheckout(opts.root ?? process.cwd());
  if (source === null) return null;
  const identity = sourceRepoName(source);
  if (identity === null) return null;
  const want = repo.trim().toLowerCase();
  const got = identity.toLowerCase();
  if (got !== want && fleetRepoName(got) !== fleetRepoName(want)) return null;
  return repairJournalPath(source);
}

/**
 * Backlog items for the bridge source-heal journal's recurring failure,
 * skipped and repair-churn events. Total: any resolution, read or fold
 * failure yields no items rather than throwing into discovery.
 */
export async function bridgeHealBacklogItems(opts: BridgeHealItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const journalPath = resolveJournalPath(repo, opts);
    if (journalPath === null) return [];
    const read = await (opts.readTail ?? readLedgerTail)(journalPath, BRIDGE_HEAL_TAIL_BYTES);
    if (read.state !== 'read') return [];
    const now = opts.now ?? Date.now();
    const { rows } = parseHealJournal(read.text, now);
    if (rows.length === 0) return [];
    const counts = new Map<string, number>();
    for (const row of rows) counts.set(row.event, (counts.get(row.event) ?? 0) + 1);
    const limit = Math.max(1, Math.min(opts.limit ?? BRIDGE_HEAL_MAX_ITEMS, BRIDGE_HEAL_MAX_ITEMS));
    const items: CloudBacklogItem[] = [];
    for (const kind of SIGNAL_KINDS) {
      if (items.length >= limit) break;
      const count = counts.get(kind) ?? 0;
      if (count < BRIDGE_HEAL_RECURRING_EVENTS) continue;
      items.push(bridgeHealItem(kind, count, repo, read.state === 'read' && read.truncated));
    }
    return items;
  } catch {
    return [];
  }
}
