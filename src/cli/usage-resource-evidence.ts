import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { collectResourceEvidence } from '../core/usage/resource-live/evidence-collector.js';

const USAGE = 'Usage: phm usage resource-evidence --targets <abs> [--watch] [--runs-dir <abs>]';

export async function cmdUsageResourceEvidence(args: string[]): Promise<number> {
  let targets: string | undefined;
  const envRuns = process.env['ASHLR_RUNS_DIR'];
  let runsDir = envRuns && isAbsolute(envRuns) ? envRuns : join(homedir(), '.ashlr-runs');
  let watch = false;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--help' || arg === '-h') { console.log(USAGE); return 0; }
    if (seen.has(arg)) { console.error(USAGE); return 2; }
    seen.add(arg);
    if (arg === '--watch') { watch = true; continue; }
    const value = args[++i];
    if (!value || !isAbsolute(value)) { console.error(USAGE); return 2; }
    if (arg === '--targets') targets = value;
    else if (arg === '--runs-dir') runsDir = value;
    else { console.error(USAGE); return 2; }
  }
  if (!targets || /(?:^|[/\\])\.codex[^/\\]*(?:[/\\]|$)/.test(runsDir)) { console.error(USAGE); return 2; }
  try {
    do {
      const { checked, nextAt } = await collectResourceEvidence({ configPath: targets, runsDir });
      if (checked.length || !watch) console.log(JSON.stringify({ checked, next_at: nextAt === null ? null : new Date(nextAt).toISOString() }));
      if (!watch || nextAt === null) return 0;
      await setTimeout(Math.max(1000, Math.min(nextAt - Date.now(), 60_000)));
    } while (watch);
    return 0;
  } catch {
    console.error('Resource evidence collection failed. Check the targets file and private runs directory.');
    return 1;
  }
}
