import { readFileSync } from 'node:fs';
import { buildReceipt, parseEvents, receiptsEnabled, renderReceipt } from '../core/engineering-receipt.js';

export async function cmdReceipt(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) { console.log(USAGE); return 0; }
  let events: string | undefined;
  let claims: string | undefined;
  let task: string | undefined;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--json') { json = true; continue; }
    const value = args[++i];
    if (!value || value.startsWith('--')) return usage();
    if (flag === '--events' && !events) events = value;
    else if (flag === '--claims' && !claims) claims = value;
    else if (flag === '--task' && !task) task = value;
    else return usage();
  }
  if (!events) return usage();
  if (!receiptsEnabled()) {
    console.error('Engineering receipts are disabled; set PHANTOM_RECEIPTS=1 to enable.');
    return 1;
  }
  try {
    const claimLines = claims ? readFileSync(claims, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean) : [];
    const receipt = buildReceipt(parseEvents(readFileSync(events, 'utf8')), { task, claims: claimLines });
    console.log(json ? JSON.stringify(receipt) : renderReceipt(receipt));
    return 0;
  } catch {
    console.error('Cannot read events or claims file.');
    return 1;
  }
}
const USAGE = 'Usage: phm engineering-receipt --events <file.jsonl> [--claims <file>] [--task <text>] [--json]';
function usage(): number {
  console.error(USAGE);
  return 2;
}
