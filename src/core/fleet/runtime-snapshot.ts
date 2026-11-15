import { lstat, readdir } from 'node:fs/promises';
import { arch, homedir, hostname, platform } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { readClaimExecution, type ClaimExecutionReport } from './claim-execution-evidence.js';
import { readFleetBoard } from './coordination.js';
import { projectCoordinationReturns } from './coordination-returns-view.js';
import { defaultStatePath } from './main-red-age.js';
import { defaultRuntimeIdentityDeps } from './runtime-identity.js';
import { readFleetRunsDirState } from './runs-dir-state.js';
import { defaultTailnetPeersDeps, readTailnetPeers } from './tailnet-peers.js';
import { treeVersionFromPackageJson } from '../verse/release-version-guard.js';
import { scrubSecrets } from '../util/scrub.js';

const UNKNOWN = 'UNKNOWN';
/** Largest epoch-millisecond instant `Date` can represent (±8.64e15 ms). */
const MAX_EPOCH_MS = 8_640_000_000_000_000;
/** An epoch-millisecond timestamp the coordination ledger itself writes. */
const epochMs = (n: unknown): n is number =>
  typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 && n <= MAX_EPOCH_MS;
/**
 * Live-claim qualification for the summary count, mirroring the temporal
 * contract of `temporallyQualified` in claim-execution-evidence.ts: both
 * timestamps must be valid epoch milliseconds, `expiresAt` must fall
 * strictly after `claimedAt`, and `claimedAt` must sit at or before the
 * observation instant. A future-dated, reversed or out-of-range claim is
 * dropped by the execution join, so it must not inflate `activeClaims`.
 */
const isLiveClaimAt = (claim: unknown, nowMs: number): boolean => {
  if (claim === null || typeof claim !== 'object') return false;
  const { claimedAt, expiresAt } = claim as { claimedAt?: unknown; expiresAt?: unknown };
  return epochMs(claimedAt) && epochMs(expiresAt) && expiresAt > claimedAt &&
    claimedAt <= nowMs && expiresAt > nowMs;
};
const identity = defaultRuntimeIdentityDeps();
const defaultExecution = (snapshot?: { board: typeof readFleetBoard; now: () => number }): Promise<ClaimExecutionReport> =>
  readClaimExecution(snapshot ?? { board: defaults.board, now: defaults.now });
export const defaults = {
  now: Date.now, home: homedir, host: hostname, platform, arch,
  pid: () => process.pid, uptime: () => process.uptime(),
  // Reuse the dashboard guardian reader's runs-root resolution.
  stateRoot: () => dirname(dirname(defaultStatePath())),
  installedVersion: identity.installedVersion,
  sourceVersion: () => treeVersionFromPackageJson(identity.readSourcePackageJson()),
  tailnet: () => readTailnetPeers(defaultTailnetPeersDeps()).self,
  board: readFleetBoard,
  execution: defaultExecution,
};
export type FleetRuntimeDeps = Omit<typeof defaults, 'execution'> & { execution?: typeof defaults.execution };

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
  execution?: { state: 'known' | 'UNKNOWN'; running: number; claimedNoWorker: number; unknown: number; reason?: string };
  asOf: string;
  reasons: string[];
}

/** One read-only snapshot; failures never expose raw exceptions or store contents.
 * `asOf` is a settled execution report's own join instant (sampled after the
 * worker read), else the completion clock, else entry — every reported age and
 * claim count is evaluated at `asOf`, so an expired claim is never RUNNING. */
export async function readRuntimeSnapshot(deps: FleetRuntimeDeps): Promise<RuntimeSnapshot> {
  const now = deps.now();
  const reasons: string[] = [];
  // Resolver exceptions get their own boundary: they degrade only the path and
  // freshness fields and never move the scan to a fallback directory.
  let home: string | null = null;
  try { home = resolve(deps.home()); } catch { reasons.push('home: path resolution failed'); }
  // Identity labels are single safe tokens: never echo emails, paths or arbitrary text.
  const label = (value: string | null): string => value && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) && scrubSecrets(value) === value ? value : UNKNOWN;
  const readLabel = (name: string, read: () => string | null): string => {
    let value = UNKNOWN;
    try { value = label(read()); } catch { /* fixed reason below */ }
    if (value === UNKNOWN) reasons.push(`${name}: unavailable`);
    return value;
  };
  let root: string | null = null;
  try { root = resolve(deps.stateRoot()); } catch { reasons.push('stateRoot: path resolution failed'); }
  let stateRoot: string = UNKNOWN;
  if (home !== null && root !== null) {
    const rel = relative(home, root);
    stateRoot = rel === '' ? '~' : rel !== '..' && !rel.startsWith(`..${sep}`) && !resolve(root).startsWith(`${sep}${sep}`)
      ? `~/${rel.split(sep).join('/')}` : '[path outside home]';
  }
  // Scan and board capture happen at the entry instant `now`; the observation
  // instant settles after the worker read — keep raw instants, evaluate at asOf.
  let stateReadMs: number | null = null;
  if (root === null) {
    reasons.push('lastFleetStateRead: state root unresolved');
  } else {
    try {
      const state = await readFleetRunsDirState({ runsDir: root, now: () => now });
      if (!state.runsDirPresent) throw new Error('state root unavailable');
      stateReadMs = await newestMtime(root);
    } catch { reasons.push('lastFleetStateRead: state missing, unreadable or scan limit exceeded'); }
  }
  const coordination: { state: string; activeClaims: number | string; newestReturnAgeSeconds: number | string; reason?: string } = {
    state: UNKNOWN, activeClaims: UNKNOWN, newestReturnAgeSeconds: UNKNOWN,
  };
  let board: ReturnType<typeof readFleetBoard> | null = null;
  try {
    board = deps.board({ now });
    if (board.state !== 'known') throw new Error('unreadable ledger');
  } catch { coordination.reason = 'coordination ledger: missing or unreadable'; }
  let execution: NonNullable<RuntimeSnapshot['execution']> = {
    state: 'UNKNOWN', running: 0, claimedNoWorker: 0, unknown: 0,
  };
  let evidence: ClaimExecutionReport | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<null>(resolve => {
      timer = setTimeout(() => resolve(null), 2_000);
    });
    // The race retains a rejection handler even if the reader settles late.
    // The defaults object (also spread by production callers) carries its
    // execution reader. Keep explicitly injected readers independent, including
    // defaults.execution paired with a different board, a supported legacy seam.
    const useCapturedBoard = deps.execution === undefined ||
      (deps.execution === defaultExecution && deps.board === defaults.board);
    // The join clock is the live injected clock, sampled inside the read after
    // the worker snapshot — a frozen entry instant predates a fresh generatedAt
    // and fails the join's own future-stamp check.
    const readExecution = useCapturedBoard ? () => defaults.execution({
      board: () => {
        if (board === null) throw new Error('unavailable captured board');
        return board;
      },
      now: deps.now,
    }) : deps.execution!;
    evidence = await Promise.race([readExecution(), deadline]);
    if (evidence === null) execution.reason = 'execution: read deadline exceeded';
    else {
      const reason = evidence.ledger !== 'known' ? 'execution: ledger unavailable'
        : evidence.processes !== 'healthy' ? 'execution: process table unavailable' : undefined;
      execution = { state: reason === undefined ? 'known' : 'UNKNOWN', ...evidence.counts,
        ...(reason === undefined ? {} : { reason }) };
    }
  } catch { execution.reason = 'execution: read failed'; }
  finally { if (timer !== undefined) clearTimeout(timer); }
  // Settle the advertised instant: a settled report's join instant; without
  // evidence the completion clock; a broken clock keeps the entry instant.
  const bounded = (ms: number): boolean => Number.isFinite(ms) && ms >= 0 && ms <= 8_640_000_000_000_000;
  const evidenceInstant = evidence === null ? Number.NaN : Date.parse(evidence.asOf);
  let asOfMs = bounded(evidenceInstant) ? evidenceInstant : now;
  if (!bounded(evidenceInstant)) { try { const t = deps.now(); if (bounded(t)) asOfMs = t; } catch { /* keep the entry instant */ } }
  const age = (ms: number): number | typeof UNKNOWN =>
    Number.isFinite(ms) && ms <= asOfMs ? Math.floor((asOfMs - ms) / 1000) : UNKNOWN;
  const lastFleetStateRead: { mtime: string; ageSeconds: number | string } = { mtime: UNKNOWN, ageSeconds: UNKNOWN };
  if (stateReadMs !== null) {
    lastFleetStateRead.mtime = new Date(stateReadMs).toISOString();
    lastFleetStateRead.ageSeconds = age(stateReadMs);
    if (lastFleetStateRead.ageSeconds === UNKNOWN) reasons.push('lastFleetStateRead: future mtime; clock skew');
  }
  // The captured board was read at entry; liveness is re-evaluated at asOf, so a
  // claim expiring mid-read is dead at the advertised instant — never RUNNING.
  if (board !== null && board.state === 'known') {
    coordination.state = 'known';
    coordination.activeClaims = board.claims.filter(claim => isLiveClaimAt(claim, asOfMs)).length;
    const newest = projectCoordinationReturns(board, asOfMs).returns[0];
    if (newest) coordination.newestReturnAgeSeconds = age(Date.parse(newest.at));
    if (coordination.newestReturnAgeSeconds === UNKNOWN) coordination.reason = 'no readable retained return at or before asOf';
  }
  const installedVersion = readLabel('installedVersion', deps.installedVersion);
  const sourceVersion = readLabel('sourceVersion', deps.sourceVersion);
  const report = {
    host: readLabel('host', deps.host), tailnetName: readLabel('tailnetName', deps.tailnet),
    installedVersion, ...(sourceVersion !== installedVersion ? { sourceVersion } : {}),
    pid: deps.pid(), uptimeSeconds: deps.uptime(), platform: readLabel('platform', deps.platform), arch: readLabel('arch', deps.arch),
    stateRoot, lastFleetStateRead, coordination, execution, asOf: new Date(asOfMs).toISOString(), reasons,
  };
  return report;
}
