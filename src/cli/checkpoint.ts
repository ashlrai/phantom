import { AgentCheckpointError, readAgentCheckpoint } from '../core/agent-checkpoint.js';

const USAGE = 'Usage: phm checkpoint resume <file> [--json]';

export async function cmdCheckpoint(args: string[]): Promise<number> {
  if (args.some(arg => ['help', '--help', '-h'].includes(arg))) { console.log(USAGE); return 0; }
  const json = args.includes('--json');
  const rest = args.filter(arg => arg !== '--json');
  if (rest.length !== 2 || rest[0] !== 'resume' || rest[1]!.startsWith('-') || args.length !== rest.length + Number(json)) {
    process.stderr.write(`${USAGE}\n`); return 2;
  }
  try {
    const checkpoint = await readAgentCheckpoint(rest[1]!);
    // JSON is also the human-readable format: it preserves every string and its boundaries.
    console.log(JSON.stringify(checkpoint, null, 2));
    return 0;
  } catch (error) {
    const message = error instanceof AgentCheckpointError ? error.message : 'Checkpoint operation failed.';
    process.stderr.write(`${message}\n`); return 2;
  }
}
