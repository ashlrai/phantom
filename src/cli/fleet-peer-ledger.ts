import { readPeerLedger, type PeerLedgerReport } from '../core/agentnet/peer-ledger.js';

const USAGE = 'Usage: ashlr fleet peer-ledger [--json]\nShow peer bus rate-limit, capacity and hop budget (read-only, metadata only).\n';

export async function cmdFleetPeerLedger(args: string[], deps: { read?: () => PeerLedgerReport } = {}): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) { process.stdout.write(USAGE); return 0; }
  const unknown = args.filter(a => a !== '--json');
  if (unknown.length) { process.stderr.write(`Unknown argument.\n${USAGE}`); return 2; }
  let report: PeerLedgerReport | undefined;
  try { report = (deps.read ?? readPeerLedger)(); } catch { /* fixed fallback below */ }
  if (!report) {
    process.stdout.write(JSON.stringify({ status: 'unavailable', reason: 'peer-ledger-unavailable' }) + '\n');
    return 1;
  }
  if (args.includes('--json')) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  else {
    const lines = [`peer ledger: ${report.status}${report.reason ? ` (${report.reason})` : ''}`,
      `live rows: ${report.liveRows} of ${report.capacity}`];
    for (const p of report.pairs) lines.push(`${p.fromAgent} -> ${p.target}  ${p.inWindow}/${report.pairLimit}  remaining ${p.remaining}`);
    if (report.truncated.pairs) lines.push('(pairs truncated)');
    for (const o of report.origins.filter(o => o.nearCap)) lines.push(`near hop cap: ${o.origin} at hop ${o.maxHop} of ${report.maxHops}`);
    process.stdout.write(lines.join('\n') + '\n');
  }
  return report.status === 'unavailable' ? 1 : 0;
}
