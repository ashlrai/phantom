import { readFileSync } from 'node:fs';
import { buildMainRedAge, defaultStatePath } from '../core/fleet/main-red-age.js';

export interface GuardianStuckRow {
  repo: string;
  redSince: string;
  redMinutes: number;
  attempts: number | null;
  revertStatus: string | null;
}
export interface GuardianStuckReport {
  v: 1;
  collectedAt: string;
  source: { path: string; status: 'read' | 'unread' | 'invalid' };
  stuck: GuardianStuckRow[];
}

type Output = { log: (message: string) => void; error: (message: string) => void };
export interface GuardianStuckDeps { now?: () => Date; output?: Output; readFile?: (path: string) => string }
const usage = 'Usage: ashlr fleet guardian-stuck [--json]';
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Returns null for an invalid state instead of treating incomplete input as healthy. */
export function buildGuardianStuck(raw: string, now: Date, path: string): GuardianStuckReport | null {
  let root: unknown;
  try { root = JSON.parse(raw); } catch { return null; }
  if (!record(root)) return null;
  const table = 'repos' in root ? root.repos : root;
  if (!record(table)) return null;
  const entries: Record<string, Record<string, unknown>> = Object.create(null) as Record<string, Record<string, unknown>>;
  for (const [repo, entry] of Object.entries(table)) {
    if (!/^[\w./@-]{1,200}$/.test(repo) || !record(entry)) return null;
    entries[repo] = entry;
  }
  const rows = buildMainRedAge(entries, now).repos;
  const stuck: GuardianStuckRow[] = [];
  for (const row of rows) {
    const entry = entries[row.repo]!;
    // A malformed job value is not evidence that no job exists.
    if (entry.cur_job !== undefined && entry.cur_job !== null && entry.cur_job !== '') continue;
    if (row.state !== 'red' || row.redSince === null || row.redMinutes === null || now.getTime() - Date.parse(row.redSince) <= 60 * 60_000) continue;
    const status = entry.revert_status;
    const revertStatus = typeof status === 'string' && /^[\w .-]{1,80}$/.test(status) ? status
      : typeof entry.reverted === 'boolean' ? (entry.reverted ? 'reverted' : 'not reverted') : null;
    stuck.push({ repo: row.repo, redSince: row.redSince, redMinutes: row.redMinutes, attempts: row.attempts, revertStatus });
  }
  return { v: 1, collectedAt: now.toISOString(), source: { path, status: 'read' }, stuck };
}

export async function cmdFleetGuardianStuck(args: string[], deps: GuardianStuckDeps = {}): Promise<number> {
  const output = deps.output ?? { log: console.log, error: console.error };
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) { output.log(usage); return 0; }
  if (args.length > 1 || (args.length === 1 && args[0] !== '--json')) { output.error(`Invalid arguments. ${usage}`); return 2; }
  const path = defaultStatePath();
  const now = (deps.now ?? (() => new Date()))();
  let raw: string | null = null;
  try { raw = (deps.readFile ?? ((p: string) => readFileSync(p, 'utf8')))(path); } catch { /* unread state is unknown */ }
  const report = (raw === null ? null : buildGuardianStuck(raw, now, path)) ?? {
    v: 1 as const, collectedAt: now.toISOString(), source: { path, status: raw === null ? 'unread' as const : 'invalid' as const }, stuck: [],
  };
  if (args[0] === '--json') output.log(JSON.stringify(report));
  else if (report.source.status !== 'read') output.error(`Cannot read guardian state (${report.source.status}): ${path}`);
  else if (report.stuck.length === 0) output.log('No stuck guardian entries.');
  else for (const row of report.stuck) output.log(`${row.repo}: red ${row.redMinutes} minutes, no current job, attempts ${row.attempts ?? 'unknown'}, revert ${row.revertStatus ?? 'unknown'}`);
  return report.source.status !== 'read' || report.stuck.length > 0 ? 1 : 0;
}
