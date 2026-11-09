import { createReadStream } from 'node:fs';
import { addBudgetReadings, readPoolBudgets } from '../core/fleet/pool-budget-store.js';
import { BUDGET_POOLS, parseBudgetOutput, validateBudgetReading, type BudgetPool } from '../core/fleet/pool-budget.js';

const HELP = `Usage:
  phm budget show [--json]
  phm budget add <pool> --bucket weeklyPct|credits|acus|capacity --remaining N [--reset-at UTC] [--at UTC] [--json]
  phm budget add <pool> --source cli|log --input <file|-> [--at UTC] [--json]
Manual observations override automatic observations until their reset. No reset means a persistent override.
Automatic input is parsed locally; raw output is never stored. '-' reads standard input.
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
