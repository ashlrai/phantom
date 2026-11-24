import { readRedfixCandidates } from '../core/fleet/redfix-candidates.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

export async function cmdJobsRedfixCandidates(args: string[], read = readRedfixCandidates): Promise<number> {
  const usage = 'Usage: phm jobs redfix-candidates [--json]';
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(usage); return 0; }
  if (args.length > 1 || (args.length === 1 && args[0] !== '--json')) { console.error(usage); return 2; }
  try {
    const candidates = await read();
    if (args[0] === '--json') console.log(JSON.stringify(sanitizePublicJson({ schema: 'jobs.redfix-candidates.v1', candidates })));
    else if (!candidates.length) console.log('redfix: 0 eligible red PRs, no cycle emitted');
    else for (const c of candidates) console.log(sanitizePublicJson(`#${c.pr} ${c.bucket ?? '-'} ${c.failingCheck ?? '-'}: ${c.kept ? 'kept' : 'skipped'} (${c.reason})`));
    return 0;
  } catch { console.error('redfix: candidate scan unavailable; no cycle planned'); return 1; }
}
