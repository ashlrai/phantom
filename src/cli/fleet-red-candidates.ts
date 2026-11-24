import { RED_BUCKETS, readRedCandidates, type RedBucket } from '../core/fleet/redfix-candidates.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

/** Read-only: choose a rebuild PR inside one path bucket. */
export async function cmdFleetRedCandidates(args: string[], read = readRedCandidates): Promise<number> {
  const usage = `Usage: phm fleet red-candidates --bucket <${Object.keys(RED_BUCKETS).join('|')}> [--json]`;
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(usage); return 0; }
  let bucket: string | undefined, json = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json' && !json) json = true;
    else if (args[i] === '--bucket' && bucket === undefined) bucket = args[++i]?.toUpperCase();
    else { console.error(usage); return 2; }
  }
  if (!bucket || !Object.hasOwn(RED_BUCKETS, bucket)) { console.error(usage); return 2; }
  const report = await read(bucket as RedBucket);
  if (json) console.log(JSON.stringify(sanitizePublicJson({ schema: 'fleet.red-candidates.v1', bucket, ...report })));
  else if (report.state === 'unknown') console.error('red candidates: scan unavailable');
  else if (!report.candidates.length) console.log('No eligible red PRs.');
  else for (const c of report.candidates) console.log(sanitizePublicJson(`#${c.number} ${c.title}: ${c.failingCheck}`));
  return report.state === 'known' ? 0 : 1;
}
