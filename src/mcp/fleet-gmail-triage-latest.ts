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
import { readGmailTriageLatest, type GmailTriageLatest } from '../core/comms/gmail-triage-latest.js';

export interface FleetGmailTriageLatestReport {
  schema: 'fleet.mcp.gmail-triage-latest.v1';
  state: 'present' | 'missing';
  latest: GmailTriageLatest | null;
  /** unreadInSample > target when present, else null. */
  overTarget: boolean | null;
  /** Seconds since the saved result; null when missing or its timestamp is unparseable. */
  ageSeconds: number | null;
}

/**
 * Runtime argument validation: this tool takes no arguments, so any key
 * (dir, path, root, cwd) is rejected before any filesystem read.
 */
export function parseFleetGmailTriageLatestArgs(args: Record<string, unknown> | undefined): Record<string, never> | null {
  return Object.keys(args ?? {}).length === 0 ? {} : null;
}

export function readFleetGmailTriageLatest(
  runsDir: string = join(homedir(), '.ashlr-runs'),
  now: () => Date = () => new Date(),
): FleetGmailTriageLatestReport {
  const latest = readGmailTriageLatest(runsDir);
  if (!latest) return { schema: 'fleet.mcp.gmail-triage-latest.v1', state: 'missing', latest: null, overTarget: null, ageSeconds: null };
  const at = Date.parse(latest.at);
  return {
    schema: 'fleet.mcp.gmail-triage-latest.v1',
    state: 'present',
    latest,
    overTarget: latest.unreadInSample > latest.target,
    ageSeconds: Number.isFinite(at) ? Math.max(0, Math.floor((now().getTime() - at) / 1000)) : null,
  };
}
