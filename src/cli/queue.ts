/** Foreground queue control: explicit snapshot in, private control overlay out. */
import { resolve } from 'node:path';
import { controlQueue } from '../core/queue/controller.js';
import { writeQueueDecision } from '../core/queue/store.js';
import { readPrivateFileCapped } from '../core/verse/preferences.js';

const MAX_INPUT_BYTES = 1024 * 1024;
const HELP = [
  'Usage: phm queue control --input FILE --out DIR [--dry-run] [--json]',
  '  --input FILE   Explicit queue snapshot JSON (at most 1 MiB).',
  '  --out DIR      Private local decision store; required unless --dry-run.',
  '  --dry-run      Compute the control overlay without writing files.',
  '  --json         Emit {decision,persistence}; persistence is null for dry runs.',
  'This command writes local controller, bandit and LP inputs. It does not launch',
  'workers, change production limits, skip required tests, or merge anything.',
].join('\n');

interface Options { input: string; out?: string; dryRun: boolean; json: boolean }

function parseOptions(args: string[]): Options | null {
  if (args[0] !== 'control') return null;
  const options: Options = { input: '', dryRun: false, json: false };
  const seen = new Set<string>();
  for (let i = 1; i < args.length; i++) {
    const flag = args[i]!;
    if (seen.has(flag)) return null;
    seen.add(flag);
    if (flag === '--dry-run') options.dryRun = true;
    else if (flag === '--json') options.json = true;
    else if (flag === '--input' || flag === '--out') {
      const value = args[++i];
      if (!value || value.startsWith('-')) return null;
      if (flag === '--input') options.input = resolve(value);
      else options.out = resolve(value);
    } else return null;
  }
  return options.input && (options.dryRun || options.out) ? options : null;
}

export async function cmdQueue(args: string[]): Promise<number> {
  if ((args.length === 1 && ['help', '--help', '-h'].includes(args[0]!)) ||
    (args.length === 2 && args[0] === 'control' && ['help', '--help', '-h'].includes(args[1]!))) {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  const options = parseOptions(args);
  if (!options) {
    process.stderr.write(`Invalid queue arguments.\n${HELP}\n`);
    return 2;
  }
  const input = readPrivateFileCapped(options.input, MAX_INPUT_BYTES);
  if (!input || input.truncated || input.bytes !== Buffer.byteLength(input.text, 'utf8')) {
    process.stderr.write('Queue input must be a readable regular JSON file of at most 1 MiB.\n');
    return 1;
  }
  let decision: ReturnType<typeof controlQueue>;
  try {
    decision = controlQueue(JSON.parse(input.text) as unknown);
  } catch {
    // Parser errors may contain the caller's raw file contents; do not echo them.
    process.stderr.write('Invalid queue snapshot. See docs/QUEUE-CONTROL.md for the input contract.\n');
    return 1;
  }
  try {
    const persistence = options.dryRun ? null : await writeQueueDecision(options.out!, decision);
    if (options.json) process.stdout.write(`${JSON.stringify({ decision, persistence })}\n`);
    else {
      const bottleneck = decision.bottleneck;
      process.stdout.write([
        bottleneck ? `Bottleneck: ${bottleneck.stage} (${bottleneck.reason}).` : 'Bottleneck: none.',
        `Planner: ${decision.planner.mode}; rate ${decision.planner.rate}. ${decision.planner.reason}`,
        `Control actions: ${decision.actions.length}.`,
        ...decision.actions.map((action) => `  ${action.stage}: ${action.control} ${String(action.from)} -> ${String(action.to)} (${action.reason}).`),
        persistence ? `Decision ${persistence.replayed ? 'already recorded' : 'recorded'}: ${persistence.path}` : 'Dry run: no files written.',
      ].join('\n') + '\n');
    }
    return 0;
  } catch {
    process.stderr.write('Queue decision could not be persisted. No production changes were attempted.\n');
    return 1;
  }
}
