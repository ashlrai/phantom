/**
 * `ashlr fleet dirty-landed` — READ-ONLY triage for open conflicting PRs.
 *
 * For every open PR GitHub calls conflicting (`mergeable` CONFLICTING or
 * `mergeStateStatus` DIRTY), the paths the PR changes are compared with the
 * tip of its base branch (master for every fleet PR) and the PR is classified:
 *
 *   landed        — every changed path already matches the base tip: the work
 *                   shipped some other way and the PR adds nothing
 *   partly-landed — some changed paths match the base tip, some still differ:
 *                   only the remaining paths need a recut
 *   needs-recut   — no changed path matches the base tip: the conflict is real
 *                   and the whole change still has to land
 *   unknown       — a read failed (bad row, fetch, moved head, merge-base,
 *                   diff): the PR is never guessed at
 *
 * Changed paths come from `git diff merge-base head` and the still-differing
 * set from `git diff base head`; a changed path absent from the tip diff is
 * identical on both sides, which means it already landed. Git objects and
 * scratch refs live in a temporary bare repository — the host repository and
 * GitHub state are never written.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CloudGh } from '../core/cloud/pr-actions.js';
import { defaultGitRunner } from '../core/verse/git-ops.js';

const REPO = 'ashlrai/phantom';
const REMOTE = 'https://github.com/ashlrai/phantom.git';
const USAGE = 'Usage: ashlr fleet dirty-landed [--json] [--limit N]';
const GH_LIST_FIELDS = 'number,title,mergeable,mergeStateStatus,headRefOid,baseRefName';
const SHA = /^[0-9a-f]{40}$/;
const MAX_TITLE = 200;
const GIT_TIMEOUT_MS = 60_000;
const GIT_MAX_BYTES = 16 * 1024 * 1024;

/** The one obvious next step for a dirty PR. */
export type DirtyLandedClass = 'landed' | 'partly-landed' | 'needs-recut' | 'unknown';

export interface DirtyLandedPr {
  number: number;
  title: string;
  /** Pinned head from the `gh pr list` read; '' when the row did not carry one. */
  head: string;
  /** The PR's base branch (`master` for every fleet PR); '' when unreadable. */
  base: string;
  class: DirtyLandedClass;
  /** Paths the PR changes relative to its merge-base. */
  changedPaths: string[];
  /** Changed paths whose head content already matches the base tip. */
  landedPaths: string[];
  /** Changed paths whose head content still differs from the base tip. */
  remainingPaths: string[];
  /** Fixed machine token explaining an `unknown` class — never stderr text. */
  reason?: string;
}

export interface DirtyLandedReport {
  schema: 'fleet.dirty-landed.v1';
  repo: string;
  generatedAt: string;
  /** Open PRs the list read returned. */
  open: number;
  /** Of those, the conflicting ones this command classified. */
  dirty: number;
  /** False when the list hit the --limit page size and dirty PRs may be unseen. */
  complete: boolean;
  counts: Record<DirtyLandedClass, number>;
  prs: DirtyLandedPr[];
}

export interface FleetDirtyLandedDeps {
  /** gh reader; defaults to the bounded production runner. */
  gh?: CloudGh;
  /** Remote the scratch repo fetches base/pull refs from (tests inject a local repo). */
  remote?: string;
  now?: () => Date;
}

interface DirtyRow {
  number: number;
  title: string;
  mergeable: string;
  mergeStateStatus: string;
  headSha: string;
  baseRef: string;
}

/** A row counts as conflicting the way classifyFleetPrGh reads conflict. */
function isConflicting(row: DirtyRow): boolean {
  return row.mergeable === 'CONFLICTING' || row.mergeStateStatus === 'DIRTY';
}

/** PURE: the class of one dirty PR from its changed paths vs the base tip. */
export function classifyDirtyLanded(changedPaths: readonly string[], stillDiffering: ReadonlySet<string>): DirtyLandedClass {
  const remaining = changedPaths.filter(path => stillDiffering.has(path));
  if (remaining.length === 0) return 'landed';
  return remaining.length === changedPaths.length ? 'needs-recut' : 'partly-landed';
}

async function git(dir: string, args: string[], maxStdoutBytes = GIT_MAX_BYTES) {
  return defaultGitRunner('git', args, { cwd: dir, timeoutMs: GIT_TIMEOUT_MS, maxStdoutBytes });
}

/** NUL-delimited `git diff --name-only`; null when the diff cannot be read. */
async function diffPaths(dir: string, a: string, b: string): Promise<string[] | null> {
  const diff = await git(dir, ['diff', '--name-only', '-z', a, b]);
  if (diff.code !== 0 || diff.timedOut || diff.truncated) return null;
  return diff.stdout.split('\0').filter(path => path.length > 0);
}

function unknown(row: DirtyRow, reason: string): DirtyLandedPr {
  return {
    number: row.number, title: row.title, head: row.headSha, base: row.baseRef,
    class: 'unknown', changedPaths: [], landedPaths: [], remainingPaths: [], reason,
  };
}

/**
 * Fetch this PR's base and head into the scratch repo, verify the head is the
 * one the list read pinned, and diff. Every failure lands in `unknown` with a
 * fixed reason; a moved head is never classified.
 */
async function inspect(dir: string, row: DirtyRow, remote: string): Promise<DirtyLandedPr> {
  if (!SHA.test(row.headSha)) return unknown(row, 'row-unreadable');
  const baseRef = `refs/heads/${row.baseRef}`;
  if (!row.baseRef || (await git(dir, ['check-ref-format', baseRef])).code !== 0) {
    return unknown(row, 'row-unreadable');
  }
  const fetch = await git(dir, ['-c', 'core.hooksPath=/dev/null', 'fetch', '--no-tags', '--no-write-fetch-head',
    remote, `+${baseRef}:refs/dirty/base`, `+refs/pull/${row.number}/head:refs/dirty/head`]);
  if (fetch.code !== 0 || fetch.timedOut || fetch.truncated) return unknown(row, 'fetch-failed');
  const head = (await git(dir, ['rev-parse', 'refs/dirty/head'])).stdout.trim();
  const base = (await git(dir, ['rev-parse', 'refs/dirty/base'])).stdout.trim();
  if (head !== row.headSha || !SHA.test(base)) return unknown(row, 'head-moved');
  const mergeBase = (await git(dir, ['merge-base', base, head])).stdout.trim();
  if (!SHA.test(mergeBase)) return unknown(row, 'no-merge-base');
  const changedPaths = await diffPaths(dir, mergeBase, head);
  if (changedPaths === null) return unknown(row, 'diff-failed');
  const differing = await diffPaths(dir, base, head);
  if (differing === null) return unknown(row, 'diff-failed');
  const stillDiffering = new Set(differing);
  return {
    number: row.number, title: row.title, head: row.headSha, base: row.baseRef,
    class: classifyDirtyLanded(changedPaths, stillDiffering),
    changedPaths,
    landedPaths: changedPaths.filter(path => !stillDiffering.has(path)),
    remainingPaths: changedPaths.filter(path => stillDiffering.has(path)),
  };
}

function parseRow(raw: unknown): DirtyRow | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  const number = row['number'];
  if (!Number.isSafeInteger(number) || (number as number) < 1) return null;
  const mergeable = row['mergeable'];
  const mergeStateStatus = row['mergeStateStatus'];
  if (typeof mergeable !== 'string' || typeof mergeStateStatus !== 'string') return null;
  const headSha = row['headRefOid'];
  const baseRef = row['baseRefName'];
  const title = row['title'];
  return {
    number: number as number,
    title: typeof title === 'string' ? title.slice(0, MAX_TITLE) : '',
    mergeable: mergeable.toUpperCase(),
    mergeStateStatus: mergeStateStatus.toUpperCase(),
    headSha: typeof headSha === 'string' ? headSha : '',
    baseRef: typeof baseRef === 'string' ? baseRef : '',
  };
}

const defaultGh: CloudGh = async args => {
  const result = await defaultGitRunner('gh', args, {
    cwd: tmpdir(), timeoutMs: GIT_TIMEOUT_MS, maxStdoutBytes: GIT_MAX_BYTES,
  });
  return { ok: result.code === 0 && !result.timedOut && !result.truncated, stdout: result.stdout, stderr: result.stderr };
};

function describe(pr: DirtyLandedPr): string {
  const where = pr.base || 'master';
  switch (pr.class) {
    case 'landed': return `landed: all ${pr.changedPaths.length} changed path(s) already on ${where}`;
    case 'partly-landed': return `partly-landed: ${pr.remainingPaths.length} of ${pr.changedPaths.length} changed path(s) still differ from ${where}`;
    case 'needs-recut': return `needs-recut: ${pr.remainingPaths.length} changed path(s) still differ from ${where}`;
    case 'unknown': return `unknown: ${pr.reason ?? 'read-failed'}`;
  }
}

export async function cmdFleetDirtyLanded(args: string[], deps: FleetDirtyLandedDeps = {}): Promise<number> {
  let limit = 500, json = false, seenLimit = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--help' || arg === '-h') { console.log(USAGE); return 0; }
    if (arg === '--json' && !json) { json = true; continue; }
    if (arg === '--limit' && !seenLimit && /^\d+$/.test(args[i + 1] ?? '')) {
      limit = Number(args[++i]); seenLimit = true;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000) { console.error(`Invalid limit. ${USAGE}`); return 2; }
      continue;
    }
    console.error(`Invalid argument. ${USAGE}`);
    return 2;
  }

  const gh = deps.gh ?? defaultGh;
  const read = await gh(['pr', 'list', '--repo', REPO, '--state', 'open', '--limit', String(limit), '--json', GH_LIST_FIELDS]);
  if (!read.ok) { console.error('fleet dirty-landed: gh pr list failed'); return 1; }
  let rows: unknown;
  try { rows = JSON.parse(read.stdout); } catch { console.error('fleet dirty-landed: invalid gh response'); return 1; }
  if (!Array.isArray(rows)) { console.error('fleet dirty-landed: invalid gh response'); return 1; }
  const parsed = rows.map(parseRow);
  if (parsed.some(row => row === null)) { console.error('fleet dirty-landed: unreadable PR row'); return 1; }
  const dirty = (parsed as DirtyRow[]).filter(isConflicting);

  const prs: DirtyLandedPr[] = [];
  if (dirty.length > 0) {
    let dir: string;
    try { dir = await mkdtemp(join(tmpdir(), 'fleet-dirty-landed-')); }
    catch { console.error('fleet dirty-landed: could not create temporary object store'); return 1; }
    try {
      const init = await git(dir, ['init', '--bare', '--quiet']);
      if (init.code !== 0) { console.error('fleet dirty-landed: could not initialize temporary object store'); return 1; }
      for (const row of dirty) {
        try { prs.push(await inspect(dir, row, deps.remote ?? REMOTE)); }
        catch { prs.push(unknown(row, 'inspection-failed')); }
      }
    } finally { await rm(dir, { recursive: true, force: true }); }
  }

  const counts: Record<DirtyLandedClass, number> = { landed: 0, 'partly-landed': 0, 'needs-recut': 0, unknown: 0 };
  for (const pr of prs) counts[pr.class] += 1;
  const report: DirtyLandedReport = {
    schema: 'fleet.dirty-landed.v1', repo: REPO,
    generatedAt: (deps.now ?? (() => new Date()))().toISOString(),
    open: rows.length, dirty: dirty.length, complete: rows.length < limit, counts, prs,
  };
  if (json) {
    console.log(JSON.stringify(report));
  } else {
    console.log(`dirty-landed (${REPO}): ${dirty.length} conflicting open PR(s) — ` +
      `${counts.landed} landed, ${counts['partly-landed']} partly-landed, ` +
      `${counts['needs-recut']} needs-recut, ${counts.unknown} unknown` +
      `${report.complete ? '' : ' (page limit reached)'}`);
    for (const pr of prs) console.log(`#${pr.number} ${describe(pr)}${pr.title ? ` — ${pr.title}` : ''}`);
  }
  return 0;
}
