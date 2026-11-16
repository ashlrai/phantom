import {
  peerPairSelectorSchema, readPeerLedger, type PeerLedgerReport, type PeerPairSelector,
} from '../core/agentnet/peer-ledger.js';

const USAGE = 'Usage: ashlr fleet peer-ledger [--json] [--from-agent <callsign> --target <target>]\n' +
  'Show peer bus rate-limit, capacity and hop budget (read-only, metadata only).\n' +
  'Pass --from-agent and --target together to inspect one exact pair, including pairs the\n' +
  '64-row display cap would hide. A missing match is not proof of enrollment or quota.\n';

export async function cmdFleetPeerLedger(
  args: string[], deps: { read?: (pair?: PeerPairSelector) => PeerLedgerReport } = {},
): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) { process.stdout.write(USAGE); return 0; }
  const reject = (message: string): number => { process.stderr.write(`${message}\n${USAGE}`); return 2; };
  let fromAgent: string | undefined, target: string | undefined;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json') continue;
    if (arg !== '--from-agent' && arg !== '--target') return reject('Unknown argument.');
    if (seen.has(arg)) return reject('Duplicate argument.');
    const value = args[i + 1];
    if (value === undefined || value.startsWith('--')) return reject(`Missing value for ${arg}.`);
    seen.add(arg); i++;
    if (arg === '--from-agent') fromAgent = value; else target = value;
  }
  if ((fromAgent === undefined) !== (target === undefined)) {
    return reject('Pair lookup requires both --from-agent and --target.');
  }
  let pair: PeerPairSelector | undefined;
  if (fromAgent !== undefined && target !== undefined) {
    const parsed = peerPairSelectorSchema.safeParse({ fromAgent, target });
    if (!parsed.success) return reject('Invalid pair selector.');
    pair = parsed.data;
  }
  const json = args.includes('--json');
  let report: PeerLedgerReport | undefined;
  try { report = (deps.read ?? ((p?: PeerPairSelector) => readPeerLedger({ pair: p })))(pair); }
  catch { /* fixed fallback below */ }
  if (!report) {
    process.stdout.write(JSON.stringify({ status: 'unavailable', reason: 'peer-ledger-unavailable' }) + '\n');
    return 1;
  }
  if (json) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  else {
    const lines = [`peer ledger: ${report.status}${report.reason ? ` (${report.reason})` : ''}`,
      `as of: ${report.asOf}`, `live rows: ${report.liveRows} of ${report.capacity}`];
    const sel = report.selection;
    if (sel) {
      const state = report.status === 'unavailable' ? 'unavailable'
        : sel.match === 'exact' ? 'matched' : 'no live evidence';
      lines.push(`pair lookup: ${sel.fromAgent} -> ${sel.target} (${state})`);
    }
    for (const p of report.pairs) lines.push(`${p.fromAgent} -> ${p.target}  ${p.inWindow}/${report.pairLimit}  remaining ${p.remaining}${p.remaining === 0 ? `  blocked; retry at: ${p.retryAt ?? 'unknown'}` : ''}`);
    if (report.truncated.pairs) lines.push('(pairs truncated)');
    for (const o of report.origins.filter(o => o.nearCap)) lines.push(`near hop cap: ${o.origin} at hop ${o.maxHop} of ${report.maxHops}`);
    process.stdout.write(lines.join('\n') + '\n');
  }
  return report.status === 'unavailable' ? 1 : 0;
}
