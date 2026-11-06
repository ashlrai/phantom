/**
 * core/fleet/main-red-age.ts — the main guardian's per-repo state, parsed and
 * projected. Shared by `ashlr fleet main-red-age` (cli/fleet-main-red-age.ts)
 * and `GET /api/verse/fleet/main-red-age` (verse/fleet-main-red-age-api.ts),
 * so the CLI's --json and the typed route never disagree.
 *
 * Reads the state file (~/.ashlr-runs/guardian/state.json; ASHLR_RUNS_DIR
 * overrides the root):
 *   {"owner/repo": {"state":"red","red_first":"<ISO>","red_since":"<ISO>",
 *                   "attempts":2,"cur_job":"RQ-1"}, ...}
 * A top-level {"repos": {...}} wrapper is accepted too. Minutes red come from
 * red_first when present, else red_since. A state file that cannot be read
 * leaves every answer "unknown"; it is never guessed — and never green.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

const MAX_REPOS = 200;
export const defaultStatePath = (): string =>
  join(process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs'), 'guardian', 'state.json');

export interface RedAgeRow {
  repo: string; state: string; redSince: string | null; redMinutes: number | null;
  attempts: number | null; currentJob: string | null;
}
export interface MainRedAgeReport {
  v: 1; collectedAt: string;
  source: { path: string; status: 'read' | 'unread' | 'invalid' };
  repos: RedAgeRow[];
}

/** The wire shape GET /api/verse/fleet/main-red-age and the console validate. */
export interface MainRedAgeV1 {
  v: 1; generatedAt: string;
  /** False when the guardian state could not be read or parsed — repos is empty and nothing claims green. */
  known: boolean;
  repos: RedAgeRow[];
}

const VALID_STATES = new Set(['green', 'red', 'unknown']);
const token = (v: unknown): v is string => typeof v === 'string' && /^[\w./@-]{1,200}$/.test(v);
const stamp = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v));
const count = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v < 1_000_000;

/** Parse the state file into repo entries; null when the text is not a state. */
export function parseGuardianState(raw: string): Record<string, Record<string, unknown>> | null {
  let root: unknown;
  try { root = JSON.parse(raw); } catch { return null; }
  if (!root || typeof root !== 'object' || Array.isArray(root)) return null;
  // Some guardian builds wrap the map in {"repos": {...}}; accept both.
  const table = root as Record<string, unknown>;
  const inner = 'repos' in table && table.repos && typeof table.repos === 'object' && !Array.isArray(table.repos)
    ? table.repos as Record<string, unknown> : table;
  const entries: Record<string, Record<string, unknown>> = {};
  for (const [repo, value] of Object.keys(inner).sort().slice(0, MAX_REPOS).map(repo => [repo, inner[repo]] as const)) {
    if (!token(repo)) continue;
    entries[repo] = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  }
  return entries;
}

export function buildMainRedAge(state: Record<string, Record<string, unknown>> | null, now: Date, path = ''): MainRedAgeReport {
  const repos: RedAgeRow[] = [];
  for (const [repo, raw] of Object.entries(state ?? {})) {
    const entry = raw ?? {}; // a malformed entry keeps its repo but every field stays unknown
    const since = stamp(entry.red_first) ? entry.red_first : stamp(entry.red_since) ? entry.red_since : null;
    const minutes = since === null ? null : (now.getTime() - Date.parse(since)) / 60000;
    repos.push({
      repo,
      state: token(entry.state) && VALID_STATES.has(entry.state) ? entry.state : 'unknown',
      redSince: since,
      // Whole minutes on the floor; a future stamp is a clock skew, not red time.
      redMinutes: minutes === null || minutes < 0 ? null : minutes === 0 ? 0 : Math.floor(minutes),
      attempts: count(entry.attempts) ? entry.attempts : null,
      currentJob: token(entry.cur_job) ? entry.cur_job : null,
    });
  }
  // Longest-red first, then green/unknown alphabetically: the oldest fire is the question.
  repos.sort((a, b) =>
    (b.state === 'red' ? 1 : 0) - (a.state === 'red' ? 1 : 0) ||
    (b.redMinutes ?? -1) - (a.redMinutes ?? -1) ||
    a.repo.localeCompare(b.repo));
  return {
    v: 1, collectedAt: now.toISOString(),
    source: { path, status: state ? 'read' : 'unread' },
    repos,
  };
}

/**
 * The route's answer: the report minus its path (never send absolute paths),
 * plus `known`. Any read or parse failure is `known: false` — unknown is
 * never green.
 */
export function mainRedAgeView(state: Record<string, Record<string, unknown>> | null, now: Date): MainRedAgeV1 {
  const report = buildMainRedAge(state, now);
  return { v: 1, generatedAt: report.collectedAt, known: state !== null, repos: report.repos };
}
