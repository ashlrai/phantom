/**
 * fleet_gmail_archive_plan_latest — the latest saved Gmail archive plan per
 * inbox (unread vs target, how many to archive, top sender addresses) through
 * the isolated fleet MCP server, so the Comms agent can see which inbox is
 * over target. Reads the same saved file the desktop app shows, at the
 * server-owned runs dir (never a caller-supplied directory, root or cwd).
 * Counts and sender addresses only. The plan proposes; this tool is read-only
 * and never moves, archives, sends or deletes mail. Never throws.
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
    unread: number;
    target: number;
    archiveCount: number;
    /** unread > target. */
    overTarget: boolean;
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
): FleetGmailArchivePlanLatestReport {
  const latest = readGmailArchivePlanLatest(runsDir);
  if (!latest) return { schema: 'fleet.mcp.gmail-archive-plan-latest.v1', state: 'missing', plans: [] };
  const plans = latest.plans
    .filter(p => args.inbox === undefined || p.inbox === args.inbox)
    .map(p => ({ ...p, overTarget: p.unread > p.target }));
  return { schema: 'fleet.mcp.gmail-archive-plan-latest.v1', state: 'present', plans };
}
