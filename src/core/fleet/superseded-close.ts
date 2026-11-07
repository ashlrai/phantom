/**
 * core/fleet/superseded-close.ts — plan and perform `gh pr close` on open
 * fleet bridge PRs whose recut already merged (Mason's Nov 1 merge-bottleneck
 * and CI-mail orders: superseded originals keep counting against the backlog
 * and every branch refresh re-runs CI on them).
 *
 * planSupersededClose derives the close set only from findSupersededPrs — a
 * merged recut whose job prompt names the open PR must exist — and keeps only
 * PRs titled `bridge: RQ-PHX-...`.
 *
 * closeSupersededPrs is a dry run unless apply is set. With apply it closes
 * one PR at a time through the injected runner, stops at the first non-zero
 * exit, never deletes a branch and never forces anything. Every attempt is
 * appended to <runsDir>/queue/superseded-closes.jsonl as one JSON line so the
 * ledger survives a mid-run stop.
 */
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { findSupersededPrs, type MergedFleetPr, type OpenFleetPr } from './superseded-prs.js';

export interface SupersededCloseRow {
  number: number;
  title: string;
  /** Number of the merged recut that made this PR redundant. */
  supersededBy: number;
  comment: string;
}

export interface SupersededCloseResult {
  attempted: number;
  closed: number;
  failed: number;
  /** The plan as passed in — never mutated, even on an early stop. */
  rows: SupersededCloseRow[];
  /** stderr or exception message of the attempt that stopped the run. */
  error?: string;
}

/** Child-process runner shape: argv only, no shell, exit code reported. */
export type SupersededCloseRunner =
  (file: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

export interface SupersededCloseOptions {
  apply: boolean;
  /** Max PRs to close this run (default 10, capped at 25). */
  limit?: number;
  runner: SupersededCloseRunner;
  runsDir: string;
  now?: () => number;
}

export const SUPERSEDED_CLOSE_REPO = 'ashlrai/phantom';
export const SUPERSEDED_CLOSE_DEFAULT_LIMIT = 10;
export const SUPERSEDED_CLOSE_MAX_LIMIT = 25;
const BRIDGE_TITLE = /^bridge: RQ-PHX-/;

export function planSupersededClose(
  open: readonly OpenFleetPr[],
  merged: readonly MergedFleetPr[],
  prompts: ReadonlyMap<string, string>,
): SupersededCloseRow[] {
  return findSupersededPrs(open, merged, prompts)
    .filter(row => BRIDGE_TITLE.test(row.pr.title))
    .map(row => ({
      number: row.pr.number,
      title: row.pr.title,
      supersededBy: row.supersededBy.number,
      comment: `Superseded by #${row.supersededBy.number} (merged). Closed by ashlr fleet superseded-close.`,
    }));
}

export function supersededCloseLimit(limit: number | undefined): number {
  const value = Math.trunc(limit ?? SUPERSEDED_CLOSE_DEFAULT_LIMIT);
  if (!Number.isFinite(value)) return SUPERSEDED_CLOSE_DEFAULT_LIMIT;
  return Math.max(0, Math.min(value, SUPERSEDED_CLOSE_MAX_LIMIT));
}

export async function closeSupersededPrs(
  rows: readonly SupersededCloseRow[],
  opts: SupersededCloseOptions,
): Promise<SupersededCloseResult> {
  if (!opts.apply) return { attempted: 0, closed: 0, failed: 0, rows: [...rows] };
  const now = opts.now ?? (() => Date.now());
  await mkdir(join(opts.runsDir, 'queue'), { recursive: true });
  const ledger = join(opts.runsDir, 'queue', 'superseded-closes.jsonl');
  let attempted = 0;
  let closed = 0;
  let failed = 0;
  let error: string | undefined;
  for (const row of rows.slice(0, supersededCloseLimit(opts.limit))) {
    attempted += 1;
    const record: { at: string; pr: number; supersededBy: number; ok: boolean; error?: string } =
      { at: new Date(now()).toISOString(), pr: row.number, supersededBy: row.supersededBy, ok: false };
    try {
      const result = await opts.runner('gh',
        ['pr', 'close', String(row.number), '--repo', SUPERSEDED_CLOSE_REPO, '--comment', row.comment]);
      record.ok = result.code === 0;
      if (!record.ok) record.error = result.stderr.trim() || `gh pr close exited ${result.code}`;
    } catch (err) {
      record.error = err instanceof Error ? err.message : String(err);
    }
    if (record.ok) {
      closed += 1;
    } else {
      failed += 1;
      error = record.error;
    }
    // A ledger write failure stops the run: continuing would close PRs with no
    // audit trail, which is worse than leaving them for the next run.
    try {
      await appendFile(ledger, `${JSON.stringify(record)}\n`, 'utf8');
    } catch {
      break;
    }
    if (!record.ok) break;
  }
  return { attempted, closed, failed, rows: [...rows], ...(error === undefined ? {} : { error }) };
}
