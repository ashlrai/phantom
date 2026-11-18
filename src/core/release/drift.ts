/**
 * `phm self drift`: is the running Phantom build behind the latest release and master, and which merged fleet
 * fixes are not live in it yet. Reads this build's embedded metadata and the local clone it was built from.
 * Local reads only: no network, no fetch, no writes. Anything unreadable is "unknown".
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readBuildIdentity, type BuildIdentity } from '../build-identity.js';
import { FLEET_WORDS, SELF_DRIFT_SCHEMA, UNKNOWN, UPDATE_COMMAND, driftLine, type FleetFix, type SelfDriftV1, type Unknown } from './drift-shape.js';

export * from './drift-shape.js';

/** Runs one read-only git command in the clone; null when it fails or exits non-zero. */
export type GitRead = (args: readonly string[]) => string | null;
export interface SelfDriftDeps {
  /** Phantom clone to read tags and master from; default is the checkout this build runs from (what `phm update` pulls). */
  repo?: string;
  git?: GitRead;
  identity?: () => BuildIdentity;
  now?: () => Date;
}

export function gitReader(repo: string): GitRead {
  return args => {
    try { return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000, maxBuffer: 32 * 1024 * 1024 }).trim(); }
    catch { return null; }
  };
}

const STABLE_TAG = /^v\d+\.\d+\.\d+$/;
const PR_NUMBER = /\s*\(#(\d+)\)$|^Merge pull request #(\d+)/;

/** Merged PRs in `git log --first-parent -m --name-only --format=%x1e%s`, newest first, each with its paths. */
export function parseMergedPrs(log: string): { pr: number; title: string; paths: string[] }[] {
  return log.split('\x1e').flatMap(record => {
    const [subject = '', ...paths] = record.split('\n').map(line => line.trim()).filter(Boolean);
    const match = PR_NUMBER.exec(subject);
    return match ? [{ pr: Number(match[1] ?? match[2]), title: subject.replace(/\s*\(#\d+\)$/, '').slice(0, 160), paths }] : [];
  });
}

export const touchesFleet = (pr: { title: string; paths: readonly string[] }): boolean =>
  FLEET_WORDS.test(pr.title) || pr.paths.some(path => FLEET_WORDS.test(path));

export function readSelfDrift(deps: SelfDriftDeps = {}): SelfDriftV1 {
  const git = deps.git ?? gitReader(deps.repo ?? fileURLToPath(new URL('../../..', import.meta.url)));
  const identity = (deps.identity ?? readBuildIdentity)();
  const running = identity.revision;
  const master = git(['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/master^{commit}']) || null;
  const tag = git(['for-each-ref', '--sort=-v:refname', '--format=%(refname:strip=2)', 'refs/tags/v*'])?.split('\n').find(name => STABLE_TAG.test(name)) ?? null;
  const hasRunning = !!running && git(['cat-file', '-e', `${running}^{commit}`]) !== null;
  const shallow = git(['rev-parse', '--is-shallow-repository']) !== 'false';
  // A count is exact when the target contains the running commit. Otherwise it is exact only in a full clone:
  // a shallow clone may have cut the history between them, and a low count there would be a guess.
  const behind = (target: string | null): number | Unknown => {
    if (!hasRunning || !target) return UNKNOWN;
    if (shallow && git(['merge-base', '--is-ancestor', running, target]) === null) return UNKNOWN;
    const count = Number(git(['rev-list', '--count', `${running}..${target}`]) ?? NaN);
    return Number.isSafeInteger(count) ? count : UNKNOWN;
  };
  const masterBehind = behind(master);
  const log = masterBehind === UNKNOWN ? null : git(['log', '--first-parent', '-m', '--name-only', '--format=%x1e%s', `${running}..${master}`]);
  const merged = log === null ? null : parseMergedPrs(log);
  const fleetFixes: FleetFix[] | Unknown = merged ? merged.filter(touchesFleet).map(({ pr, title }) => ({ pr, title })) : UNKNOWN;
  const facts = {
    latestRelease: { tag: tag ?? UNKNOWN, behind: tag ? behind(`refs/tags/${tag}`) : UNKNOWN },
    master: { revision: master ?? UNKNOWN, behind: masterBehind },
    fleetFixes,
    unknownReason: masterBehind !== UNKNOWN ? null
      : !running ? 'this build has no recorded commit'
        : !master ? 'origin/master is not readable in the local clone'
          : !hasRunning ? 'the local clone does not have the running commit' : 'the local clone history is too short',
  };
  return {
    schema: SELF_DRIFT_SCHEMA, version: 1, checkedAt: (deps.now ?? (() => new Date()))().toISOString(),
    running: { version: identity.packageVersion ?? UNKNOWN, revision: running ?? UNKNOWN },
    ...facts, mergedPrs: merged ? merged.length : UNKNOWN,
    status: masterBehind === UNKNOWN ? UNKNOWN : masterBehind === 0 ? 'up to date' : 'behind',
    updateCommand: UPDATE_COMMAND, line: driftLine(facts),
  };
}

export function formatSelfDrift(drift: SelfDriftV1): string {
  const short = (rev: string) => rev === UNKNOWN ? rev : rev.slice(0, 10);
  const commits = (n: number | Unknown) => n === UNKNOWN ? 'unknown' : n === 0 ? 'up to date' : `${n} behind`;
  const fixes = drift.fleetFixes === UNKNOWN ? [] : drift.fleetFixes;
  return [
    drift.line,
    `  running         ${drift.running.version} (${short(drift.running.revision)})`,
    `  latest release  ${drift.latestRelease.tag}: ${commits(drift.latestRelease.behind)}`,
    `  master          ${short(drift.master.revision)}: ${commits(drift.master.behind)}, ${drift.mergedPrs} merged PRs since the running commit`,
    ...(fixes.length ? ['Fleet fixes merged but not live yet:'] : []),
    ...fixes.slice(0, 20).map(fix => `  #${fix.pr} ${fix.title}`),
    ...(fixes.length > 20 ? [`  and ${fixes.length - 20} more (see --json)`] : []),
    `Master and tags are as of the local clone's last fetch; ${UPDATE_COMMAND} --check fetches.`,
  ].join('\n') + '\n';
}
