import { readJson } from '../core/resources/grokbot/ledger.js';
import { importRoutines, readRoutines, rebalanceSavedRoutines } from '../core/automations/routines.js';

export async function runRoutinesCli(args: string[], out = console.log, err = console.error): Promise<number> {
  const [verb, file, ...extra] = args;
  if (verb === '--help' || verb === 'help' || !verb) {
    out('Usage: phantom routines export | import <file.json> | rebalance'); return 0;
  }
  if (extra.length || (verb === 'import' ? !file : file !== undefined) || !['export', 'import', 'rebalance'].includes(verb)) {
    err('Usage: phantom routines export | import <file.json> | rebalance'); return 2;
  }
  try {
    const routines = verb === 'import' ? await importRoutines(await readJson(file!, 16_384))
      : verb === 'rebalance' ? await rebalanceSavedRoutines() : await readRoutines();
    out(JSON.stringify({ schema: 'phantom-routines.v1', routines }, null, 2)); return 0;
  } catch {
    err('Routine operation refused: check document, fresh provider evidence, and conflicting IDs. Existing data was preserved.'); return 1;
  }
}
