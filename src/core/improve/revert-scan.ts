/**
 * Fleet revert scan — the reachable half of the 72h-window revert detector.
 *
 * `detectRevertOutcomes` (./reverted.ts) knows how to find a merged PR's
 * revert in a default-branch history, but nothing called it: the records the
 * router's hold-rate signal consumes were never produced. This module is the
 * missing front half: it turns gh-shaped merged-PR exports into
 * `RevertCandidate`s, resolves which local ref to scan, runs the detector and
 * folds everything into a `revert.scan.v1` report.
 *
 * Honesty rules, same as the detector: a row that cannot supply repository,
 * number and merge commit is skipped and counted, never guessed; an
 * unreadable export file is counted, not treated as "no reverts"; a checkout
 * or ref git cannot read lands in `errors` with `degraded: true`. The report
 * names the exact ref and head commit it scanned, so a consumer can tell
 * which merges the scan could have seen — coverage is evidence, absence of a
 * record is not proof of no revert outside it.
 */
import { credentialExecFileSync as execFileSync } from '../integrations/secrets.js';
import { prKey } from './lesson-trial.js';
import type { ObserveExec } from './observe.js';
import {
  REVERT_WINDOW_MS,
  detectRevertOutcomes,
  revertedOutcomeKeys,
  type RevertCandidate,
  type RevertOutcomeRecord,
} from './reverted.js';

export const REVERT_SCAN_SCHEMA = 'revert.scan.v1';

const realExec: ObserveExec = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
const GIT = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'];
const SHA = /^[0-9a-f]{40}$/;
/** Same shape eval-report's prKeyOf accepts; kept local so improve/ stays self-contained. */
const PR_URL_RE = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)\/?$/;
/** Default scan order when --ref is not given: the remote's default branch, then the checkout's HEAD. */
const DEFAULT_REFS = ['origin/HEAD', 'HEAD'];

type Row = Record<string, unknown>;
const asRow = (v: unknown): Row | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Row) : null);
const str = (row: Row, ...keys: string[]): string | null => {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return null;
};

function repoFromUrl(value: unknown): { repository: string; number: number } | null {
  if (typeof value !== 'string') return null;
  const m = PR_URL_RE.exec(value.trim());
  return m ? { repository: `${m[1]}/${m[2]}`, number: Number(m[3]) } : null;
}

function mergeShaOf(row: Row): string | null {
  const raw = row['mergeCommit'];
  const value = typeof raw === 'string' ? raw : asRow(raw) ? str(asRow(raw)!, 'oid', 'sha') : str(row, 'merge_commit_sha', 'mergeCommitOid');
  if (value === null) return null;
  const sha = value.trim().toLowerCase();
  return SHA.test(sha) ? sha : null;
}

function mergedAtOf(row: Row): string | null {
  const value = str(row, 'mergedAt');
  return value !== null && Number.isFinite(Date.parse(value)) ? value : null;
}

/**
 * One gh-shaped merged-PR export (a JSON array, a single object, or JSONL) →
 * candidates plus the count of rows that could not become one. A row needs a
 * GitHub PR identity (url, or repository.nameWithOwner + number) and a merge
 * commit sha; `mergedAt` is optional because an in-history merge commit
 * supplies its own committer time.
 */
export function revertCandidatesFromExport(text: string): { candidates: RevertCandidate[]; rows: number; skipped: number } {
  const trimmed = text.trim();
  const candidates: RevertCandidate[] = [];
  let rows = 0;
  let skipped = 0;
  const push = (raw: unknown): void => {
    const row = asRow(raw);
    rows += 1;
    if (!row) { skipped += 1; return; }
    const fromUrl = repoFromUrl(row['url']) ?? repoFromUrl(row['prUrl']) ?? repoFromUrl(row['pr_url']) ?? repoFromUrl(row['html_url']);
    const repoRow = asRow(row['repository']) ?? asRow(row['headRepository']);
    const nameWithOwner = repoRow ? str(repoRow, 'nameWithOwner', 'name_with_owner') : null;
    const rowNumber = typeof row['number'] === 'number' && Number.isSafeInteger(row['number']) && row['number'] > 0 ? row['number'] : null;
    const mergeSha = mergeShaOf(row);
    let repository: string | null = null;
    let number: number | null = null;
    if (fromUrl) {
      // When the row also carries a number it must agree with the URL's.
      if (rowNumber !== null && rowNumber !== fromUrl.number) { skipped += 1; return; }
      repository = fromUrl.repository;
      number = fromUrl.number;
    } else if (nameWithOwner !== null && /^[\w.-]+\/[\w.-]+$/.test(nameWithOwner) && rowNumber !== null) {
      repository = nameWithOwner;
      number = rowNumber;
    }
    if (repository === null || number === null || mergeSha === null) { skipped += 1; return; }
    candidates.push({ repository, number, mergeSha, mergedAt: mergedAtOf(row) });
  };
  if (trimmed === '') return { candidates, rows, skipped };
  try {
    const value: unknown = JSON.parse(trimmed);
    if (Array.isArray(value)) { for (const entry of value) push(entry); return { candidates, rows, skipped }; }
    push(value);
    return { candidates, rows, skipped };
  } catch { /* not one JSON document — JSONL */ }
  for (const line of trimmed.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    try { push(JSON.parse(line)); } catch { rows += 1; skipped += 1; }
  }
  return { candidates, rows, skipped };
}

export interface RevertScanRef {
  /** The ref that resolved (the requested one, or the first default that did). */
  ref: string;
  /** Its head commit — the newest history the scan can see. */
  sha: string;
  /** Head committer time (strict ISO); bounds which merges' windows the scan could close. */
  at: string;
}

/**
 * Resolve the ref to scan: the requested one, else `origin/HEAD` then `HEAD`.
 * Returns null when git cannot read any candidate — the caller reports the
 * scan as degraded rather than guessing at a branch.
 */
export function resolveRevertScanRef(repoDir: string, requested: string | null, exec: ObserveExec = realExec): RevertScanRef | null {
  for (const ref of requested ? [requested] : DEFAULT_REFS) {
    try {
      const out = exec('git', [...GIT, 'log', '-n1', '--format=%H%x1f%cI', ref], repoDir).trim();
      const split = out.indexOf('\x1f');
      const sha = split < 0 ? '' : out.slice(0, split);
      const at = split < 0 ? '' : out.slice(split + 1);
      if (SHA.test(sha) && Number.isFinite(Date.parse(at))) return { ref, sha, at };
    } catch { /* unreadable ref — try the next default */ }
  }
  return null;
}

export interface RevertScanReport {
  schema: typeof REVERT_SCAN_SCHEMA;
  repoDir: string;
  /** The scanned ref, or null when no candidate made the git read necessary. */
  ref: string | null;
  /** Head commit of `ref` — the coverage horizon; null when unresolved. */
  head: { sha: string; at: string } | null;
  windowMs: number;
  prsFiles: { files: number; unreadable: number };
  candidates: { rows: number; usable: number; skipped: number; duplicates: number };
  reverts: RevertOutcomeRecord[];
  /** Sorted prKeys of `reverts` — the set a router subtracts from landed work. */
  revertedKeys: string[];
  /** True when any input was unreadable or the scan itself failed. */
  degraded: boolean;
  errors: string[];
}

/**
 * Parse exports, resolve the ref and run the detector. Never throws on
 * evidence problems — unreadable files, unresolvable refs and git failures
 * land in the report as counts and `errors`, so a consumer always sees what
 * was actually scanned.
 */
export function buildRevertScanReport(input: {
  repoDir: string;
  /** Explicit git ref; defaults to origin/HEAD then HEAD. */
  ref?: string | null;
  /** Export texts in --prs order; null marks an unreadable file. */
  prs: readonly (string | null)[];
  exec?: ObserveExec;
  windowMs?: number;
}): RevertScanReport {
  const exec = input.exec ?? realExec;
  const windowMs = input.windowMs ?? REVERT_WINDOW_MS;
  const report: RevertScanReport = {
    schema: REVERT_SCAN_SCHEMA,
    repoDir: input.repoDir,
    ref: null,
    head: null,
    windowMs,
    prsFiles: { files: input.prs.length, unreadable: input.prs.filter((t) => t === null).length },
    candidates: { rows: 0, usable: 0, skipped: 0, duplicates: 0 },
    reverts: [],
    revertedKeys: [],
    degraded: false,
    errors: [],
  };
  const seen = new Set<string>();
  const candidates: RevertCandidate[] = [];
  for (const text of input.prs) {
    if (text === null) continue;
    const parsed = revertCandidatesFromExport(text);
    report.candidates.rows += parsed.rows;
    report.candidates.skipped += parsed.skipped;
    for (const candidate of parsed.candidates) {
      const key = prKey(candidate.repository, candidate.number);
      if (seen.has(key)) { report.candidates.duplicates += 1; continue; }
      seen.add(key);
      candidates.push(candidate);
    }
  }
  report.candidates.usable = candidates.length;
  report.degraded = report.prsFiles.unreadable > 0;
  if (candidates.length === 0) return report;
  const resolved = resolveRevertScanRef(input.repoDir, input.ref ?? null, exec);
  if (resolved === null) {
    report.degraded = true;
    report.errors.push(`no scannable ref under ${input.repoDir}`);
    return report;
  }
  report.ref = resolved.ref;
  report.head = { sha: resolved.sha, at: resolved.at };
  const scan = detectRevertOutcomes(candidates, input.repoDir, resolved.ref, exec, { windowMs });
  report.reverts = scan.records;
  report.revertedKeys = [...revertedOutcomeKeys(scan.records)].sort();
  if (scan.errors.length > 0) report.degraded = true;
  report.errors.push(...scan.errors);
  return report;
}

/** Human-readable summary; unknown coverage is stated, never implied. */
export function formatRevertScanReport(report: RevertScanReport): string {
  const lines: string[] = [];
  const coverage = report.ref === null
    ? 'no ref scanned'
    : `${report.ref} @ ${report.head?.sha.slice(0, 12) ?? '?'} (${report.head?.at ?? 'unknown time'})`;
  lines.push(
    `Revert scan (${Math.round(report.windowMs / 3_600_000)}h window): ` +
    `${report.candidates.usable} merged PR${report.candidates.usable === 1 ? '' : 's'} checked on ${coverage}` +
    `${report.candidates.skipped + report.candidates.duplicates > 0 ? `; ${report.candidates.skipped} row(s) skipped, ${report.candidates.duplicates} duplicate(s)` : ''}` +
    `${report.prsFiles.unreadable > 0 ? `; ${report.prsFiles.unreadable} export file(s) unreadable` : ''}` +
    `${report.degraded ? ' [degraded]' : ''}`,
  );
  for (const revert of report.reverts) {
    const latencyH = (revert.revertLatencyMs / 3_600_000).toFixed(1);
    lines.push(
      `  ${revert.pr} reverted by ${revert.revertedBy.slice(0, 12)} at ${revert.revertedAt}` +
      ` (${latencyH}h after merge${revert.relandedBy ? `; relanded by ${revert.relandedBy.slice(0, 12)}` : ''})`,
    );
  }
  if (report.reverts.length === 0 && report.ref !== null) {
    lines.push('  no in-window reverts detected in the scanned history');
  }
  for (const error of report.errors) lines.push(`  error: ${error}`);
  return lines.join('\n');
}
