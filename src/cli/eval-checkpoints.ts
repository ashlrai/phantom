import { dirname, resolve } from 'node:path';
import { compareCheckpointReplay, MAX_CHECKPOINT_REPLAY_BYTES } from '../core/local-eval/checkpoint-comparison.js';
import { readStableRegularFile } from '../core/util/stable-file-read.js';

interface Dependencies {
  env?: NodeJS.ProcessEnv;
  read?: (path: string) => unknown;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

/** Offline only: no model, tool execution, or repository mutation. */
export function cmdEvalCheckpoints(args: string[], deps: Dependencies = {}): number {
  const stdout = deps.stdout ?? (text => process.stdout.write(text));
  const stderr = deps.stderr ?? (text => process.stderr.write(text));
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    stdout('Usage: PHANTOM_CHECKPOINTS=1 phm eval checkpoints --file <fixture.json> [--json]\nOffline replay; token counts are conservative estimates, outcomes are context assertions.\n');
    return 0;
  }
  if ((deps.env ?? process.env)['PHANTOM_CHECKPOINTS'] !== '1') {
    stderr('error: PHANTOM_CHECKPOINTS=1 is required\n');
    return 2;
  }
  if (args[0] !== '--file' || !args[1] || args[1].startsWith('--') || args.length > 3 ||
    args.length === 3 && args[2] !== '--json') {
    stderr('error: use eval checkpoints --file <fixture.json> [--json]\n');
    return 2;
  }
  try {
    const path = resolve(args[1]);
    const read = deps.read ?? ((file: string): unknown => {
      const result = readStableRegularFile(file, { anchorPath: dirname(file),
        maxFileBytes: MAX_CHECKPOINT_REPLAY_BYTES, remainingBytes: MAX_CHECKPOINT_REPLAY_BYTES });
      if (!result.ok) throw new Error('Unreadable fixture');
      return JSON.parse(result.text) as unknown;
    });
    const report = compareCheckpointReplay(read(path), deps.env ?? process.env);
    stdout(JSON.stringify(report, null, 2) + '\n');
    return 0;
  } catch {
    stderr('error: unable to compare checkpoint fixture; check file safety, size, schema and strategy boundaries\n');
    return 2;
  }
}
