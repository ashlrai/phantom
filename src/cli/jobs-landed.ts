/** `phm jobs landed`: thin handler. The logic lives in core/fleet/landed-on-master.ts. */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { landedLine, landedOnMaster, readPublishedJobs } from '../core/fleet/landed-on-master.js';

const usage = 'Usage: phm jobs landed [--since 24h] [--runs-dir <dir>] [--json]';
const help = `${usage}
Did each job published in the window reach master? Answered from git alone (git fetch origin master, then the commit subjects), so it works where gh cannot run. Run it inside a checkout of the repo.
A failed fetch says "can't tell", never "not on master". --json prints jobs.landed.v1. Exit 0 report, 1 git unreadable, 2 bad usage. Reads only.`;

export async function cmdJobsLanded(args: string[], now = Date.now()): Promise<number> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) { console.log(help); return 0; }
  let values;
  try { ({ values } = parseArgs({ args, options: { since: { type: 'string' }, 'runs-dir': { type: 'string' }, json: { type: 'boolean' } }, allowPositionals: false })); }
  catch { console.error(usage); return 2; }
  let hours = 24;
  if (values.since !== undefined) {
    const m = /^(\d+(?:\.\d+)?)([hd])$/.exec(values.since);
    hours = m ? Number(m[1]) * (m[2] === 'd' ? 24 : 1) : NaN;
    if (!(hours > 0 && hours <= 8760)) { console.error(`${usage}\n--since takes a number and h or d, like 24h.`); return 2; }
  }
  const sinceMs = now - hours * 3_600_000;
  const jobs = await readPublishedJobs(values['runs-dir'] ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs'), sinceMs);
  // Search a little before the window so a job published at its edge still finds its commit.
  const results = landedOnMaster(jobs.map(j => j.id), { since: new Date(sinceMs).toISOString() });
  const at = new Map(jobs.map(j => [j.id, j.publishedAtMs]));
  if (values.json) console.log(JSON.stringify({ schema: 'jobs.landed.v1', since_hours: hours, count: results.length, jobs: results }));
  else if (!results.length) console.log('No published jobs in that window.');
  else for (const r of results) console.log(landedLine(r, at.get(r.id), now));
  return results.some(r => r.state === 'unknown') ? 1 : 0;
}
