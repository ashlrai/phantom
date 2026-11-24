/** `phm self-update --check [--json]` | `--plan`: thin handler. Logic lives in core/fleet/self-update-check.ts. Read-only. */
import { SELF_UPDATE_PLAN, readSelfUpdateCheck, type SelfUpdateCheck } from '../core/fleet/self-update-check.js';

const usage = 'Usage: phm self-update --check [--json] | --plan [--json]';
const help = `${usage}
--check  Is the phm running on this host current? Prints the running commit and build time, how many commits it is behind origin/master (local ref, no network), the last rebuild result, then one verdict: "current", "behind N commits" or "last build failed: <line>".
--plan   Prints the blue/green steps (build into a new directory, smoke check, swap a symlink, keep the old one for rollback). Runs nothing and never touches the live checkout.
Exit 0 report, 2 bad usage. Never fetches, pulls, builds or writes.`;

export async function cmdSelfUpdate(args: string[], read: () => SelfUpdateCheck = () => readSelfUpdateCheck()): Promise<number> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) { console.log(help); return 0; }
  const json = args.includes('--json');
  const modes = args.filter(a => a !== '--json');
  if (modes.length !== 1 || (modes[0] !== '--check' && modes[0] !== '--plan')) { console.error(usage); return 2; }
  if (modes[0] === '--plan') {
    if (json) console.log(JSON.stringify({ schema: 'self-update.plan.v1', steps: SELF_UPDATE_PLAN }));
    else SELF_UPDATE_PLAN.forEach((s, i) => console.log(`${i + 1}. ${s}`));
    return 0;
  }
  const check = read();
  if (json) console.log(JSON.stringify(check));
  else {
    console.log(`running: ${check.running.sha?.slice(0, 7) ?? 'unknown'}${check.running.builtAt ? ` built ${check.running.builtAt}` : ''}`);
    console.log(`behind master: ${check.behind ?? 'unknown'}`);
    console.log(`last build: ${check.lastBuild.result}${check.lastBuild.result === 'unknown' ? '' : ` (${check.lastBuild.line})`}`);
    console.log(check.verdict);
  }
  return 0;
}
