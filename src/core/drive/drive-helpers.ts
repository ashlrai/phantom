/**
 * Shared pure helpers and constants for the `src/core/drive` module family.
 *
 * Keeps security-pin matching, approved-repo defaults, bounded durable-state
 * eviction, plain-record/number guards, and closed node-runner identifiers in
 * one place so drive loops and node modules cannot drift apart.
 */

/** The seven approved fleet repos; no discovery or expansion. */
export const APPROVED_FLEET_REPOS = [
  'ashlrai/phantom',
  'ashlrai/phantom-secrets',
  'ashlrai/locus',
  'ashlrai/lexicon',
  'ashlrai/ashlr-md',
  'ashlrai/ashlr-stack',
  'ashlrai/ashlr-plugin',
] as const;

export const DEFAULT_FLEET_AUTHOR = 'ashlr-fleet[bot]';
export const DEFAULT_STATE_ENTRY_CAP = 8_192;

/** Closed wire protocol between the node pool worker and reviewed host runners. */
export const NODE_RUNNER_PROTOCOL = 'phm-node-worker/v1';

/** Pack identifier for bounded read-only codex file runs on remote nodes. */
export const CODEX_FILE_PACK = 'codex-file';

const SAFE_NODE_JOB_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,119}$/;

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Single-component bounded identifier safe for per-job paths and result filenames. */
export function isSafeNodeJobId(value: string): boolean {
  return SAFE_NODE_JOB_ID_RE.test(value);
}

export function shortRepoName(repo: string): string {
  return repo.split('/').pop() ?? repo;
}

/** `.github` segment, publish.sh basename, or a segment containing a pinned token. */
export function securityPinnedPath(path: string): boolean {
  return path.split('/').some((segment) => {
    const lower = segment.toLowerCase();
    return lower === '.github' || lower === 'publish.sh' ||
      /dispatchd|git[-_]safe|scrub|reap/.test(lower);
  });
}

/** Conservative pin check: a truncated file list is unproven and pins too. */
export function prTouchesSecurityPin(pr: { readonly filesTruncated: boolean; readonly files: readonly string[] }): boolean {
  return pr.filesTruncated || pr.files.some(securityPinnedPath);
}

/** Bound durable state maps by evicting the oldest entries first when over `cap`. */
export function pruneOldestEntries<T>(
  record: Record<string, T>,
  timestampOf: (entry: T) => number,
  cap = DEFAULT_STATE_ENTRY_CAP,
): void {
  const keys = Object.keys(record);
  if (keys.length <= cap) return;
  keys
    .sort((a, b) => timestampOf(record[a]!) - timestampOf(record[b]!))
    .slice(0, keys.length - cap)
    .forEach((key) => delete record[key]);
}
