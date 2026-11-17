/**
 * M165: self-heal loop — detect broken build/test in enrolled repos and
 * auto-propose a HIGH-PRIORITY fix so the fleet moves forward.
 *
 * Philosophy: "easier to fix-forward than gate up front." When the fleet
 * breaks a repo it should immediately detect and queue a repair, not wait
 * on a human to notice.
 *
 * SAFETY / POSTURE:
 *  - Never throws — every failure is captured as metadata.
 *  - No secrets in output — VerifyCommandResult.output is already scrubbed.
 *  - Flag-gated: cfg.foundry?.selfHeal defaults TRUE (fix-forward posture).
 *    Set to false to disable.
 *  - Bounded: each repo is time-boxed (timeoutMs per command, default 90 s),
 *    each repo gets a per-item budget, and a cycle stops starting repos when
 *    its wall-clock budget runs out. A persisted cursor resumes the next cycle
 *    at the first repo this one did not reach, so a large enrollment is
 *    covered over several ticks instead of timing out every tick.
 *  - Proposal-only: proposeHeal returns a WorkItem for the backlog; nothing
 *    is applied or merged here.
 */

import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import type { AshlrConfig, WorkItem } from '../types.js';
import {
  canonicalEnrollmentPath,
  isEnrolled,
  killSwitchOn,
  listEnrolled,
} from '../sandbox/policy.js';
import {
  acquireOutwardMutationFence,
  ownsOutwardMutationFence,
  releaseOutwardMutationFence,
  type OutwardMutationFence,
} from '../sandbox/mutation-fence.js';
import {
  detectVerifyCommands,
  runVerifyCommandAsync,
} from '../run/verify-commands.js';
import {
  isActionableSelfHealFailureText,
  isActionableSelfHealItem,
} from './self-heal-trust.js';
import { acquireLocalStoreLock, releaseLocalStoreLock } from './local-store-lock.js';
export { pruneQueuedSelfHealItems } from './self-heal-queue-prune.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BreakageResult {
  broken: boolean;
  /** True only when the repo had verify commands and every checked command produced a trustworthy result. */
  verified?: boolean;
  /** Verification kinds proven green before the first failure. */
  clearedKinds?: Array<'build' | 'test'>;
  kind?: 'build' | 'test';
  /** First non-blank failure line from the command output, capped at 200 chars. */
  detail?: string;
  reason?: 'no-verify-commands' | 'detect-error' | 'untrusted-verify-result';
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract the first meaningful failure line from command output.
 * Prefers lines with "error", "fail", or "FAIL" to cut through noise.
 */
function firstFailureLine(output: string): string {
  const lines = output.split('\n').map(l => l.trim()).filter(Boolean);
  // M341: a PASSING line whose test NAME contains "error"/"failure" must never
  // be quoted as the failure — "(pass) … handles success and failure cases"
  // and "ok 56 … without error" were being fed to fleet workers as the broken
  // test, producing unfixable self-heal items.
  const isPassLine = (l: string) => /^\((pass|skip|todo)\)|^ok \d|^[✓√]|\bpassed\b/i.test(l);
  const candidates = lines.filter((l) => !isPassLine(l));
  // Strong failure markers first (bun/tap/vitest), then the generic match.
  const errorLine =
    candidates.find((l) => /^\(fail\)|^not ok\b|^[✗×]|\bFAIL\b|\bERROR\b/.test(l)) ??
    candidates.find((l) => /error|fail/i.test(l));
  const chosen = errorLine ?? lines[0] ?? 'unknown failure';
  return chosen.slice(0, 200);
}

/** Map VerifyCommand kind to 'build' | 'test'. */
function kindOf(vcKind: string): 'build' | 'test' {
  return vcKind === 'test' ? 'test' : 'build';
}

/** Stable deterministic id for a self-heal WorkItem. */
function selfHealId(repo: string, breakageKind: string): string {
  const hash = createHash('sha1')
    .update(`${repo}:self-heal:${breakageKind}`)
    .digest('hex')
    .slice(0, 12);
  return `${basename(repo)}:self-heal:${hash}`;
}

// ---------------------------------------------------------------------------
// detectBreakage
// ---------------------------------------------------------------------------

/**
 * Run the repo's build + test commands and detect whether any are RED.
 *
 * - Uses detectVerifyCommands to find commands (typecheck / lint / build / test).
 * - Degrades gracefully: if no commands are detected, returns { broken: false }.
 * - Time-boxed per command (default 90 s; short to keep the cycle snappy).
 * - Never throws.
 */
export interface DetectBreakageOptions {
  signal?: AbortSignal;
  /**
   * Wall-clock budget for this repo's whole check. Each command's timeout is
   * capped at what is left of it; a repo that runs out is reported unverified
   * (`untrusted-verify-result`), never green.
   */
  budgetMs?: number;
  /** Test seam for the budget clock. */
  now?: () => number;
}

export async function detectBreakage(
  repoDir: string,
  cfg?: Pick<AshlrConfig, 'foundry'>,
  opts?: DetectBreakageOptions,
): Promise<BreakageResult> {
  try {
    const commands = detectVerifyCommands(repoDir, 'quick');
    if (commands.length === 0) {
      return { broken: false, verified: false, reason: 'no-verify-commands' };
    }

    // Per-command timeout: use cfg.foundry.timeoutMs if set, else 90 s (shorter
    // than the M43 default of 120 s so the self-heal cycle stays snappy).
    const timeoutMs = Math.min(
      cfg?.foundry?.timeoutMs ?? 90_000,
      90_000,
    );
    const now = opts?.now ?? Date.now;
    const deadlineAtMs = typeof opts?.budgetMs === 'number' && Number.isFinite(opts.budgetMs)
      ? now() + Math.max(0, opts.budgetMs)
      : Number.POSITIVE_INFINITY;
    const clearedKinds = new Set<'build' | 'test'>();

    for (const vc of commands) {
      if (opts?.signal?.aborted) {
        return { broken: false, verified: false, reason: 'detect-error' };
      }
      const remainingMs = deadlineAtMs - now();
      if (remainingMs < 1_000) {
        return {
          broken: false,
          verified: false,
          clearedKinds: Array.from(clearedKinds),
          reason: 'untrusted-verify-result',
        };
      }
      const kind = kindOf(vc.kind);
      const result = await runVerifyCommandAsync(vc, repoDir, cfg as AshlrConfig ?? {} as AshlrConfig, {
        timeoutMs: Math.max(1_000, Math.min(timeoutMs, Math.floor(remainingMs))),
        ...(opts?.signal ? { signal: opts.signal } : {}),
      });
      if (!result.ok) {
        if (vc.required === false) continue;
        const failureCategory = result.failureCategory ?? 'code';
        if (failureCategory !== 'code') {
          return {
            broken: false,
            verified: false,
            clearedKinds: Array.from(clearedKinds),
            reason: 'untrusted-verify-result',
          };
        }
        const detail = firstFailureLine(result.output);
        if (!isActionableSelfHealFailureText(detail)) {
          return {
            broken: false,
            verified: false,
            clearedKinds: Array.from(clearedKinds),
            reason: 'untrusted-verify-result',
          };
        }
        return {
          broken: true,
          verified: true,
          clearedKinds: Array.from(clearedKinds),
          kind,
          detail,
        };
      }
      clearedKinds.add(kind);
    }

    return { broken: false, verified: true, clearedKinds: Array.from(clearedKinds) };
  } catch {
    // Never throw, but do not treat detector failures as proven green.
    return { broken: false, verified: false, reason: 'detect-error' };
  }
}

// ---------------------------------------------------------------------------
// proposeHeal
// ---------------------------------------------------------------------------

/**
 * Build a HIGH-PRIORITY WorkItem that tells the fleet to fix the broken repo.
 *
 * Score: value=5 / effort=1 = 5.0 — top of the backlog, jumps the queue.
 * Source: 'self-heal' would be ideal but WorkSource is a fixed union; 'self'
 * is the closest existing value (M54: "the fleet's own backlog").
 */
export function proposeHeal(
  repoDir: string,
  breakage: BreakageResult,
  _cfg?: Pick<AshlrConfig, 'foundry'>,
): WorkItem {
  const kind = breakage.kind ?? 'build';
  const repoName = basename(repoDir);
  const detail = breakage.detail ?? 'unknown failure';

  const title = `Fix broken ${kind} in ${repoName}: ${detail}`;
  const fullDetail =
    `Self-heal: ${kind} is RED in ${repoDir}.\n` +
    `First failure: ${detail}\n` +
    `Investigate the failing command, fix the root cause, and verify the suite passes.`;

  // value=5 effort=1 → score=5 (highest possible)
  const value = 5;
  const effort = 1;
  const score = value / Math.max(1, effort); // = 5

  return {
    id: selfHealId(repoDir, kind),
    repo: repoDir,
    source: 'self',
    title,
    detail: fullDetail,
    value,
    effort,
    score,
    tags: ['self-heal', kind, 'high-priority'],
    ts: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// runSelfHealCycle
// ---------------------------------------------------------------------------

export interface SelfHealCycleResult {
  checked: number;
  checkedRepos: string[];
  broken: string[];
  healItems: WorkItem[];
  /** Repos this cycle did not reach because its budget ran out; the cursor resumes at them. */
  deferred?: number;
  /** True when the cycle stopped on its wall-clock budget rather than finishing the list. */
  budgetExhausted?: boolean;
}

/**
 * Wall-clock budget for one self-heal cycle. The daemon runs self-heal inside
 * the 5-minute maintenance phase (TICK_PHASE_MAINTENANCE_MS); the cycle stops
 * starting repos well before that deadline so the phase settles `ok`.
 */
export const SELF_HEAL_CYCLE_BUDGET_MS = 2 * 60_000;
/** Per-repo (per-item) budget: one slow repo cannot consume the whole cycle. */
export const SELF_HEAL_REPO_BUDGET_MS = 2 * 60_000;
/** A repo is not started with less than this left in the cycle budget. */
export const SELF_HEAL_MIN_REPO_BUDGET_MS = 15_000;

function selfHealCursorPath(): string {
  return join(homedir(), '.ashlr', 'self-heal-cursor.json');
}

/** The last repo a cycle finished checking, or null. Never throws. */
export function readSelfHealCursor(): string | null {
  try {
    const parsed = JSON.parse(readFileSync(selfHealCursorPath(), 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const last = (parsed as Record<string, unknown>).lastChecked;
    return typeof last === 'string' && last.length > 0 ? last : null;
  } catch {
    return null;
  }
}

function writeSelfHealCursor(lastChecked: string): void {
  try {
    const dir = join(homedir(), '.ashlr');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeJsonAtomic(selfHealCursorPath(), { v: 1, lastChecked, at: new Date().toISOString() });
  } catch {
    // Best-effort: a lost cursor restarts the rotation at the first repo.
  }
}

/** Rotate `repos` to start just after the cursor's repo, so every cycle makes forward progress. */
function rotateFromCursor(repos: string[], lastChecked: string | null): string[] {
  if (lastChecked === null) return repos;
  const index = repos.indexOf(lastChecked);
  if (index < 0) return repos;
  return [...repos.slice(index + 1), ...repos.slice(0, index + 1)];
}

/** Absolute path to the self-heal queue file under ~/.ashlr/. */
function selfHealQueuePath(): string {
  return join(homedir(), '.ashlr', 'self-heal-queue.json');
}

function backlogPath(): string {
  return join(homedir(), '.ashlr', 'backlog.json');
}

function readWorkItemsArrayStrict(
  filePath: string,
): { ok: true; items: WorkItem[] } | { ok: false } {
  try {
    if (!existsSync(filePath)) return { ok: true, items: [] };
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
    if (!Array.isArray(parsed)) return { ok: false };
    return { ok: true, items: parsed as WorkItem[] };
  } catch {
    return { ok: false };
  }
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  const tmp = `${filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  renameSync(tmp, filePath);
}

function queueLockPath(): string {
  return join(homedir(), '.ashlr', '.self-heal-queue.lock');
}

export function withSelfHealQueueLock<T>(fn: () => T): { ok: true; value: T } | { ok: false } {
  const lock = acquireLocalStoreLock(queueLockPath());
  if (!lock) return { ok: false };
  try {
    return { ok: true, value: fn() };
  } finally {
    releaseLocalStoreLock(lock);
  }
}

function isSelfHealItemForRepo(
  value: unknown,
  repoKey: string,
  kinds?: ReadonlySet<'build' | 'test'>,
): boolean {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<WorkItem>;
  if (typeof item.repo !== 'string') return false;
  if (!Array.isArray(item.tags) || !item.tags.includes('self-heal')) return false;
  // Proposal-repair work has its own generation-aware terminal lifecycle.
  // A green repository must not erase a still-active repair attempt.
  if (item.tags.includes('proposal-repair')) return false;
  if (kinds && !item.tags.some((tag) => kinds.has(tag as 'build' | 'test'))) return false;
  try {
    return resolve(item.repo) === repoKey;
  } catch {
    return false;
  }
}

function invalidSelfHealItem(value: unknown, enrolledRepoKeys: ReadonlySet<string>): boolean {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<WorkItem>;
  if (!Array.isArray(item.tags) || !item.tags.includes('self-heal')) return false;
  if (typeof item.repo !== 'string') return true;
  if (
    typeof item.id !== 'string' ||
    typeof item.source !== 'string' ||
    typeof item.title !== 'string' ||
    typeof item.detail !== 'string' ||
    typeof item.value !== 'number' ||
    typeof item.effort !== 'number' ||
    typeof item.score !== 'number' ||
    typeof item.ts !== 'string'
  ) return true;
  try {
    const repoKey = resolve(item.repo);
    return !enrolledRepoKeys.has(repoKey) ||
      !existsSync(item.repo) ||
      !isActionableSelfHealItem(item as WorkItem);
  } catch {
    return true;
  }
}

function pruneSelfHealItemsFromQueue(
  repoDir: string,
  kinds?: ReadonlySet<'build' | 'test'>,
  canPersist: () => boolean = () => true,
): number {
  try {
    const qPath = selfHealQueuePath();
    const read = readWorkItemsArrayStrict(qPath);
    if (!read.ok) return 0;
    const existing = read.items;
    if (existing.length === 0) return 0;
    const repoKey = resolve(repoDir);
    const filtered = existing.filter((item) => !isSelfHealItemForRepo(item, repoKey, kinds));
    const removed = existing.length - filtered.length;
    if (removed > 0) {
      if (!canPersist()) return 0;
      writeJsonAtomic(qPath, filtered);
    }
    return removed;
  } catch {
    return 0;
  }
}

function pruneSelfHealItemsFromBacklog(
  repoDir: string,
  kinds?: ReadonlySet<'build' | 'test'>,
  canPersist: () => boolean = () => true,
): number {
  try {
    const bPath = backlogPath();
    if (!existsSync(bPath)) return 0;
    const parsed = JSON.parse(readFileSync(bPath, 'utf8')) as unknown;
    const repoKey = resolve(repoDir);

    if (Array.isArray(parsed)) {
      const filtered = parsed.filter((item) => !isSelfHealItemForRepo(item, repoKey, kinds));
      const removed = parsed.length - filtered.length;
      if (removed > 0) {
        if (!canPersist()) return 0;
        writeJsonAtomic(bPath, filtered);
      }
      return removed;
    }

    if (
      parsed &&
      typeof parsed === 'object' &&
      Array.isArray((parsed as { items?: unknown }).items)
    ) {
      const envelope = parsed as { items: unknown[] };
      const filtered = envelope.items.filter((item) => !isSelfHealItemForRepo(item, repoKey, kinds));
      const removed = envelope.items.length - filtered.length;
      if (removed > 0) {
        if (!canPersist()) return 0;
        writeJsonAtomic(bPath, { ...parsed, items: filtered });
      }
      return removed;
    }

    return 0;
  } catch {
    return 0;
  }
}

function pruneStaleSelfHealItems(
  repoDir: string,
  kinds?: Array<'build' | 'test'>,
  canPersist: () => boolean = () => true,
): number {
  const kindSet = kinds && kinds.length > 0 ? new Set(kinds) : undefined;
  const locked = withSelfHealQueueLock(() =>
    pruneSelfHealItemsFromQueue(repoDir, kindSet, canPersist) +
    pruneSelfHealItemsFromBacklog(repoDir, kindSet, canPersist));
  return locked.ok ? locked.value : 0;
}

function recordPrunedRepos(before: unknown[], after: unknown[], repos?: Set<string>): void {
  if (!repos) return;
  const retained = new Set(after);
  for (const item of before) {
    if (retained.has(item) || !item || typeof item !== 'object') continue;
    const repo = (item as { repo?: unknown }).repo;
    if (typeof repo === 'string') repos.add(resolve(repo));
  }
}

function pruneInvalidSelfHealItemsUnlocked(
  repos: string[],
  canPersist: () => boolean = () => true,
  checkedRepos?: Set<string>,
): number {
  const enrolledRepoKeys = new Set<string>();
  for (const repo of repos) {
    try { enrolledRepoKeys.add(resolve(repo)); } catch { /* ignore invalid registry entries */ }
  }

  let removed = 0;
  try {
    const qPath = selfHealQueuePath();
    const read = readWorkItemsArrayStrict(qPath);
    if (!read.ok) throw new Error('self-heal queue is malformed');
    const existing = read.items;
    if (existing.length > 0) {
      const filtered = existing.filter((item) => !invalidSelfHealItem(item, enrolledRepoKeys));
      const removedFromQueue = existing.length - filtered.length;
      if (filtered.length !== existing.length) {
        if (!canPersist()) return removed;
        writeJsonAtomic(qPath, filtered);
        recordPrunedRepos(existing, filtered, checkedRepos);
        removed += removedFromQueue;
      }
    }
  } catch {
    // Best-effort only.
  }

  try {
    const bPath = backlogPath();
    if (!existsSync(bPath)) return removed;
    const parsed = JSON.parse(readFileSync(bPath, 'utf8')) as unknown;
    if (Array.isArray(parsed)) {
      const filtered = parsed.filter((item) => !invalidSelfHealItem(item, enrolledRepoKeys));
      const removedFromBacklog = parsed.length - filtered.length;
      if (filtered.length !== parsed.length) {
        if (!canPersist()) return removed;
        writeJsonAtomic(bPath, filtered);
        recordPrunedRepos(parsed, filtered, checkedRepos);
        removed += removedFromBacklog;
      }
    } else if (
      parsed &&
      typeof parsed === 'object' &&
      Array.isArray((parsed as { items?: unknown }).items)
    ) {
      const envelope = parsed as { items: unknown[] };
      const filtered = envelope.items.filter((item) => !invalidSelfHealItem(item, enrolledRepoKeys));
      const removedFromBacklog = envelope.items.length - filtered.length;
      if (filtered.length !== envelope.items.length) {
        if (!canPersist()) return removed;
        writeJsonAtomic(bPath, { ...parsed, items: filtered });
        recordPrunedRepos(envelope.items, filtered, checkedRepos);
        removed += removedFromBacklog;
      }
    }
  } catch {
    // Best-effort only.
  }

  return removed;
}

function pruneInvalidSelfHealItems(
  repos: string[],
  canPersist: () => boolean = () => true,
  checkedRepos?: Set<string>,
): number {
  const locked = withSelfHealQueueLock(() => pruneInvalidSelfHealItemsUnlocked(repos, canPersist, checkedRepos));
  return locked.ok ? locked.value : 0;
}

function targetedInvalidSelfHealItem(
  value: unknown,
  targetRepoKeys: ReadonlySet<string>,
  enrolledRepoKeys: ReadonlySet<string>,
): boolean {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<WorkItem>;
  if (!Array.isArray(item.tags) || !item.tags.includes('self-heal')) return false;
  if (typeof item.repo !== 'string') return false;
  try {
    if (!targetRepoKeys.has(resolve(item.repo))) return false;
    return invalidSelfHealItem(value, enrolledRepoKeys);
  } catch {
    return false;
  }
}

function pruneInvalidSelfHealItemsForReposUnlocked(
  targetRepos: string[],
  enrolled: string[],
  canPersist: () => boolean = () => true,
  checkedRepos?: Set<string>,
): number {
  const targetRepoKeys = new Set<string>();
  for (const repo of targetRepos) {
    try { targetRepoKeys.add(resolve(repo)); } catch { /* ignore malformed target rows */ }
  }
  if (targetRepoKeys.size === 0) return 0;

  const enrolledRepoKeys = new Set<string>();
  for (const repo of enrolled) {
    try { enrolledRepoKeys.add(resolve(repo)); } catch { /* ignore invalid registry entries */ }
  }

  let removed = 0;
  try {
    const qPath = selfHealQueuePath();
    const read = readWorkItemsArrayStrict(qPath);
    if (!read.ok) return 0;
    const existing = read.items;
    if (existing.length > 0) {
      const filtered = existing.filter((item) => !targetedInvalidSelfHealItem(item, targetRepoKeys, enrolledRepoKeys));
      const removedFromQueue = existing.length - filtered.length;
      if (filtered.length !== existing.length) {
        if (!canPersist()) return removed;
        writeJsonAtomic(qPath, filtered);
        recordPrunedRepos(existing, filtered, checkedRepos);
        removed += removedFromQueue;
      }
    }
  } catch {
    // Best-effort only.
  }

  try {
    const bPath = backlogPath();
    if (!existsSync(bPath)) return removed;
    const parsed = JSON.parse(readFileSync(bPath, 'utf8')) as unknown;
    if (Array.isArray(parsed)) {
      const filtered = parsed.filter((item) => !targetedInvalidSelfHealItem(item, targetRepoKeys, enrolledRepoKeys));
      const removedFromBacklog = parsed.length - filtered.length;
      if (filtered.length !== parsed.length) {
        if (!canPersist()) return removed;
        writeJsonAtomic(bPath, filtered);
        recordPrunedRepos(parsed, filtered, checkedRepos);
        removed += removedFromBacklog;
      }
    } else if (
      parsed &&
      typeof parsed === 'object' &&
      Array.isArray((parsed as { items?: unknown }).items)
    ) {
      const envelope = parsed as { items: unknown[] };
      const filtered = envelope.items.filter((item) => !targetedInvalidSelfHealItem(item, targetRepoKeys, enrolledRepoKeys));
      const removedFromBacklog = envelope.items.length - filtered.length;
      if (filtered.length !== envelope.items.length) {
        if (!canPersist()) return removed;
        writeJsonAtomic(bPath, { ...parsed, items: filtered });
        recordPrunedRepos(envelope.items, filtered, checkedRepos);
        removed += removedFromBacklog;
      }
    }
  } catch {
    // Best-effort only.
  }

  return removed;
}

function pruneInvalidSelfHealItemsForRepos(
  targetRepos: string[],
  enrolled: string[],
  canPersist: () => boolean = () => true,
  checkedRepos?: Set<string>,
): number {
  const locked = withSelfHealQueueLock(() =>
    pruneInvalidSelfHealItemsForReposUnlocked(targetRepos, enrolled, canPersist, checkedRepos));
  return locked.ok ? locked.value : 0;
}

/**
 * Queue a heal item to disk so the fleet daemon picks it up on the next tick
 * ahead of other work. Best-effort — failure here must never abort the cycle.
 */
export function queueSelfHealItem(item: WorkItem): boolean {
  return queueSelfHealItemDetailed(item).ok;
}

export interface QueueSelfHealItemResult {
  ok: boolean;
  changed: boolean;
}

export function queueSelfHealItemDetailed(
  item: WorkItem,
  opts: { beforeWrite?: () => boolean } = {},
): QueueSelfHealItemResult {
  const lock = acquireLocalStoreLock(queueLockPath());
  if (!lock) return { ok: false, changed: false };
  try {
    if (opts.beforeWrite && !opts.beforeWrite()) return { ok: false, changed: false };
    const qPath = selfHealQueuePath();
    const dir = join(homedir(), '.ashlr');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const read = readWorkItemsArrayStrict(qPath);
    if (!read.ok) throw new Error('self-heal queue is malformed');
    const existing = read.items;
    const current = existing.find((candidate) => candidate.id === item.id);
    if (current && JSON.stringify(current) === JSON.stringify(item)) {
      return { ok: true, changed: false };
    }

    // Replace existing entry for same id (idempotent)
    const filtered = existing.filter(i => i.id !== item.id);
    filtered.unshift(item); // high-priority: front of queue

    if (opts.beforeWrite && !opts.beforeWrite()) return { ok: false, changed: false };
    writeJsonAtomic(qPath, filtered);
    return { ok: true, changed: true };
  } catch {
    // Best-effort — never propagate
    return { ok: false, changed: false };
  } finally {
    releaseLocalStoreLock(lock);
  }
}

function persistHealItem(item: WorkItem, canPersist: () => boolean): void {
  queueSelfHealItemDetailed(item, { beforeWrite: canPersist });
}

function uniqueEnrolledTargets(repos: string[], enrolled: string[]): string[] {
  const enrolledByKey = new Map<string, string>();
  for (const repo of enrolled) {
    const key = canonicalEnrollmentPath(repo);
    // Canonicalize only the caller's current target. A legacy registry alias
    // must not be promoted into enrollment authority by resolving it here.
    if (key === repo) enrolledByKey.set(key, repo);
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const repo of repos) {
    const key = canonicalEnrollmentPath(repo);
    if (!key) continue;
    const enrolledRepo = enrolledByKey.get(key);
    if (!enrolledRepo || seen.has(key)) continue;
    seen.add(key);
    out.push(enrolledRepo);
  }
  return out;
}

async function runSelfHealCycleForRepoList(
  repos: string[],
  cfg: Pick<AshlrConfig, 'foundry'> | undefined,
  authority: OutwardMutationFence | undefined,
  opts: SelfHealCycleOptions,
  checkedRepos: Set<string>,
): Promise<SelfHealCycleResult> {
  const { signal } = opts;
  const now = opts.now ?? Date.now;
  const cycleBudgetMs = opts.budgetMs ?? SELF_HEAL_CYCLE_BUDGET_MS;
  const repoBudgetMs = opts.perRepoBudgetMs ?? SELF_HEAL_REPO_BUDGET_MS;
  const cycleDeadlineMs = now() + Math.max(0, cycleBudgetMs);
  const broken: string[] = [];
  const healItems: WorkItem[] = [];
  const authorized = (repo: string): boolean =>
    ownsOutwardMutationFence(authority) && !killSwitchOn() && isEnrolled(repo) && !signal?.aborted;

  const ordered = rotateFromCursor(repos, readSelfHealCursor());
  let checked = 0;
  let budgetExhausted = false;
  for (const repo of ordered) {
    const remainingMs = cycleDeadlineMs - now();
    if (remainingMs < SELF_HEAL_MIN_REPO_BUDGET_MS) {
      budgetExhausted = true;
      break;
    }
    if (signal?.aborted) break;
    checked++;
    try {
      if (!authorized(repo)) continue;
      checkedRepos.add(repo);
      const result = await detectBreakage(repo, cfg, {
        ...(signal ? { signal } : {}),
        budgetMs: Math.min(repoBudgetMs, remainingMs),
        now,
      });
      // The cursor names the last repo reached, so the next cycle starts after it.
      if (!signal?.aborted) writeSelfHealCursor(repo);
      if (!authorized(repo)) continue;
      if (result.broken) {
        pruneStaleSelfHealItems(repo, undefined, () => authorized(repo));
        if (!authorized(repo)) continue;
        broken.push(repo);
        const item = proposeHeal(repo, result, cfg);
        healItems.push(item);
        persistHealItem(item, () => authorized(repo));
      } else if (result.verified === true) {
        pruneStaleSelfHealItems(repo, undefined, () => authorized(repo));
      } else if (result.clearedKinds && result.clearedKinds.length > 0) {
        pruneStaleSelfHealItems(repo, result.clearedKinds, () => authorized(repo));
      }
    } catch {
      // Per-repo errors never abort the cycle.
    }
  }

  const deferred = ordered.length - checked;
  return {
    checked,
    checkedRepos: [...checkedRepos],
    broken,
    healItems,
    ...(deferred > 0 ? { deferred } : {}),
    ...(budgetExhausted ? { budgetExhausted } : {}),
  };
}

export interface SelfHealCycleOptions {
  /** Borrow authority from a caller that already owns the outward fence. */
  authority?: OutwardMutationFence;
  /**
   * RQ-DAEMONTICK-UNBLOCK: the calling tick phase's signal. Aborting stops the
   * repo scan and cancels the in-flight verify command (its process group is
   * killed by the verify runner's own teardown).
   */
  signal?: AbortSignal;
  /** Wall-clock budget for the whole cycle (default SELF_HEAL_CYCLE_BUDGET_MS). */
  budgetMs?: number;
  /** Per-repo budget (default SELF_HEAL_REPO_BUDGET_MS). */
  perRepoBudgetMs?: number;
  /** Test seam for the budget clock. */
  now?: () => number;
}

function selfHealAuthority(
  opts: SelfHealCycleOptions,
): { authority: OutwardMutationFence | null | undefined; borrowed: boolean } {
  const borrowed = Object.prototype.hasOwnProperty.call(opts, 'authority');
  return {
    authority: borrowed ? opts.authority : acquireOutwardMutationFence(),
    borrowed,
  };
}

export async function runSelfHealCycleForRepos(
  repos: string[],
  cfg?: Pick<AshlrConfig, 'foundry'>,
  opts: SelfHealCycleOptions = {},
): Promise<SelfHealCycleResult> {
  let lifecycle: ReturnType<typeof selfHealAuthority> | undefined;
  try {
    const enabled = (cfg?.foundry as Record<string, unknown> | undefined)?.selfHeal !== false;
    if (!enabled) return { checked: 0, checkedRepos: [], broken: [], healItems: [] };

    lifecycle = selfHealAuthority(opts);
    const authority = lifecycle.authority;
    if (!authority || !ownsOutwardMutationFence(authority) || killSwitchOn()) {
      return { checked: 0, checkedRepos: [], broken: [], healItems: [] };
    }
    const enrolled = listEnrolled();
    const targets = uniqueEnrolledTargets(repos, enrolled);
    if (targets.length === 0) return { checked: 0, checkedRepos: [], broken: [], healItems: [] };
    const authorizedTargets = (): boolean =>
      ownsOutwardMutationFence(lifecycle?.authority) && !killSwitchOn() &&
      targets.every((repo) => isEnrolled(repo));
    const checkedRepos = new Set<string>();
    pruneInvalidSelfHealItemsForRepos(targets, enrolled, authorizedTargets, checkedRepos);
    if (!authorizedTargets()) return { checked: 0, checkedRepos: [], broken: [], healItems: [] };
    return await runSelfHealCycleForRepoList(targets, cfg, authority, opts, checkedRepos);
  } catch {
    return { checked: 0, checkedRepos: [], broken: [], healItems: [] };
  } finally {
    if (lifecycle && !lifecycle.borrowed) releaseOutwardMutationFence(lifecycle.authority);
  }
}

/**
 * Iterate every enrolled repo, detect breakage, propose heals for broken ones,
 * and queue them for the next fleet tick.
 *
 * - Flag-gated: skipped entirely when cfg.foundry?.selfHeal === false.
 * - Default is TRUE (fix-forward posture).
 * - Bounded: repos processed sequentially (avoids overwhelming the machine),
 *   within the cycle budget; the cursor resumes the next cycle where this one stopped.
 * - Never throws.
 */
export async function runSelfHealCycle(
  cfg?: Pick<AshlrConfig, 'foundry'>,
  opts: SelfHealCycleOptions = {},
): Promise<SelfHealCycleResult> {
  let lifecycle: ReturnType<typeof selfHealAuthority> | undefined;
  try {
    // Flag gate — default TRUE
    const enabled = (cfg?.foundry as Record<string, unknown> | undefined)?.selfHeal !== false;
    if (!enabled) {
      return { checked: 0, checkedRepos: [], broken: [], healItems: [] };
    }

    lifecycle = selfHealAuthority(opts);
    const authority = lifecycle.authority;
    if (!authority || !ownsOutwardMutationFence(authority) || killSwitchOn()) {
      return { checked: 0, checkedRepos: [], broken: [], healItems: [] };
    }
    const repos = listEnrolled();
    const authorizedCycle = (): boolean =>
      ownsOutwardMutationFence(lifecycle?.authority) && !killSwitchOn();
    const checkedRepos = new Set<string>();
    pruneInvalidSelfHealItems(repos, authorizedCycle, checkedRepos);
    if (!authorizedCycle()) return { checked: 0, checkedRepos: [], broken: [], healItems: [] };
    return await runSelfHealCycleForRepoList(repos, cfg, authority, opts, checkedRepos);
  } catch {
    return { checked: 0, checkedRepos: [], broken: [], healItems: [] };
  } finally {
    if (lifecycle && !lifecycle.borrowed) releaseOutwardMutationFence(lifecycle.authority);
  }
}
