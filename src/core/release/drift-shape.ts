// Pure shape of `phm self drift`: no node imports, so the web bundle can use it.
/**
 * Self drift: how far the running Phantom build trails the latest release and master, and which merged fleet
 * fixes it does not have yet. A fact that could not be read is the string "unknown"; nothing is guessed.
 */
export const SELF_DRIFT_SCHEMA = 'phantom.self-drift.v1';
export const UNKNOWN = 'unknown';
export type Unknown = typeof UNKNOWN;
export const UPDATE_COMMAND = 'phm update';
/** A merged PR is a fleet fix when its title or one of its paths contains one of these words. */
export const FLEET_WORDS = /queue|dispatch|recut|precheck|router|yield|leader/i;

export interface FleetFix { pr: number; title: string }
export interface SelfDriftV1 {
  schema: typeof SELF_DRIFT_SCHEMA;
  version: 1;
  checkedAt: string;
  running_sha: string | Unknown;
  master_sha: string | Unknown;
  /** Commits on master absent from the running build; local fetch only. */
  behind: number | Unknown;
  /** All merged PRs absent from this build, newest first; unknown if history cannot be read. */
  missing_prs: FleetFix[] | Unknown;
  /** This build's own embedded metadata (dist/build-identity.json); never read from Git. */
  running: { version: string | Unknown; revision: string | Unknown };
  /** Newest stable `vX.Y.Z` tag in the local clone, and the commits it has that the running build lacks. */
  latestRelease: { tag: string | Unknown; behind: number | Unknown };
  /** origin/master in the local clone (as fresh as its last fetch), and the commits the running build lacks. */
  master: { revision: string | Unknown; behind: number | Unknown };
  /** Merged PRs on master since the running commit. */
  mergedPrs: number | Unknown;
  /** Those of them whose title or paths touch the fleet, newest first. */
  fleetFixes: FleetFix[] | Unknown;
  status: 'up to date' | 'behind' | Unknown;
  /** Why the status is unknown, in plain words; null when it is known. */
  unknownReason: string | null;
  updateCommand: typeof UPDATE_COMMAND;
  /** The one human line, also shown as "Running build" on Home. */
  line: string;
}

/** The same single sentence for the CLI, API and Home. */
export function driftLine(drift: Pick<SelfDriftV1, 'behind' | 'unknownReason'>): string {
  const behind = drift.behind;
  if (behind === UNKNOWN) return `Running build: unknown (${drift.unknownReason ?? 'not readable'}).`;
  if (behind === 0) return 'Running build is up to date.';
  return `Running build is ${behind} ${behind === 1 ? 'fix' : 'fixes'} behind. Restart to update.`;
}

/** Validate only the fields Home consumes; never claim unvalidated fields are typed. */
export function narrowSelfDrift(raw: unknown): Pick<SelfDriftV1, 'behind' | 'line'> | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Partial<SelfDriftV1>;
  return row.schema === SELF_DRIFT_SCHEMA && row.version === 1 && typeof row.line === 'string'
    && (row.behind === UNKNOWN || (Number.isSafeInteger(row.behind) && row.behind! >= 0))
    ? { behind: row.behind!, line: row.line } : null;
}
