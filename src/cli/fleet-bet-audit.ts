/** Convention loader entry for `ashlr fleet bet-audit`; read-only reporting, never gates. */
import { isAbsolute } from 'node:path';
import {
  BET_AUDIT_DEFAULT_HOURS, readBetAudit, type BetAuditOptions, type BetAuditRow,
} from '../core/fleet/bet-audit.js';

type IO = { stdout?: { write(text: string): unknown } };

const USAGE = 'Usage: ashlr fleet bet-audit [--hours <n>] [--json] [--runs-dir <abs>]\n' +
  'Read-only audit of leader BET/FIXUP orders that never reached the queue or metrics.\n';

/** Table plus the summary line ("12 issued, 4 lost, 3 merged"). */
export function formatBetAudit(rows: readonly BetAuditRow[]): string {
  const header = ['ID', 'REPO', 'LANE', 'ISSUED', 'STATUS', 'URL'];
  const cells = rows.map(row => [row.id, row.repo, row.lane ?? '-', row.issuedAt, row.status, row.url ?? '-']);
  const widths = header.map((head, index) => Math.max(head.length, ...cells.map(cell => cell[index]!.length)));
  const line = (parts: readonly string[]) =>
    parts.map((part, index) => part.padEnd(widths[index]!)).join('  ').trimEnd();
  const count = (status: BetAuditRow['status']) => rows.filter(row => row.status === status).length;
  const summary = `${rows.length} issued, ${count('lost')} lost, ${count('merged')} merged`;
  return `${[line(header), ...cells.map(line), summary].join('\n')}\n`;
}

export async function cmdFleetBetAudit(args: string[], io: IO = {}, opts: BetAuditOptions = {}): Promise<number> {
  const output = io.stdout ?? process.stdout;
  if (args.includes('--help') || args.includes('-h')) {
    output.write(USAGE);
    return 0;
  }
  let hours: number | undefined;
  let runsDir: string | undefined;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    if (flag === '--json' && !json) { json = true; continue; }
    if ((flag === '--hours' && hours === undefined) || (flag === '--runs-dir' && runsDir === undefined)) {
      const value = args[++i];
      if (!value || value.startsWith('--') || value.includes('\0')) return 2;
      if (flag === '--hours') {
        const parsed = Number(value);
        if (!Number.isFinite(parsed) || parsed <= 0) return 2;
        hours = parsed;
      } else {
        if (!isAbsolute(value)) return 2;
        runsDir = value;
      }
      continue;
    }
    return 2;
  }
  try {
    const report = await readBetAudit(runsDir, { ...opts, hours: hours ?? opts.hours ?? BET_AUDIT_DEFAULT_HOURS });
    if (json) output.write(`${JSON.stringify(report)}\n`);
    else {
      output.write(formatBetAudit(report.rows));
      const degraded = Object.entries(report.sources).filter(([, state]) => state !== 'healthy');
      if (degraded.length) output.write(`sources: ${degraded.map(([name, state]) => `${name}=${state}`).join(' ')}\n`);
    }
    return 0;
  } catch {
    output.write(json ? `${JSON.stringify({ schema: 'fleet.bet-audit.v1', error: 'Unable to read audit sources' })}\n` : 'Unable to read audit sources\n');
    return 0;
  }
}
