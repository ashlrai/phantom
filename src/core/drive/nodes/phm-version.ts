import { createRequire } from 'node:module';
import { validCap } from './state.js';

/**
 * Nodes advertise the phm build they run as a `phm-<version>` capability on join.
 * A cap (not a new flag/field) because a primary still on an older build refuses unknown
 * flags: a worker upgraded before its primary must keep joining. Caps never gate routing
 * unless a job requires them, so this is observation only.
 */
export const VERSION_CAP_PREFIX = 'phm-';
const SEMVER = /^(\d{1,9})\.(\d{1,9})\.(\d{1,9})(?:[-+][0-9a-z.-]*)?$/;

/** ASHLR_VERSION is set by the SEA shim, where package.json is not resolvable. */
export function localPhmVersion(): string | null {
  const env = process.env['ASHLR_VERSION'];
  if (env) return env;
  try { return (createRequire(import.meta.url)('../../../../package.json') as { version?: string }).version ?? null; } catch { return null; }
}

export function versionCap(version: string | null): string | null {
  const cap = version === null ? null : `${VERSION_CAP_PREFIX}${version.toLowerCase()}`;
  return cap !== null && SEMVER.test(version!.toLowerCase()) && validCap(cap) ? cap : null;
}

/** True for the `phm-<semver>` build marker a join advertises. It is
 * observation metadata for self-update drift — never a lane or pack a job
 * can require — so lane projections filter it out while `caps` keeps it. */
export function isVersionCap(cap: string): boolean {
  return cap.startsWith(VERSION_CAP_PREFIX) && SEMVER.test(cap.slice(VERSION_CAP_PREFIX.length));
}

export function versionFromCaps(caps: readonly string[]): string | null {
  const cap = caps.find(isVersionCap);
  return cap ? cap.slice(VERSION_CAP_PREFIX.length) : null;
}

/** Negative when a<b. Compares major.minor.patch only; prerelease tags are not ordered. */
export function compareVersions(a: string, b: string): number {
  const x = SEMVER.exec(a), y = SEMVER.exec(b);
  if (!x || !y) return 0;
  for (let i = 1; i <= 3; i++) { const d = Number(x[i]) - Number(y[i]); if (d !== 0) return d; }
  return 0;
}

/** 'unknown': the node reported a build but no comparable target exists, so
 * drift is unmeasured — never a fabricated 'current'. */
export type DriftStatus = 'current' | 'behind' | 'ahead' | 'unreported' | 'unknown';
export interface NodeDrift { nodeId: string; live: boolean; version: string | null; status: DriftStatus; slots: number | null }
export interface SelfUpdatePlan {
  schemaVersion: 1;
  dryRun: true;
  executable: false;
  target: string | null;
  nodes: NodeDrift[];
  drifted: string[];
  steps: string[];
}

interface ViewedNode { nodeId: string; live: boolean; caps: string[]; slots?: number }

/** Pure: reports drift from pool-view nodes against a target build. Never touches a node. */
export function planNodeSelfUpdate(nodes: readonly ViewedNode[], target: string | null): SelfUpdatePlan {
  // Only a parseable release version can judge drift. compareVersions returns
  // 0 for input it cannot order, so an absent or unparseable target (a build
  // that cannot name itself, or a --target compareVersions rejects) must not
  // fall through to 'current' — reported versions read 'unknown' instead.
  const comparable = target !== null && SEMVER.test(target) ? target : null;
  const rows: NodeDrift[] = nodes.map(n => {
    const version = versionFromCaps(n.caps);
    const status: DriftStatus = version === null ? 'unreported'
      : comparable === null ? 'unknown'
      : compareVersions(version, comparable) < 0 ? 'behind' : compareVersions(version, comparable) > 0 ? 'ahead' : 'current';
    return { nodeId: n.nodeId, live: n.live, version, status, slots: n.slots ?? null };
  });
  const drifted = rows.filter(r => r.status === 'behind' || r.status === 'unreported').map(r => r.nodeId);
  const steps = comparable === null ? [
    'Plan only: this command never updates, restarts or edits any node.',
    target === null
      ? 'No comparison target: this build\'s phm version could not be determined, so reported versions read "unknown" rather than a drift verdict. Pass --target <x.y.z> to compare, or repair this install.'
      : `Comparison target ${target} is not a comparable release version, so reported versions read "unknown". Pass --target <x.y.z>.`,
    ...(drifted.length ? ['Nodes marked "unreported" predate version reporting or have not joined; they report again after their next worker join.'] : []),
  ] : drifted.length ? [
    'Plan only: this command never updates, restarts or edits any node.',
    'Update the primary and backup hosts first, one at a time, so the pool keeps a witness.',
    'Then update each drifted worker host through its normal install path (reviewed build, no copied credentials).',
    'Re-run this plan: a node reports its version again only after its next worker join; "unreported" means it predates version reporting or has not joined.',
  ] : ['No drift: every reporting node matches the target.'];
  return { schemaVersion: 1, dryRun: true, executable: false, target, nodes: rows, drifted, steps };
}
