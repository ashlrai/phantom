import { readResourceLedger, type ResourceLedgerV1 } from '../core/fleet/runs-resource-ledger.js';

const value = (input: string | number | boolean | null): string => input === null ? 'unknown' : String(input);

function printLedger(ledger: ResourceLedgerV1): void {
  console.log(`Resource ledger (generated: ${ledger.generatedAt}; observed: ${value(ledger.asOf)})`);
  console.log(`Sources: status ${ledger.sources.status}; API spend ${ledger.sources.apiSpend}`);
  if (ledger.lanes.length === 0) console.log('Lanes: none reported');
  for (const lane of ledger.lanes) {
    console.log(`\n${lane.lane}: running/target ${value(lane.running)}/${value(lane.target)}; held ${value(lane.held)}; window ${lane.window}`);
    if (lane.window === 'weekly') {
      console.log(`  Weekly usage: ${lane.usedPct === null ? 'unknown' : `${lane.usedPct}%`}`);
    } else if (lane.window === 'credits') {
      console.log(`  Credits remaining: ${value(lane.creditsRemaining)}`);
    } else {
      console.log('  Usage: unmetered / no reported window');
    }
    console.log(`  Reset: ${value(lane.resetAt)}; source: ${value(lane.source)}`);
    console.log(`  Burn: ${lane.burnPctPerHour === null ? 'unknown' : `${lane.burnPctPerHour}%/hour`}; tokens/hour (6h): ${value(lane.tokensPerHour6h)}; projected exhaustion: ${value(lane.projectedExhaustion)}`);
  }
  const spend = ledger.apiSpend;
  if (spend === null) {
    console.log('\nAPI spend: unknown');
  } else {
    console.log(`\nAPI spend: today ${value(spend.usdToday)} USD; week ${value(spend.usdWeek)} USD; rows ${spend.rowsToday}; errors ${spend.errorsToday}`);
    console.log(`  Tokens in/out today: ${spend.tokensInToday}/${spend.tokensOutToday}; last observed: ${value(spend.lastAt)}; models: ${spend.models.length ? spend.models.join(', ') : 'none reported'}`);
  }
}

export async function cmdResourceLedger(
  args: string[],
  read: () => Promise<ResourceLedgerV1> = readResourceLedger,
): Promise<number> {
  let json = false;
  let help = false;
  for (const arg of args) {
    if (arg === '--json' && !json) json = true;
    else if ((arg === '--help' || arg === '-h') && !help) help = true;
    else {
      process.stderr.write('Invalid ledger arguments; use phm resources ledger --help.\n');
      return 2;
    }
  }
  if (help) {
    console.log('Usage: phm resources ledger [--json] [--help|-h]');
    console.log('Read the live resource ledger, including source health and observation time.');
    return 0;
  }
  try {
    const ledger = await read();
    if (json) console.log(JSON.stringify(ledger, null, 2));
    else printLedger(ledger);
    return 0;
  } catch {
    process.stderr.write('Unable to read resource ledger.\n');
    return 1;
  }
}
