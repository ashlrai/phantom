/** Convention loader entry for `ashlr fleet teammates`; read-only teammate status, never sends. */
import { loadConfigReadOnly } from '../core/config.js';
import { readTeammates, type TeammateStatusDeps, type TeammatesReport } from '../core/fleet/teammate-status.js';
import { sanitizePublicJson } from '../core/util/public-json.js';
import type { AshlrConfig } from '../core/types.js';

const USAGE = 'Usage: ashlr fleet teammates [--json]\n' +
  'Agent teammates — a2a counterparts, declared `teammates` entries and non-self allowlisted\n' +
  'iMessage handles — with channel, masked handle, off-plan capacity, last inbound/outbound\n' +
  'text times and the count of their messages with no reply. Read-only: chat.db is opened\n' +
  'read-only, nothing is sent and nothing is written.';

export interface FleetTeammatesDeps extends TeammateStatusDeps {
  /** Injected config (test seam). Default loadConfigReadOnly(). */
  cfg?: AshlrConfig;
}

const safe = (value: string): string => String(sanitizePublicJson(value))
  // eslint-disable-next-line no-control-regex -- terminal output must not contain control characters.
  .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '');

/** Human table: one row per teammate plus a chat.db note when it is not readable. */
export function formatTeammates(report: TeammatesReport): string {
  const header = ['NAME', 'CHANNEL', 'HANDLE', 'CAPACITY', 'LAST INBOUND', 'LAST OUTBOUND', 'UNANSWERED', 'SOURCE'];
  const cells = report.teammates.map((t) => [
    t.name,
    t.channel,
    t.handleMasked ?? '-',
    t.offPlanCapacity ? 'off-plan' : 'on-plan',
    t.lastInboundAt ?? '-',
    t.lastOutboundAt ?? '-',
    String(t.unanswered),
    t.source,
  ].map(safe));
  const widths = header.map((head, index) => Math.max(head.length, ...cells.map((cell) => cell[index]!.length)));
  const line = (parts: readonly string[]): string =>
    parts.map((part, index) => part.padEnd(widths[index]!)).join('  ').trimEnd();
  const lines = cells.length === 0 ? ['teammates: none configured'] : [line(header), ...cells.map(line)];
  if (report.chatDb !== 'ok') lines.push(`chat.db: ${report.chatDb}`);
  return lines.join('\n');
}

export async function cmdFleetTeammates(args: string[], deps: FleetTeammatesDeps = {}): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) { console.log(USAGE); return 0; }
  let json = false;
  for (const arg of args) {
    if (arg === '--json' && !json) { json = true; continue; }
    console.error(USAGE);
    return 2;
  }
  const cfg = deps.cfg ?? loadConfigReadOnly();
  const report = await readTeammates(cfg, deps);
  if (json) console.log(JSON.stringify(sanitizePublicJson(report)));
  else console.log(formatTeammates(report));
  return 0;
}
