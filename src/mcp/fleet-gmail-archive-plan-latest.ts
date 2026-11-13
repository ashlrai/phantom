/**
 * fleet_gmail_archive_plan_latest — the latest saved Gmail archive plan per
 * inbox (sampled unread vs target, how many to archive, top sender addresses)
 * through the isolated fleet MCP server, so the Comms agent can see which
 * inbox's saved sample is over target. Reads the same saved file the desktop
 * app shows, at the server-owned runs dir (never a caller-supplied directory,
 * root or cwd). Counts describe the scanned sample only: overTargetScope is
 * 'sample' and liveInboxTargetState stays 'unknown' — a saved plan never
 * proves live inbox health or that archiving happened, even when the sample
 * is under target. Counts and sender addresses only. The plan proposes; this
 * tool is read-only and never moves, archives, sends or deletes mail. Never
 * throws.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readGmailArchivePlanLatest } from '../core/comms/gmail-archive-plan-latest.js';

const MAX_INBOX_FILTER = 64;

export interface FleetGmailArchivePlanLatestArgs { inbox?: string }

export interface FleetGmailArchivePlanLatestReport {
  schema: 'fleet.mcp.gmail-archive-plan-latest.v1';
  state: 'present' | 'missing';
  plans: {
    inbox: string;
    at: string;
    /** Unread count inside the saved sample scan; not the live inbox total. */
    unread: number;
    target: number;
    archiveCount: number;
    /** Compatibility comparison of saved-sample unread > target, not inbox health. */
    overTarget: boolean;
    /** The comparison covers only the saved sample scan. */
    overTargetScope: 'sample';
    /** A saved sample cannot establish whether the live inbox meets its target. */
    liveInboxTargetState: 'unknown';
    /** Seconds since this plan was saved; null when its timestamp is unparseable. */
    ageSeconds: number | null;
    topSenders: { sender: string; count: number }[];
  }[];
}

/** Runtime argument validation: only an optional `inbox` string (max 64 chars); any other key is rejected. */
export function parseFleetGmailArchivePlanLatestArgs(args: Record<string, unknown> | undefined): FleetGmailArchivePlanLatestArgs | null {
  const a = args ?? {};
  if (Object.keys(a).some(k => k !== 'inbox')) return null;
  if (a.inbox === undefined) return {};
  if (typeof a.inbox !== 'string' || a.inbox.length > MAX_INBOX_FILTER) return null;
  return { inbox: a.inbox };
}

export function readFleetGmailArchivePlanLatest(
  args: FleetGmailArchivePlanLatestArgs = {},
  runsDir: string = join(homedir(), '.ashlr-runs'),
  now: () => Date = () => new Date(),
): FleetGmailArchivePlanLatestReport {
  const latest = readGmailArchivePlanLatest(runsDir);
  if (!latest) return { schema: 'fleet.mcp.gmail-archive-plan-latest.v1', state: 'missing', plans: [] };
  const nowMs = now().getTime();
  const plans = latest.plans
    .filter(p => args.inbox === undefined || p.inbox === args.inbox)
    .map(p => {
      const at = Date.parse(p.at);
      return {
        ...p,
        overTarget: p.unread > p.target,
        overTargetScope: 'sample' as const,
        liveInboxTargetState: 'unknown' as const,
        ageSeconds: Number.isFinite(at) ? Math.max(0, Math.floor((nowMs - at) / 1000)) : null,
      };
    });
  return { schema: 'fleet.mcp.gmail-archive-plan-latest.v1', state: 'present', plans };
}
