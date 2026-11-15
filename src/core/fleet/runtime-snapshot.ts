import { lstat, readdir } from 'node:fs/promises';
import { arch, homedir, hostname, platform } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { readFleetBoard } from './coordination.js';
import { projectCoordinationReturns } from './coordination-returns-view.js';
import { defaultStatePath } from './main-red-age.js';
import { defaultRuntimeIdentityDeps } from './runtime-identity.js';
import { readFleetRunsDirState } from './runs-dir-state.js';
import { defaultTailnetPeersDeps, readTailnetPeers } from './tailnet-peers.js';
import { treeVersionFromPackageJson } from '../verse/release-version-guard.js';
import { scrubSecrets } from '../util/scrub.js';

const UNKNOWN = 'UNKNOWN';
const identity = defaultRuntimeIdentityDeps();
export const defaults = {
  now: Date.now, home: homedir, host: hostname, platform, arch,
  pid: () => process.pid, uptime: () => process.uptime(),
  // Reuse the dashboard guardian reader's runs-root resolution.
  stateRoot: () => dirname(dirname(defaultStatePath())),
  installedVersion: identity.installedVersion,
  sourceVersion: () => treeVersionFromPackageJson(identity.readSourcePackageJson()),
  tailnet: () => readTailnetPeers(defaultTailnetPeersDeps()).self,
  board: readFleetBoard,
};
export type FleetRuntimeDeps = typeof defaults;

/** Metadata only, bounded, and never follows symlinks or reads file contents. */
async function newestMtime(root: string): Promise<number> {
  let newest = -Infinity;
  let remaining = 4096;
  async function visit(path: string, depth: number): Promise<void> {
    if (--remaining < 0 || depth > 16) throw new Error('state scan limit');
    const info = await lstat(path);
    if (info.isSymbolicLink()) return;
    if (info.isFile()) newest = Math.max(newest, info.mtimeMs);
    else if (info.isDirectory()) {
      const entries = await readdir(path);
      if (entries.length > remaining) throw new Error('state scan limit');
      for (const entry of entries) await visit(join(path, entry), depth + 1);
    }
  }
  await visit(root, 0);
  if (!Number.isFinite(newest)) throw new Error('no state files');
  return newest;
}

export interface RuntimeSnapshot {
  host: string;
  tailnetName: string;
  installedVersion: string;
  sourceVersion?: string;
  pid: number;
  uptimeSeconds: number;
  platform: string;
  arch: string;
  stateRoot: string;
  lastFleetStateRead: { mtime: string; ageSeconds: number | string };
  coordination: { state: string; activeClaims: number | string; newestReturnAgeSeconds: number | string; reason?: string };
  asOf: string;
  reasons: string[];
}

/** One read-only snapshot; failures never expose raw exceptions or store contents. */
export async function readRuntimeSnapshot(deps: FleetRuntimeDeps): Promise<RuntimeSnapshot> {
  const now = deps.now();
  const reasons: string[] = [];
  const home = resolve(deps.home());
  // Identity labels are single safe tokens: never echo emails, paths or arbitrary text.
  const label = (value: string | null): string => value && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) && scrubSecrets(value) === value ? value : UNKNOWN;
  const readLabel = (name: string, read: () => string | null): string => {
    let value = UNKNOWN;
    try { value = label(read()); } catch { /* fixed reason below */ }
    if (value === UNKNOWN) reasons.push(`${name}: unavailable`);
    return value;
  };
  const root = resolve(deps.stateRoot());
  const rel = relative(home, root);
  const stateRoot = rel === '' ? '~' : rel !== '..' && !rel.startsWith(`..${sep}`) && !resolve(root).startsWith(`${sep}${sep}`)
    ? `~/${rel.split(sep).join('/')}` : '[path outside home]';
  const age = (ms: number): number | typeof UNKNOWN => Number.isFinite(ms) && ms <= now ? Math.floor((now - ms) / 1000) : UNKNOWN;
  const lastFleetStateRead: { mtime: string; ageSeconds: number | string } = { mtime: UNKNOWN, ageSeconds: UNKNOWN };
  try {
    const state = await readFleetRunsDirState({ runsDir: root, now: () => now });
    if (!state.runsDirPresent) throw new Error('state root unavailable');
    const ms = await newestMtime(root);
    lastFleetStateRead.mtime = new Date(ms).toISOString();
    lastFleetStateRead.ageSeconds = age(ms);
    if (lastFleetStateRead.ageSeconds === UNKNOWN) reasons.push('lastFleetStateRead: future mtime; clock skew');
  } catch { reasons.push('lastFleetStateRead: state missing, unreadable or scan limit exceeded'); }
  const coordination: { state: string; activeClaims: number | string; newestReturnAgeSeconds: number | string; reason?: string } = {
    state: UNKNOWN, activeClaims: UNKNOWN, newestReturnAgeSeconds: UNKNOWN,
  };
  try {
    const board = deps.board({ now });
    if (board.state !== 'known') throw new Error('unreadable ledger');
    const returns = projectCoordinationReturns(board, now);
    coordination.state = 'known';
    coordination.activeClaims = board.claims.length;
    const newest = returns.returns[0];
    if (newest) coordination.newestReturnAgeSeconds = age(Date.parse(newest.at));
    if (coordination.newestReturnAgeSeconds === UNKNOWN) coordination.reason = 'no readable retained return at or before asOf';
  } catch { coordination.reason = 'coordination ledger: missing or unreadable'; }
  const installedVersion = readLabel('installedVersion', deps.installedVersion);
  const sourceVersion = readLabel('sourceVersion', deps.sourceVersion);
  const report = {
    host: readLabel('host', deps.host), tailnetName: readLabel('tailnetName', deps.tailnet),
    installedVersion, ...(sourceVersion !== installedVersion ? { sourceVersion } : {}),
    pid: deps.pid(), uptimeSeconds: deps.uptime(), platform: readLabel('platform', deps.platform), arch: readLabel('arch', deps.arch),
    stateRoot, lastFleetStateRead, coordination, asOf: new Date(now).toISOString(), reasons,
  };
  return report;
}
