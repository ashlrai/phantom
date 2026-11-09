import { resolve } from 'node:path';
import { AgentCheckpointError, readAgentCheckpoint, saveAgentCheckpoint } from '../core/agent-checkpoint.js';
import { appendRunEvent, isRunEventJobId, RunEventLogError } from '../core/events/run-event-log.js';

const USAGE = 'Usage: phm checkpoint resume <file> [--json] | save <source> <destination> <worktree> [--job <id>] [--runs-dir <dir>] [--json]';

export async function cmdCheckpoint(args: string[]): Promise<number> {
  if (args.length === 1 && ['help', '--help', '-h'].includes(args[0]!)) { console.log(USAGE); return 0; }
  const optionValues = new Map<string, string>();
  const rest: string[] = [];
  let jsonCount = 0;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json') { jsonCount++; continue; }
    if ((arg === '--job' || arg === '--runs-dir') && args[i + 1] && !args[i + 1]!.startsWith('-')) {
      optionValues.set(arg, args[++i]!);
      continue;
    }
    rest.push(arg);
  }
  if (jsonCount > 1 || !((rest.length === 2 && rest[0] === 'resume') || (rest.length === 4 && rest[0] === 'save')) || rest.slice(1).some(arg => arg.startsWith('-'))) {
    process.stderr.write(`${USAGE}\n`); return 2;
  }
  const job = optionValues.get('--job');
  if (rest[0] === 'resume' && (job !== undefined || optionValues.has('--runs-dir'))) {
    process.stderr.write(`--job/--runs-dir apply to save only.\n${USAGE}\n`); return 2;
  }
  if (job !== undefined && !isRunEventJobId(job)) { process.stderr.write(`Invalid --job id.\n`); return 2; }
  try {
    const checkpoint = rest[0] === 'save'
      ? await saveAgentCheckpoint(rest[1]!, rest[2]!, rest[3]!)
      : await readAgentCheckpoint(rest[1]!);
    // JSON is also the human-readable format: it preserves every string and its boundaries.
    console.log(JSON.stringify(checkpoint, null, 2));
    if (rest[0] === 'save' && job) {
      // Record the handoff on the job's event-sourced trail; replay surfaces it
      // as the resume point. The checkpoint itself was already saved — a
      // failed append is reported, not fatal.
      try {
        await appendRunEvent(job, 'checkpoint', { ref: resolve(rest[2]!), source: 'agent-checkpoint' },
          { runsDir: optionValues.get('--runs-dir') });
      } catch (error) {
        const detail = error instanceof RunEventLogError ? error.message : 'event append failed';
        process.stderr.write(`checkpoint saved; run event not recorded: ${detail}\n`);
      }
    }
    return 0;
  } catch (error) {
    const message = error instanceof AgentCheckpointError ? error.message : 'Checkpoint operation failed.';
    process.stderr.write(`${message}\n`); return 2;
  }
}
