import { IntentError } from '../core/intent/schema.js';
import { importIntentFiles } from '../core/intent/import.js';

const usage = `Usage: ashlr fleet intent-import <file.jsonl> [more files...] [--json]
Imports directive JSON/JSONL files into the private intent ledger, keeping provenance.
Files are named explicitly; nothing is discovered. ASHLR_RUNS_DIR overrides ~/.ashlr-runs.`;

export async function cmdFleetIntentImport(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h', 'help'].includes(args[0]!)) {
    console.log(usage);
    return 0;
  }
  const json = args.includes('--json');
  const fail = (message: string, code: number): number => {
    if (json) console.log(JSON.stringify({ ok: false, error: message }));
    else console.error(`intent-import: ${message}`);
    return code;
  };
  const paths: string[] = [];
  let seenJson = false;
  for (const arg of args) {
    if (arg === '--json' && !seenJson) seenJson = true;
    else if (arg.startsWith('-') || arg === '') return fail('Invalid arguments. Run ashlr fleet intent-import --help.', 2);
    else paths.push(arg);
  }
  if (paths.length === 0) return fail('Name at least one JSONL or JSON file.', 2);
  try {
    const result = await importIntentFiles(paths);
    if (json) console.log(JSON.stringify({ ok: true, ...result }));
    else console.log(`Imported ${result.imported}, deduped ${result.deduped}; ${result.items} in the ledger.`);
    return 0;
  } catch (caught) {
    return fail(caught instanceof IntentError ? caught.message : 'Intent import failed.', 1);
  }
}
