import { AgentCheckpointError, readAgentCheckpoint, saveAgentCheckpoint } from '../core/agent-checkpoint.js';

const USAGE = 'Usage: phm checkpoint resume <file> [--json] | save <source> <destination> <worktree> [--json]';

export async function cmdCheckpoint(args: string[]): Promise<number> {
  if (args.length === 1 && ['help', '--help', '-h'].includes(args[0]!)) { console.log(USAGE); return 0; }
  if (args.includes('--help') || args.includes('-h')) { console.log(USAGE); return 0; }
  const json = args.includes('--json');
  const rest = args.filter(arg => arg !== '--json');
  if (args.length !== rest.length + Number(json) || !((rest.length === 2 && rest[0] === 'resume') || (rest.length === 4 && rest[0] === 'save')) || rest.slice(1).some(arg => arg.startsWith('-'))) {
    process.stderr.write(`${USAGE}\n`); return 2;
  }
  try {
    const checkpoint = rest[0] === 'save'
      ? await saveAgentCheckpoint(rest[1]!, rest[2]!, rest[3]!)
      : await readAgentCheckpoint(rest[1]!);
    // JSON is also the human-readable format: it preserves every string and its boundaries.
    console.log(JSON.stringify(checkpoint, null, 2));
    return 0;
  } catch (error) {
    const message = error instanceof AgentCheckpointError ? error.message : 'Checkpoint operation failed.';
    process.stderr.write(`${message}\n`); return 2;
  }
}
