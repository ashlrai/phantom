import { intentSummary } from '../core/intent/summary.js';

const usage = 'Usage: ashlr fleet intent-summary [--json]';

export async function cmdFleetIntentSummary(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(usage); return 0; }
  if (args.length > 1 || (args.length === 1 && args[0] !== '--json')) { console.error(usage); return 2; }
  const report = await intentSummary();
  if (args[0] === '--json') console.log(JSON.stringify(report));
  else {
    console.log(report.sourceQuality === 'unavailable'
      ? 'Intent ledger evidence is unavailable; counts are unknown.'
      : report.present
      ? `Intents: ${report.items}; tracked: ${report.tracked}; partial: ${report.partial}; stale: ${report.stale}`
      : 'Intent ledger not present.');
    for (const item of report.staleItems) console.log(`  ${item.id} [${item.status}] ${item.title}`);
  }
  return report.sourceQuality === 'unavailable' ? 1 : 0;
}
