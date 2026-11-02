import { isAbsolute, resolve } from 'node:path';
import { readGuardianDrainCheckpoint } from '../core/fleet/guardian-drain-checkpoint.js';
import type { GuardianDrainDeps } from '../core/fleet/guardian-retry-drain.js';
import type { GuardianRepeatDeps } from '../core/fleet/guardian-repeat.js';
import { cmdFleetGuardianDrain } from './fleet-guardian-drain.js';
import { cmdFleetGuardianLoop } from './fleet-guardian-loop.js';

// `fleet guardian-resume` — restart continuity for guardian-drain. After a
// guardian process restarts, the supervisor never transcribes the last
// verified state path by hand: every verified attempt already records the
// fixed private guardian-drain-latest.json checkpoint inside its output
// session, and --checkpoint-dir names exactly one such existing session (no
// directory scan, no guessed latest). A valid checkpoint is delegated to
// `fleet guardian-drain` with checkpoint.latestOutput as --source-state and
// --new-session, so --apply allocates a fresh private child under
// --output-dir; the checkpoint session and the state it names are read-only
// inputs and are never overwritten. --source-state and --new-session are
// rejected here because the checkpoint supplies both. Exit codes mirror
// guardian-drain: 2 argument errors, 3 missing/unsafe checkpoint (no
// verifier launched, no session allocated), otherwise the delegated code
// (0 done/stopped, 4 deadline, 5 refused). Error output is fixed text;
// raw checkpoint or filesystem exceptions are never printed.
export async function cmdFleetGuardianResume(
  args: string[],
  deps: GuardianDrainDeps & GuardianRepeatDeps & { writeLine?: (line: string) => void | Promise<void> } = {},
): Promise<number> {
  const values: Record<string, string> = {};
  let json = false, stream = false, apply = false;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    if (flag === '--json' && !json) { json = true; continue; }
    if (flag === '--stream' && !stream) { stream = true; continue; }
    if (flag === '--apply' && !apply) { apply = true; continue; }
    if (!['--checkpoint-dir', '--manifest', '--output-dir', '--max-retries', '--timeout-ms', '--stop-file', '--duration-ms', '--interval-ms', '--idle-backoff-max-ms'].includes(flag)
      || values[flag] !== undefined || !args[i + 1] || args[i + 1]!.startsWith('--')) {
      process.stderr.write('error: invalid guardian-resume arguments\n'); return 2;
    }
    values[flag] = args[++i]!;
  }
  if (json && stream) { process.stderr.write('error: --json and --stream are mutually exclusive\n'); return 2; }
  const duration = values['--duration-ms'], interval = values['--interval-ms'];
  const validRepeat = (v: string | undefined, min: number): boolean =>
    v !== undefined && /^[1-9]\d*$/.test(v) && Number(v) >= min && Number(v) <= 86_400_000;
  if ((duration !== undefined || interval !== undefined) && (!validRepeat(duration, 1) || !validRepeat(interval, 1000))) {
    process.stderr.write('error: guardian-resume requires --duration-ms 1..86400000 and --interval-ms 1000..86400000 together\n'); return 2;
  }
  const backoff = values['--idle-backoff-max-ms'];
  if (backoff !== undefined && (duration === undefined || interval === undefined
    || !validRepeat(backoff, Number(interval)) || !Number.isSafeInteger(Number(backoff)))) {
    process.stderr.write('error: guardian-resume requires --idle-backoff-max-ms between interval-ms and 86400000 in repeat mode\n'); return 2;
  }
  const checkpointDir = values['--checkpoint-dir'];
  if (checkpointDir === undefined || !isAbsolute(checkpointDir) || checkpointDir.length > 4096
    || checkpointDir.includes('\0') || resolve(checkpointDir) !== checkpointDir) {
    process.stderr.write('error: guardian-resume requires an absolute --checkpoint-dir naming one existing private session\n');
    return 2;
  }
  let latestOutput: string;
  try {
    const checkpoint = readGuardianDrainCheckpoint(checkpointDir);
    if (checkpoint === null) throw new Error('checkpoint absent');
    latestOutput = checkpoint.latestOutput;
  } catch {
    process.stderr.write('error: guardian-resume found no valid private checkpoint in --checkpoint-dir\n');
    return 3;
  }
  // The drain command re-validates every forwarded flag; the checkpoint is
  // the only validated input added by this wrapper.
  const forwarded = ['--source-state', latestOutput];
  if (duration === undefined) forwarded.push('--new-session');
  else forwarded.push('--duration-ms', duration, '--interval-ms', interval!);
  if (backoff !== undefined) forwarded.push('--idle-backoff-max-ms', backoff);
  for (const flag of ['--manifest', '--output-dir', '--max-retries', '--timeout-ms', '--stop-file'] as const) {
    const value = values[flag];
    if (value !== undefined) forwarded.push(flag, value);
  }
  if (apply) forwarded.push('--apply');
  if (json) forwarded.push('--json');
  if (stream) forwarded.push('--stream');
  return duration === undefined ? cmdFleetGuardianDrain(forwarded, deps) : cmdFleetGuardianLoop(forwarded, deps);
}
