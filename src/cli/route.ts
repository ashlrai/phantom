/**
 * `phm route` - per-job expected-value routing for the Ashlr router queue.
 *
 *   phm route job --input <job.json|-> [--metrics <feed.json|->]
 *                 [--plan <plan.json|->] [--budgets <snapshot.json|->]
 *
 * Reads one queue job spec, the measured lane/tier priors (`phm metrics
 * ingest` output or the same keyed shape) and the per-pool budget pressure
 * (`phm budget plan` output, or a `phm budget show` snapshot with
 * --budgets), then prints the chosen pool, tier and serving model as JSON.
 * When neither pressure document is supplied the local budget ledger
 * (~/.ashlr/fleet/budgets) is read the same way `phm budget show` reads it.
 *
 * Advisory: the command never dispatches work, moves a balance, touches a
 * provider or writes state. Output is always JSON; --json is accepted for
 * script compatibility. Exit 0 means a decision was reached (including a
 * hold, which is a decision); exit 2 means invalid arguments or input.
 */
import { createReadStream } from 'node:fs';
import {
  parseRouteJobSpec,
  poolPressureFromPlan,
  poolPressureFromSnapshot,
  RouteInputError,
  routeJobExpectedValue,
  routePriorsFromMetrics,
  type JobRouteDecision,
} from '../core/fleet/job-ev-route.js';
import { readPoolBudgets } from '../core/fleet/pool-budget-store.js';

const HELP = `Usage: phm route job --input <job.json|-> [--metrics <feed.json|->] [--plan <plan.json|->] [--budgets <snapshot.json|->] [--json]

Choose the queue job's pool, tier and serving model by expected merged impact
per token under per-pool budget pressure. Mechanical work routes local,
hard or high-impact work routes frontier only, and over-pace pools are avoided.

--input    One job JSON object: {id, repo?, task?, template?, riskTier?,
           difficulty?, expectedImpact?}. '-' reads standard input.
--metrics  A 'phm metrics ingest' feed (or the same keyed priors) for
           per-template and per-tier merge/empty/token/impact rollups.
--plan     A 'phm budget plan' document ({plan:{...}} or bare plan).
--budgets  A 'phm budget show' snapshot ({budgets:{...}} or bare snapshot),
           used only when --plan is absent. With neither, the local budget
           ledger is read directly.
Output is always JSON. Advisory only: no dispatch, spend or writes.
Exit 0: decision reached (route or hold). Exit 2: invalid arguments or input.`;

const MAX_INPUT_BYTES = 1_048_576;

async function readInput(path: string, stdin: AsyncIterable<string | Buffer>): Promise<string> {
  const stream = path === '-' ? stdin : createReadStream(path);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_INPUT_BYTES) throw new RouteInputError('Input exceeds 1 MiB.');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new RouteInputError(`Invalid JSON in ${what}.`);
  }
}

export interface RouteCliDeps {
  stdin?: AsyncIterable<string | Buffer>;
  readBudgets?: () => Promise<unknown>;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

export async function cmdRoute(args: string[], deps: RouteCliDeps = {}): Promise<number> {
  const out = deps.out ?? ((line: string) => console.log(line));
  const err = deps.err ?? ((line: string) => console.error(line));
  const stdin = deps.stdin ?? process.stdin;
  if (!args.length || args.includes('--help') || args.includes('-h') || args[0] === 'help') {
    out(HELP);
    return 0;
  }
  if (args[0] !== 'job') {
    err(HELP);
    return 2;
  }
  const options = new Map<string, string>();
  let json = false;
  for (let i = 1; i < args.length; i++) {
    const option = args[i]!;
    if (option === '--json' && !json) { json = true; continue; }
    if (!['--input', '--metrics', '--plan', '--budgets'].includes(option) || options.has(option)) {
      err(HELP);
      return 2;
    }
    const value = args[++i];
    if (!value || value.startsWith('--')) {
      err(HELP);
      return 2;
    }
    options.set(option, value);
  }
  const input = options.get('--input');
  if (!input) {
    err(HELP);
    return 2;
  }
  const stdinConsumers = [input, options.get('--metrics'), options.get('--plan'), options.get('--budgets')]
    .filter((v) => v === '-').length;
  if (stdinConsumers > 1) {
    err('phm route: only one input may read standard input.');
    return 2;
  }
  try {
    const spec = parseRouteJobSpec(parseJson(await readInput(input, stdin), 'the job input'));
    const priors = options.has('--metrics')
      ? routePriorsFromMetrics(parseJson(await readInput(options.get('--metrics')!, stdin), 'the metrics feed'))
      : {};
    const pressure = options.has('--plan')
      ? poolPressureFromPlan(parseJson(await readInput(options.get('--plan')!, stdin), 'the budget plan'))
      : options.has('--budgets')
        ? poolPressureFromSnapshot(parseJson(await readInput(options.get('--budgets')!, stdin), 'the budget snapshot'))
        : poolPressureFromSnapshot(await (deps.readBudgets ?? readPoolBudgets)());
    const decision: JobRouteDecision = routeJobExpectedValue(spec, { priors, pressure });
    out(JSON.stringify(decision, null, 2));
    return 0;
  } catch (error) {
    // Input may carry private task text; only controlled diagnostics are printed.
    err(`phm route: ${error instanceof RouteInputError ? error.message : 'input could not be read'}`);
    return 2;
  }
}
