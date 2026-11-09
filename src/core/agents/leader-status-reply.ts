/** Deterministic "Phantom status" answer for Mason's Leader requests: facts read on this Mac, no model call. */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { explainFleetAdmission } from '../../cli/fleet-admission.js';
import { foldLaneMerges, readLaneMergesJobs } from '../../cli/fleet-lane-merges.js';
import { readNeedsMason } from '../fleet/needs-mason-resolve.js';

export interface StatusLane { lane: string; running: number; target: number; held: boolean }
/** Every field is null when its reader failed; null is printed as unknown, never as 0. */
export interface StatusFacts {
  installedVersion: string | null;
  latestVersion: string | null;
  lanes: StatusLane[] | null;
  mergesLastHour: number | null;
  needsYouCount: number | null;
  observedAt: string | null;
}

const PHRASES = new Set(['status', 'phantom status', 'fleet status', "what's the status", 'whats the status']);

/** Narrow on purpose: any real question stays with the model. */
export function isStatusRequest(text: string): boolean {
  if (typeof text !== 'string' || text.length > 100) return false;
  return PHRASES.has(text.trim().toLowerCase().replace(/[?.]$/, '').trim());
}

const MAX_LANES = 5;

export function composeStatusReply(facts: StatusFacts): string {
  const known = (value: string | number | null): string => value === null ? 'unknown' : String(value);
  const { installedVersion: installed, latestVersion: latest } = facts;
  const pending = installed !== null && latest !== null && installed !== latest;
  const lines = [`Phantom status (observed ${known(facts.observedAt)})`];
  lines.push(`App: installed ${known(installed)}, latest ${known(latest)}${pending ? ' - update pending' : ''}`);
  if (facts.lanes === null) lines.push('Lanes: unknown');
  else if (!facts.lanes.length) lines.push('Lanes: none reported');
  else {
    const shown = facts.lanes.slice(0, MAX_LANES);
    lines.push(...shown.map(row => `Lane ${row.lane}: ${row.running} running of ${row.target}${row.held ? ' (held)' : ''}`));
    if (facts.lanes.length > shown.length) lines.push(`+${facts.lanes.length - shown.length} more lanes`);
  }
  lines.push(`Merges in the last hour: ${known(facts.mergesLastHour)}`);
  lines.push(`Needs you: ${known(facts.needsYouCount)}`);
  return lines.slice(0, 8).join('\n');
}

export interface StatusFactsOptions {
  runsDir: string;
  now?: () => Date;
  /** Test seams; defaults read the installed app and the staged update on this Mac. */
  readInstalled?: () => string | null | Promise<string | null>;
  readLatest?: () => string | null | Promise<string | null>;
}

async function attempt<T>(read: () => T | Promise<T>): Promise<T | null> {
  try { return await read(); } catch { return null; }
}

// The desktop update modules are heavy; load them only when no reader is injected.
const defaultInstalled = async (): Promise<string | null> => (await import('../app-update-status.js')).readInstalledBundleVersion();
const defaultLatest = async (): Promise<string | null> => {
  const { defaultAppUpdateStatusDeps, readAppUpdateStatus } = await import('../app-update-status.js');
  return readAppUpdateStatus(defaultAppUpdateStatusDeps()).available;
};

/** Reuses the Fleet readers; a failing reader yields null for its field and never throws. */
export async function readStatusFacts(options: StatusFactsOptions): Promise<StatusFacts> {
  const now = (options.now ?? (() => new Date()))();
  const runsDir = options.runsDir || join(homedir(), '.ashlr-runs');
  const [lanes, mergesLastHour] = await Promise.all([
    attempt(async () => explainFleetAdmission(JSON.parse(await readFile(join(runsDir, 'queue', 'status.json'), 'utf8')))
      .lanes.map(({ lane, running, target, held }) => ({ lane, running, target, held }))),
    attempt(async () => {
      const jobs = await readLaneMergesJobs(runsDir);
      return jobs === null ? null : foldLaneMerges(jobs, 1, now.getTime()).lanes.reduce((sum, row) => sum + row.merges, 0);
    }),
  ]);
  return {
    installedVersion: await attempt(options.readInstalled ?? defaultInstalled),
    latestVersion: await attempt(options.readLatest ?? defaultLatest),
    lanes,
    mergesLastHour,
    needsYouCount: await attempt(() => { const read = readNeedsMason({ runsDir }); return read.status === 'available' ? read.items.length : null; }),
    observedAt: now.toISOString(),
  };
}
