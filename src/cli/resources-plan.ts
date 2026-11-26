import { isAbsolute } from 'node:path';
import { defaultResourceLiveRunsDir } from '../core/usage/resource-live/feed.js';
import { readFleetResourcePlan, writeFleetResourceAdvice } from '../core/usage/resource-live/fleet-plan.js';

const usage = 'Usage: phm resources plan [--json] [--write-advice] [--runs-dir <absolute-path>]';

export async function cmdResourcesPlan(args: string[]): Promise<number> {
  let runsDir = defaultResourceLiveRunsDir(), json = false, advice = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') { console.log(usage); return 0; }
    if (arg === '--json') json = true;
    else if (arg === '--write-advice') advice = true;
    else if (arg === '--runs-dir' && isAbsolute(args[i + 1] ?? '') && !/(?:^|[/\\])\.codex[^/\\]*(?:[/\\]|$)/.test(args[i + 1]!)) runsDir = args[++i]!;
    else { console.error(usage); return 2; }
  }
  const plan = await readFleetResourcePlan(runsDir);
  if (advice) {
    try { writeFleetResourceAdvice(runsDir, plan); }
    catch { console.error('resources plan: could not publish dispatcher advice'); return 1; }
  }
  if (json) console.log(JSON.stringify(plan));
  else {
    for (const lane of plan.lanes) console.log(`${lane.lane}: target=${lane.target_concurrency ?? 'unknown'} (advisory)`);
    for (const row of plan.allowances) console.log(`${row.id}: projected waste=${row.projected_waste_at_deadline ?? 'unknown'} ${row.unit ?? ''}`.trimEnd());
    const bank = plan.codex_reset_bank;
    if (bank) console.log(`Codex reset bank: unknown (${bank.unknown_reason})${bank.hint ? `. ${bank.hint}` : ''}`);
  }
  return 0;
}
