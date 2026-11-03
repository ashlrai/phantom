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
import { tmpdir } from 'node:os';
import type { CloudGh } from '../core/cloud/pr-actions.js';
import { defaultGitRunner } from '../core/verse/git-ops.js';
import {
  classifyDirtyLanded, inspectDirtyLanded, unknownDirtyLanded, withScratchRepo, type DirtyLandedClass, type DirtyLandedPr, type DirtyRow,
} from '../core/fleet/dirty-landed-inspect.js';

export { classifyDirtyLanded, type DirtyLandedClass, type DirtyLandedPr };

const REPO = 'ashlrai/phantom';
const REMOTE = 'https://github.com/ashlrai/phantom.git';
const USAGE = 'Usage: ashlr fleet dirty-landed [--json] [--limit N]';
const GH_LIST_FIELDS = 'number,title,mergeable,mergeStateStatus,headRefOid,baseRefName';
const MAX_TITLE = 200;
const GIT_TIMEOUT_MS = 60_000;
const GIT_MAX_BYTES = 16 * 1024 * 1024;

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

/** A row counts as conflicting the way classifyFleetPrGh reads conflict. */
function isConflicting(row: DirtyRow): boolean {
  return row.mergeable === 'CONFLICTING' || row.mergeStateStatus === 'DIRTY';
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
    try {
      await withScratchRepo(async dir => {
        for (const row of dirty) {
          try { prs.push(await inspectDirtyLanded(dir, row, deps.remote ?? REMOTE)); }
          catch { prs.push(unknownDirtyLanded(row, 'inspection-failed')); }
        }
      });
    } catch (error) {
      const init = error instanceof Error && error.message === 'scratch-init-failed';
      console.error(`fleet dirty-landed: could not ${init ? 'initialize' : 'create'} temporary object store`);
      return 1;
    }
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
