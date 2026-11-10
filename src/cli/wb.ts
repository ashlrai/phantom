import { parseArgs } from 'node:util';
import { readWorkbenchSecrets } from '../core/workbench/secrets.js';
import { runSteerAction, SteerRefusedError, type SteerRequest } from '../core/workbench/steer.js';

const HELP = `Usage: phm wb secrets [--json]
       phm wb steer --text <note> [--apply] [--json]
       phm wb reprioritize <job-id> --priority P0|P1|P2|P3 [--apply] [--json]
       phm wb stop <job-id> [--apply] [--json]

Desktop workbench verbs — the same actions POST /api/wb/v1/action runs.
Every verb is a dry run unless --apply is passed.

  secrets             Read Phantom Secrets custody metadata (names only).
  steer               Append a steer note to the leaders' inbox.
  reprioritize        Re-priority one unclaimed queue line (READY or HOLD).
  stop                SIGTERM then SIGKILL every process carrying the job id.`;

async function cmdSecrets(args: string[]): Promise<number> {
  const reading = await readWorkbenchSecrets();
  if (args.includes('--json')) console.log(JSON.stringify(reading));
  else {
    console.log('Phantom Secrets custody');
    console.log(reading.state === 'unknown' ? 'Custody metadata unavailable.' : `${reading.secrets.length} secrets`);
    for (const row of reading.secrets) console.log(`${row.name}\t${row.scope ?? 'unknown'}\t${row.ageMs === null ? 'unknown' : `${Math.floor(row.ageMs / 86_400_000)} days`}\t${row.lastRotated ?? 'unknown'}`);
  }
  return reading.state === 'ok' ? 0 : 1;
}

function report(result: Awaited<ReturnType<typeof runSteerAction>>, dryRun: boolean, json: boolean): void {
  if (json) { console.log(JSON.stringify({ v: 1, dryRun, ...result })); return; }
  const verb = dryRun ? 'would' : 'did';
  switch (result.action) {
    case 'steer.note': console.log(`steer.note: ${verb} append ${result.bytes} bytes to the leaders' inbox`); break;
    case 'queue.reprioritize': console.log(`queue.reprioritize: ${verb} move ${result.job} ${result.from} → ${result.to}`); break;
    case 'job.stop': console.log(`job.stop: ${result.outcome === 'not-running' ? 'no live processes carry' : `${verb} signal ${result.pids.length} process(es) for`} ${result.job}`); break;
  }
}

/** One steer verb from argv. Returns the request, or a help/usage exit. */
function parseSteer(verb: string, args: string[]): { request?: SteerRequest; json: boolean; apply: boolean } | number {
  let parsed;
  try {
    parsed = parseArgs({
      args, strict: true, allowPositionals: true,
      options: {
        text: { type: 'string' }, priority: { type: 'string' },
        apply: { type: 'boolean' }, json: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch { console.error(HELP); return 2; }
  const { values, positionals } = parsed;
  if (values.help) { console.log(HELP); return 0; }
  const out = { json: values.json === true, apply: values.apply === true };
  if (verb === 'steer') {
    if (positionals.length !== 0 || typeof values.text !== 'string') { console.error(HELP); return 2; }
    return { request: { action: 'steer.note', text: values.text }, ...out };
  }
  if (values.text !== undefined || positionals.length !== 1) { console.error(HELP); return 2; }
  if (verb === 'reprioritize') {
    if (typeof values.priority !== 'string') { console.error(HELP); return 2; }
    return { request: { action: 'queue.reprioritize', job: positionals[0]!, priority: values.priority }, ...out };
  }
  if (values.priority !== undefined) { console.error(HELP); return 2; }
  return { request: { action: 'job.stop', job: positionals[0]! }, ...out };
}

export async function cmdWb(args: string[]): Promise<number> {
  const verb = args[0];
  if (verb === undefined || verb === '--help' || verb === '-h') { console.log(HELP); return 0; }
  if (verb === 'secrets') {
    if (args.slice(1).some(arg => arg !== '--json')) { console.error(HELP); return 2; }
    return cmdSecrets(args.slice(1));
  }
  if (verb !== 'steer' && verb !== 'reprioritize' && verb !== 'stop') { console.error(HELP); return 2; }

  const parsed = parseSteer(verb, args.slice(1));
  if (typeof parsed === 'number') return parsed;
  const dryRun = !parsed.apply;
  try {
    const result = await runSteerAction(parsed.request!, { dryRun });
    report(result, dryRun, parsed.json);
    return 0;
  } catch (error) {
    // SteerRefusedError = bad input (HTTP's 400); anything else = operational (503).
    const message = error instanceof SteerRefusedError ? `invalid ${verb}` : (error instanceof Error ? error.message : `${verb} unavailable`);
    if (parsed.json) console.log(JSON.stringify({ v: 1, dryRun, error: message }));
    else console.error(message);
    return error instanceof SteerRefusedError ? 2 : 1;
  }
}
