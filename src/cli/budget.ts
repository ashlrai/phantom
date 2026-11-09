import { createReadStream } from 'node:fs';
import { addBudgetReadings, readPoolBudgets } from '../core/fleet/pool-budget-store.js';
import { BUDGET_POOLS, parseBudgetOutput, validateBudgetReading, type BudgetPool } from '../core/fleet/pool-budget.js';
import { SPEND_BUDGET_PERIODS, type SpendBudgetPeriod } from '../core/spend/budget-policy.js';
import { readSpendBudget, setSpendBudget, SpendBudgetOwnerError } from '../core/spend/budget-store.js';

const HELP = `Usage:
  phm budget show [--json]
  phm budget add <pool> --bucket weeklyPct|credits|acus|capacity --remaining N [--reset-at UTC] [--at UTC] [--json]
  phm budget add <pool> --source cli|log --input <file|-> [--at UTC] [--json]
  phm budget get --json
  phm budget set --provider <id> --period day|week|month --usd <n> --json
Manual observations override automatic observations until their reset. No reset means a persistent override.
Automatic input is parsed locally; raw output is never stored. '-' reads standard input.
Spend budget get/set is the owner USD cap. The default is 0. Set requires an interactive terminal. A budget above 0 counts only with a pin-chain or Mason approval attestation. Agents cannot set it.
`;
async function readInput(path: string): Promise<string> {
  const stream = path === '-' ? process.stdin : createReadStream(path);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.from(chunk as Uint8Array);
    size += bytes.length;
    if (size > 1_048_576) throw new Error('Budget input too large');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString('utf8');
}
export async function cmdBudget(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) { console.log(HELP); return 0; }
  if (args[0] === 'get' || args[0] === 'set') return cmdSpendBudget(args);
  const json = args.includes('--json');
  try {
    const positional: string[] = [];
    const options = new Map<string, string>();
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!;
      if (arg === '--json') continue;
      if (!arg.startsWith('-')) { positional.push(arg); continue; }
      if (!['--bucket', '--remaining', '--reset-at', '--at', '--source', '--input'].includes(arg) || options.has(arg)) throw new Error('Invalid budget option');
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error('Missing budget option value');
      options.set(arg, value);
    }
    const [command = 'show', pool] = positional;
    if (command === 'show') {
      if (positional.length > 1 || options.size) throw new Error('show accepts only --json');
    } else if (command === 'add') {
      if (positional.length !== 2 || !BUDGET_POOLS.includes(pool as BudgetPool)) throw new Error('add requires a supported pool');
      const source = options.get('--source') ?? 'manual';
      const timestamp = options.get('--at') ?? new Date().toISOString();
      if (Date.parse(timestamp) > Date.now()) throw new Error('Future observations are not allowed');
      if (source === 'manual') {
        if (options.has('--input') || !options.has('--remaining') || !/^\d+(?:\.\d+)?$/.test(options.get('--remaining')!)) throw new Error('Manual add requires a numeric remaining amount');
        await addBudgetReadings([validateBudgetReading({ pool, bucket: options.get('--bucket'), remaining: Number(options.get('--remaining')), resetAt: options.get('--reset-at') ?? null, timestamp, source })]);
      } else if (source === 'cli' || source === 'log') {
        if (!options.has('--input') || ['--bucket', '--remaining', '--reset-at'].some(k => options.has(k))) throw new Error('Automatic add requires only --input and optional --at');
        const input = options.get('--input')!;
        const output = await readInput(input);
        await addBudgetReadings(parseBudgetOutput(pool as BudgetPool, source, output, timestamp));
      } else throw new Error('Invalid budget source');
    } else throw new Error('Expected budget add or show');
    const budgets = await readPoolBudgets();
    if (json) console.log(JSON.stringify({ budgets }));
    else {
      console.log(`Pool budgets (${budgets.sourceState})`);
      for (const [name, view] of Object.entries(budgets.pools)) {
        console.log(`${name} [${view.mode}] ${Object.entries(view.buckets).map(([bucket, v]) => `${bucket}=${v.remaining ?? 'unknown'} (${v.source ?? 'unknown'}, ${v.timestamp ?? 'unobserved'})`).join(' ')}`);
      }
    }
    return budgets.sourceState === 'healthy' ? 0 : 1;
  } catch {
    // Do not echo input, filesystem paths, raw provider errors or credentials.
    console.error(json ? JSON.stringify({ error: 'budget operation failed; check arguments and ledger access' }) : 'Budget operation failed. Run phm budget --help for usage.');
    return 2;
  }
}

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  return args[index + 1];
}

async function cmdSpendBudget(args: string[]): Promise<number> {
  const json = args.includes('--json');
  const command = args[0];
  const fail = (message: string): number => {
    console.error(json ? JSON.stringify({ error: message }) : message);
    return 2;
  };
  if (command === 'get') {
    if (args.some((arg) => arg !== 'get' && arg !== '--json')) return fail('phm budget get accepts only --json');
    const read = await readSpendBudget();
    const body = { schema: read.policy.schema, source: read.source, entries: read.policy.entries };
    if (json) console.log(JSON.stringify(body));
    else console.log(`${read.source}: ${read.policy.entries.map((entry) => `${entry.provider} ${entry.period} $${entry.usd}`).join(', ') || 'no entries'}`);
    return 0;
  }
  if (command !== 'set') return fail('Expected budget get or set');
  const provider = flag(args, '--provider');
  const period = flag(args, '--period');
  const usdText = flag(args, '--usd');
  if (!provider || !period || usdText === undefined || !SPEND_BUDGET_PERIODS.includes(period as SpendBudgetPeriod)) {
    return fail('phm budget set requires --provider, --period day|week|month, and --usd');
  }
  if (!/^\d+(?:\.\d+)?$/.test(usdText)) return fail('usd must be a non-negative number');
  try {
    const policy = await setSpendBudget(
      { provider, period: period as SpendBudgetPeriod, usd: Number(usdText) },
      { env: process.env },
    );
    if (json) console.log(JSON.stringify({ schema: policy.schema, source: 'owner', entries: policy.entries }));
    else console.log(`Set ${provider} ${period} to $${usdText}`);
    return 0;
  } catch (error) {
    if (error instanceof SpendBudgetOwnerError) return fail(error.message);
    return fail('Spend budget was not changed');
  }
}
