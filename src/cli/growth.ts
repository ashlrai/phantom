/**
 * `phm growth` prints growth.series.v1, the same series the Growth charts draw.
 * Read-only. A series with no ledger is `no-data-source`, never a made-up line.
 */
import { isAbsolute } from 'node:path';
import { readGrowthReport } from '../core/growth/read.js';
import { isGrowthRange, type GrowthRange, type GrowthReport } from '../core/growth/series.js';

const USAGE = `phm growth [--json] [--range 1H|1D|1W|1M] [--prs <file>]

Time series for the Growth charts. Range defaults to 1D.
Missing sources stay "no data source". See docs/GROWTH.md.`;

function flag(args: string[], name: string): string | null {
  const index = args.indexOf(name);
  if (index < 0) return null;
  const value = args[index + 1];
  return value && !value.startsWith('-') ? value : null;
}

function printHuman(report: GrowthReport): void {
  const ready = report.series.filter((series) => series.status === 'ready').length;
  console.log(`Growth ${report.range}. ${ready} series ready, ${report.series.length - ready} with no data source.`);
  for (const series of report.series) {
    console.log(`${series.label}: ${series.status === 'ready' ? (series.source ?? 'ready') : 'no data source'}`);
  }
  console.log(`${report.blindSpots.length} world-model blind spots.`);
}

export async function cmdGrowth(args: string[]): Promise<number> {
  const json = args.includes('--json');
  if (args.includes('--help') || args.includes('-h')) {
    console.log(json ? JSON.stringify({ usage: USAGE }) : USAGE);
    return 0;
  }
  const rest = args.filter((arg) => arg !== '--json');
  const allowed = new Set(['--range', '--prs']);
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]!;
    if (!arg.startsWith('-')) {
      console.error(USAGE);
      return 2;
    }
    const value = rest[index + 1];
    if (!allowed.has(arg) || !value || value.startsWith('-')) {
      console.error(USAGE);
      return 2;
    }
    index += 1;
  }
  const rangeText = flag(rest, '--range') ?? '1D';
  if (!isGrowthRange(rangeText)) {
    console.error(USAGE);
    return 2;
  }
  const range: GrowthRange = rangeText;
  const pullsFile = flag(rest, '--prs');
  if (pullsFile && !isAbsolute(pullsFile)) {
    console.error('Pull export path must be absolute');
    return 2;
  }
  const report = await readGrowthReport({ range, pullsFile });
  if (!report) {
    console.error('Pull export could not be read');
    return 1;
  }
  if (json) console.log(JSON.stringify(report, null, 2));
  else printHuman(report);
  return 0;
}
