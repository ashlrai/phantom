/**
 * fleet_gmail_triage_latest — the last saved Gmail triage result (unread vs
 * target) through the isolated fleet MCP server, so the Leader and other
 * agents can see inbox status without a shell. Reads the same saved file the
 * desktop app shows, at the server-owned runs dir (never a caller-supplied
 * directory, root or cwd). Counts and a short directory label only — never
 * subjects, senders, bodies, message ids or absolute paths. Local saved
 * counts are not proof of delivery or archiving. Read-only; never throws.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readGmailTriageInboxReports, type GmailTriageLatest } from '../core/comms/gmail-triage-latest.js';

/**
 * One saved inbox record. `label` is a directory basename, not a verified
 * account (two account directories sharing a basename share one entry). Counts
 * are saved exports: not live unread totals and not proof anything was archived.
 */
export interface FleetGmailTriageInboxEntry {
  label: string;
  at: string;
  ageSeconds: number | null;
  scanned: number;
  updates: number;
  drafted: number;
  review: number;
  failed: number;
  unreadInSample: number;
  target: number;
  archiveCandidateCount: number;
  /** unreadInSample > target for this inbox's own sample only. */
  overTarget: boolean;
  overTargetScope: 'sample';
  liveInboxTargetState: 'unknown';
}

export interface FleetGmailTriageLatestReport {
  schema: 'fleet.mcp.gmail-triage-latest.v1';
  state: 'present' | 'missing';
  latest: GmailTriageLatest | null;
  /** Compatibility comparison of unreadInSample > target, not inbox health. */
  overTarget: boolean | null;
  /** The comparison covers only the saved sample; missing data has unknown scope. */
  overTargetScope: 'sample' | 'unknown';
  /** Saved samples cannot establish whether the live inbox meets its target. */
  liveInboxTargetState: 'unknown';
  /** Seconds since the saved result; null when missing or its timestamp is unparseable. */
  ageSeconds: number | null;
  /** Additive: every saved inbox (bounded by the store), newest first; [] when missing. */
  inboxes: FleetGmailTriageInboxEntry[];
  inboxLabelIdentity: 'directory-basename-unverified';
}

/**
 * Runtime argument validation: this tool takes no arguments, so any key
 * (dir, path, root, cwd) is rejected before any filesystem read.
 */
export function parseFleetGmailTriageLatestArgs(args: Record<string, unknown> | undefined): Record<string, never> | null {
  return Object.keys(args ?? {}).length === 0 ? {} : null;
}

function ageOf(at: string, now: () => Date): number | null {
  const ms = Date.parse(at);
  return Number.isFinite(ms) ? Math.max(0, Math.floor((now().getTime() - ms) / 1000)) : null;
}

export function readFleetGmailTriageLatest(
  runsDir: string = join(homedir(), '.ashlr-runs'),
  now: () => Date = () => new Date(),
): FleetGmailTriageLatestReport {
  const reports = readGmailTriageInboxReports(runsDir);
  const latest = reports?.latest ?? null;
  const inboxes = (reports?.inboxes ?? []).map((r): FleetGmailTriageInboxEntry => ({
    label: r.dir,
    at: r.at,
    ageSeconds: ageOf(r.at, now),
    scanned: r.scanned,
    updates: r.updates,
    drafted: r.drafted,
    review: r.review,
    failed: r.failed,
    unreadInSample: r.unreadInSample,
    target: r.target,
    archiveCandidateCount: r.archiveCandidateCount,
    overTarget: r.unreadInSample > r.target,
    overTargetScope: 'sample',
    liveInboxTargetState: 'unknown',
  }));
  const base = { schema: 'fleet.mcp.gmail-triage-latest.v1', liveInboxTargetState: 'unknown', inboxes, inboxLabelIdentity: 'directory-basename-unverified' } as const;
  if (!latest) return { ...base, state: 'missing', latest: null, overTarget: null, overTargetScope: 'unknown', ageSeconds: null };
  return {
    ...base,
    state: 'present',
    latest,
    overTarget: latest.unreadInSample > latest.target,
    overTargetScope: 'sample',
    ageSeconds: ageOf(latest.at, now),
  };
}
