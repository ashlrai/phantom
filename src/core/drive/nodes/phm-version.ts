import { createRequire } from 'node:module';
import { validCap } from './state.js';

/**
 * Nodes advertise the phm build they run as a `phm-<version>` capability on join.
 * A cap (not a new flag/field) because a primary still on an older build refuses unknown
 * flags: a worker upgraded before its primary must keep joining. Caps never gate routing
 * unless a job requires them, so this is observation only.
 */
const VERSION_CAP_PREFIX = 'phm-';
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

export function versionFromCaps(caps: readonly string[]): string | null {
  const cap = caps.find(c => c.startsWith(VERSION_CAP_PREFIX) && SEMVER.test(c.slice(VERSION_CAP_PREFIX.length)));
  return cap ? cap.slice(VERSION_CAP_PREFIX.length) : null;
}

/** Negative when a<b. Compares major.minor.patch only; prerelease tags are not ordered. */
export function compareVersions(a: string, b: string): number {
  const x = SEMVER.exec(a), y = SEMVER.exec(b);
  if (!x || !y) return 0;
  for (let i = 1; i <= 3; i++) { const d = Number(x[i]) - Number(y[i]); if (d !== 0) return d; }
  return 0;
}

export type DriftStatus = 'current' | 'behind' | 'ahead' | 'unreported';
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
  const rows: NodeDrift[] = nodes.map(n => {
    const version = versionFromCaps(n.caps);
    const status: DriftStatus = version === null ? 'unreported' : target === null ? 'current'
      : compareVersions(version, target) < 0 ? 'behind' : compareVersions(version, target) > 0 ? 'ahead' : 'current';
    return { nodeId: n.nodeId, live: n.live, version, status, slots: n.slots ?? null };
  });
  const drifted = rows.filter(r => r.status === 'behind' || r.status === 'unreported').map(r => r.nodeId);
  return { schemaVersion: 1, dryRun: true, executable: false, target, nodes: rows, drifted, steps: drifted.length ? [
    'Plan only: this command never updates, restarts or edits any node.',
    'Update the primary and backup hosts first, one at a time, so the pool keeps a witness.',
    'Then update each drifted worker host through its normal install path (reviewed build, no copied credentials).',
    'Re-run this plan: a node reports its version again only after its next worker join; "unreported" means it predates version reporting or has not joined.',
  ] : ['No drift: every reporting node matches the target.'] };
}
