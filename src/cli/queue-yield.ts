import { readGeneratorYield } from '../core/queue/generator-yield.js';

export async function cmdQueueYield(args: string[]): Promise<number> {
  let hours = 24; let json = false; let seenSince = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json' && !json) json = true;
    else if (args[i] === '--since' && !seenSince) {
      seenSince = true;
      const match = /^(\d+(?:\.\d+)?)(h|d)$/.exec(args[++i] ?? '');
      if (!match) { console.error('Use --since with hours or days, such as 24h.'); return 2; }
      hours = Number(match[1]) * (match[2] === 'd' ? 24 : 1);
    } else { console.error('Usage: phm queue yield [--since 24h] [--json]'); return 2; }
  }
  if (!Number.isFinite(hours) || hours <= 0) { console.error('Since must be positive.'); return 2; }
  const report = await readGeneratorYield(undefined, hours);
  if (json) console.log(JSON.stringify(report));
  else if (!report.known) console.log('Generator yield: unknown (job metrics unavailable).');
  else {
    console.log('Generator\tJobs\tPRs\tMerged\tEmpty rate\tMedian diff lines\tTokens per merged PR');
    for (const r of report.generators) console.log(`${r.generator}\t${r.jobs}\t${r.prs}\t${r.merged}\t${r.emptyRate === null ? 'unknown' : `${(r.emptyRate * 100).toFixed(1)}%`}\t${r.medianDiffLines ?? 'unknown'}\t${r.tokensPerMergedPr ?? 'unknown'}`);
    console.log(`Malformed lines skipped: ${report.malformedLines}`);
  }
  return 0;
}
