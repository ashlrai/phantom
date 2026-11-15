import { IntentError, isIntentStatus, validIntentId } from '../core/intent/schema.js';
import { getIntent, listIntents } from '../core/intent/read.js';

const usage = `Usage: ashlr fleet intent-read list [--status <status>] [--json]
       ashlr fleet intent-read get <id> [--json]
The ledger is in ~/.ashlr-runs/intent/ledger.json; ASHLR_RUNS_DIR overrides ~/.ashlr-runs.`;

export async function cmdFleetIntentRead(args: string[]): Promise<number> {
  const json = args.includes('--json');
  const fail = (message: string): number => {
    if (json) console.log(JSON.stringify({ ok: false, error: message }));
    else console.error(`intent-read: ${message}`);
    return 2;
  };
  if (args.length === 1 && ['--help', '-h', 'help'].includes(args[0]!)) {
    console.log(usage);
    return 0;
  }
  const action = args[0];
  if (action !== 'list' && action !== 'get') return fail('Invalid arguments. Run ashlr fleet intent-read --help.');
  let status: import('../core/intent/schema.js').IntentStatus | undefined;
  let id: string | undefined;
  let seenJson = false;
  for (let i = 1; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json' && !seenJson) { seenJson = true; continue; }
    if (arg === '--status' && action === 'list' && status === undefined) {
      const value = args[++i];
      if (!value || !isIntentStatus(value)) return fail('Invalid status.');
      status = value;
      continue;
    }
    if (action === 'get' && !id && validIntentId(arg)) { id = arg; continue; }
    return fail('Invalid arguments. Run ashlr fleet intent-read --help.');
  }
  if (action === 'get' && !id) return fail('A valid directive id is required.');
  try {
    if (action === 'list') {
      const { items: records } = await listIntents({ status });
      if (json) console.log(JSON.stringify({ ok: true, records }));
      else for (const item of records) console.log(`${item.id}  [${item.status}]  ${item.title}`);
    } else {
      const item = await getIntent(id!);
      if (!item) return fail('Intent not found.');
      if (json) console.log(JSON.stringify({ ok: true, item }));
      else console.log(`${item.id}  [${item.status}]  ${item.title}`);
    }
    return 0;
  } catch (error) {
    return fail(error instanceof IntentError ? error.message : 'Intent ledger could not be read.');
  }
}
