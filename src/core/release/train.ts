/**
 * Continuous release train. Cuts at most hourly from green master, builds the
 * tagged commit, and resumes the sanctioned publishers. KILL fails closed.
 * See docs/RELEASING.md.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const TRAIN_SCHEMA = 'phantom.release-train.v1';
export const HOURLY_MINUTES = 60;
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
type StepStatus = 'complete' | 'pending' | 'stopped' | 'hooked';

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
   */
  head: { tag: string; sha: string; message: string; releaseMessage?: string; ancestry: Ancestry; committedAt: string | null } | null;
  releases: ReleaseRow[];
  openReleasePr: { number: number; nodeId: string; version: string; headSha: string; headRef: string; mergeable: string; state: 'OPEN' | 'MERGED'; queued: boolean } | null;
  pullChecks: { pending: number; failing: number } | null;
  build: { runId: number; attempt: number; artifactId: number; completedAt: string | null } | null;
  buildPending: boolean;
  /** A failed release build for this SHA completed within the last 6 hours. */
  buildCooldown: boolean;
  attest: { runId: number; attempt: number; artifactId: number; completedAt: string | null } | null;
  attestPending: boolean;
  audit: { runId: number; attempt: number } | null;
  npmPublished: boolean | null;
  npmAt: string | null;
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
  superseded: string[];
  website: typeof WEBSITE_HOOK;
  steps: Record<string, { status: StepStatus; reason?: string }>;
  stages: Record<string, StageTiming>;
}

export const ENQUEUE_PULL_REQUEST = 'mutation($id:ID!){enqueuePullRequest(input:{pullRequestId:$id}){mergeQueueEntry{position state}}}';
const PULL_NODE = /^PR_[A-Za-z0-9_-]+$/;
export type ReleaseWrite =
  | { method: 'PATCH'; path: string; body: { name: string; body: string; draft: true; prerelease: false } }
  | { method: 'POST'; path: 'graphql'; body: { query: string; variables: { pullRequestId: string } } }
  | { method: 'POST'; path: string; body: { ref: string; inputs: Record<string, string | boolean> } };

export interface TrainPlan { state: TrainState; writes: ReleaseWrite[]; exitCode: 0 | 1 }

export function fleetKillPath(home = homedir()): string { return join(home, '.ashlr', 'KILL'); }
export function autorunOffPath(home = homedir()): string { return join(home, '.ashlr-runs', 'RELEASE_AUTORUN_OFF'); }

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

/** Standing approval: at most hourly. Slower values pass through. Faster values rise to 60. */
export function cappedCadenceMinutes(raw: number): number {
  if (!Number.isInteger(raw) || raw < 1 || raw > 1440) throw new Error('invalid release cadence');
  return Math.max(HOURLY_MINUTES, raw);
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

export function isReleasePleaseCommit(message: string, version: string): boolean {
  const match = RELEASE_SUBJECT.exec(message);
  if (!match) return false;
  return `${match[1]}.${match[2]}.${match[3]}` === version;
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
  const dispatch = /^repos\/ashlrai\/phantom\/actions\/workflows\/(attest-ci-build|publish-canonical-npm|ci)\.yml\/dispatches$/;
  if (write.path.includes('/merge') || JSON.stringify(write.body).includes('admin') || JSON.stringify(write.body).includes('bypass')) {
    throw new Error('refusing release write');
  }
  if (write.method === 'PATCH') {
    if (!release.test(write.path)) throw new Error('refusing release write');
    if (write.body.draft !== true || write.body.prerelease !== false) throw new Error('refusing to publish a superseded draft');
    return;
  }
  if (write.path === 'graphql') {
    const body = write.body as { query?: string; variables?: { pullRequestId?: string } };
    if (body.query !== ENQUEUE_PULL_REQUEST || !PULL_NODE.test(body.variables?.pullRequestId ?? '')) throw new Error('refusing release enqueue');
    return;
  }
  if (dispatch.test(write.path)) {
    const body = write.body as { ref?: string; inputs?: Record<string, string | boolean> };
    if ((body.ref !== 'master' && !/^v\d+\.\d+\.\d+$/.test(body.ref ?? '')) || !body.inputs) throw new Error('refusing workflow dispatch');
    return;
  }
  throw new Error('refusing release write');
}

export function buildTrain(input: TrainObservation): TrainPlan {
  const kill = releaseKillDecision(input.fleetKill, input.autorunOff);
  const minutes = cappedCadenceMinutes(input.cadenceMinutes);
  const stopped = (reason: string): TrainPlan => ({
    exitCode: 1,
    writes: [],
    state: {
      schema: TRAIN_SCHEMA, stopped: true, reason, version: null, tag: null, sha: null, next: null,
      superseded: [], website: WEBSITE_HOOK,
      steps: { kill: { status: 'stopped', reason } },
      stages: emptyStages(null),
    },
  });
  if (!kill.proceed) return stopped(kill.reason);
  if (!SHA.test(input.masterSha) || !VERSION.test(input.masterVersion)) return stopped('master-identity');

  let headTag: { name: string; sha: string } | null;
  try { headTag = newestTag(input.tags); }
  catch { return stopped('duplicate-tag'); }
  if (!input.head || !headTag || input.head.tag !== headTag.name || input.head.sha !== headTag.sha) {
    return stopped(input.head ? 'candidate-not-newest' : 'no-release-tag');
  }
  const version = headTag.name.slice(1);
  const admitted = (input.head.ancestry === 'ancestor' || input.head.ancestry === 'identical')
    && input.head.sha !== ''
    && (isReleasePleaseCommit(input.head.message, version) || isReleasePleaseCommit(input.head.releaseMessage ?? '', version));
  if (!admitted) return stopped('candidate-refused');

  const marker = supersedeMarker(headTag.name);
  const superseded: string[] = [];
  const writes: ReleaseWrite[] = [];
  for (const row of input.releases) {
    if (row.draft !== true) continue;
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
  const pr = input.openReleasePr;
  const checks = input.pullChecks;
  if (cadenceDue && pr && checks && pr.state === 'OPEN' && !pr.queued && pr.version === expected && pr.headRef.startsWith('release-please--')
    && SHA.test(pr.headSha) && pr.mergeable === 'MERGEABLE' && checks.failing === 0 && checks.pending === 0) {
    writes.push(enqueueReleasePullRequest(pr.nodeId));
  }

  const row = input.releases.find((release) => release.tag_name === headTag.name) ?? null;
  const names = row?.assets.map((asset) => asset.name) ?? [];
  const signed = signedAssetSet(names);
  const feed = names.includes('latest.json');
  const published = row !== null && row.draft === false && feed;
  const assetAt = latestTime(row?.assets.map((asset) => asset.created_at) ?? []);
  if (!input.build && !input.buildPending && !input.buildCooldown && !(row?.draft === false && input.npmPublished === true)) {
    writes.push({
      method: 'POST', path: `repos/${REPOSITORY}/actions/workflows/ci.yml/dispatches`,
      // ci.yml types release_gate as boolean. The dispatch API stores inputs as
      // strings; Actions then exposes inputs.release_gate as a boolean.
      body: { ref: headTag.name, inputs: { release_gate: 'true' } },
    });
  }
  if (input.build && !input.attest && !input.attestPending) {
    writes.push({
      method: 'POST', path: `repos/${REPOSITORY}/actions/workflows/attest-ci-build.yml/dispatches`,
      body: { ref: 'master', inputs: {
        ci_run_id: String(input.build.runId), ci_run_attempt: String(input.build.attempt),
        candidate_sha: headTag.sha, build_artifact_id: String(input.build.artifactId),
      } },
    });
  }
  if (input.build && input.attest && input.audit && input.npmPublished === false) {
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
  for (const write of writes) assertReleaseWrite(write);

  const feedMatches = updaterFeedMatches(version, input.feedVersion);
  const publishedFeed = published && feedMatches;
  if (published && !feedMatches) {
    return {
      exitCode: 1,
      writes: [],
      state: {
        schema: TRAIN_SCHEMA, stopped: true, reason: 'feed-version-mismatch', version, tag: headTag.name, sha: headTag.sha,
        next: 'feed', superseded, website: WEBSITE_HOOK,
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
    build: { status: input.build ? 'complete' : 'pending' },
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
      next, superseded, website: WEBSITE_HOOK, steps, stages,
    },
  };
}

export function markWritesApplied(state: TrainState): TrainState {
  const steps: TrainState['steps'] = { ...state.steps, supersede: { status: 'complete' } };
  const order = ['build', 'attest', 'sign', 'notarize', 'npm', 'feed', 'docs', 'finalize'];
  const next = order.find((name) => steps[name]?.status === 'pending') ?? null;
  return { ...state, steps, next };
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

export async function observeTrain(
  read: (path: string) => Promise<unknown>,
  now = new Date().toISOString(),
  cadenceMinutes = HOURLY_MINUTES,
  kill: { fleet: KillObservation; autorun: KillObservation } = {
    fleet: readSentinel(fleetKillPath()),
    autorun: readSentinel(autorunOffPath()),
  },
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
    if (ref?.ref !== `refs/tags/v${masterVersion}` || object?.type !== 'commit' || !SHA.test(String(object.sha ?? ''))) throw new Error('current tag is not a commit');
    const tagged = record(await read(`repos/${REPOSITORY}/commits/${String(object.sha)}`));
    lastTaggedAt = text(record(record(tagged?.commit)?.committer)?.date);
    const compare = record(await read(`repos/${REPOSITORY}/compare/${String(object.sha)}...${masterSha}`));
    if (compare?.status === 'ahead' && Number.isInteger(compare.ahead_by)) aheadBy = Number(compare.ahead_by);
    else if (compare?.status === 'identical') aheadBy = 0;
    else throw new Error('current tag is not an ancestor of master');
  }
  const tagRows = await pages(read, `repos/${REPOSITORY}/tags`);
  const tags = tagRows.map((row) => {
    const item = record(row);
    return { name: text(item?.name) ?? '', sha: text(record(item?.commit)?.sha) ?? '' };
  }).filter((tag) => TAG.test(tag.name) && SHA.test(tag.sha));
  const newest = newestTag(tags);
  let head: TrainObservation['head'] = null;
  if (newest) {
    const commit = record(await read(`repos/${REPOSITORY}/commits/${newest.sha}`));
    const message = text(record(commit?.commit)?.message) ?? '';
    const committedAt = text(record(record(commit?.commit)?.committer)?.date);
    const compare = record(await read(`repos/${REPOSITORY}/compare/${newest.sha}...${masterSha}`));
    const status = text(compare?.status);
    const ancestry: Ancestry = status === 'ahead' ? 'ancestor' : status === 'identical' ? 'identical' : status === 'diverged' ? 'diverged' : status === 'behind' ? 'behind' : 'unknown';
    head = { tag: newest.name, sha: newest.sha, message, ancestry, committedAt };
    if (!isReleasePleaseCommit(message, newest.name.slice(1))) {
      const releaseMessage = await ancestorReleaseMessage(read, newest);
      if (releaseMessage) head.releaseMessage = releaseMessage;
    }
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
    const state = text(detail?.mergeable_state) ?? '';
    const pullState = detail?.merged_at ? 'MERGED' : detail?.state === 'open' ? 'OPEN' : 'OPEN';
    if (!version || !headRef.startsWith('release-please--') || !SHA.test(headSha) || !PULL_NODE.test(nodeId)) throw new Error('invalid release pull request');
    const mergeable = detail?.mergeable === true && state === 'clean' ? 'MERGEABLE' : state === 'dirty' ? 'CONFLICTING' : 'UNKNOWN';
    openReleasePr = { number: Number(listed.number), nodeId, version, headSha, headRef, mergeable, state: pullState, queued: false };
  }
  let pullChecks: TrainObservation['pullChecks'] = null;
  if (openReleasePr) {
    const checks = record(await read(`repos/${REPOSITORY}/commits/${openReleasePr.headSha}/check-runs?filter=latest&per_page=100`));
    const runs = Array.isArray(checks?.check_runs) ? checks.check_runs : null;
    if (!runs || checks?.total_count !== runs.length || runs.length > 100) throw new Error('incomplete check inventory');
    let pending = 0; let failing = 0; let actions = 0;
    for (const run of runs) {
      const item = record(run);
      if (record(item?.app)?.id !== 15368) continue;
      actions += 1;
      if (item?.status !== 'completed') pending += 1;
      else if (item.conclusion !== 'success') failing += 1;
    }
    if (actions === 0) failing += 1;
    pullChecks = { pending, failing };
  }
  const version = head ? head.tag.slice(1) : masterVersion;
  const found = head ? await successfulRun(read, 'ci.yml', head.sha, head.tag, Date.parse(now)) : { build: null, pending: false, cooldown: false };
  const audit = head ? await auditRun(read, head.sha) : null;
  const attested = found.build ? await attestRun(read, found.build.runId, found.build.attempt) : { attest: null, pending: false };
  const npm = await read(`registry/npm/@ashlr/phantom/${version}`);
  const npmRecord = record(npm);
  const docsSynced = head ? docsCarriersSynced(head.message, version) : false;
  return {
    now, fleetKill: kill.fleet, autorunOff: kill.autorun,
    masterSha, masterVersion, cadenceMinutes, lastTaggedAt, aheadBy, tags, head, releases,
    openReleasePr, pullChecks, build: found.build, buildPending: found.pending, buildCooldown: found.cooldown,
    attest: attested.attest, attestPending: attested.pending, audit,
    npmPublished: npm === null ? false : npmRecord?.version === version ? true : null,
    npmAt: text(npmRecord?.time) ?? (npmRecord && record(npmRecord.time)?.[version] ? String(record(npmRecord.time)?.[version]) : null),
    docsSynced,
    feedVersion: await publishedFeedVersion(read, releases, head?.tag ?? null),
  };
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

export function failedBuildWithin(run: Record<string, unknown>, nowMs: number, windowMs = 6 * 60 * 60 * 1000): boolean {
  if (run.status !== 'completed' || run.conclusion !== 'failure') return false;
  const at = Date.parse(text(run.updated_at) ?? '');
  return Number.isFinite(at) && nowMs >= at && nowMs - at < windowMs;
}

async function successfulRun(read: (path: string) => Promise<unknown>, workflow: string, sha: string, tag: string, nowMs: number): Promise<{ build: TrainObservation['build']; pending: boolean; cooldown: boolean }> {
  const listed = record(await read(`repos/${REPOSITORY}/actions/workflows/${workflow}/runs?head_sha=${sha}&per_page=20`));
  const runs = Array.isArray(listed?.workflow_runs) ? listed.workflow_runs : [];
  if (!Number.isInteger(listed?.total_count) || Number(listed?.total_count) > 20 && runs.length === 20) throw new Error('incomplete build inventory');
  let pending = false;
  let cooldown = false;
  for (const row of runs) {
    const run = record(row);
    if (!run || run.head_sha !== sha) continue;
    if (run.path === '.github/workflows/ci.yml'
      && (run.event === 'workflow_dispatch' || run.event === 'schedule')
      && text(record(run.repository)?.full_name) === REPOSITORY
      && text(record(run.head_repository)?.full_name) === REPOSITORY
      && failedBuildWithin(run, nowMs)) cooldown = true;
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
    return { build: { runId: Number(id), attempt: Number(attempt), artifactId: Number(match.id), completedAt: text(run.updated_at) }, pending, cooldown };
  }
  return { build: null, pending, cooldown };
}

async function auditRun(read: (path: string) => Promise<unknown>, sha: string): Promise<TrainObservation['audit']> {
  const listed = record(await read(`repos/${REPOSITORY}/actions/workflows/dependency-audit.yml/runs?head_sha=${sha}&status=success&per_page=5`));
  const runs = Array.isArray(listed?.workflow_runs) ? listed.workflow_runs : [];
  for (const row of runs) {
    const run = record(row);
    if (run?.head_sha !== sha || run.conclusion !== 'success' || run.head_branch !== 'master') continue;
    if (!Number.isSafeInteger(run.id) || !Number.isSafeInteger(run.run_attempt)) continue;
    return { runId: Number(run.id), attempt: Number(run.run_attempt) };
  }
  return null;
}

async function attestRun(read: (path: string) => Promise<unknown>, ciRun: number, ciAttempt: number): Promise<{ attest: TrainObservation['attest']; pending: boolean }> {
  const listed = record(await read(`repos/${REPOSITORY}/actions/workflows/attest-ci-build.yml/runs?per_page=20`));
  const runs = Array.isArray(listed?.workflow_runs) ? listed.workflow_runs : null;
  if (!runs) throw new Error('incomplete attest inventory');
  const needle = new RegExp(`^ashlr-attested-${ciRun}-${ciAttempt}-([1-9]\\d*)-([1-9]\\d*)$`);
  let pending = false;
  for (const row of runs) {
    const run = record(row);
    if (run?.head_branch !== 'master') continue;
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

/** Argv and stdin for one `gh api` call. A body is sent only with `--input -`. */
export function releaseGithubCall(method: string, path: string, body?: unknown): { args: string[]; input?: string } {
  const args = ['api', '--hostname', 'github.com', '--method', method];
  if (body === undefined) return { args: [...args, path] };
  return { args: [...args, '--input', '-', path], input: JSON.stringify(body) };
}

function gh(method: string, path: string, body?: unknown): string {
  const appWrite = method === 'PATCH' || path === 'graphql';
  const token = appWrite ? process.env.RELEASE_APP_TOKEN : process.env.GH_TOKEN;
  if (!token) throw new Error(appWrite ? 'release app token unavailable' : 'github token unavailable');
  const env: NodeJS.ProcessEnv = { ...process.env, GH_TOKEN: token };
  delete env.RELEASE_APP_TOKEN;
  const call = releaseGithubCall(method, path, body);
  try {
    return execFileSync('gh', call.args, {
      encoding: 'utf8', input: call.input,
      maxBuffer: 8 * 1024 * 1024, env,
    });
  } catch {
    throw new Error(`github ${method} ${path} failed`);
  }
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
  const textBody = gh('GET', path);
  return textBody ? JSON.parse(textBody) as unknown : null;
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
    const decision = hosted ?? releaseKillDecision(readSentinel(fleetKillPath()), readSentinel(autorunOffPath()));
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
    const allowBuild = process.env.RELEASE_TRAIN_DISPATCH_BUILD !== 'false';
    for (const write of plan.writes) {
      if (!allowBuild && write.path.endsWith('/ci.yml/dispatches')) continue;
      assertReleaseWrite(write);
      gh(write.method, write.path, write.body);
    }
    if (plan.writes.some((write) => write.method === 'PATCH')) state = markWritesApplied(state);
  }
  const json = `${JSON.stringify(state, null, 2)}\n`;
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
