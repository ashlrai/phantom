import { rejectUnknownOptions } from './args.js';
import { ownerThreadOptions } from './comms-owner-thread.js';
import { readOwnerThreadHistory } from '../core/comms/owner-thread-archive.js';

const usage = 'Usage: ashlr fleet owner-history [--before <seq>] [--limit <n>] [--json]';
export interface FleetOwnerHistoryDeps {
  options?: { runsDir: string };
  output?: (text: string) => void;
  error?: (text: string) => void;
}
export async function cmdFleetOwnerHistory(args: string[], deps: FleetOwnerHistoryDeps = {}): Promise<number> {
  const output = deps.output ?? console.log; const error = deps.error ?? console.error;
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) { output(usage); return 0; }
  const bad = rejectUnknownOptions(args, { flags: ['--json'], values: ['--before', '--limit'] });
  const validArgs = args.every((arg, i) => ['--json', '--before', '--limit'].includes(arg) || (i > 0 && ['--before', '--limit'].includes(args[i - 1]!)));
  const number = (flag: string) => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
  const beforeRaw = number('--before'); const limitRaw = number('--limit');
  const validNumber = (raw: string | undefined, max: number) => raw === undefined || (/^\d+$/.test(raw) && Number.isSafeInteger(Number(raw)) && Number(raw) > 0 && Number(raw) <= max);
  if (bad || !validArgs || ['--json', '--before', '--limit'].some(flag => args.filter(arg => arg === flag).length > 1) ||
      (args.includes('--before') && beforeRaw === undefined) || (args.includes('--limit') && limitRaw === undefined) ||
      !validNumber(beforeRaw, Number.MAX_SAFE_INTEGER) || !validNumber(limitRaw, 500)) { error(usage); return 2; }
  const history = readOwnerThreadHistory(deps.options ?? ownerThreadOptions({}), {
    ...(beforeRaw === undefined ? {} : { before: Number(beforeRaw) }), ...(limitRaw === undefined ? {} : { limit: Number(limitRaw) }),
  });
  if (args.includes('--json')) output(JSON.stringify(history));
  else {
    for (const message of history.messages) output(`#${message.seq} ${message.at} ${message.channel} ${message.direction} ${message.text.slice(0, 160).replace(/[\r\n]/g, ' ')}`);
    output(`archives: ${history.archives}, skipped: ${history.skipped}`);
  }
  return 0;
}
