import { closeSync, constants, fstatSync, mkdirSync, openSync, readSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  applySafariImport, markSafariImportDone, planSafariImport, readSafariImportState, SafariImportStateError,
} from '../core/fleet/safari-import-ask.js';

const usage = 'Usage: ashlr fleet safari-import [--json] [--apply | --done] [--runs-dir <dir>]';

/** Appends one open `- [ ]` item to NEEDS-MASON.md, the same file the glance and resolve paths read. */
function appendNeedsMasonLine(runsDir: string, text: string): void {
  mkdirSync(runsDir, { recursive: true });
  const fd = openSync(join(runsDir, 'NEEDS-MASON.md'), constants.O_RDWR | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
  try {
    const size = fstatSync(fd).size;
    let lead = '';
    if (size > 0) {
      const last = Buffer.alloc(1);
      readSync(fd, last, 0, 1, size - 1);
      if (last[0] !== 0x0a) lead = '\n';
    }
    writeSync(fd, `${lead}- [ ] ${text}\n`);
  } finally { closeSync(fd); }
}

export async function cmdFleetSafariImport(args: string[], opts: { runsDir?: string; now?: () => Date } = {}): Promise<number> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) { console.log(usage); return 0; }
  let json = false, apply = false, done = false;
  let runsDirArg: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json' && !json) json = true;
    else if (arg === '--apply' && !apply) apply = true;
    else if (arg === '--done' && !done) done = true;
    else if (arg === '--runs-dir' && runsDirArg === undefined && args[i + 1] && !args[i + 1]!.startsWith('-')) runsDirArg = args[++i];
    else { console.error(usage); return 2; }
  }
  if (apply && done) { console.error(usage); return 2; }
  const runsDir = runsDirArg ?? opts.runsDir ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
  const now = opts.now ?? (() => new Date());
  const print = (plan: string, extra: Record<string, unknown> = {}): void =>
    console.log(json ? JSON.stringify({ plan, ...extra }) : `safari-import: ${plan}${extra.asked ? ' (NEEDS-MASON line added)' : ''}`);
  try {
    if (done) { markSafariImportDone({ runsDir, now }); print('done'); return 0; }
    if (apply) {
      const before = readSafariImportState(runsDir);
      const plan = applySafariImport({ runsDir, now, appendNeedsLine: line => appendNeedsMasonLine(runsDir, line) });
      print(plan === 'ask' ? 'waiting' : plan, { asked: plan === 'ask', previous: planSafariImport(before) });
      return 0;
    }
    print(planSafariImport(readSafariImportState(runsDir)));
    return 0;
  } catch (error) {
    console.error(error instanceof SafariImportStateError ? error.message : 'Unable to update Safari import state.');
    return 1;
  }
}
