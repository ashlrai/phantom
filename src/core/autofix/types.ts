/**
 * Shared types for `phm autofix` (RQ-SELF-AWARE-AUTOFIX-1).
 * Detectors name four Eng Ops conditions. Fixers act only through an
 * injected host so tests never call the real system.
 */

export const AUTOFIX_SCHEMA = 'autofix.v1';
export const LEDGER_NAME = 'autofix.jsonl';
export const SHA_RE = /^[0-9a-f]{40}$/;
export const LANE_RE = /^[a-z][a-z0-9-]{1,30}$/;
export const LAUNCHD_LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/;

export const FIXER_IDS = [
  'release-stuck-draft',
  'launchd-crashloop',
  'stuck-lane',
  'outside-load',
] as const;

export type FixerId = (typeof FIXER_IDS)[number] | 'pinned-hand-edit';

const FIX_RESULTS = [
  'applied', 'dry-run', 'skipped', 'refused', 'refused_admitted',
  'refused_stale', 'refused_operator', 'failed', 'detect-only',
] as const;

export type FixResult = (typeof FIX_RESULTS)[number];

const INCIDENT_STATUSES = ['fixed', 'failed', 'intentional', 'refused'] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];

const FIXER_ID_SET: ReadonlySet<string> = new Set([...FIXER_IDS, 'pinned-hand-edit']);
const FIX_RESULT_SET: ReadonlySet<string> = new Set(FIX_RESULTS);
const INCIDENT_STATUS_SET: ReadonlySet<string> = new Set(INCIDENT_STATUSES);

export function isAutofixRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isFixerId(value: unknown): value is FixerId {
  return typeof value === 'string' && FIXER_ID_SET.has(value);
}

export function isFixResult(value: unknown): value is FixResult {
  return typeof value === 'string' && FIX_RESULT_SET.has(value);
}

export function isIncidentStatus(value: unknown): value is IncidentStatus {
  return typeof value === 'string' && INCIDENT_STATUS_SET.has(value);
}

export interface LedgerLine {
  ts: string;
  fixer: FixerId;
  target: string;
  action: string;
  before: unknown;
  after: unknown;
  result: FixResult;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** More than this many new launchd runs in the last hour, and still climbing. */
export const CRASH_THRESHOLD = 20;
/** Two `runs` samples must be at least this far apart. */
export const SAMPLE_GAP_MS = 60_000;
/** A sample older than this is not a current reading. */
export const FRESH_MS = 90_000;
export const HOUR_MS = 3_600_000;
/** A plist or rollback sibling newer than this is an operator start. */
export const OPERATOR_QUIET_MS = 15 * 60_000;
export const DEFAULT_STUCK_MIN = 30;
/** dispatchd D02: stop launching when load1 exceeds this times the CPU count. */
export const LOAD_PER_CPU = 2;
export const NICE_NORMAL = 15;
export const NICE_BATCH = 20;
export const RELEASE_LABEL = 'ai.ashlr.release-autorun';
export const RESIDENT_LABEL = 'ai.ashlr.daemon';
export const AUDIT_WORKFLOW = 'dependency-audit.yml';
export const AUDIT_REPO = 'ashlrai/phantom';

export const PINNED_NAMES = [
  'dispatchd.py',
  'dispatchd_guard.py',
  'lane_rules.py',
  'launch.sh',
  'publish.sh',
  'git-safe-env.sh',
  'release-autorun.sh',
  'version-bump-train.sh',
] as const;

export interface ReleaseDraft {
  id: number;
  tag: string;
  sha: string;
  draft: boolean;
  assetCount: number;
  createdAtMs: number;
}

export interface RunsSample {
  atMs: number;
  runs: number;
  lastExitCode: number | null;
  pid: number | null;
}

export interface LaunchdJob {
  label: string;
  domain: 'gui' | 'user' | 'system';
  disabled: boolean;
  /** History only. Apply takes a fresh `launchctl print` sample at now. */
  samples: RunsSample[];
  logTail: string;
  /** null when the plist mtime could not be read. That blocks a disable. */
  plistMtimeMs: number | null;
  /** Newest `.rollback.*` sibling, or null when the directory listed none. */
  rollbackMtimeMs: number | null;
  /** True for ai.ashlr.daemon and any other job the authority grant owns. */
  authorityGoverned?: boolean;
}

export interface LaneLease {
  id: string;
  owner: string;
  expiresAtMs: number | null;
  mtimeMs: number;
  manifestPresent: boolean;
}

export interface LaneView {
  lane: string;
  running: number;
  lastProgressAtMs: number | null;
  /** slots.json target. 0 means the lane is intentionally off. */
  target?: number | null;
  leases: LaneLease[];
}

/** One line appended to ~/.ashlr-runs/ledger/incidents.jsonl. */
export interface IncidentStatusLine {
  key: string;
  status: IncidentStatus;
  reason: string;
  ts: string;
}

export interface Proc {
  pid: number;
  ppid: number;
  uid: number;
  nice: number;
  comm: string;
  dispatchdOwned: boolean;
}

export interface PinnedFile {
  name: string;
  installedPath: string;
  /** Lowercase hex, or null when the installed file is absent. */
  installedSha256: string | null;
  /** Lowercase hex of the repo mirror or pin, or null when there is nothing to compare. */
  expectedSha256: string | null;
}

export interface AutofixSnapshot {
  releases: ReleaseDraft[];
  attestShas: string[];
  autorunLog: string;
  launchdJobs: LaunchdJob[];
  lanes: LaneView[];
  load1: number | null;
  ncpu: number | null;
  loadPerCpu: number;
  processes: Proc[];
  pinned: PinnedFile[];
}

export interface AutofixHost {
  now(): Date;
  uid(): number;
  runsDir(): string;
  homeDir(): string;
  killPath(): string;
  exists(path: string): boolean;
  readText(path: string): string | null;
  writeFile(path: string, text: string): void;
  appendFile(path: string, text: string): void;
  unlink(path: string): void;
  statMtime(path: string): number | null;
  listDir(path: string): string[];
  exec(argv: readonly string[]): ExecResult;
  restartLanePool(lane: string): Promise<{ beforeTarget: number; afterTarget: number }>;
}

export function defaultLaunchdJob(
  label: string,
  plistMtimeMs: number | null,
  rollbackMtimeMs: number | null,
  samples: RunsSample[] = [],
): LaunchdJob {
  return {
    label,
    domain: 'gui',
    disabled: false,
    samples,
    logTail: '',
    plistMtimeMs,
    rollbackMtimeMs,
    authorityGoverned: label === RESIDENT_LABEL,
  };
}

export function emptySnapshot(): AutofixSnapshot {
  return {
    releases: [],
    attestShas: [],
    autorunLog: '',
    launchdJobs: [],
    lanes: [],
    load1: null,
    ncpu: null,
    loadPerCpu: LOAD_PER_CPU,
    processes: [],
    pinned: [],
  };
}
