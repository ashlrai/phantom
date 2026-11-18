/** `phm decide`: thin handler. Parses argv and prints the result of core/decide `decide({question, options, context})`. */
import { resolve } from 'node:path';
import type { DecideInput, DecideResult } from '../core/decide/options.js';

const usage = `Usage: phm decide --question <text> --options <a,b,c> [--context <file>] [--json]
Ask one question with a fixed list of answers. Prints one of the options, or "unknown" when the model
cannot tell, replies twice without picking a listed option, or no model answers. It never guesses.
  --question <text>   what to decide
  --options <a,b,c>   the allowed answers, separated by commas
  --context <file>    a text file the answer should be based on (up to 256 KiB)
  --json              print {version, choice, confidence, reason, model, latency_ms}
The router picks its cheapest verified model; no model is named here. Each decision is logged as one
line in the metrics event log, without the question or context. Exit 0: an option was chosen. Exit 1: unknown. Exit 2: bad usage.`;

class UsageError extends Error {}

export interface DecideCliDeps {
  decide?: (input: DecideInput) => Promise<DecideResult>;
  readContext?: (path: string) => Promise<string>;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

export async function cmdDecide(args: string[], deps: DecideCliDeps = {}): Promise<number> {
  const out = deps.out ?? console.log;
  const err = deps.err ?? console.error;
  if (args.includes('--help') || args.includes('-h')) { out(usage); return 0; }
  const values = new Map<string, string>();
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json' && !json) { json = true; continue; }
    const value = args[i + 1];
    if (!['--question', '--options', '--context'].includes(arg) || values.has(arg) || value === undefined) {
      err(`phm decide: unknown, repeated or incomplete option ${arg}\n${usage}`);
      return 2;
    }
    values.set(arg, args[++i]!);
  }
  try {
    let context: string | undefined;
    const file = values.get('--context');
    if (file !== undefined) {
      const read = deps.readContext ?? (async (path: string) => (await import('../core/fleet/model-verify.js')).readText(path, 256 * 1024));
      context = await read(resolve(file)).catch(() => { throw new UsageError('The context file could not be read. Give a text file of up to 256 KiB.'); });
    }
    const { decide, DecideInputError } = await import('../core/decide/index.js');
    const input: DecideInput = {
      question: values.get('--question') ?? '', options: (values.get('--options') ?? '').split(',').map(option => option.trim()).filter(Boolean),
      ...(context !== undefined ? { context } : {}), use: 'cli',
    };
    const run: NonNullable<DecideCliDeps['decide']> = deps.decide ?? (value => decide(value));
    let result: DecideResult;
    try { result = await run(input); }
    catch (error) { if (error instanceof DecideInputError) throw new UsageError(error.message); throw error; }
    out(json ? JSON.stringify(result) : [
      `Choice: ${result.choice}`,
      ...(result.choice === 'unknown' ? [] : [`Confidence: ${Math.round(result.confidence * 100)}%`]),
      `Why: ${result.reason}`,
      `Model: ${result.model}, ${result.latency_ms} ms`,
    ].join('\n'));
    return result.choice === 'unknown' ? 1 : 0;
  } catch (error) {
    if (!(error instanceof UsageError)) { err('phm decide: the decision could not be made.'); return 1; }
    err(`phm decide: ${error.message}`);
    return 2;
  }
}
