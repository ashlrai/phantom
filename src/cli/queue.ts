import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { queueReportFromText } from '../core/queue-metrics.js';
import { importMarkdown } from '../core/queue/markdown.js';
import { QueueStore } from '../core/queue/store.js';
import { validateQueue, type QueueDocument } from '../core/queue/schema.js';

const HELP = `Usage: phm queue <command> [--dir <queue-directory>] [--json]
  add <id> --priority P0 --pool <pool> --tier <tier> --repo <repo>
      --scope <text> --acceptance <text> [--deps <id,id>]
  claim <id> --owner <worker>
  done <id> --owner <worker> [--pr-url <https-url>]
  block <id> --owner <worker> --reason <text>
  list
  import <router-queue.md|queue.json>   Bootstrap an empty queue
  export [--md]                       JSON to stdout; --md writes queue.mirror.md
  report --events <file> [--json]     Per-station lambda, mu, rho, W and bottleneck
With --pr-url, done records PR-OPEN; done without it records DONE.
Claims require READY and all dependencies DONE. No fleet cutover is performed.`;

const REPORT_USAGE = `Usage: phm queue report --events <file> [--json]
Read local JSON/JSONL station visits: {station, arrivedAt, startedAt?, completedAt?}.
Timestamps must be ISO with timezone. JSON may also be {start,end,events:[...]}.
Default window: earliest arrival to latest event. Each row is one station visit.
lambda = arrivals/window; mu = 1/mean completed service time; rho = lambda/mu.
W = mean completed arrival-to-completion time. Rates: jobs/hour; W: hours.
Single-server stations; bottleneck = highest known rho (alphabetical ties).
Unknown metrics print n/a; incomplete visits count toward arrivals only.`;

const WORK_QUEUE_COMMANDS = new Set(['add', 'claim', 'done', 'block', 'list', 'import', 'export']);

async function queueReport(args: string[]): Promise<number> {
  let file: string | undefined;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json' && !json) json = true;
    else if (arg === '--events' && file === undefined && args[i + 1] && !args[i + 1]!.startsWith('--')) file = args[++i];
    else { console.error(REPORT_USAGE); return 2; }
  }
  if (!file) { console.error(REPORT_USAGE); return 2; }
  try {
    const report = queueReportFromText(await readFile(file, 'utf8'));
    if (json) console.log(JSON.stringify(report, null, 2));
    else {
      console.log('Station\tlambda (/h)\tmu (/h)\trho\tW (h)');
      const fmt = (value: number | null) => value === null ? 'n/a' : value.toFixed(4);
      for (const s of report.stations) console.log(`${s.station}\t${fmt(s.lambda)}\t${fmt(s.mu)}\t${fmt(s.rho)}\t${fmt(s.W)}`);
      console.log(`Bottleneck: ${report.bottleneck ?? 'n/a'}`);
    }
    return 0;
  } catch (err) {
    console.error(`queue report: ${err instanceof Error ? err.message : 'Unable to read events'}`);
    return 1;
  }
}

export async function cmdQueue(args: string[]): Promise<number> {
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) { console.log(HELP); return 0; }
  if (args[0] === 'report') return queueReport(args.slice(1));
  if (!WORK_QUEUE_COMMANDS.has(args[0])) { console.error(HELP); return 2; }
  let json = args.includes('--json');
  try {
    const { values: parsedValues, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: {
      json: { type: 'boolean' }, md: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
      ...Object.fromEntries(['dir', 'priority', 'pool', 'tier', 'repo', 'scope', 'acceptance', 'deps', 'owner', 'pr-url', 'reason'].map(key => [key, { type: 'string' as const }])),
    } });
    const values: Record<string, string | boolean | undefined> = parsedValues;
    json = values.json === true;
    if (values.help || !positionals.length) { console.log(HELP); return 0; }
    const [command, operand] = positionals;
    const allowed: Record<string, string[]> = {
      add: ['priority', 'pool', 'tier', 'repo', 'scope', 'acceptance', 'deps'], claim: ['owner'],
      done: ['owner', 'pr-url'], block: ['owner', 'reason'], list: [], import: [], export: ['md'],
    };
    if (!Object.hasOwn(allowed, command)) throw new Error(`Unknown queue command: ${command}`);
    if (positionals.length !== (['list', 'export'].includes(command) ? 1 : 2)) throw new Error('Unexpected or missing operand');
    for (const key of Object.keys(values)) if (!['dir', 'json', ...allowed[command]].includes(key)) throw new Error(`Unsupported option for ${command}: --${key}`);
    const required = (key: string): string => {
      const value = values[key];
      if (typeof value !== 'string' || !value.trim()) throw new Error(`Required: --${key}`);
      return value;
    };
    const store = new QueueStore(typeof values.dir === 'string' ? values.dir : undefined);
    let result: unknown;
    switch (command) {
      case 'add': result = await store.add({ id: operand, status: 'READY', priority: required('priority'), pool: required('pool'), tier: required('tier'), repo: required('repo'), scope: required('scope'), acceptance: required('acceptance'), deps: typeof values.deps === 'string' ? values.deps.split(',') : [], claims: [] }); break;
      case 'claim': result = await store.claim(operand, required('owner')); break;
      case 'done': result = await store.finish(operand, required('owner'), { prUrl: typeof values['pr-url'] === 'string' ? values['pr-url'] : undefined }); break;
      case 'block': result = await store.finish(operand, required('owner'), { reason: required('reason') }); break;
      case 'import': {
        const text = await readFile(operand, 'utf8');
        const doc: QueueDocument = operand.endsWith('.json') ? JSON.parse(text) : importMarkdown(text);
        validateQueue(doc);
        result = await store.import(doc); break;
      }
      case 'export': result = values.md ? { path: await store.mirror() } : await store.read(); break;
      case 'list': result = await store.read(); break;
    }
    console.log(JSON.stringify(result, null, json ? undefined : 2));
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Queue operation failed';
    if (json) console.log(JSON.stringify({ error: message })); else console.error(message);
    return 1;
  }
}
