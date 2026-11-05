/**
 * `ashlr fleet cos-work` — one bounded chief-of-staff worker pass
 * (RQ-PHX-COSWORKONCE11). Claims the oldest READY cos-* intake job, runs one
 * headless model turn on the declared planner slate, and records the reply as
 * a draft that needs Mason's approval. Sends nothing. Callers that want a
 * loop invoke this verb once per tick; the pass itself is never recurring.
 */
import { runCosWorkOnce, type CosWorkResult } from '../core/cos/worker.js';

const usage = `Usage: ashlr fleet cos-work [--json]
One bounded chief-of-staff pass: claim the oldest READY cos-* intake job, run
one headless model turn on the declared planner slate, and record the reply
as a draft awaiting Mason's approval in NEEDS-MASON.md. Sends nothing.
Exit 0 for idle, paused or drafted; 1 for blocked; 2 for usage errors.`;

const line = (result: CosWorkResult): string =>
  result.outcome === 'drafted' ? `drafted ${result.id} via ${result.provider}`
    : result.outcome === 'blocked' ? `blocked ${result.id}: ${result.reason}`
      : result.outcome;

export async function cmdFleetCosWork(args: string[]): Promise<number> {
  const json = args.includes('--json');
  for (const arg of args) {
    if (arg === '--json') continue;
    if (arg === '--help' || arg === '-h') { console.log(json ? JSON.stringify({ usage }) : usage); return 0; }
    console.error(`Invalid arguments. ${usage.split('\n')[0]}`);
    return 2;
  }
  try {
    const result = await runCosWorkOnce();
    console.log(json ? JSON.stringify(result) : line(result));
    return result.outcome === 'blocked' ? 1 : 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'cos-work failed';
    if (json) console.log(JSON.stringify({ error: message }));
    else console.error(message);
    return 1;
  }
}
