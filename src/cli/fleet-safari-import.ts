import { appendNeedsMasonLine } from '../core/fleet/needs-mason-append.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  applySafariImport, markSafariImportDone, planSafariImport, readSafariImportState, SafariImportStateError,
} from '../core/fleet/safari-import-ask.js';
import {
  runSafariImportHelper, SAFARI_IMPORT_HELPER_USAGE, type SafariImportHelperDeps,
} from '../core/fleet/safari-import-helper.js';

const usage = `Usage: ashlr fleet safari-import [--json] [--apply | --done] [--runs-dir <dir>]
       ${SAFARI_IMPORT_HELPER_USAGE}
Without a mode, plans or records the NEEDS-MASON ask to import Chrome data into Safari.
status and begin-import drive scripts/mac-bridge/safari_import.py (python3 -I, never a
shell) to check or open Safari's File > Import From > Google Chrome dialog. --root names
the runs root under which supervisor/NEEDS-MASON.md receives any block line (default
~/.ashlr-runs); the helper is killed --timeout + 15s after launch. With --json the
helper's JSON prints unchanged and its exit code propagates: 2 means blocked on a human
step, a normal result. Safari, Keychain and the import itself stay with the operator.`;

/** Flags whose next argument is a value, not a mode word. */
const VALUE_FLAGS = new Set(['--runs-dir', '--root', '--timeout']);

/** True when argv names a bare word (a mode), so the helper path owns parsing and validation. */
function hasModeWord(args: readonly string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    if (VALUE_FLAGS.has(args[i]!)) i++;
    else if (!args[i]!.startsWith('-')) return true;
  }
  return false;
}

export { appendNeedsMasonLine } from '../core/fleet/needs-mason-append.js';

export async function cmdFleetSafariImport(
  args: string[], opts: { runsDir?: string; now?: () => Date } & SafariImportHelperDeps = {},
): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) { console.log(usage); return 0; }
  if (hasModeWord(args)) return runSafariImportHelper(args, { exec: opts.exec, locateScript: opts.locateScript });
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
