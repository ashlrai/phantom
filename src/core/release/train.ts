/**
 * Continuous release train. Cuts from green master, builds the tagged commit,
 * and resumes the sanctioned publishers. KILL fails closed.
 * See docs/RELEASING.md.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// The hosted workflow executes this file directly with Node's type stripping.
function readEnvironmentCredential(envKey: string): string | undefined {
  return process.env[envKey];
}

export const TRAIN_SCHEMA = 'phantom.release-train.v1';
/** Default enqueue cadence in minutes when RELEASE_CADENCE_MINUTES is unset.
 *  Matches the hosted Release PR default. Valid values are 1 through 1440. */
export const DEFAULT_CADENCE_MINUTES = 5;

/** Resolve a cadence value from RELEASE_CADENCE_MINUTES, or the default. */
export function cadenceMinutesFromEnv(raw: string | undefined = process.env.RELEASE_CADENCE_MINUTES): number {
  if (raw === undefined || raw === '') return DEFAULT_CADENCE_MINUTES;
  if (!/^[1-9]\d*$/.test(raw)) throw new Error('invalid release cadence');
  return cappedCadenceMinutes(Number(raw));
}
export const REPOSITORY = 'ashlrai/phantom';
export const REPOSITORY_ID = 1263526319;
export const WEBSITE_HOOK = Object.freeze({
  repository: 'ashlrai/phantom-secrets',
  root: 'apps/web',
  domain: 'phm.dev',
  profile: 'phantom-public-web',
  module: 'src/core/website/host-release.ts',
});

const SHA = /^[a-f0-9]{40}$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const RELEASE_SUBJECT = /^chore\([^)\r\n]+\): release (0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?: \(#\d+\))?/;

export type KillObservation = 'inactive' | 'active' | 'unknown';
export type Ancestry = 'ancestor' | 'identical' | 'diverged' | 'behind' | 'unknown';
/** Required GitHub Actions checks on one commit. Missing or unfinished is pending, not green. */
export type CandidateCi = 'green' | 'red' | 'pending' | 'unknown';
type StepStatus = 'complete' | 'pending' | 'stopped' | 'hooked';
const ACTIONS_APP_ID = 15368;
const RELEASE_TAG = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;

/** GitHub `head_branch` is `master` or a bare `vX.Y.Z`. `refs/heads/vX.Y.Z` is a branch. */
export function releaseHeadBranch(branch: unknown): boolean {
  if (branch === 'master') return true;
  if (typeof branch !== 'string' || branch.startsWith('refs/')) return false;
  return RELEASE_TAG.test(branch);
}

/** Release-train job name. It must never be a candidate-admission check. */
export const TRAIN_JOB_CHECK_NAME = 'train';

/**
 * Judge only the named required Actions checks on this SHA.
 * The train's own `train` check-runs are ignored even if listed, so a failed
 * train retry cannot poison the same SHA.
 * GitHub's check-run listing can include one row per check suite, so a later
 * failed or skipped Merge Gate from tag or push CI must not override an earlier
 * successful run of that same required context.
 * Queued or in-progress required checks are pending, not red.
 * An empty required set is unknown (fail closed). A required check with only
 * completed non-success conclusions is red.
 */
export function judgeRequiredChecks(
  required: readonly string[],
  runs: readonly { name: string; status: string; conclusion: string | null; appId: number }[],
): CandidateCi {
  const names = [...new Set(required.filter((name) => name !== TRAIN_JOB_CHECK_NAME))];
  if (names.length === 0) return 'unknown';
  let pending = false;
  for (const name of names) {
    const matched = runs.filter((run) => run.appId === ACTIONS_APP_ID && run.name === name);
    if (matched.length === 0) {
      pending = true;
      continue;
    }
    let seenSuccess = false;
    let seenIncomplete = false;
    let seenFailure = false;
    for (const run of matched) {
      // A check run left at in_progress with a non-success conclusion already
      // written is settled red (GitHub ghost state seen on release PR #8367).
      // A success conclusion on an unsettled row stays pending, never green.
      if (run.status !== 'completed') {
        if (typeof run.conclusion === 'string' && run.conclusion !== '' && run.conclusion !== 'success') seenFailure = true;
        else seenIncomplete = true;
      } else if (run.conclusion === 'success') seenSuccess = true;
      else seenFailure = true;
    }
    if (seenIncomplete) pending = true;
    else if (seenSuccess) continue;
    else if (seenFailure) return 'red';
    else pending = true;
  }
  return pending ? 'pending' : 'green';
}

export interface FinalizeRunRecord {
  status: string;
  conclusion: string | null;
  createdAt: string | null;
  version: string | null;
  sha: string | null;
}

export const FINALIZE_ATTEMPT_CAP = 2;
export const FINALIZE_FAILURE_COOLDOWN_MS = 60 * 60 * 1000;

/** Matches `run-name` on finalize-github-release.yml. Anything else is unreadable. */
export function finalizeRunIdentity(title: string | null): { version: string; sha: string } | null {
  const match = /^finalize ((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)) ([a-f0-9]{40})$/.exec(title ?? '');
  if (!match) return null;
  return { version: match[1]!, sha: match[2]! };
}

/**
 * At most two finalize runs for one version and sha. A failure in the last
 * hour blocks the next try. An unattributed run newer than the candidate
 * counts against that pair, so a title-less failure cannot retry every tick.
 */
export function finalizeRetryDecision(input: {
  now: string;
  version: string;
  sha: string;
  since: string | null;
  runs: readonly FinalizeRunRecord[];
}): { dispatch: boolean; reason: string } {
  const nowMs = Date.parse(input.now);
  const sinceMs = input.since === null ? Number.NEGATIVE_INFINITY : Date.parse(input.since);
  if (!Number.isFinite(nowMs) || !Number.isFinite(sinceMs)) return { dispatch: false, reason: 'finalize-clock' };
  const relevant = input.runs.filter((run) => {
    if (run.version !== null && run.sha !== null) return run.version === input.version && run.sha === input.sha;
    const at = run.createdAt === null ? Number.NaN : Date.parse(run.createdAt);
    return Number.isFinite(at) && at >= sinceMs;
  });
  if (relevant.some((run) => run.status !== 'completed')) return { dispatch: false, reason: 'finalize-in-progress' };
  if (relevant.length >= FINALIZE_ATTEMPT_CAP) return { dispatch: false, reason: 'finalize-attempt-cap' };
  const cooling = relevant.some((run) => {
    if (run.conclusion === 'success' || run.conclusion === 'skipped') return false;
    const at = run.createdAt === null ? Number.NaN : Date.parse(run.createdAt);
    if (!Number.isFinite(at) || at > nowMs) return true;
    return nowMs - at < FINALIZE_FAILURE_COOLDOWN_MS;
  });
  if (cooling) return { dispatch: false, reason: 'finalize-failure-cooldown' };
  return { dispatch: true, reason: 'finalize-allowed' };
}

export const FINALIZE_HISTORY_MS = 24 * 60 * 60 * 1000;
const FINALIZE_RUN_PAGE_SIZE = 100;
const FINALIZE_RUN_PAGE_CAP = 10;

/** One page of finalize runs created in the last 24 hours. */
export function finalizeRunsQuery(now: string, page: number): string {
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs) || !Number.isInteger(page) || page < 1) throw new Error('finalize-clock');
  const created = new Date(nowMs - FINALIZE_HISTORY_MS).toISOString();
  return `repos/${REPOSITORY}/actions/workflows/finalize-github-release.yml/runs?per_page=${FINALIZE_RUN_PAGE_SIZE}&page=${page}&created=${encodeURIComponent(`>=${created}`)}`;
}

function finalizeRunRecord(row: unknown): FinalizeRunRecord {
  const item = record(row);
  const identity = finalizeRunIdentity(text(item?.display_title) ?? text(item?.name));
  return {
    status: text(item?.status) ?? '',
    conclusion: text(item?.conclusion),
    createdAt: text(item?.created_at),
    version: identity?.version ?? null,
    sha: identity?.sha ?? null,
  };
}

/** Every finalize run in the last 24 hours. A truncated window throws, so the cap cannot reset by falling off the first page. */
export async function listFinalizeRuns(read: (path: string) => Promise<unknown>, now: string): Promise<FinalizeRunRecord[]> {
  const runs: FinalizeRunRecord[] = [];
  for (let page = 1; page <= FINALIZE_RUN_PAGE_CAP; page += 1) {
    const listed = record(await read(finalizeRunsQuery(now, page)));
    if (!listed || !Array.isArray(listed.workflow_runs)) throw new Error('incomplete finalize run inventory');
    const rows = listed.workflow_runs;
    runs.push(...rows.map(finalizeRunRecord));
    const total = listed.total_count;
    if (typeof total === 'number' && rows.length < FINALIZE_RUN_PAGE_SIZE && total !== runs.length) {
      throw new Error('incomplete finalize run inventory');
    }
    if (rows.length < FINALIZE_RUN_PAGE_SIZE) return runs;
  }
  throw new Error('incomplete finalize run inventory');
}

export interface ReleaseAsset { name: string; created_at: string | null }
export interface ReleaseRow {
  id: number;
  tag_name: string;
  draft: boolean;
  name: string;
  body: string;
  created_at: string | null;
  assets: ReleaseAsset[];
}
export interface TrainObservation {
  now: string;
  fleetKill: KillObservation;
  autorunOff: KillObservation;
  masterSha: string;
  masterVersion: string;
  cadenceMinutes: number;
  lastTaggedAt: string | null;
  aheadBy: number;
  tags: { name: string; sha: string }[];
  /**
   * releaseMessage: auto-tag tags the commit whose checks finished, which can
   * be a later merge than the release-please commit (two merges a second apart).
   * It carries that release commit's message when it is an ancestor of the tag
   * and package.json at the tag still carries the tag version.
   * packageVersion and releaseGate identify that same tagged SHA when the
   * subject is not a release-please line: package.json equals the tag and the
   * release-gate receipt on that SHA is green.
   */
  head: {
    tag: string; sha: string; message: string; releaseMessage?: string;
    packageVersion?: string | null; releaseGate?: ReleaseGateReceipt;
    ancestry: Ancestry; compareStatus?: string; committedAt: string | null;
  } | null;
  skippedTags?: { tag: string; reason: string }[];
  releases: ReleaseRow[];
  openReleasePr: {
    number: number; nodeId: string; version: string; headSha: string; headRef: string;
    mergeable: string; state: 'OPEN' | 'MERGED'; queued: boolean;
    /** Latest merge-queue removal time when it is the newest queue event and the PR is not queued. */
    queueEjectedAt?: string | null;
    /** committedDate of the PR head commit; null when the queue read did not return it. */
    headCommittedAt?: string | null;
    /**
     * True when an unaddressed merge-queue ejection left stale-green head
     * checks and the head trails master: re-enqueueing would retry evidence
     * the queue already rejected, so the plan syncs the branch first.
     */
    branchSyncDue?: boolean;
    /**
     * True when that ejection's base compare could not be read or returned no
     * recognized status, so whether the head trails master is unknown. The
     * plan defers every write to this PR — enqueue could retry evidence the
     * queue already rejected and a blind sync could be a no-op write — while
     * the rest of the observation and plan still complete.
     */
    branchSyncUnknown?: boolean;
  } | null;
  pullChecks: { pending: number; failing: number } | null;
  /** Required CI on `head.sha`. Green is the only value that may dispatch a build. */
  candidateCi: CandidateCi;
  build: { runId: number; attempt: number; artifactId: number; completedAt: string | null } | null;
  buildPending: boolean;
  /**
   * The master push CI run for `head.sha` finished without success (for example
   * a red advisory Quick typecheck, which leaves Merge Gate green). The desktop
   * release-build job reuses only a green exact-source push run, so a
   * dispatched CI run can never produce the build artifact for this SHA.
   */
  pushCiRed?: boolean;
  /**
   * Required CI (the fast Merge Gate) on `masterSha`. Read only when the
   * candidate is stuck on `pushCiRed` with no build and master is strictly past
   * it. Green lets the train fix forward from master instead of waiting forever.
   */
  masterCi?: CandidateCi;
  attest: { runId: number; attempt: number; artifactId: number; completedAt: string | null } | null;
  attestPending: boolean;
  audit: { runId: number; attempt: number } | null;
  /** A tag-ref or master audit for this SHA is queued or running. */
  auditPending?: boolean;
  npmPublished: boolean | null;
  npmAt: string | null;
  /** Public npm provenance for this version. Absent means finalize is not dispatched. */
  npmPublish?: { runId: number; attempt: number; integrity: string } | null;
  /** A finalize run is queued, waiting, or in progress. */
  finalizePending?: boolean;
  /**
   * Recent finalize runs. `version` and `sha` are null when the run cannot
   * be attributed; those still count against the current candidate when they
   * are newer than its commit.
   */
  finalizeRuns?: readonly FinalizeRunRecord[];
  docsSynced: boolean;
  /** Parsed `version` from the updater endpoint, or null when it was not read. */
  feedVersion: string | null;
}

interface StageTiming { at: string | null; sinceMergeMs: number | null }
export interface TrainState {
  schema: typeof TRAIN_SCHEMA;
  stopped: boolean;
  reason: string;
  version: string | null;
  tag: string | null;
  sha: string | null;
  next: string | null;
  advance?: { action: 'advance-from-master'; version: string; sha: string; reason: string };
  superseded: string[];
  skippedTags?: { tag: string; reason: string }[];
  website: typeof WEBSITE_HOOK;
  steps: Record<string, { status: StepStatus; reason?: string }>;
  stages: Record<string, StageTiming>;
}

export const ENQUEUE_PULL_REQUEST = 'mutation($pullRequestId:ID!){enqueuePullRequest(input:{pullRequestId:$pullRequestId}){mergeQueueEntry{position state}}}';
/**
 * MERGE method only: a base merge commit on top of the head, never a rewrite
 * or force-push. expectedHeadOid pins the exact observed head so a head that
 * moved since the read is refused instead of synced blind.
 */
export const UPDATE_PULL_REQUEST_BRANCH = 'mutation($pullRequestId:ID!,$expectedHeadOid:GitObjectID!){updatePullRequestBranch(input:{pullRequestId:$pullRequestId,expectedHeadOid:$expectedHeadOid,updateMethod:MERGE}){pullRequest{id headRefOid}}}';
const PULL_NODE = /^PR_[A-Za-z0-9_-]+$/;
export type ReleaseWrite =
  | { method: 'PATCH'; path: string; body: { name: string; body: string; draft: true; prerelease: false } }
  | { method: 'POST'; path: 'graphql'; body: { query: string; variables: { pullRequestId: string; expectedHeadOid?: string } } }
  | { method: 'POST'; path: string; body: { ref: string; inputs: Record<string, string | boolean> } };

export interface TrainPlan { state: TrainState; writes: ReleaseWrite[]; exitCode: 0 | 1 }

export function fleetKillPath(home = homedir()): string { return join(home, '.ashlr', 'KILL'); }
function readLocalTrainStop(home = homedir()): KillObservation {
  const operator = readSentinel(fleetKillPath(home));
  return operator === 'inactive' ? readSentinel(join(home, '.ashlr', 'DESKTOP_UPDATE_STOP')) : operator;
}
export function autorunOffPath(home = homedir()): string { return join(home, '.ashlr-runs', 'RELEASE_AUTORUN_OFF'); }
export const RELEASE_TRAIN_STOP_SCHEMA = 'phantom.release-train-stop.v1';
const RELEASE_TRAIN_STOP_MARKER = 'release train off (fleet-stop)\n';
const RELEASE_TRAIN_STOP_RECORD = 'RELEASE_TRAIN_PAUSED_BY_STOP';
const RELEASE_TRAIN_GH_TIMEOUT_MS = 15_000;

export function releaseTrainStopRecordPath(home = homedir()): string {
  return join(home, '.ashlr-runs', RELEASE_TRAIN_STOP_RECORD);
}

export interface ReleaseTrainStopGhResult { status: number | null; stdout: string }
export type ReleaseTrainStopGhRunner = (args: string[], timeout: number) => ReleaseTrainStopGhResult;
export interface ReleaseTrainStopDeps {
  home?: string;
  gh?: ReleaseTrainStopGhRunner;
  now?: () => Date;
  log?: (line: string) => void;
}

const runReleaseTrainStopGh: ReleaseTrainStopGhRunner = (args, timeout) =>
  spawnSync('gh', args, { encoding: 'utf8', stdio: 'pipe', timeout });

function releaseTrainStopRecord(value: unknown): value is {
  schema: typeof RELEASE_TRAIN_STOP_SCHEMA;
  at: string;
  variableWasOn: boolean | null;
} {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return row['schema'] === RELEASE_TRAIN_STOP_SCHEMA
    && typeof row['at'] === 'string' && Number.isFinite(Date.parse(row['at']))
    && (row['variableWasOn'] === true || row['variableWasOn'] === false || row['variableWasOn'] === null);
}

function readReleaseTrainVariableState(gh: ReleaseTrainStopGhRunner, log: (line: string) => void, timeout = RELEASE_TRAIN_GH_TIMEOUT_MS): boolean | null {
  try {
    const result = gh(['variable', 'get', 'PHANTOM_RELEASE_TRAIN', '-R', 'ashlrai/phantom'], timeout);
    if (result.status === 0) {
      const value = result.stdout.trim();
      if (value === 'on') return true;
      if (value === 'off') return false;
    }
  } catch { /* a failed read is unknown */ }
  log('PHANTOM_RELEASE_TRAIN state could not be read before fleet stop; recording unknown');
  return null;
}

export function readHostedReleaseTrainPause(gh: ReleaseTrainStopGhRunner = runReleaseTrainStopGh): 'paused' | 'enabled' | 'unknown' {
  const value = readReleaseTrainVariableState(gh, () => {}, 3_000);
  return value === false ? 'paused' : value === true ? 'enabled' : 'unknown';
}

function setReleaseTrainVariable(value: 'on' | 'off', gh: ReleaseTrainStopGhRunner, log: (line: string) => void): void {
  try {
    const result = gh(['variable', 'set', 'PHANTOM_RELEASE_TRAIN', '-R', 'ashlrai/phantom', '--body', value], RELEASE_TRAIN_GH_TIMEOUT_MS);
    if (result.status !== 0) log(`PHANTOM_RELEASE_TRAIN was not set ${value}`);
  } catch {
    log(`PHANTOM_RELEASE_TRAIN was not set ${value}`);
  }
}

export function pauseReleaseTrainForStop(deps: ReleaseTrainStopDeps = {}): void {
  const home = deps.home ?? homedir();
  const gh = deps.gh ?? runReleaseTrainStopGh;
  const log = deps.log ?? ((line: string) => console.error(line));
  const dir = join(home, '.ashlr-runs');
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    log('release autorun pause directory was not created');
  }
  try {
    writeFileSync(autorunOffPath(home), RELEASE_TRAIN_STOP_MARKER, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') log('release autorun pause file was not written');
  }
  const variableWasOn = readReleaseTrainVariableState(gh, log);
  try {
    writeFileSync(releaseTrainStopRecordPath(home), `${JSON.stringify({
      schema: RELEASE_TRAIN_STOP_SCHEMA,
      at: (deps.now ?? (() => new Date()))().toISOString(),
      variableWasOn,
    })}\n`, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    const recordPath = releaseTrainStopRecordPath(home);
    let existingRecordIsValid = false;
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      try {
        const stat = lstatSync(recordPath);
        existingRecordIsValid = !stat.isSymbolicLink() && stat.isFile()
          && releaseTrainStopRecord(JSON.parse(readFileSync(recordPath, 'utf8')) as unknown);
      } catch { /* a missing or invalid record cannot authorize restoration */ }
    }
    if (!existingRecordIsValid) {
      log('release train stop provenance was not recorded');
    }
  }
  setReleaseTrainVariable('off', gh, log);
}

export function resumeReleaseTrainAfterStop(deps: ReleaseTrainStopDeps = {}): void {
  const home = deps.home ?? homedir();
  const gh = deps.gh ?? runReleaseTrainStopGh;
  const log = deps.log ?? ((line: string) => console.error(line));
  const recordPath = releaseTrainStopRecordPath(home);
  if (!existsSync(recordPath)) return;

  let variableWasOn: boolean | null = null;
  try {
    const stat = lstatSync(recordPath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      log('release train stop provenance is not a regular file; leaving it untouched');
      return;
    }
    const record: unknown = JSON.parse(readFileSync(recordPath, 'utf8'));
    if (releaseTrainStopRecord(record)) variableWasOn = record.variableWasOn;
    else log('release train stop provenance is invalid; the GitHub variable will not be restored');
  } catch {
    log('release train stop provenance could not be read; the GitHub variable will not be restored');
  }

  const offPath = autorunOffPath(home);
  try {
    if (existsSync(offPath)) {
      const stat = lstatSync(offPath);
      if (!stat.isSymbolicLink() && stat.isFile() && readFileSync(offPath, 'utf8') === RELEASE_TRAIN_STOP_MARKER) {
        unlinkSync(offPath);
      } else {
        log(`Release train remains held by ${offPath}; delete it if the hold is not intentional.`);
      }
    }
  } catch {
    log(`Release train OFF file could not be cleared; check ${offPath} manually.`);
  }

  if (variableWasOn === true) setReleaseTrainVariable('on', gh, log);
  try {
    unlinkSync(recordPath);
  } catch {
    log('release train stop provenance could not be removed');
  }
}

/** Proven absence is inactive. A symlink, odd node, or unreadable path is unknown. */
export function readSentinel(path: string): KillObservation {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) return 'unknown';
    return 'active';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return 'inactive';
    return 'unknown';
  }
}

/** Hosted Actions cannot see ~/.ashlr/KILL. The repo variable is the remote stop. */
export function hostedTrainGate(env: { GITHUB_ACTIONS?: string; PHANTOM_RELEASE_TRAIN?: string }): { proceed: boolean; reason: string } | null {
  if (env.GITHUB_ACTIONS !== 'true') return null;
  if (env.PHANTOM_RELEASE_TRAIN === 'on') return { proceed: true, reason: 'repo-variable-on' };
  if (env.PHANTOM_RELEASE_TRAIN === 'off') return { proceed: false, reason: 'repo-variable-off' };
  return { proceed: false, reason: 'repo-variable-unset' };
}

export function releaseKillDecision(fleet: KillObservation, autorun: KillObservation): { proceed: boolean; reason: string } {
  if (fleet === 'active') return { proceed: false, reason: 'fleet-kill' };
  if (fleet !== 'inactive') return { proceed: false, reason: 'fleet-kill-unknown' };
  if (autorun === 'active') return { proceed: false, reason: 'release-autorun-off' };
  if (autorun !== 'inactive') return { proceed: false, reason: 'release-autorun-unknown' };
  return { proceed: true, reason: 'kill-inactive' };
}

/** Local stop stays authoritative. The GitHub variable update is best-effort. */
export function pauseReleaseTrain(exec: (file: string, args: string[], opts: { stdio: 'pipe'; timeout: number }) => unknown = execFileSync, home = homedir(), log: (line: string) => void = (line) => console.error(line)): void {
  try {
    const dir = join(home, '.ashlr-runs');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = autorunOffPath(home);
    if (!existsSync(path)) writeFileSync(path, 'release train off\n', { mode: 0o600 });
  } catch {
    log('release autorun pause file was not written');
  }
  try {
    exec('gh', ['variable', 'set', 'PHANTOM_RELEASE_TRAIN', '-R', 'ashlrai/phantom', '--body', 'off'], { stdio: 'pipe', timeout: 15_000 });
  } catch {
    log('PHANTOM_RELEASE_TRAIN was not set off');
  }
}

export function mergeStageDone(state: string | null | undefined): boolean {
  return state === 'MERGED';
}

export function enqueueReleasePullRequest(nodeId: string): ReleaseWrite {
  if (!PULL_NODE.test(nodeId)) throw new Error('refusing release enqueue');
  return { method: 'POST', path: 'graphql', body: { query: ENQUEUE_PULL_REQUEST, variables: { pullRequestId: nodeId } } };
}

/**
 * Refresh an ejected release-please head against current master. Planned only
 * for an unaddressed merge-queue ejection on a head that trails master; the
 * new merge commit makes pull_request checks re-verify the exact head, which
 * either re-greens for enqueue or goes red so release-please regenerates.
 */
export function syncReleasePullRequest(nodeId: string, headOid: string): ReleaseWrite {
  if (!PULL_NODE.test(nodeId) || !SHA.test(headOid)) throw new Error('refusing release branch sync');
  return { method: 'POST', path: 'graphql', body: { query: UPDATE_PULL_REQUEST_BRANCH, variables: { pullRequestId: nodeId, expectedHeadOid: headOid } } };
}

/** Configured release cadence in minutes. Valid values are 1 through 1440, with no hourly floor. */
export function cappedCadenceMinutes(raw: number): number {
  if (!Number.isInteger(raw) || raw < 1 || raw > 1440) throw new Error('invalid release cadence');
  return raw;
}

export function nextPatch(version: string): string {
  const match = VERSION.exec(version);
  if (!match) throw new Error('invalid source version');
  const patch = Number(match[3]);
  if (!Number.isSafeInteger(patch) || patch >= Number.MAX_SAFE_INTEGER) throw new Error('version overflow');
  return `${match[1]}.${match[2]}.${patch + 1}`;
}

function versionOf(tag: string): [number, number, number] | null {
  const match = TAG.exec(tag);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersion(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1;
  }
  return 0;
}

/** True when a tag is at least the next patch of master, the existing strictly-greater gate. */
export function successorTagConflict(masterVersion: string, tags: readonly { name: string }[]): boolean {
  const expected = nextPatch(masterVersion);
  return tags.some((tag) => {
    const version = versionOf(tag.name);
    const next = versionOf(`v${expected}`);
    return version !== null && next !== null && compareVersion(version, next) >= 0;
  });
}

export function refusePublishIfSuccessorConflict(writes: ReleaseWrite[], observed: Pick<TrainObservation, 'masterVersion' | 'tags'>): ReleaseWrite[] {
  if (!successorTagConflict(observed.masterVersion, observed.tags)) return writes;
  return writes.filter((write) => !write.path.endsWith('/publish-canonical-npm.yml/dispatches'));
}

type OpenReleasePr = TrainObservation['openReleasePr'];

/** A green, mergeable, unqueued release-please PR for exactly `version`. */
function readyReleasePr(pr: OpenReleasePr, checks: TrainObservation['pullChecks'], version: string): NonNullable<OpenReleasePr> | null {
  const ready = pr !== null && checks !== null && pr.state === 'OPEN' && !pr.queued && pr.version === version
    && pr.headRef.startsWith('release-please--') && SHA.test(pr.headSha) && pr.mergeable === 'MERGEABLE'
    && checks.failing === 0 && checks.pending === 0;
  return ready ? pr : null;
}

/**
 * Fix forward past a candidate that can never build. Its master push CI ended
 * red, so release-build has no green exact-source run to reuse and every
 * dispatched CI run ends without an artifact (v3.30.34, push run 43807308941).
 * When master has moved strictly past it, still carries that version, and the
 * required fast gate on master HEAD is green, the next patch is cut from
 * master. The candidate is only listed as skipped and superseded in the plan;
 * its tag and draft are never written.
 */
export function fixForwardDue(input: TrainObservation, candidate: { name: string; sha: string }): boolean {
  return input.pushCiRed === true && !input.build && !input.buildPending
    && input.head?.ancestry === 'ancestor' && input.masterSha !== candidate.sha
    && input.masterVersion === candidate.name.slice(1)
    && input.masterCi === 'green' && input.npmPublished !== true
    && !input.releases.some((row) => row.tag_name === candidate.name && row.draft === false);
}

export function isReleasePleaseCommit(message: string, version: string): boolean {
  const match = RELEASE_SUBJECT.exec(message);
  if (!match) return false;
  return `${match[1]}.${match[2]}.${match[3]}` === version;
}

/** Same names and all/any rules as ci-release-gate.mjs. A receipt is those check runs on one SHA. */
export const RELEASE_GATE_RECEIPT = Object.freeze([
  ['Merge Gate', 'all'],
  ['Secret-shape scan', 'all'],
  ['Secret scan (diff)', 'all'],
  ['Check generated files', 'any'],
  ['Check authority drift (hermetic)', 'any'],
  ['Quick typecheck', 'any'],
  ['Fast gate (typecheck + affected tests)', 'any'],
  ['Desktop release smoke', 'any'],
  ['Release suites (build + signing path)', 'any'],
] as const);

export type ReleaseGateReceipt = 'green' | 'red' | 'pending' | 'unknown';

/** Green only when every receipt row is present. Missing or running is pending. A bad conclusion is red. */
export function releaseGateReceipt(
  runs: readonly { name: string; status: string; conclusion: string | null; appId: number }[],
): ReleaseGateReceipt {
  let pending = false;
  for (const [name, rule] of RELEASE_GATE_RECEIPT) {
    const rows = runs.filter((run) => run.appId === ACTIONS_APP_ID && run.name === name);
    if (rows.length === 0) { pending = true; continue; }
    if (rows.some((run) => run.status !== 'completed')) { pending = true; continue; }
    const conclusions = rows.map((run) => run.conclusion ?? 'none');
    if (conclusions.some((conclusion) => conclusion !== 'success' && conclusion !== 'skipped')) return 'red';
    if (rule === 'all' && conclusions.includes('skipped')) return 'red';
    if (rule === 'any' && !conclusions.includes('success')) pending = true;
  }
  return pending ? 'pending' : 'green';
}

function releaseMismatch(tag: string, message: string): string {
  return `release_message_mismatch: tag=${tag} first_line=${JSON.stringify(message.split(/\r?\n/, 1)[0] ?? '')} expected=chore(<scope>): release ${tag.slice(1)}`;
}

export function docsCarriersSynced(message: string, version: string): boolean {
  return message.includes(`chore(release): sync candidate version carriers to ${version}`);
}

/**
 * Highest stable semver wins. Input order and a cached flag never choose an
 * older feed. Entries that are not X.Y.Z are ignored. An empty list is null.
 */
export function selectUpdaterFeed(entries: readonly { version: string; cached?: boolean }[]): string | null {
  let best: [number, number, number] | null = null;
  let chosen: string | null = null;
  for (const entry of entries) {
    const version = versionOf(`v${entry.version}`);
    if (!version) continue;
    if (!best || compareVersion(version, best) > 0) {
      best = version;
      chosen = entry.version;
    }
  }
  return chosen;
}

export function updaterFeedMatches(publishedVersion: string, feedVersion: string | null): boolean {
  return feedVersion === publishedVersion && VERSION.test(publishedVersion);
}

function newestTag(tags: { name: string; sha: string }[]): { name: string; sha: string } | null {
  let best: { name: string; sha: string; version: [number, number, number] } | null = null;
  const seen = new Set<string>();
  for (const tag of tags) {
    const version = versionOf(tag.name);
    if (!version || !SHA.test(tag.sha)) continue;
    const key = tag.name;
    if (seen.has(key)) throw new Error('duplicate release tag');
    seen.add(key);
    if (!best || compareVersion(version, best.version) > 0) best = { name: tag.name, sha: tag.sha, version };
  }
  return best ? { name: best.name, sha: best.sha } : null;
}

function supersedeMarker(successor: string): string {
  return `Superseded by ${successor}. This draft stays unpublished.`;
}

function signedAssetSet(names: string[]): boolean {
  const has = (suffix: string) => names.some((name) => name.endsWith(suffix));
  return has('.tgz') && has('.tgz.sig') && has('.app.tar.gz') && has('.app.tar.gz.sig')
    && names.includes('manifest.json') && names.includes('manifest.json.sig');
}

function latestTime(values: (string | null)[]): string | null {
  const times = values.filter((value): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value)));
  if (times.length === 0) return null;
  return times.sort()[times.length - 1] ?? null;
}

function timing(at: string | null, mergeAt: string | null): StageTiming {
  if (!at) return { at: null, sinceMergeMs: null };
  if (!mergeAt) return { at, sinceMergeMs: null };
  const ms = Date.parse(at) - Date.parse(mergeAt);
  return { at, sinceMergeMs: Number.isFinite(ms) && ms >= 0 ? ms : null };
}

function emptyStages(mergeAt: string | null): Record<string, StageTiming> {
  const names = ['merge', 'tag', 'build', 'attest', 'sign', 'notarize', 'npm', 'feed', 'docs', 'website', 'finalize'];
  return Object.fromEntries(names.map((name) => [name, name === 'merge' ? timing(mergeAt, mergeAt) : { at: null, sinceMergeMs: null }]));
}

export function assertReleaseWrite(write: ReleaseWrite): void {
  if (write.method !== 'PATCH' && write.method !== 'POST') throw new Error('refusing release write');
  const release = /^repos\/ashlrai\/phantom\/releases\/([1-9]\d*)$/;
  const dispatch = /^repos\/ashlrai\/phantom\/actions\/workflows\/(attest-ci-build|dependency-audit|publish-canonical-npm|ci|release-please|finalize-github-release)\.yml\/dispatches$/;
  if (write.path.includes('/merge') || JSON.stringify(write.body).includes('admin') || JSON.stringify(write.body).includes('bypass')) {
    throw new Error('refusing release write');
  }
  if (write.method === 'PATCH') {
    if (!release.test(write.path)) throw new Error('refusing release write');
    if (write.body.draft !== true || write.body.prerelease !== false) throw new Error('refusing to publish a superseded draft');
    return;
  }
  if (write.path === 'graphql') {
    const body = write.body as { query?: string; variables?: { pullRequestId?: string; expectedHeadOid?: string } };
    if (!PULL_NODE.test(body.variables?.pullRequestId ?? '')) throw new Error('refusing release pull request write');
    if (body.query === ENQUEUE_PULL_REQUEST) {
      if (body.variables?.expectedHeadOid !== undefined) throw new Error('refusing release enqueue');
      return;
    }
    if (body.query === UPDATE_PULL_REQUEST_BRANCH) {
      if (!SHA.test(body.variables?.expectedHeadOid ?? '')) throw new Error('refusing release branch sync');
      return;
    }
    throw new Error('refusing release write');
  }
  if (dispatch.test(write.path)) {
    const body = write.body as { ref?: string; inputs?: Record<string, string | boolean> };
    if ((body.ref !== 'master' && !/^v\d+\.\d+\.\d+$/.test(body.ref ?? '')) || !body.inputs) throw new Error('refusing workflow dispatch');
    if (write.path.endsWith('/release-please.yml/dispatches') && (body.ref !== 'master' || Object.keys(body.inputs).length !== 0)) throw new Error('refusing release PR dispatch');
    if (write.path.endsWith('/dependency-audit.yml/dispatches') && (!/^v\d+\.\d+\.\d+$/.test(body.ref ?? '') || Object.keys(body.inputs).length !== 0)) {
      throw new Error('refusing audit dispatch');
    }
    if (write.path.endsWith('/finalize-github-release.yml/dispatches')) {
      const inputs = body.inputs as Record<string, string>;
      const keys = Object.keys(inputs).sort();
      if (body.ref !== 'master' || keys.join(',') !== 'candidate_integrity,candidate_sha,confirm_stable_finalization,publish_run_attempt,publish_run_id,version') {
        throw new Error('refusing finalize dispatch');
      }
      if (inputs.version === '3.30.34' || inputs.confirm_stable_finalization !== 'true') throw new Error('refusing finalize dispatch');
      if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(inputs.version ?? '')) throw new Error('refusing finalize dispatch');
      if (!/^[1-9]\d*$/.test(inputs.publish_run_id ?? '') || !/^[1-9]\d*$/.test(inputs.publish_run_attempt ?? '')) throw new Error('refusing finalize dispatch');
      if (!/^[a-f0-9]{40}$/.test(inputs.candidate_sha ?? '')) throw new Error('refusing finalize dispatch');
      if (!/^sha512-[A-Za-z0-9+/]{86}==$/.test(inputs.candidate_integrity ?? '')) throw new Error('refusing finalize dispatch');
    }
    return;
  }
  throw new Error('refusing release write');
}

const RELEASE_PR_DISPATCH = `repos/${REPOSITORY}/actions/workflows/release-please.yml/dispatches`;

/**
 * Plan the next patch from green master after `fixForwardDue`. The only writes
 * are the sanctioned Release PR ones: enqueue a green release PR for exactly
 * `successor`, or ask the Release PR workflow (which re-checks green master
 * and cadence itself) to cut one. No PATCH is planned, so the skipped
 * candidate's draft and every older draft stay untouched in this run.
 */
function fixForward(input: TrainObservation, candidate: { name: string; sha: string }, successor: string, cadenceDue: boolean): TrainPlan {
  const pr = input.openReleasePr;
  const writes: ReleaseWrite[] = [];
  let releasePr: string;
  const ready = readyReleasePr(pr, input.pullChecks, successor);
  if (ready) {
    if (cadenceDue && !ready.branchSyncUnknown) writes.push(ready.branchSyncDue ? syncReleasePullRequest(ready.nodeId, ready.headSha) : enqueueReleasePullRequest(ready.nodeId));
    releasePr = !cadenceDue ? 'release-cadence-wait' : ready.branchSyncUnknown ? 'release-pr-compare-unknown' : ready.branchSyncDue ? 'release-pr-syncing' : 'release-pr-enqueued';
  } else if (pr && pr.state === 'OPEN' && pr.version === successor) {
    releasePr = pr.queued ? 'release-pr-queued' : 'release-pr-checks-pending';
  } else if (cadenceDue) {
    writes.push({ method: 'POST', path: RELEASE_PR_DISPATCH, body: { ref: 'master', inputs: {} } });
    releasePr = 'release-pr-dispatched';
  } else {
    releasePr = 'release-cadence-wait';
  }
  for (const write of writes) assertReleaseWrite(write);
  const reason = 'candidate-push-ci-red';
  const skipped = { tag: candidate.name, reason: `${reason}: tag=${candidate.name} sha=${candidate.sha} superseded_by=v${successor} master=${input.masterSha}` };
  const pending = (why?: string) => ({ status: 'pending' as const, ...(why ? { reason: why } : {}) });
  const steps: TrainState['steps'] = {
    kill: { status: 'complete' },
    admit: { status: 'complete' },
    supersede: { status: 'complete' },
    'release-pr': pending(releasePr),
    merge: pending(),
    tag: pending('auto-tag'),
    build: pending(),
    attest: pending(),
    sign: pending('mac-release-autorun'),
    notarize: pending('mac-release-autorun'),
    npm: pending(),
    feed: pending(),
    docs: pending(),
    website: pending('phantom-secrets'),
    finalize: pending(),
  };
  return {
    exitCode: 0,
    writes,
    state: {
      schema: TRAIN_SCHEMA, stopped: false, reason: 'fix-forward-from-master',
      version: successor, tag: `v${successor}`, sha: input.masterSha, next: 'release-pr',
      advance: { action: 'advance-from-master', version: successor, sha: input.masterSha, reason },
      superseded: [candidate.name],
      skippedTags: [...(input.skippedTags ?? []), skipped],
      website: WEBSITE_HOOK, steps, stages: emptyStages(null),
    },
  };
}

export function buildTrain(input: TrainObservation): TrainPlan {
  const kill = releaseKillDecision(input.fleetKill, input.autorunOff);
  const minutes = cappedCadenceMinutes(input.cadenceMinutes);
  const stopped = (reason: string): TrainPlan => ({
    exitCode: 1,
    writes: [],
    state: {
      schema: TRAIN_SCHEMA, stopped: true, reason, version: null, tag: null, sha: null, next: null,
      superseded: [], skippedTags: input.skippedTags ?? [], website: WEBSITE_HOOK,
      steps: { kill: { status: 'stopped', reason } },
      stages: emptyStages(null),
    },
  });
  if (!kill.proceed) return stopped(kill.reason);
  if (!SHA.test(input.masterSha) || !VERSION.test(input.masterVersion)) return stopped('master-identity');

  let headTag: { name: string; sha: string } | null;
  try { headTag = newestTag(input.tags); }
  catch { return stopped('duplicate-tag'); }
  if (input.head && input.head.sha === '') return stopped('candidate-refused: tag_sha_empty');
  const eligibleTags = input.tags.filter((tag) => !input.skippedTags?.some((skipped) => skipped.tag === tag.name));
  try { headTag = newestTag(eligibleTags); } catch { return stopped('duplicate-tag'); }
  if (!input.head || !headTag || input.head.tag !== headTag.name || input.head.sha !== headTag.sha) {
    return stopped(input.head ? 'candidate-not-newest' : 'no-release-tag');
  }
  const version = headTag.name.slice(1);
  const subjectAdmitted = isReleasePleaseCommit(input.head.message, version) || isReleasePleaseCommit(input.head.releaseMessage ?? '', version);
  // The tagged SHA is the release when its package.json version is the tag and
  // the release-gate receipt on that SHA is green. The commit subject is not
  // an input to the receipt, digest, or attestation checks, which stay bound
  // to this SHA.
  const receiptAdmitted = input.head.packageVersion === version && input.head.releaseGate === 'green';
  const admitted = (input.head.ancestry === 'ancestor' || input.head.ancestry === 'identical')
    && input.head.sha !== ''
    && (subjectAdmitted || receiptAdmitted);
  if (!admitted) {
    const detail = input.head.ancestry !== 'ancestor' && input.head.ancestry !== 'identical'
      ? `compare_not_ahead: ${input.head.compareStatus ?? input.head.ancestry}`
      : releaseMismatch(input.head.tag, input.head.message);
    return stopped(`candidate-refused: ${detail}`);
  }
  // Admission already requires ancestry `ancestor` or `identical`.
  // compare(candidate...master) status `ahead` is `ancestor` (master contains the tag).
  // That is the same relationship as compare(master...candidate) status `behind`.
  // `identical` is master HEAD. Diverged stays refused above. Red CI is refused here.
  if (input.candidateCi === 'red') return stopped('candidate-ci-red');
  const publishable = input.candidateCi === 'green';

  const marker = supersedeMarker(headTag.name);
  const superseded: string[] = [];
  const writes: ReleaseWrite[] = [];
  for (const row of input.releases) {
    if (row.draft !== true || row.tag_name === 'v3.30.34') continue;
    const older = versionOf(row.tag_name);
    const current = versionOf(headTag.name);
    if (!older || !current || compareVersion(older, current) >= 0) continue;
    if (row.body.includes(marker)) { superseded.push(row.tag_name); continue; }
    const body = `${row.body.trim()}\n\n${marker}\n`;
    const name = row.name.includes('(superseded by ') ? row.name : `${row.name} (superseded by ${headTag.name})`;
    writes.push({ method: 'PATCH', path: `repos/${REPOSITORY}/releases/${row.id}`, body: { name, body, draft: true, prerelease: false } });
    superseded.push(row.tag_name);
  }

  const elapsed = input.lastTaggedAt ? Date.parse(input.now) - Date.parse(input.lastTaggedAt) : Number.NaN;
  const cadenceDue = input.aheadBy > 0 && Number.isFinite(elapsed) && elapsed >= minutes * 60_000;
  const expected = nextPatch(input.masterVersion);
  if (successorTagConflict(input.masterVersion, input.tags)) return stopped('duplicate_tag');
  const pr = input.openReleasePr;
  const checks = input.pullChecks;
  if (fixForwardDue(input, headTag)) return fixForward(input, headTag, expected, cadenceDue);
  const ready = cadenceDue ? readyReleasePr(pr, checks, expected) : null;
  if (ready && !ready.branchSyncUnknown) writes.push(ready.branchSyncDue ? syncReleasePullRequest(ready.nodeId, ready.headSha) : enqueueReleasePullRequest(ready.nodeId));

  const row = input.releases.find((release) => release.tag_name === headTag.name) ?? null;
  const names = row?.assets.map((asset) => asset.name) ?? [];
  const signed = signedAssetSet(names);
  const feed = names.includes('latest.json');
  const published = row !== null && row.draft === false && feed;
  const assetAt = latestTime(row?.assets.map((asset) => asset.created_at) ?? []);
  // Always dispatch CI and attest on the tag ref, even when that commit is
  // also master HEAD. ci.yml has no on.push.tags trigger, and a master ref
  // hides the build from anyone looking for the tag; both refs peel to the
  // same SHA when they match, but github.ref_name must be the tag so the
  // phantom-release-<tag> concurrency group and tag-scoped workflows apply.
  const ref = headTag.name;
  // The Mac autorun looks up the dependency audit by the release SHA. A master
  // push audit is not a tag-ref run, so dispatch the audit on the tag itself
  // as soon as this candidate is admitted. Empty inputs keep the audit workflow
  // on its own steps. GITHUB_TOKEN sends it; the release App has no actions right.
  if (!input.audit && !input.auditPending && publishable) {
    writes.push({
      method: 'POST', path: `repos/${REPOSITORY}/actions/workflows/dependency-audit.yml/dispatches`,
      body: { ref, inputs: {} },
    });
  }
  if (!input.build && !input.buildPending && publishable && !input.pushCiRed && !(row?.draft === false && input.npmPublished === true)) {
    writes.push({
      method: 'POST', path: `repos/${REPOSITORY}/actions/workflows/ci.yml/dispatches`,
      // ci.yml types release_gate as boolean. The dispatch API stores inputs as
      // strings; Actions then exposes inputs.release_gate as a boolean.
      body: { ref, inputs: { release_gate: 'true' } },
    });
  }
  if (input.build && !input.attest && !input.attestPending && publishable) {
    writes.push({
      method: 'POST', path: `repos/${REPOSITORY}/actions/workflows/attest-ci-build.yml/dispatches`,
      body: { ref, inputs: {
        ci_run_id: String(input.build.runId), ci_run_attempt: String(input.build.attempt),
        candidate_sha: headTag.sha, build_artifact_id: String(input.build.artifactId),
      } },
    });
  }
  if (input.build && input.attest && input.audit && input.npmPublished === false && publishable) {
    // Re-run the strictly-greater tag check immediately before publish dispatch.
    if (successorTagConflict(input.masterVersion, input.tags)) return stopped('duplicate_tag');
    writes.push({
      method: 'POST', path: `repos/${REPOSITORY}/actions/workflows/publish-canonical-npm.yml/dispatches`,
      body: { ref: 'master', inputs: {
        candidate_sha: headTag.sha, ci_run_id: String(input.build.runId), ci_run_attempt: String(input.build.attempt),
        attestor_run_id: String(input.attest.runId), attestor_run_attempt: String(input.attest.attempt),
        attested_artifact_id: String(input.attest.artifactId), version,
        audit_run_id: String(input.audit.runId), audit_run_attempt: String(input.audit.attempt),
      } },
    });
  }
  const stocked = signed && names.includes('latest.json');
  const finalizeRetry = finalizeRetryDecision({
    now: input.now, version, sha: headTag.sha, since: input.head.committedAt, runs: input.finalizeRuns ?? [],
  });
  if (row?.draft === true && stocked && publishable && input.npmPublished === true && input.npmPublish
    && input.finalizePending !== true && finalizeRetry.dispatch && version !== '3.30.34' && headTag.name !== 'v3.30.34') {
    writes.push({
      method: 'POST', path: `repos/${REPOSITORY}/actions/workflows/finalize-github-release.yml/dispatches`,
      body: { ref: 'master', inputs: {
        version, publish_run_id: String(input.npmPublish.runId), publish_run_attempt: String(input.npmPublish.attempt),
        candidate_sha: headTag.sha, candidate_integrity: input.npmPublish.integrity, confirm_stable_finalization: 'true',
      } },
    });
  }
  for (const write of writes) assertReleaseWrite(write);

  const feedMatches = updaterFeedMatches(version, input.feedVersion);
  const publishedFeed = published && feedMatches;
  if (published && !feedMatches) {
    return {
      exitCode: 1,
      writes: [],
      state: {
        schema: TRAIN_SCHEMA, stopped: true, reason: 'feed-version-mismatch', version, tag: headTag.name, sha: headTag.sha,
        next: 'feed', superseded, skippedTags: input.skippedTags ?? [], website: WEBSITE_HOOK,
        steps: { feed: { status: 'pending', reason: 'feed-version-mismatch' } },
        stages: emptyStages(input.head.committedAt),
      },
    };
  }

  const mergeAt = input.head.committedAt;
  const docs = input.docsSynced && docsCarriersSynced(input.head.message, version);
  const steps: TrainState['steps'] = {
    kill: { status: 'complete' },
    admit: { status: 'complete' },
    merge: { status: mergeStageDone(admitted ? 'MERGED' : pr?.state) ? 'complete' : 'pending' },
    supersede: { status: writes.some((write) => write.method === 'PATCH') ? 'pending' : 'complete' },
    build: {
      status: input.build ? 'complete' : 'pending',
      ...(!input.build && !publishable ? { reason: input.candidateCi === 'pending' ? 'candidate-ci-pending' : 'candidate-ci-unknown' }
        : !input.build && input.pushCiRed ? { reason: 'candidate-push-ci-red' } : {}),
    },
    attest: { status: input.attest ? 'complete' : 'pending' },
    sign: { status: signed ? 'complete' : 'pending', reason: signed ? 'signed-release-assets' : 'mac-release-autorun' },
    notarize: { status: signed ? 'complete' : 'pending', reason: signed ? 'signed-release-assets' : 'mac-release-autorun' },
    npm: { status: input.npmPublished === true ? 'complete' : 'pending', ...(input.npmPublished === null ? { reason: 'registry-unknown' } : {}) },
    feed: { status: publishedFeed || (feed && !published && feedMatches) ? 'complete' : 'pending', ...(published && !feedMatches ? { reason: 'feed-version-mismatch' } : {}) },
    docs: { status: docs ? 'complete' : 'pending' },
    website: { status: docs ? 'hooked' : 'pending', reason: 'phantom-secrets' },
    finalize: { status: publishedFeed && input.npmPublished === true ? 'complete' : 'pending' },
  };
  const order = ['build', 'attest', 'sign', 'notarize', 'npm', 'feed', 'docs', 'finalize'];
  if (steps.supersede?.status === 'pending') order.unshift('supersede');
  const next = order.find((name) => steps[name]?.status === 'pending') ?? null;
  const stages = emptyStages(mergeAt);
  stages.tag = timing(row?.created_at ?? null, mergeAt);
  stages.build = timing(input.build?.completedAt ?? null, mergeAt);
  stages.attest = timing(input.attest?.completedAt ?? null, mergeAt);
  stages.sign = timing(signed ? assetAt : null, mergeAt);
  stages.notarize = timing(signed ? assetAt : null, mergeAt);
  stages.npm = timing(input.npmPublished === true ? input.npmAt : null, mergeAt);
  stages.feed = timing(feed ? assetAt : null, mergeAt);
  stages.docs = timing(docs ? mergeAt : null, mergeAt);
  stages.website = { at: null, sinceMergeMs: null };
  stages.finalize = timing(published ? assetAt : null, mergeAt);
  return {
    exitCode: 0,
    writes,
    state: {
      schema: TRAIN_SCHEMA, stopped: false, reason: kill.reason, version, tag: headTag.name, sha: headTag.sha,
      next, superseded, skippedTags: input.skippedTags ?? [], website: WEBSITE_HOOK, steps, stages,
    },
  };
}

/**
 * Step summary for the workflow run. A skipped tag is not a blocker: it has no
 * release-please commit (e.g. a hand version bump), is never published, and is
 * superseded once the next release-please tag is admitted.
 */
export function trainStepSummary(state: Pick<TrainState, 'reason' | 'skippedTags'>): string {
  const skipped = state.skippedTags ?? [];
  const lines = [`### Release train`, '', state.reason];
  if (skipped.length > 0) {
    lines.push('', 'Skipped tags. They have no release-please commit, so the train never publishes them;'
      + ' the next release-please tag supersedes their drafts. Not a blocker for the candidate above.');
    for (const item of skipped) lines.push(`- ${item.reason}`);
  }
  return `${lines.join('\n')}\n`;
}

export function markWritesApplied(state: TrainState): TrainState {
  const steps: TrainState['steps'] = { ...state.steps, supersede: { status: 'complete' } };
  const order = ['build', 'attest', 'sign', 'notarize', 'npm', 'feed', 'docs', 'finalize'];
  const next = order.find((name) => steps[name]?.status === 'pending') ?? null;
  return { ...state, steps, next: state.advance ? 'release-pr' : next };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

async function pages(read: (path: string) => Promise<unknown>, path: string): Promise<unknown[]> {
  const rows: unknown[] = [];
  for (let page = 1; page <= 10; page += 1) {
    const batch = await read(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    if (!Array.isArray(batch)) throw new Error('incomplete release inventory');
    rows.push(...batch);
    if (batch.length < 100) return rows;
  }
  throw new Error('incomplete release inventory');
}

async function packageVersionAt(read: (path: string) => Promise<unknown>, sha: string): Promise<string | null> {
  try {
    const content = record(await read(`repos/${REPOSITORY}/contents/package.json?ref=${sha}`));
    if (content?.encoding !== 'base64' || typeof content.content !== 'string') return null;
    const pkg = record(JSON.parse(Buffer.from(content.content.replace(/\s/g, ''), 'base64').toString('utf8')));
    if (pkg?.name !== '@ashlr/phantom' || typeof pkg.version !== 'string' || !VERSION.test(pkg.version)) return null;
    return pkg.version;
  } catch {
    return null;
  }
}

async function releaseGateFor(read: (path: string) => Promise<unknown>, sha: string): Promise<ReleaseGateReceipt> {
  try {
    const collected: { name: string; status: string; conclusion: string | null; appId: number }[] = [];
    let total: number | null = null;
    for (let page = 1; page <= 10; page += 1) {
      const listed = record(await read(`repos/${REPOSITORY}/commits/${sha}/check-runs?filter=latest&app_id=${ACTIONS_APP_ID}&per_page=100&page=${page}`));
      const batch = listed && Array.isArray(listed.check_runs) ? listed.check_runs : null;
      const pageTotal = listed && Number.isInteger(listed.total_count) ? Number(listed.total_count) : null;
      if (!batch || pageTotal === null || pageTotal < 0) return 'unknown';
      if (total === null) total = pageTotal;
      else if (pageTotal !== total) return 'unknown';
      for (const row of batch) {
        const item = record(row);
        collected.push({
          name: text(item?.name) ?? '',
          status: text(item?.status) ?? '',
          conclusion: text(item?.conclusion),
          appId: Number(record(item?.app)?.id),
        });
      }
      if (batch.length < 100) break;
    }
    if (total === null || total !== collected.length || collected.length > 1000) return 'unknown';
    return releaseGateReceipt(collected);
  } catch {
    return 'unknown';
  }
}

async function ancestorReleaseMessage(read: (path: string) => Promise<unknown>, tag: { name: string; sha: string }): Promise<string | null> {
  const version = tag.name.slice(1);
  const content = record(await read(`repos/${REPOSITORY}/contents/package.json?ref=${tag.sha}`));
  if (content?.encoding !== 'base64' || typeof content.content !== 'string') return null;
  const pkg = record(JSON.parse(Buffer.from(content.content.replace(/\s/g, ''), 'base64').toString('utf8')));
  if (pkg?.name !== '@ashlr/phantom' || pkg.version !== version) return null;
  const rows = await read(`repos/${REPOSITORY}/commits?sha=${tag.sha}&per_page=30`);
  if (!Array.isArray(rows)) return null;
  for (const row of rows) {
    const message = text(record(record(row)?.commit)?.message) ?? '';
    if (isReleasePleaseCommit(message, version)) return message;
  }
  return null;
}

export interface ReleasePrQueueState {
  queued: boolean;
  /**
   * createdAt of the newest merge-queue removal, only when it is the latest
   * queue event and the PR is not currently queued. A removal means the merge
   * group rejected this head against a newer base; the head's own required
   * checks can stay green because they verified an older merge.
   */
  ejectedAt: string | null;
  /** committedDate of the PR head commit; null when the read did not return it. */
  headCommittedAt: string | null;
}

const RELEASE_PR_QUEUED = 'query($id:ID!){node(id:$id){... on PullRequest{isInMergeQueue}}}';
const RELEASE_PR_EJECTION = 'query($id:ID!){node(id:$id){... on PullRequest{headRef{target{... on Commit{committedDate}}} timelineItems(last:20,itemTypes:[ADDED_TO_MERGE_QUEUE_EVENT,REMOVED_FROM_MERGE_QUEUE_EVENT]){nodes{__typename ... on AddedToMergeQueueEvent{createdAt} ... on RemovedFromMergeQueueEvent{createdAt}}}}}}';

function graphqlNode(call: (method: string, path: string, body?: unknown) => string, query: string, nodeId: string): Record<string, unknown> | null {
  const payload: unknown = JSON.parse(call('POST', 'graphql', { query, variables: { id: nodeId } }));
  const errors = record(payload)?.errors;
  if (Array.isArray(errors) && errors.length > 0) throw new Error('release queue state unavailable');
  return record(record(record(payload)?.data)?.node);
}

/**
 * Merge-queue membership is GraphQL-only; REST pull reads never expose it.
 * enqueuePullRequest rejects an already-queued PR, so the plan must observe
 * the entry instead of planning a write that can only fail. Membership stays
 * on the minimal proven query; the ejection detail is a second best-effort
 * read whose failure degrades to ordinary enqueue evidence, never to a
 * stalled observation.
 */
export async function releasePrMergeQueueState(
  nodeId: string,
  call: (method: string, path: string, body?: unknown) => string = gh,
): Promise<ReleasePrQueueState> {
  if (!PULL_NODE.test(nodeId)) throw new Error('invalid release pull request');
  const node = graphqlNode(call, RELEASE_PR_QUEUED, nodeId);
  if (typeof node?.isInMergeQueue !== 'boolean') throw new Error('release queue state unavailable');
  if (node.isInMergeQueue) return { queued: true, ejectedAt: null, headCommittedAt: null };
  let ejectedAt: string | null = null;
  let headCommittedAt: string | null = null;
  try {
    const detail = graphqlNode(call, RELEASE_PR_EJECTION, nodeId);
    const items = record(detail?.timelineItems)?.nodes;
    const events = Array.isArray(items) ? items.map(record) : [];
    const last = record(events.at(-1));
    ejectedAt = last?.__typename === 'RemovedFromMergeQueueEvent' ? text(last.createdAt) : null;
    headCommittedAt = text(record(record(detail?.headRef)?.target)?.committedDate);
  } catch {
    ejectedAt = null;
    headCommittedAt = null;
  }
  return { queued: false, ejectedAt, headCommittedAt };
}

export async function observeTrain(
  read: (path: string) => Promise<unknown>,
  now = new Date().toISOString(),
  cadenceMinutes = cadenceMinutesFromEnv(),
  kill: { fleet: KillObservation; autorun: KillObservation } = {
    fleet: readLocalTrainStop(),
    autorun: readSentinel(autorunOffPath()),
  },
  mergeQueueLookup: (nodeId: string) => Promise<ReleasePrQueueState> = releasePrMergeQueueState,
): Promise<TrainObservation> {
  const repo = record(await read(`repos/${REPOSITORY}`));
  if (repo?.id !== REPOSITORY_ID || repo.full_name !== REPOSITORY) throw new Error('unexpected repository');
  const master = record(await read(`repos/${REPOSITORY}/commits/master`));
  const masterSha = text(master?.sha);
  if (!masterSha || !SHA.test(masterSha)) throw new Error('master identity unavailable');
  const content = record(await read(`repos/${REPOSITORY}/contents/package.json?ref=${masterSha}`));
  if (content?.encoding !== 'base64' || typeof content.content !== 'string') throw new Error('package metadata unavailable');
  const pkg = record(JSON.parse(Buffer.from(content.content.replace(/\s/g, ''), 'base64').toString('utf8')));
  if (pkg?.name !== '@ashlr/phantom' || typeof pkg.version !== 'string' || !VERSION.test(pkg.version)) throw new Error('package metadata unavailable');
  const masterVersion = pkg.version;
  let lastTaggedAt: string | null = null;
  let aheadBy = 0;
  const current = await read(`repos/${REPOSITORY}/git/ref/tags/v${masterVersion}`);
  if (current !== null) {
    const ref = record(current);
    const object = record(ref?.object);
    if (ref?.ref !== `refs/tags/v${masterVersion}` || !object) throw new Error('current tag is not a commit');
    const tagSha = await peeledTagCommit(read, object);
    const tagged = record(await read(`repos/${REPOSITORY}/commits/${tagSha}`));
    lastTaggedAt = text(record(record(tagged?.commit)?.committer)?.date);
    const compare = record(await read(`repos/${REPOSITORY}/compare/${tagSha}...${masterSha}`));
    if (compare?.status === 'ahead' && Number.isInteger(compare.ahead_by)) aheadBy = Number(compare.ahead_by);
    else if (compare?.status === 'identical') aheadBy = 0;
    else throw new Error('current tag is not an ancestor of master');
  }
  const tagRows = await pages(read, `repos/${REPOSITORY}/tags`);
  const tags = tagRows.map((row) => {
    const item = record(row);
    return { name: text(item?.name) ?? '', sha: text(record(item?.commit)?.sha) ?? '' };
  }).filter((tag) => TAG.test(tag.name));
  // Validate each candidate after the ancestor walk; a newer unrelated tag
  // must not hide the latest actual release.
  const skippedTags: { tag: string; reason: string }[] = [];
  let head: TrainObservation['head'] = null;
  let firstRejected: TrainObservation['head'] = null;
  const remaining = [...tags];
  while (remaining.length > 0) {
    const newest = newestTag(remaining);
    if (!newest) break;
    const commit = record(await read(`repos/${REPOSITORY}/commits/${newest.sha}`));
    const message = text(record(commit?.commit)?.message) ?? '';
    const committedAt = text(record(record(commit?.commit)?.committer)?.date);
    const compare = record(await read(`repos/${REPOSITORY}/compare/${newest.sha}...${masterSha}`));
    const status = text(compare?.status);
    const ancestry: Ancestry = status === 'ahead' ? 'ancestor' : status === 'identical' ? 'identical' : status === 'diverged' ? 'diverged' : status === 'behind' ? 'behind' : 'unknown';
    const candidate: NonNullable<TrainObservation['head']> = { tag: newest.name, sha: newest.sha, message, ancestry, compareStatus: status ?? 'unknown', committedAt };
    const version = newest.name.slice(1);
    if (!isReleasePleaseCommit(message, version)) {
      const releaseMessage = await ancestorReleaseMessage(read, newest);
      if (releaseMessage) candidate.releaseMessage = releaseMessage;
    }
    candidate.packageVersion = await packageVersionAt(read, newest.sha);
    if (candidate.packageVersion === version) candidate.releaseGate = await releaseGateFor(read, newest.sha);
    const subject = isReleasePleaseCommit(message, version) || candidate.releaseMessage !== undefined;
    const receipt = candidate.packageVersion === version && candidate.releaseGate === 'green';
    if (subject || receipt) {
      head = candidate;
      break;
    }
    firstRejected ??= candidate;
    skippedTags.push({ tag: newest.name, reason: releaseMismatch(newest.name, message) });
    remaining.splice(remaining.findIndex((tag) => tag.name === newest.name), 1);
  }
  if (!head && firstRejected) {
    head = firstRejected;
    skippedTags.splice(skippedTags.findIndex((item) => item.tag === head?.tag), 1);
  }
  const releaseRows = await pages(read, `repos/${REPOSITORY}/releases`);
  const releases: ReleaseRow[] = releaseRows.map((row) => {
    const item = record(row);
    const id = item?.id;
    if (!Number.isSafeInteger(id) || Number(id) <= 0) throw new Error('invalid release id');
    const assets = Array.isArray(item?.assets) ? item.assets.map((asset) => {
      const entry = record(asset);
      return { name: text(entry?.name) ?? '', created_at: text(entry?.created_at) };
    }) : [];
    return {
      id: Number(id), tag_name: text(item?.tag_name) ?? '', draft: item?.draft === true,
      name: text(item?.name) ?? '', body: text(item?.body) ?? '', created_at: text(item?.created_at), assets,
    };
  });
  const pulls = await pages(read, `repos/${REPOSITORY}/pulls?state=open`);
  const candidates = pulls.filter((row) => {
    const item = record(row);
    const title = text(item?.title) ?? '';
    const headRef = text(record(item?.head)?.ref) ?? '';
    return /^chore\([^)]+\): release \d+\.\d+\.\d+/.test(title) && headRef.startsWith('release-please--');
  });
  if (candidates.length > 1) throw new Error('multiple open release pull requests');
  let openReleasePr: TrainObservation['openReleasePr'] = null;
  const listed = record(candidates[0]);
  if (listed && Number.isSafeInteger(listed.number)) {
    const detail = record(await read(`repos/${REPOSITORY}/pulls/${Number(listed.number)}`));
    const title = text(detail?.title) ?? '';
    const version = /^chore\([^)]+\): release (\d+\.\d+\.\d+)/.exec(title)?.[1];
    const headRef = text(record(detail?.head)?.ref) ?? '';
    const headSha = text(record(detail?.head)?.sha) ?? '';
    const nodeId = text(detail?.node_id) ?? '';
    const pullState = detail?.merged_at ? 'MERGED' : detail?.state === 'open' ? 'OPEN' : 'OPEN';
    if (!version || !headRef.startsWith('release-please--') || !SHA.test(headSha) || !PULL_NODE.test(nodeId)) throw new Error('invalid release pull request');
    // mergeable_state folds in advisory check and review state; enqueue
    // authority is the required-check judgment below plus GitHub's own rules.
    const mergeable = detail?.mergeable === true ? 'MERGEABLE' : detail?.mergeable === false ? 'CONFLICTING' : 'UNKNOWN';
    openReleasePr = { number: Number(listed.number), nodeId, version, headSha, headRef, mergeable, state: pullState, queued: false, queueEjectedAt: null, headCommittedAt: null, branchSyncDue: false };
  }
  // Required check names are shared by the release-PR head, the admitted
  // candidate and the fix-forward master read; fetch the ruleset evidence once.
  let requiredNamesPromise: Promise<string[]> | null = null;
  const requiredNames = () => (requiredNamesPromise ??= requiredCheckNames(read));
  let pullChecks: TrainObservation['pullChecks'] = null;
  if (openReleasePr) {
    const queue = await mergeQueueLookup(openReleasePr.nodeId);
    openReleasePr.queued = queue.queued;
    openReleasePr.queueEjectedAt = queue.ejectedAt;
    openReleasePr.headCommittedAt = queue.headCommittedAt;
    // A merge-queue ejection leaves the head's own required checks green:
    // they verified head+base at pull_request time while the queue rejected
    // head+base at enqueue time. When that rejection postdates the head
    // commit, the green evidence is stale and re-enqueueing retries a merge
    // the queue already refused. Sync the branch once so pull_request checks
    // re-verify the exact head against current master: a transient failure
    // then merges, a deterministic one surfaces as red head checks and lets
    // release-please regenerate. The head-commit comparison keeps a synced
    // head from re-entering this path, and the base comparison keeps a head
    // that already contains master from planning a no-op update.
    const ejectedMs = queue.ejectedAt ? Date.parse(queue.ejectedAt) : Number.NaN;
    const committedMs = queue.headCommittedAt ? Date.parse(queue.headCommittedAt) : Number.NaN;
    if (Number.isFinite(ejectedMs) && Number.isFinite(committedMs) && ejectedMs > committedMs) {
      // A failed or unrecognized compare is unknown, never clear: the plan
      // defers writes to this PR rather than enqueueing stale evidence or
      // planning a blind sync, while the rest of the observation completes.
      try {
        const compare = record(await read(`repos/${REPOSITORY}/compare/${masterSha}...${openReleasePr.headSha}`));
        const status = text(compare?.status);
        if (status === 'behind' || status === 'diverged') openReleasePr.branchSyncDue = true;
        else if (status !== 'ahead' && status !== 'identical') openReleasePr.branchSyncUnknown = true;
      } catch {
        openReleasePr.branchSyncUnknown = true;
      }
    }
    // Only required checks gate the enqueue: advisory Actions runs (dependency
    // audit, Vercel-adjacent jobs) neither block nor substitute for Merge Gate.
    const prCi = await requiredCiOnSha(read, openReleasePr.headSha, await requiredNames());
    pullChecks = { pending: prCi === 'pending' ? 1 : 0, failing: prCi === 'red' || prCi === 'unknown' ? 1 : 0 };
  }
  const version = head ? head.tag.slice(1) : masterVersion;
  const found = head ? await successfulRun(read, 'ci.yml', head.sha, head.tag) : { build: null, pending: false, pushCiRed: false };
  const audited = head ? await auditRun(read, head.sha) : { audit: null, pending: false };
  const attested = found.build ? await attestRun(read, found.build.runId, found.build.attempt) : { attest: null, pending: false };
  const npm = await read(`registry/npm/@ashlr/phantom/${version}`);
  const npmRecord = record(npm);
  const integrity = text(record(npmRecord?.dist)?.integrity) ?? '';
  let npmPublish: TrainObservation['npmPublish'] = null;
  if (/^sha512-[A-Za-z0-9+/]{86}==$/.test(integrity)) {
    try {
      const parsed = publishRunFromAttestation(await read(`registry/attestations/@ashlr/phantom/${version}`));
      if (parsed) npmPublish = { ...parsed, integrity };
    } catch {
      npmPublish = null;
    }
  }
  let finalizePending = false;
  let finalizeRuns: FinalizeRunRecord[] = [];
  if (npmPublish) {
    try {
      finalizeRuns = await listFinalizeRuns(read, now);
      finalizePending = finalizeRuns.some((run) => run.status !== 'completed');
    } catch {
      finalizePending = true;
    }
  }
  const docsSynced = head ? docsCarriersSynced(head.message, version) : false;
  const candidateCi = head ? await requiredCiOnSha(read, head.sha, await requiredNames()) : 'unknown';
  // Only a candidate that can never build needs master's gate: see fixForwardDue.
  const masterCi = head && found.pushCiRed && !found.build && !found.pending && head.sha !== masterSha
    ? await requiredCiOnSha(read, masterSha, await requiredNames()) : undefined;
  return {
    now, fleetKill: kill.fleet, autorunOff: kill.autorun,
    masterSha, masterVersion, cadenceMinutes, lastTaggedAt, aheadBy, tags, head, skippedTags, releases,
    openReleasePr, pullChecks, candidateCi, build: found.build, buildPending: found.pending, pushCiRed: found.pushCiRed,
    ...(masterCi ? { masterCi } : {}),
    attest: attested.attest, attestPending: attested.pending, audit: audited.audit, auditPending: audited.pending,
    npmPublished: npm === null ? false : npmRecord?.version === version ? true : null,
    npmAt: text(npmRecord?.time) ?? (npmRecord && record(npmRecord.time)?.[version] ? String(record(npmRecord.time)?.[version]) : null),
    npmPublish,
    finalizePending,
    finalizeRuns,
    docsSynced,
    feedVersion: await publishedFeedVersion(read, releases, head?.tag ?? null),
  };
}

async function peeledTagCommit(read: (path: string) => Promise<unknown>, object: Record<string, unknown>): Promise<string> {
  let current: Record<string, unknown> | null = object;
  const seen = new Set<string>();
  for (let depth = 0; current?.type === 'tag'; depth += 1) {
    const annotation = text(current.sha) ?? '';
    if (depth >= 4 || !SHA.test(annotation) || seen.has(annotation)) throw new Error('current tag is not a commit');
    seen.add(annotation);
    const tag = record(await read(`repos/${REPOSITORY}/git/tags/${annotation}`));
    if (text(tag?.sha) !== annotation) throw new Error('current tag is not a commit');
    current = record(tag?.object);
    if (!current) throw new Error('current tag is not a commit');
  }
  const sha = text(current?.sha) ?? '';
  if (current?.type !== 'commit' || !SHA.test(sha)) throw new Error('current tag is not a commit');
  return sha;
}

function checkContext(value: unknown): string | null {
  const name = text(record(value)?.context) ?? (typeof value === 'string' ? value : null);
  return name && name.length > 0 && name.length <= 128 && !name.includes('\n') ? name : null;
}

/** Required check contexts from rulesets and classic branch protection. */
async function requiredCheckNames(read: (path: string) => Promise<unknown>): Promise<string[]> {
  const names = new Set<string>();
  const rules = await read(`repos/${REPOSITORY}/rules/branches/master`);
  if (Array.isArray(rules)) {
    for (const rule of rules) {
      const item = record(rule);
      if (item?.type !== 'required_status_checks') continue;
      const checks = record(item.parameters)?.required_status_checks;
      if (!Array.isArray(checks)) continue;
      for (const check of checks) {
        const name = checkContext(check);
        if (name) names.add(name);
      }
    }
  }
  const branch = record(await read(`repos/${REPOSITORY}/branches/master`));
  const contexts = record(record(branch?.protection)?.required_status_checks)?.contexts;
  if (Array.isArray(contexts)) {
    for (const context of contexts) {
      const name = checkContext(context);
      if (name) names.add(name);
    }
  }
  return [...names];
}

/** Required contexts judged on this exact SHA's latest Actions check runs. */
async function requiredCiOnSha(read: (path: string) => Promise<unknown>, sha: string, names: readonly string[]): Promise<CandidateCi> {
  const collected: unknown[] = [];
  let total: number | null = null;
  for (let page = 1; page <= 10; page += 1) {
    const listed = record(await read(`repos/${REPOSITORY}/commits/${sha}/check-runs?filter=latest&app_id=${ACTIONS_APP_ID}&per_page=100&page=${page}`));
    const batch = listed && Array.isArray(listed.check_runs) ? listed.check_runs : null;
    const pageTotal = listed && Number.isInteger(listed.total_count) ? Number(listed.total_count) : null;
    if (!batch || pageTotal === null || pageTotal < 0) return 'unknown';
    if (total === null) total = pageTotal;
    else if (pageTotal !== total) return 'unknown';
    collected.push(...batch);
    if (batch.length < 100) break;
  }
  if (total === null || total !== collected.length || collected.length > 1000) return 'unknown';
  const parsed = collected.map((row) => {
    const item = record(row);
    return {
      name: text(item?.name) ?? '',
      status: text(item?.status) ?? '',
      conclusion: text(item?.conclusion),
      appId: Number(record(item?.app)?.id),
    };
  });
  return judgeRequiredChecks(names, parsed);
}

async function publishedFeedVersion(read: (path: string) => Promise<unknown>, releases: ReleaseRow[], tag: string | null): Promise<string | null> {
  const row = tag ? releases.find((release) => release.tag_name === tag) : undefined;
  if (!row || row.draft) return null;
  const body = record(await read('updater/latest.json'));
  const version = text(body?.version);
  return version && VERSION.test(version) ? version : null;
}

export function admitCiRun(run: Record<string, unknown>, sha: string, tag: string): boolean {
  if (run.head_sha !== sha || run.path !== '.github/workflows/ci.yml') return false;
  if (run.event !== 'workflow_dispatch' && run.event !== 'schedule') return false;
  if (text(record(run.repository)?.full_name) !== REPOSITORY) return false;
  if (text(record(run.head_repository)?.full_name) !== REPOSITORY) return false;
  return run.head_branch === 'master' || run.head_branch === tag;
}

async function successfulRun(read: (path: string) => Promise<unknown>, workflow: string, sha: string, tag: string): Promise<{ build: TrainObservation['build']; pending: boolean; pushCiRed: boolean }> {
  const listed = record(await read(`repos/${REPOSITORY}/actions/workflows/${workflow}/runs?head_sha=${sha}&per_page=20`));
  const runs = Array.isArray(listed?.workflow_runs) ? listed.workflow_runs : [];
  if (!Number.isInteger(listed?.total_count) || Number(listed?.total_count) > 20 && runs.length === 20) throw new Error('incomplete build inventory');
  let pending = false;
  let pushRed = false; let pushGreen = false;
  for (const row of runs) {
    const run = record(row);
    if (!run || run.head_sha !== sha) continue;
    if (run.event === 'push' && run.head_branch === 'master' && run.path === '.github/workflows/ci.yml') {
      if (run.status === 'completed' && run.conclusion === 'success') pushGreen = true;
      else if (run.status === 'completed') pushRed = true;
    }
    if (run.status === 'queued' || run.status === 'in_progress' || run.status === 'waiting') pending = true;
    if (!admitCiRun(run, sha, tag)) continue;
    if (run.status !== 'completed' || run.conclusion !== 'success') continue;
    const id = run.id; const attempt = run.run_attempt;
    if (!Number.isSafeInteger(id) || !Number.isSafeInteger(attempt) || Number(id) <= 0 || Number(attempt) <= 0) continue;
    const artifacts = record(await read(`repos/${REPOSITORY}/actions/runs/${Number(id)}/artifacts?per_page=100`));
    const rows = Array.isArray(artifacts?.artifacts) ? artifacts.artifacts : [];
    if (artifacts?.total_count !== rows.length || rows.length > 100) throw new Error('incomplete build artifact inventory');
    const name = `ashlr-build-${Number(id)}-${Number(attempt)}`;
    const match = rows.map(record).find((artifact) => artifact?.name === name && artifact.expired !== true);
    if (!match || !Number.isSafeInteger(match.id)) continue;
    return { build: { runId: Number(id), attempt: Number(attempt), artifactId: Number(match.id), completedAt: text(run.updated_at) }, pending, pushCiRed: false };
  }
  return { build: null, pending, pushCiRed: pushRed && !pushGreen };
}

export function admitAuditRun(run: Record<string, unknown> | null, sha: string): boolean {
  if (!run || run.head_sha !== sha || run.path !== '.github/workflows/dependency-audit.yml') return false;
  return run.head_branch === 'master' || (typeof run.head_branch === 'string' && /^v\d+\.\d+\.\d+$/.test(run.head_branch));
}

async function auditRun(read: (path: string) => Promise<unknown>, sha: string): Promise<{ audit: TrainObservation['audit']; pending: boolean }> {
  const listed = record(await read(`repos/${REPOSITORY}/actions/workflows/dependency-audit.yml/runs?head_sha=${sha}&per_page=10`));
  const runs = Array.isArray(listed?.workflow_runs) ? listed.workflow_runs : [];
  let pending = false;
  for (const row of runs) {
    const run = record(row);
    if (!admitAuditRun(run, sha)) continue;
    if (run?.status === 'queued' || run?.status === 'in_progress' || run?.status === 'waiting') pending = true;
    if (run?.status !== 'completed' || run?.conclusion !== 'success') continue;
    if (!Number.isSafeInteger(run?.id) || !Number.isSafeInteger(run?.run_attempt)) continue;
    return { audit: { runId: Number(run.id), attempt: Number(run.run_attempt) }, pending };
  }
  return { audit: null, pending };
}

async function attestRun(read: (path: string) => Promise<unknown>, ciRun: number, ciAttempt: number): Promise<{ attest: TrainObservation['attest']; pending: boolean }> {
  const listed = record(await read(`repos/${REPOSITORY}/actions/workflows/attest-ci-build.yml/runs?per_page=20`));
  const runs = Array.isArray(listed?.workflow_runs) ? listed.workflow_runs : null;
  if (!runs) throw new Error('incomplete attest inventory');
  const needle = new RegExp(`^ashlr-attested-${ciRun}-${ciAttempt}-([1-9]\\d*)-([1-9]\\d*)$`);
  let pending = false;
  for (const row of runs) {
    const run = record(row);
    if (!run || !releaseHeadBranch(run.head_branch)) continue;
    if (run.status === 'queued' || run.status === 'in_progress' || run.status === 'waiting') pending = true;
    if (run.status !== 'completed' || run.conclusion !== 'success' || !Number.isSafeInteger(run.id)) continue;
    const artifacts = record(await read(`repos/${REPOSITORY}/actions/runs/${Number(run.id)}/artifacts?per_page=100`));
    const rows = Array.isArray(artifacts?.artifacts) ? artifacts.artifacts : [];
    if (artifacts?.total_count !== rows.length || rows.length > 100) continue;
    const match = rows.map(record).find((artifact) => needle.test(String(artifact?.name ?? '')) && artifact?.expired !== true);
    if (!match || !Number.isSafeInteger(match.id) || !Number.isSafeInteger(run.run_attempt)) continue;
    return { attest: { runId: Number(run.id), attempt: Number(run.run_attempt), artifactId: Number(match.id), completedAt: text(run.updated_at) }, pending };
  }
  return { attest: null, pending };
}

export function releaseStatus(state: TrainState): { schema: typeof TRAIN_SCHEMA; ok: true; state: TrainState } {
  if (state.schema !== TRAIN_SCHEMA) throw new Error('release state schema mismatch');
  return { schema: TRAIN_SCHEMA, ok: true, state };
}

export function readReleaseState(path: string): TrainState {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  const state = record(parsed);
  if (state?.schema !== TRAIN_SCHEMA || typeof state.stopped !== 'boolean' || !state.steps || !state.stages) {
    throw new Error('release state is invalid');
  }
  return parsed as TrainState;
}

const PUBLISH_WORKFLOW = '.github/workflows/publish-canonical-npm.yml';
const PUBLISH_INVOCATION = /^https:\/\/github\.com\/ashlrai\/phantom\/actions\/runs\/([1-9]\d*)\/attempts\/([1-9]\d*)$/;

/** Path, event and run id must all sit on this one predicate. A partial object is not a match. */
function onePredicate(node: Record<string, unknown> | null): { runId: number; attempt: number } | null {
  if (!node) return null;
  const build = record(node.buildDefinition);
  const workflow = record(record(build?.externalParameters)?.workflow);
  const github = record(record(build?.internalParameters)?.github);
  const invocation = text(record(record(node.runDetails)?.metadata)?.invocationId);
  const path = text(workflow?.path);
  const event = text(github?.event_name);
  if (path !== PUBLISH_WORKFLOW || event !== 'workflow_dispatch' || !invocation) return null;
  const match = PUBLISH_INVOCATION.exec(invocation);
  if (!match) return null;
  const runId = Number(match[1]);
  const attempt = Number(match[2]);
  if (!Number.isSafeInteger(runId) || !Number.isSafeInteger(attempt)) return null;
  return { runId, attempt };
}

export function publishRunFromAttestation(body: unknown): { runId: number; attempt: number } | null {
  const rows = Array.isArray(record(body)?.attestations) ? record(body)?.attestations as unknown[] : null;
  if (!rows || rows.length !== 1) return null;
  const payload = text(record(record(record(rows[0])?.bundle)?.dsseEnvelope)?.payload);
  if (!payload || payload.length > 200_000) return null;
  let decoded: unknown;
  try { decoded = JSON.parse(Buffer.from(payload, 'base64').toString('utf8')); } catch { return null; }
  const statement = record(decoded);
  if (!statement) return null;
  const candidates = [record(statement.predicate), record(statement.buildDefinition) ? statement : null];
  if (Array.isArray(statement.subject)) {
    for (const entry of statement.subject) candidates.push(record(entry));
  }
  const found = candidates.map(onePredicate).filter((item): item is { runId: number; attempt: number } => item !== null);
  if (found.length !== 1) return null;
  return found[0]!;
}

/** Argv and stdin for one `gh api` call. A body is sent only with `--input -`. */
export function releaseGithubCall(method: string, path: string, body?: unknown): { args: string[]; input?: string } {
  const args = ['api', '--hostname', 'github.com', '--method', method];
  if (body === undefined) return { args: [...args, path] };
  return { args: [...args, '--input', '-', path], input: JSON.stringify(body) };
}

export const WORKFLOW_DISPATCH = /^repos\/ashlrai\/phantom\/actions\/workflows\/(attest-ci-build|dependency-audit|publish-canonical-npm|ci|release-please|finalize-github-release)\.yml\/dispatches$/;

/** Draft PATCH and enqueue use the App token. Workflow dispatches stay on
 *  GITHUB_TOKEN: the ashlr-release App has no actions permission, so a mint
 *  that requests that permission 422s. */
export function releaseWriteUsesAppToken(method: string, path: string): boolean {
  if (method === 'POST' && WORKFLOW_DISPATCH.test(path)) return false;
  return method === 'PATCH' || path === 'graphql';
}

function gh(method: string, path: string, body?: unknown): string {
  const appWrite = releaseWriteUsesAppToken(method, path);
  const token = appWrite ? readEnvironmentCredential('RELEASE_APP_TOKEN') : readEnvironmentCredential('GH_TOKEN');
  if (!token) throw new Error(appWrite ? 'release app token unavailable' : 'github token unavailable');
  const env: NodeJS.ProcessEnv = { ...process.env, GH_TOKEN: token };
  delete env.RELEASE_APP_TOKEN;
  const call = releaseGithubCall(method, path, body);
  try {
    return execFileSync('gh', call.args, {
      encoding: 'utf8', input: call.input,
      maxBuffer: 8 * 1024 * 1024, env,
    });
  } catch (error) {
    // The current version's tag does not exist yet right after a release PR
    // merges; observeTrain treats a null read as "not tagged". Only that exact
    // GET maps 404 to empty; every other failure stays fail-closed.
    if (method === 'GET' && isMissingTagRef(path, (error as { stderr?: unknown }).stderr)) return '';
    throw new Error(`github ${method} ${path} failed`);
  }
}

const TAG_REF_PATH = new RegExp(`^repos/${REPOSITORY}/git/ref/tags/v\\d+\\.\\d+\\.\\d+$`);
/** True only for a 404 on this repository's exact version tag ref. */
export function isMissingTagRef(path: string, stderr: unknown): boolean {
  return TAG_REF_PATH.test(path) && typeof stderr === 'string' && /\bHTTP 404\b/.test(stderr);
}

async function githubRead(path: string): Promise<unknown> {
  if (path === 'updater/latest.json') {
    const response = await fetch('https://github.com/ashlrai/phantom/releases/latest/download/latest.json', { redirect: 'follow' });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error('updater feed read failed');
    const textBody = await response.text();
    if (textBody.length > 128 * 1024) throw new Error('updater feed read failed');
    return JSON.parse(textBody) as unknown;
  }
  if (path.startsWith('registry/npm/')) {
    const spec = path.slice('registry/npm/'.length);
    const response = await fetch(`https://registry.npmjs.org/${spec}`, { redirect: 'error' });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error('registry read failed');
    return response.json() as Promise<unknown>;
  }
  if (path.startsWith('registry/attestations/@ashlr/phantom/')) {
    const version = path.slice('registry/attestations/@ashlr/phantom/'.length);
    if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error('registry read failed');
    const response = await fetch(`https://registry.npmjs.org/-/npm/v1/attestations/@ashlr%2fphantom@${version}`, { redirect: 'error' });
    if (!response.ok) throw new Error('registry read failed');
    return response.json() as Promise<unknown>;
  }
  const textBody = gh('GET', path);
  return textBody ? JSON.parse(textBody) as unknown : null;
}

/** A completed Release PR workflow must not recursively dispatch itself. */
export function allowReleasePrDispatch(path: string, enabled = process.env.RELEASE_TRAIN_DISPATCH_RELEASE_PR): boolean {
  return enabled !== 'false' || !path.endsWith('/release-please.yml/dispatches');
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try { return import.meta.url === pathToFileURL(realpathSync(entry)).href; }
  catch { return false; }
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args[0] === 'guard') {
    const hosted = hostedTrainGate(process.env);
    const decision = hosted ?? releaseKillDecision(readLocalTrainStop(), readSentinel(autorunOffPath()));
    process.stdout.write(`${JSON.stringify({ schema: TRAIN_SCHEMA, ...decision })}\n`);
    return decision.proceed ? 0 : 1;
  }
  if (args[0] === 'status') {
    const fileFlag = args.indexOf('--file');
    const file = fileFlag >= 0 ? args[fileFlag + 1] : '';
    if (!file) {
      process.stdout.write(`${JSON.stringify({ schema: TRAIN_SCHEMA, ok: false, reason: 'release-state-unavailable' })}\n`);
      return 0;
    }
    process.stdout.write(`${JSON.stringify(releaseStatus(readReleaseState(file)))}\n`);
    return 0;
  }
  if (args[0] !== 'run') throw new Error('usage: train.ts guard | run [--apply] [--out file] | status --file file');
  const apply = args.includes('--apply');
  const outFlag = args.indexOf('--out');
  const out = outFlag >= 0 ? args[outFlag + 1] : '';
  const observed = await observeTrain(githubRead);
  const plan = buildTrain(observed);
  let state = plan.state;
  if (apply && plan.exitCode === 0) {
    let writes = plan.writes;
    if (writes.some((write) => write.path.endsWith('/publish-canonical-npm.yml/dispatches'))) {
      const fresh = await observeTrain(githubRead);
      writes = refusePublishIfSuccessorConflict(writes, fresh);
      if (writes.length !== plan.writes.length) return 1;
    }
    for (const write of writes) {
      if (!allowReleasePrDispatch(write.path)) continue;
      assertReleaseWrite(write);
      gh(write.method, write.path, write.body);
    }
    if (writes.some((write) => write.method === 'PATCH')) state = markWritesApplied(state);
  }
  const json = `${JSON.stringify(state, null, 2)}\n`;
  if (process.env.GITHUB_STEP_SUMMARY) {
    const { appendFileSync } = await import('node:fs');
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, trainStepSummary(state));
  }
  if (out) writeFileSync(out, json, { mode: 0o644 });
  process.stdout.write(json);
  return plan.exitCode;
}

if (isDirectRun()) {
  void main().then(
    (code) => { process.exitCode = code; },
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : 'release train failed'}\n`);
      process.exitCode = 1;
    },
  );
}
