/**
 * Unattended self-improvement discovery pass journal.
 *
 * autoDiscover (src/core/improve/discover.ts) runs discoverBacklog on the
 * cloud scheduler's improve job and gets back { ran, added, errors } — one
 * errors[] entry per evidence feed that threw ('<feedName>: <message>'),
 * per GitHub poll that failed ('default branch checks: ...', 'issues: ...')
 * and the hot-patch log read. Until this journal the scheduler's improve
 * job read only `added`: the errors array was computed and dropped, so a
 * feed that started throwing went silent forever — its items simply
 * stopped being added while the loop looked healthy. `phm improve
 * discover` printed the same errors as warnings, but nobody runs it on a
 * schedule.
 *
 * appendDiscoveryPass writes one bounded {v:1, at, added, errors[]} row
 * per pass that ran discovery, to <runsDir>/metrics/improve-discovery.jsonl
 * — the same runs-dir journal layout every sibling feed reads. The file
 * is append-only evidence for discovery-errors-backlog.ts; a write
 * failure must never stall discovery, so callers wrap it best-effort.
 */
import { appendFileSync, closeSync, constants as fsConstants, mkdirSync, openSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Journal path relative to the runs dir: metrics/improve-discovery.jsonl. */
export const DISCOVERY_PASS_JOURNAL_RELATIVE = join('metrics', 'improve-discovery.jsonl');
/** Errors kept per row; a pass has at most one entry per feed plus the polls. */
export const DISCOVERY_PASS_MAX_ERRORS = 50;
/** Per-error character bound; error text is diagnostic, never a payload. */
export const DISCOVERY_PASS_MAX_ERROR_CHARS = 300;

const NO_FOLLOW = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;

/**
 * The runs dir discovery journals live under: $ASHLR_RUNS_DIR when set and
 * non-empty (an empty value is unset, never a cwd-relative path), else
 * ~/.ashlr-runs — the same resolution the sibling feeds apply.
 */
export function discoveryRunsDir(): string {
  const env = process.env['ASHLR_RUNS_DIR'];
  return env !== undefined && env !== '' ? env : join(homedir(), '.ashlr-runs');
}

/** Absolute journal path for a runs dir (default: discoveryRunsDir()). */
export function discoveryPassJournalPath(runsDir?: string): string {
  return join(runsDir ?? discoveryRunsDir(), DISCOVERY_PASS_JOURNAL_RELATIVE);
}

/**
 * Append one pass row. `added` is the count of new backlog items the pass
 * appended (null stays null — unknown, never zeroed); `errors` is the
 * pass's own error strings, capped per row and per message. Synchronous
 * and bounded; throws on fs failure — callers treat it as best-effort.
 */
export function appendDiscoveryPass(
  errors: readonly string[],
  added: number | null,
  now: Date = new Date(),
  runsDir?: string,
): void {
  const path = discoveryPassJournalPath(runsDir);
  const row = {
    v: 1,
    at: now.toISOString(),
    added: typeof added === 'number' && Number.isSafeInteger(added) && added >= 0 ? added : null,
    errors: errors
      .filter((e): e is string => typeof e === 'string')
      .slice(0, DISCOVERY_PASS_MAX_ERRORS)
      .map((e) => e.slice(0, DISCOVERY_PASS_MAX_ERROR_CHARS)),
  };
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | NO_FOLLOW, 0o600);
  try {
    appendFileSync(fd, `${JSON.stringify(row)}\n`, 'utf8');
  } finally {
    closeSync(fd);
  }
}
