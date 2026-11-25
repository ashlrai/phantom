/** `phm node measure`: print the self-measured `phm node beat --capacity` sample. Thin: core maps the measurement. */
import { readNodeCapacity, type NodeCapacity } from '../core/drive/nodes/capacity.js';
import { nodeBeatCapacity } from '../core/drive/nodes/capacity-sample.js';

export const NODE_MEASURE_USAGE = `Usage: phm node measure [--json]

Measures this node's capacity (RAM headroom, disk floor, host slot registry) and prints
the JSON object to pass as --capacity to 'phm node beat', for example:
  phm node beat --node <id> --session <n> --capacity "$(phm node measure)" --json

Default output is the bare sample, so command substitution pastes it directly; --json
wraps it in the standard {schemaVersion,command} envelope. Every number is measured on
this machine; nothing is invented, nothing leaves it. A node whose measured hold the
sample schema cannot express (cpu-*, host-slots-*) exits 1: omit --capacity on that
beat, as the pool worker does, so the node reads unknown rather than wrongly ready.`;

export interface NodeMeasureDeps {
  measure?: () => NodeCapacity;
  host?: () => string;
  now?: () => number;
}

export async function cmdNodeMeasure(args: string[], deps: NodeMeasureDeps = {}): Promise<number> {
  const json = args.includes('--json');
  const fail = (message: string, fix: string, code: string, exit: number): number => {
    if (json) console.log(JSON.stringify({ schemaVersion: 1, command: 'measure', error: { code, message, fix } }));
    else console.error(`${message} Fix: ${fix}`);
    return exit;
  };
  const extra = args.filter(a => a !== '--json');
  if (extra.length) return fail(`Unknown argument${extra.length === 1 ? '' : 's'} ${extra.join(' ')}.\n${NODE_MEASURE_USAGE}`,
    'Run: phm node measure --help', 'usage', 2);
  let capacity: NodeCapacity;
  try { capacity = (deps.measure ?? (() => readNodeCapacity()))(); }
  catch { return fail('Node capacity measurement failed.', 'Check that this node can read its own memory, disk and process tables, then retry.', 'error', 1); }
  const report = nodeBeatCapacity(capacity, { ...(deps.host ? { host: deps.host } : {}), ...(deps.now ? { now: deps.now } : {}) });
  if (!report.sample) {
    return fail(`This node cannot report a capacity sample (held: ${report.held}).`,
      'Omit --capacity on the beat and pass --slots 0 if the node should hold admission; the sample schema cannot express this hold.', 'held', 1);
  }
  console.log(json ? JSON.stringify({ schemaVersion: 1, command: 'measure', capacity: report.sample }) : JSON.stringify(report.sample));
  return 0;
}
