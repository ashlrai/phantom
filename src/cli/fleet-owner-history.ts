import { rejectUnknownOptions } from './args.js';
import { ownerThreadOptions, parseOwnerThreadFilterArgs } from './comms-owner-thread.js';
import { readOwnerThreadHistory } from '../core/comms/owner-thread-archive.js';

const usage = 'Usage: ashlr fleet owner-history [--before <seq>] [--limit <n>] [--channel <desktop|telegram|email|imessage|slack>] [--direction <inbound|outbound>] [--since <15m|2h|1d|ISO|epoch-ms>] [--before-at <15m|2h|1d|ISO|epoch-ms>] [--contains <text>] [--json]';
export interface FleetOwnerHistoryDeps {
  options?: { runsDir: string };
  output?: (text: string) => void;
  error?: (text: string) => void;
}
export async function cmdFleetOwnerHistory(args: string[], deps: FleetOwnerHistoryDeps = {}): Promise<number> {
  const output = deps.output ?? console.log; const error = deps.error ?? console.error;
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) { output(usage); return 0; }
  const valueFlags = ['--before', '--limit', '--channel', '--direction', '--since', '--before-at', '--contains'];
  const known = ['--json', ...valueFlags];
  const bad = rejectUnknownOptions(args, { flags: ['--json'], values: valueFlags });
  const validArgs = args.every((arg, i) => known.includes(arg) || (i > 0 && valueFlags.includes(args[i - 1]!)));
  const number = (flag: string) => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
  const beforeRaw = number('--before'); const limitRaw = number('--limit');
  const validNumber = (raw: string | undefined, max: number) => raw === undefined || (/^\d+$/.test(raw) && Number.isSafeInteger(Number(raw)) && Number(raw) > 0 && Number(raw) <= max);
  if (bad || !validArgs || known.some(flag => args.filter(arg => arg === flag).length > 1) ||
      (args.includes('--before') && beforeRaw === undefined) || (args.includes('--limit') && limitRaw === undefined) ||
      !validNumber(beforeRaw, Number.MAX_SAFE_INTEGER) || !validNumber(limitRaw, 500)) { error(usage); return 2; }
  const parsed = parseOwnerThreadFilterArgs(args);
  if (parsed.error !== undefined) { error(parsed.error); error(usage); return 2; }
  const history = readOwnerThreadHistory(deps.options ?? ownerThreadOptions({}), {
    ...(beforeRaw === undefined ? {} : { before: Number(beforeRaw) }), ...(limitRaw === undefined ? {} : { limit: Number(limitRaw) }),
    ...(parsed.filter ?? {}),
  });
  if (args.includes('--json')) output(JSON.stringify(history));
  else {
    for (const message of history.messages) output(`#${message.seq} ${message.at} ${message.channel} ${message.direction} ${message.text.slice(0, 160).replace(/[\r\n]/g, ' ')}`);
    output(`archives: ${history.archives}, skipped: ${history.skipped}`);
  }
  return 0;
}
