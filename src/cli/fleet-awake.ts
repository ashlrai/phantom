import { resolve } from 'node:path';
import { defaultRunsDir } from '../core/fleet/landed-closes-read.js';
import { awakeStatus, setAwake } from '../core/fleet/keep-awake.js';

const usage = `Usage: phm fleet awake on|off|status [--json] [--runs-dir <dir>]
Keep the Mac from idle-sleeping while jobs are running or queued and it is on power (off by default).
'on' makes the self-tick hold a standard macOS idle-sleep assertion (caffeinate -i, tied to that tick's pid) and
let go when the queue is empty. It never changes a system power setting. 'off' removes the switch file
(<runs-dir>/queue/keep-awake.on); deleting that one file by hand is the kill switch. JSON schema fleet.awake.v1.
Only a self-tick run with --apply holds the assertion. Exit 0, or 2 on a bad option.`;

export async function cmdFleetAwake(args: string[], deps: { out?: (line: string) => void; err?: (line: string) => void; runsDir?: string } = {}): Promise<number> {
  const out = deps.out ?? console.log, err = deps.err ?? console.error;
  if (args.includes('--help') || args.includes('-h')) { out(usage); return 0; }
  let json = false, action: string | undefined, runsArg: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!, next = args[i + 1];
    if (arg === '--json') json = true;
    else if (arg === '--runs-dir' && runsArg === undefined && next && !next.startsWith('-')) { runsArg = next; i++; }
    else if (action === undefined && ['on', 'off', 'status'].includes(arg)) action = arg;
    else { err(`phm fleet awake: unknown or incomplete option ${arg}\n${usage}`); return 2; }
  }
  if (action === undefined) { err(usage); return 2; }
  const runsDir = runsArg ? resolve(runsArg) : deps.runsDir ?? defaultRunsDir();
  if (action !== 'status') setAwake(runsDir, action === 'on');
  const status = awakeStatus(runsDir);
  out(json ? JSON.stringify(status) : status.line);
  return 0;
}
