import { validateBusEnvelope } from '../core/fleet/bus-envelope.js';
import { type BusInboxOptions, listBusInboxAfter } from '../core/fleet/bus-inbox.js';
import { readBusThread } from '../core/fleet/bus-thread-context.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const usage = 'Usage: ashlr fleet bus-thread --id <id> [--json]';
interface Dependencies {
  list?: typeof listBusInboxAfter;
  output?: (text: string) => void;
  error?: (text: string) => void;
}

export async function cmdFleetBusThread(args: string[], options: BusInboxOptions = {}, deps: Dependencies = {}): Promise<number> {
  const output = deps.output ?? (text => console.log(text));
  const error = deps.error ?? (text => console.error(text));
  const invalid = (): number => { error(`Invalid arguments. ${usage}`); return 2; };
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    output(`${usage}\nReads retained live local context only; routing labels are not authenticated identities.`);
    return 0;
  }
  let id: string | undefined, json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json' && !json) json = true;
    else if ((arg === '--id' || arg.startsWith('--id=')) && id === undefined) {
      id = arg === '--id' ? args[++i] : arg.slice(5);
      if (!id || (arg === '--id' && id.startsWith('--'))) return invalid();
    } else return invalid();
  }
  if (!id || !validateBusEnvelope({ id, from: 'x', to: 'x', priority: 'P3', ttl: 1, body: null }).ok) return invalid();
  const result = readBusThread(id, options, deps.list);
  if (json) output(JSON.stringify(result));
  else {
    const safe = (value: unknown): string => JSON.stringify(sanitizePublicJson(value)).replace(/[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
    output(`Bus thread ${safe(id)}: ${result.complete ? result.rootFound ? `${result.messages.length} messages` : 'not found' : 'incomplete (source failure)'}; scanned through ${result.scannedThrough}.`);
    for (const row of result.messages) output(`${row.cursor} ${safe(row.envelope)}`);
  }
  return result.complete && result.rootFound ? 0 : 1;
}
