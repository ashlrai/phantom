/**
 * `phm self drift`: is the installed Phantom CLI the fleet runs behind the latest release and master, and which
 * merged fleet capabilities are not live in it yet. Local reads only (the installed package's build manifest, the
 * local Phantom clone, and `--help` of the installed CLI with a 5 s timeout); no network, no writes.
 */
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { parseBuildIdentity } from '../build-identity.js';
import { FLEET_CAPABILITIES, SELF_DRIFT_SCHEMA, UNKNOWN, driftLine, type FeatureRow, type FeatureState, type SelfDriftV1, type Unknown } from './drift-shape.js';

export * from './drift-shape.js';

export const PROBE_TIMEOUT_MS = 5000;
export type GitRead = (args: readonly string[]) => string | null;
export interface ProbeResult { code: number | null; output: string; timedOut: boolean }
export type HelpProbe = (argv: readonly string[]) => Promise<ProbeResult>;
/** The installed CLI: its path on PATH and the version and build commit its package recorded. Null is unreadable. */
export interface InstalledBuild { bin: string | null; version: string | null; revision: string | null }
export interface SelfDriftDeps {
  /** Local Phantom clone; default ~/Projects/ashlrai/phantom. */
  repo?: string;
  git?: GitRead;
  installed?: () => InstalledBuild;
  /** Runs the installed CLI with argv + --help; injected by tests. */
  probe?: HelpProbe;
  now?: () => Date;
}

export const defaultPhantomClone = (): string => join(homedir(), 'Projects', 'ashlrai', 'phantom');

export function gitReader(repo: string): GitRead {
  return args => {
    try { return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000, maxBuffer: 16 * 1024 * 1024 }).trim(); }
    catch { return null; }
  };
}

/** Reads the `phm` on PATH and its package's build manifest; never runs it. */
export function readInstalledBuild(path = process.env.PATH ?? ''): InstalledBuild {
  const bin = path.split(delimiter).filter(Boolean).map(dir => join(dir, 'phm')).find(file => existsSync(file)) ?? null;
  if (!bin) return { bin: null, version: null, revision: null };
  try {
    const root = dirname(dirname(realpathSync(bin)));
    const manifest = existsSync(join(root, 'dist', 'build-identity.json')) ? parseBuildIdentity(readFileSync(join(root, 'dist', 'build-identity.json'), 'utf8')) : null;
    if (manifest?.packageVersion) return { bin, version: manifest.packageVersion, revision: manifest.revision };
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { name?: unknown; version?: unknown };
    return { bin, version: pkg.name === '@ashlr/phantom' && typeof pkg.version === 'string' ? pkg.version : null, revision: null };
  } catch { return { bin, version: null, revision: null }; }
}

function helpProbe(bin: string): HelpProbe {
  return argv => new Promise(resolve => {
    execFile(bin, [...argv, '--help'], { timeout: PROBE_TIMEOUT_MS, maxBuffer: 1024 * 1024, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } },
      (error, stdout, stderr) => {
        const failure = error as (Error & { code?: unknown; killed?: boolean; signal?: unknown }) | null;
        resolve({ code: !failure ? 0 : typeof failure.code === 'number' ? failure.code : null, output: `${stdout}${stderr}`, timedOut: !!failure?.killed });
      });
  });
}

const STABLE_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;
/** Git dates as UTC ISO strings, or null when unparseable. */
const iso = (text: string | null | undefined): string | null => text && Number.isFinite(Date.parse(text)) ? new Date(text).toISOString() : null;
const versionParts = (version: string): number[] | null => {
  const match = STABLE_TAG.exec(version.startsWith('v') ? version : `v${version}`);
  return match ? match.slice(1).map(Number) : null;
};
const newer = (a: number[], b: number[]): boolean => a[0]! !== b[0]! ? a[0]! > b[0]! : a[1]! !== b[1]! ? a[1]! > b[1]! : a[2]! > b[2]!;

/** Stable `vX.Y.Z` tags, newest first, or null when the clone cannot be read. */
export function releaseTags(git: GitRead): { tag: string; at: string }[] | null {
  const out = git(['for-each-ref', '--sort=-v:refname', '--format=%(refname:strip=2)%09%(creatordate:iso-strict)', 'refs/tags/v*']);
  if (out === null) return null;
  return out.split('\n').map(line => line.split('\t')).filter(([tag, at]) => STABLE_TAG.test(tag ?? '') && !!iso(at)).map(([tag, at]) => ({ tag: tag!, at: iso(at)! }));
}

/** Stable releases newer than `version`; unknown when either side is unreadable or the clone has no tags. */
export function countBehind(version: string | null, tags: readonly { tag: string }[] | null): number | Unknown {
  const mine = version === null ? null : versionParts(version);
  if (!mine || !tags?.length) return UNKNOWN;
  return tags.filter(({ tag }) => newer(versionParts(tag)!, mine)).length;
}

/** The release-due boost for Phantom: no probes, just the manifest and local tags. */
export function readBehindReleases(deps: Pick<SelfDriftDeps, 'repo' | 'git' | 'installed'> = {}): number | Unknown {
  const tags = releaseTags(deps.git ?? gitReader(deps.repo ?? defaultPhantomClone()));
  return tags?.length ? countBehind((deps.installed ?? readInstalledBuild)().version, tags) : UNKNOWN;
}

export async function readSelfDrift(deps: SelfDriftDeps = {}): Promise<SelfDriftV1> {
  const git = deps.git ?? gitReader(deps.repo ?? defaultPhantomClone());
  const installed = (deps.installed ?? readInstalledBuild)();
  const tags = releaseTags(git);
  const master = git(['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/master^{commit}']) || null;
  const masterAt = master ? iso(git(['log', '-1', '--format=%cI', master])) : null;
  // Count only when the clone has the installed commit and the walk never reached a parentless commit: in a
  // shallow clone that is a cut-off point, past which the count would be a guess.
  const counted = master && installed.revision && git(['cat-file', '-e', `${installed.revision}^{commit}`]) !== null
    ? git(['log', '--first-parent', '--format=%cI%x09%P', `${installed.revision}..${master}`]) : null;
  const rows = counted === null ? null : counted.split('\n').filter(Boolean).map(line => line.split('\t'));
  const unshipped = rows && rows.every(([, parents]) => !!parents) ? rows.map(([at]) => at!) : null;

  const probe = deps.probe ?? (installed.bin ? helpProbe(installed.bin) : null);
  const features = await Promise.all(FLEET_CAPABILITIES.map(async (cap): Promise<FeatureRow> => {
    let state: FeatureState = 'unknown';
    if (probe) {
      const result = await probe(cap.argv).catch(() => null);
      if (result && !result.timedOut && result.code !== null) state = result.code === 0 && cap.proof.every(text => result.output.includes(text)) ? 'live' : 'missing';
    }
    return { name: cap.name, command: `phm ${cap.argv.join(' ')} --help`, state };
  }));
  const pick = (state: FeatureState) => features.filter(row => row.state === state).map(row => row.name);
  const drift = {
    behindReleases: countBehind(installed.version, tags),
    liveFeatures: pick('live'), missingFeatures: pick('missing'), unknownFeatures: pick('unknown'),
  };
  return {
    schema: SELF_DRIFT_SCHEMA, version: 1, checkedAt: (deps.now ?? (() => new Date()))().toISOString(),
    installed: { version: installed.version ?? UNKNOWN, revision: installed.revision ?? UNKNOWN },
    latestRelease: tags?.[0] ? { tag: tags[0].tag, at: tags[0].at } : { tag: UNKNOWN, at: UNKNOWN },
    master: { revision: master ?? UNKNOWN, at: masterAt ?? UNKNOWN },
    behindCommits: unshipped ? unshipped.length : UNKNOWN,
    oldestUnshippedMergeAt: unshipped ? iso(unshipped.at(-1)) ?? (unshipped.length ? UNKNOWN : null) : UNKNOWN,
    ...drift, features, line: driftLine(drift),
  };
}

export function formatSelfDrift(drift: SelfDriftV1): string {
  const short = (rev: string) => rev === UNKNOWN ? rev : rev.slice(0, 10);
  const lines = [
    `Running build: ${drift.line}`,
    `  installed ${drift.installed.version} (${short(drift.installed.revision)})`,
    `  latest release ${drift.latestRelease.tag}; master ${short(drift.master.revision)}`,
    `  behind: ${drift.behindReleases} releases, ${drift.behindCommits} master commits; oldest unshipped ${drift.oldestUnshippedMergeAt ?? 'none'}`,
    ...drift.features.map(row => `  ${row.state === 'live' ? 'live   ' : row.state === 'missing' ? 'missing' : 'unknown'} ${row.name} (${row.command})`),
  ];
  if (typeof drift.behindReleases === 'number' && drift.behindReleases > 0) lines.push('Next: update the installed CLI (phm update) so these fleet changes take effect.');
  else if (drift.behindReleases === 0 && drift.missingFeatures.length) lines.push('Next: these are merged but not released yet; see phm releases for the release that ships them.');
  lines.push('Read from the installed package and the local Phantom clone; fetch the clone first for current numbers.');
  return `${lines.join('\n')}\n`;
}
