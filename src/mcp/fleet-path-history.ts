/**
 * fleet_path_history — which landed fleet jobs touched one repository path
 * on origin/master, for the isolated fleet MCP server. The reverse lookup of
 * fleet_job_history: a planner asks which job ids touched a path before
 * choosing a collision-free task. Reuses pathJobHistory and its bridge
 * subject parser — never a second scanner — so the MCP answer and
 * `phm fleet path-history <path>` cannot drift. The ref is fixed at
 * origin/master; there is deliberately no caller ref, filesystem root, cwd
 * or executable argument.
 *
 * The pathspec is always literal: `git --literal-pathspecs` keeps names such
 * as `literal [x].txt` from expanding as glob magic, and `--` ends option
 * parsing so a leading-dash name stays a pathspec. Every returned row is
 * recorded merge evidence, never a live lane, dispatch or merge-queue
 * verdict. The scan is bounded (newest scanBound commits touching the path,
 * newest first) and the result is bounded (at most `limit` distinct job
 * ids), so an empty or capped result proves only what the bounded scan saw —
 * it does not prove no fleet job landed work on the path.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathJobHistory } from '../core/fleet/path-job-history.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const exec = promisify(execFile);

export const MAX_FLEET_PATH_HISTORY = 100;
export const DEFAULT_FLEET_PATH_HISTORY = 20;
/** Fixed scan ref: the planner asks about landed work, so only origin/master counts. */
export const FLEET_PATH_HISTORY_REF = 'origin/master';
/** The bounded scan covers limit × this many newest commits touching the path. */
export const FLEET_PATH_HISTORY_SCAN_FACTOR = 3;

export interface FleetPathHistoryArgs {
  /** Repository-relative literal pathspec such as src/mcp/fleet-server.ts. */
  path: string;
  /** Distinct job ids to return; the commit scan itself is always bounded. */
  limit: number;
}

export interface FleetPathHistoryDeps {
  /** Newest-first commits touching `path`, at most `maxCommits` rows. */
  log?: (path: string, maxCommits: number) => Promise<Array<{ sha: string; date: string; subject: string }>>;
  /** Internal command seam for testing the production reader. */
  git?: (args: string[]) => Promise<string>;
}

export interface FleetPathHistoryV1 {
  schemaVersion: 1;
  snapshotKind: 'local-persisted';
  authority: 'none';
  generatedAt: string;
  note: string;
  path: string;
  ref: string;
  resolvedRef: string | null;
  scanBound: number;
  scanned: number;
  scanMayBeTruncated: boolean;
  limit: number;
  matchesTruncated: boolean;
  jobs: Array<{ jobId: string; pr: number | null; sha: string; date: string; title: string }>;
}

const NOTE = `Bounded recorded merge evidence only: bridge commits on ${FLEET_PATH_HISTORY_REF} touching the requested repository-relative path (matched as a literal pathspec — glob magic never expands), scanned newest-first inside at most scanBound commits and deduplicated by job id, capped at limit jobs. An empty or capped result proves only what this bounded scan saw — it does not prove no fleet job landed work on this path. Never a live lane, dispatch or merge-queue verdict.`;

const PATH_HISTORY_KEYS = new Set(['path', 'limit']);
// eslint-disable-next-line no-control-regex -- rejecting control bytes is the point of this check.
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/;

/**
 * One repository-relative literal pathspec. Rejects the empty path, `.`
 * (the whole tree is not one path), control characters, absolute spellings
 * (POSIX `/`, Windows drive, UNC, `~` home and the pathspec-magic `:`
 * prefix), backslashes — a Windows separator that could smuggle traversal
 * past the `/` segment check — and `..` segments, all before any git
 * process is spawned. Interior spaces are ordinary filename characters.
 */
function validRepoPath(path: string): boolean {
  if (path === '' || path === '.' || CONTROL_CHARS.test(path)) return false;
  if (path.startsWith('/') || path.startsWith('~') || path.startsWith(':') ||
    path.includes('\\') || /^[A-Za-z]:/.test(path)) return false;
  return path.split('/').every(segment => segment !== '..');
}

/**
 * Runtime argument validation: low-level SDK servers never check the
 * tools/list schema, so the server re-validates on every call. Unknown keys
 * (including any caller-supplied ref, root, cwd or executable), a missing or
 * unsafe path, and null, non-integer or out-of-range limits are rejected
 * before the git reader runs.
 */
export function parseFleetPathHistoryArgs(args: Record<string, unknown>): FleetPathHistoryArgs | null {
  const path = args['path'], limit = args['limit'] ?? DEFAULT_FLEET_PATH_HISTORY;
  if (Object.keys(args).some(key => !PATH_HISTORY_KEYS.has(key)) ||
    typeof path !== 'string' || !validRepoPath(path) ||
    args['limit'] === null ||
    typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > MAX_FLEET_PATH_HISTORY) return null;
  return { path, limit };
}

/** Execute bounded git commands without a shell. */
const runGit = async (args: string[]): Promise<string> => {
  const { stdout } = await exec('git', args, { encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
  return stdout;
};

/**
 * One bounded scan for the literal path on the fixed ref. Reader failures
 * (missing git, missing ref, unreadable object store) propagate — the server
 * reports them as a sanitized tool error, never as fabricated empty history.
 * Commit subjects stay inside the parser; only job id, pr, sha, date and
 * title cross this boundary, all passed through the shared public-JSON scrub.
 */
export async function readFleetPathHistory(input: FleetPathHistoryArgs, deps: FleetPathHistoryDeps = {}): Promise<FleetPathHistoryV1> {
  let resolvedRef: string | null = null;
  let log = deps.log;
  if (!log) {
    const git = deps.git ?? runGit;
    resolvedRef = (await git(['rev-parse', '--verify', `${FLEET_PATH_HISTORY_REF}^{commit}`])).trim();
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(resolvedRef)) throw new Error('Invalid resolved commit OID');
    const oid = resolvedRef;
    log = async (path, maxCommits) => {
      const stdout = await git([
        '--literal-pathspecs', 'log', `-n${maxCommits}`,
        '--format=%H%x09%cI%x09%s', oid, '--', path,
      ]);
      return stdout.split('\n').filter(Boolean).map(line => {
        const [sha = '', date = '', ...subject] = line.split('\t');
        return { sha, date, subject: subject.join('\t') };
      });
    };
  }
  const readLog = log;
  const scanBound = input.limit * FLEET_PATH_HISTORY_SCAN_FACTOR;
  let scanned = 0;
  const jobs = await pathJobHistory(input.path, {
    log: async (path, limit) => {
      const commits = await readLog(path, limit * FLEET_PATH_HISTORY_SCAN_FACTOR);
      scanned = commits.length;
      return commits;
    },
  }, { limit: input.limit });
  return sanitizePublicJson({
    schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none',
    generatedAt: new Date().toISOString(), note: NOTE,
    path: input.path, ref: FLEET_PATH_HISTORY_REF, resolvedRef,
    scanBound, scanned, scanMayBeTruncated: scanned >= scanBound,
    limit: input.limit, matchesTruncated: jobs.length === input.limit,
    jobs,
  }) as FleetPathHistoryV1;
}
