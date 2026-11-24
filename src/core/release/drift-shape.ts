// Pure shape of `phm self drift`: no node imports, so the web bundle can use it.
/**
 * Self drift: how far the installed Phantom CLI (the one the fleet runs) trails
 * the latest release and master, and which merged fleet capabilities it does
 * not have yet. A fact the reader could not read is the string "unknown";
 * nothing is inferred or guessed.
 */
export const SELF_DRIFT_SCHEMA = 'phantom.self-drift.v1';
export const UNKNOWN = 'unknown';
export type Unknown = typeof UNKNOWN;

/**
 * Fleet capabilities and the installed-CLI help that proves each one exists.
 * Live means `phm <argv> --help` exits 0 within 5 s AND its output contains
 * every `proof` string: several verbs (`fleet`, `leader`, `models`) print
 * generic help with exit 0 for a verb they do not know, so exit 0 alone proves
 * nothing. Add a row when a fleet improvement ships behind a new verb or flag.
 */
export const FLEET_CAPABILITIES = [
  { name: 'recut-check', argv: ['recut', 'check'], proof: ['Usage: phm recut check'] },
  { name: 'yield-stop-list', argv: ['jobs', 'yield'], proof: ['--stop-list'] },
  { name: 'stop-file', argv: ['fleet', 'needs-wait'], proof: ['fleet needs-wait', '--stop-file'] },
  { name: 'pulse', argv: ['fleet', 'pulse'], proof: ['Usage: phm fleet pulse'] },
  { name: 'decisions', argv: ['decisions'], proof: ['phm decisions answer'] },
  { name: 'leader-replies', argv: ['leader', 'replies'], proof: ['phm leader replies'] },
  { name: 'model-check', argv: ['models', 'check'], proof: ['check [--diff'] },
] as const satisfies readonly FleetCapability[];

export interface FleetCapability { name: string; argv: readonly string[]; proof: readonly string[] }
export type CapabilityName = typeof FLEET_CAPABILITIES[number]['name'];
export type FeatureState = 'live' | 'missing' | 'unknown';
export interface FeatureRow { name: CapabilityName; command: string; state: FeatureState }

export interface SelfDriftV1 {
  schema: typeof SELF_DRIFT_SCHEMA;
  version: 1;
  checkedAt: string;
  /** The `phm` on PATH: package version and build commit from its build manifest. */
  installed: { version: string | Unknown; revision: string | Unknown };
  /** Newest stable `v*` tag in the local Phantom clone. */
  latestRelease: { tag: string | Unknown; at: string | Unknown };
  /** origin/master in the local Phantom clone (as fresh as its last fetch). */
  master: { revision: string | Unknown; at: string | Unknown };
  /** Stable release tags newer than the installed version. */
  behindReleases: number | Unknown;
  /** Commits on master that the installed build commit does not contain. */
  behindCommits: number | Unknown;
  /** Commit time of the oldest master commit not in the installed build; null when none. */
  oldestUnshippedMergeAt: string | null | Unknown;
  liveFeatures: CapabilityName[];
  missingFeatures: CapabilityName[];
  unknownFeatures: CapabilityName[];
  features: FeatureRow[];
  /** The one human line, also shown as "Running build" on Home. */
  line: string;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** "Up to date", or "N releases behind, M fleet features not live yet"; unknown parts say unknown. */
export function driftLine(drift: Pick<SelfDriftV1, 'behindReleases' | 'missingFeatures' | 'unknownFeatures'>): string {
  const missing = drift.missingFeatures.length, unknown = drift.unknownFeatures.length;
  const tail = unknown ? `; ${plural(unknown, 'feature')} unknown` : '';
  if (drift.behindReleases === 0 && missing === 0) return `Up to date${tail}`;
  const releases = drift.behindReleases === UNKNOWN ? 'releases behind unknown' : `${plural(drift.behindReleases, 'release')} behind`;
  return `${releases}, ${missing} fleet ${missing === 1 ? 'feature' : 'features'} not live yet${tail}`;
}

/** Narrow an untrusted response (web client) to the typed shape, or null. */
export function narrowSelfDrift(raw: unknown): SelfDriftV1 | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Partial<SelfDriftV1>;
  const names = (v: unknown) => Array.isArray(v) && v.every(item => typeof item === 'string');
  return row.schema === SELF_DRIFT_SCHEMA && row.version === 1 && typeof row.line === 'string'
    && (row.behindReleases === UNKNOWN || Number.isSafeInteger(row.behindReleases))
    && names(row.liveFeatures) && names(row.missingFeatures) && names(row.unknownFeatures)
    ? raw as SelfDriftV1 : null;
}
