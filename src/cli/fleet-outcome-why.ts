/**
 * `ashlr fleet outcome-why [<id>] [--json]` — one read-only answer for a
 * failed outcome: status, failed/aborted tasks with run ids and repos, the
 * manager's latest stage state, and each failed run's stream-log path when
 * the file exists on disk. With no id it explains every failed outcome.
 * Exit 1 only when the named outcome does not exist; a degraded or missing
 * ledger still exits 0 with a clear line. All reads go through
 * explainOutcome (core/fleet/outcome-why.ts); this file only parses argv
 * and renders.
 */
import { explainOutcome, type ExplainOutcomeDeps, type OutcomeWhy, type OutcomeWhyResult } from '../core/fleet/outcome-why.js';

const usage = 'Usage: ashlr fleet outcome-why [<id>] [--json]';

function printWhy(why: OutcomeWhy): void {
  console.log(`outcome ${why.id}: ${why.status}`);
  console.log(why.headline);
  console.log(`manager latest: ${why.manager.latestState ?? 'none'}`);
  if (why.failedTasks.length > 0) {
    console.log('failed tasks:');
    for (const task of why.failedTasks) {
      console.log(`  ${task.key} (${task.state}) repo=${task.repo ?? '-'} run=${task.runId ?? '-'}`);
      if (task.logPath !== null) console.log(`    log: ${task.logPath}`);
    }
  }
  console.log(`next: ${why.nextStep}`);
}

export async function cmdFleetOutcomeWhy(args: string[], deps: ExplainOutcomeDeps = {}): Promise<number> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    console.log(usage);
    return 0;
  }
  let id: string | undefined;
  let json = false;
  for (const arg of args) {
    if (arg === '--json' && !json) json = true;
    else if (id === undefined && !arg.startsWith('-')) id = arg;
    else { console.error(usage); return 2; }
  }
  const result: OutcomeWhyResult = await explainOutcome(id, deps);
  if (json) {
    console.log(JSON.stringify(result));
    return 'error' in result && result.error === 'not-found' ? 1 : 0;
  }
  if ('error' in result) {
    if (result.error === 'not-found') {
      console.error(`outcome ${result.id} not found`);
      return 1;
    }
    console.log('outcome records are unavailable: the outcome ledger could not be read');
    return 0;
  }
  if ('outcomes' in result) {
    if (result.outcomes.length === 0) {
      console.log('no failed outcomes');
      return 0;
    }
    result.outcomes.forEach((why, index) => {
      if (index > 0) console.log('');
      printWhy(why);
    });
    return 0;
  }
  printWhy(result);
  return 0;
}
