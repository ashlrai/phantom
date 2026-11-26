import { FLEET_BUS_HOPS_LIMIT_MAX, readFleetBusHops } from '../core/fleet/bus-hops.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const usage = 'Usage: phm fleet bus-hops [--limit <1..50>] [--from <agent-or-label>] [--to <agent-or-label>] [--exclude-from <agent-or-label>] [--id <id>] [--json]\n'
  + 'Newest recorded cross-agent bus hops from the private hop log, oldest first.\n'
  + 'A hop is a send attempt: id, from, to and nullable token usage — never a body, delivery or lifecycle claim.\n'
  + '--from/--to/--exclude-from resolve through the identity registry like every other bus read; an\n'
  + 'unresolvable ref or unreadable registry keeps exact-label matching. --id keeps one exact message id.\n'
  + 'The log has no timestamps; matched counts hits in the scanned window and truncated marks rows beyond it.\n'
  + 'Missing is a verified-empty log; unreadable reports unknown, never an invented empty page.';

const LABEL = /^[\x21-\x7e]{1,128}$/;

export async function cmdFleetBusHops(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(usage); return 0; }
  let json = false, limit: number | undefined;
  const filters: { from?: string; to?: string; excludeFrom?: string; id?: string } = {};
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json' && !json && !seen.has(arg)) { json = true; seen.add(arg); continue; }
    const match = /^(--limit|--from|--to|--exclude-from|--id)(?:=(.*))?$/.exec(arg);
    if (!match || seen.has(match[1]!)) return 2;
    const value = match[2] ?? args[++i];
    if (value === undefined || value === '' || value.startsWith('--')) return 2;
    seen.add(match[1]!);
    if (match[1] === '--limit') {
      if (!/^\d+$/.test(value)) return 2;
      limit = Number(value);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > FLEET_BUS_HOPS_LIMIT_MAX) return 2;
    } else if (!LABEL.test(value)) return 2;
    else if (match[1] === '--from') filters.from = value;
    else if (match[1] === '--to') filters.to = value;
    else if (match[1] === '--exclude-from') filters.excludeFrom = value;
    else filters.id = value;
  }
  let result;
  try { result = readFleetBusHops({ ...(limit === undefined ? {} : { limit }), ...filters }); }
  catch { return 1; }
  if (result.sourceState === 'unreadable') {
    console.log(json ? JSON.stringify(sanitizePublicJson(result)) : 'Bus hops unknown.');
    return 1;
  }
  if (result.hops === null || result.hops.length === 0) {
    console.log(json ? JSON.stringify(sanitizePublicJson(result)) : 'No bus hops recorded.');
    return 0;
  }
  if (json) { console.log(JSON.stringify(sanitizePublicJson(result), null, 2)); return 0; }
  const lines = result.hops.map(hop =>
    `${hop.id}  ${hop.from} → ${hop.to}  in=${hop.inputTokens ?? 'unknown'} out=${hop.outputTokens ?? 'unknown'}`);
  const tail = [
    `${result.returnedHops} of ${result.matched} matched hops${result.truncated ? ' (older rows beyond the scan window)' : ''}.`,
    ...(result.skippedRows !== null && result.skippedRows > 0 ? [`Skipped ${result.skippedRows} invalid row${result.skippedRows === 1 ? '' : 's'}.`] : []),
  ];
  console.log([...lines, '', ...tail].join('\n'));
  return 0;
}
