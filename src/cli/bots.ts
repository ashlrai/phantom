import { applySeatHandoff, applySeatHandoffs, listSeats, planSeatHandoff, planSeatHandoffs, sendSeatMessage } from '../core/bots/seats.js';
import { explainPhantomBot, listPhantomBots, planPhantomBot, readPhantomBot } from '../core/agents/phantom-bot.js';

function options(args: string[], flags: string[], values: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  while (args.length) {
    const key = args.shift()!;
    if (flags.includes(key)) result[key] = 'true';
    else if (values.includes(key) && args[0] && !args[0].startsWith('--')) result[key] = args.shift()!;
    else throw new Error(`Invalid option: ${key}`);
  }
  return result;
}
export async function runBotsCli(argv: string[], out = console.log, home?: string): Promise<number> {
  try {
    const [verb, ...args] = argv;
    if (!verb || ['help', '--help', '-h'].includes(verb) || args.includes('--help') || args.includes('-h')) {
      out('phm bots list|seats|handoffs [--apply]|handoff --seat <id> [--apply]|show <id>|explain <id>|create --dry-run --id <id> --outcome <text> --profile <id>|message --from <seat> --to <seat|owner> --text <text> [--json]'); return 0;
    }
    const name = ['show', 'explain'].includes(verb) ? args.shift()! : '';
    const opts = options(args, ['--json', '--dry-run', '--apply'], ['--seat', '--id', '--outcome', '--profile', '--needs', '--min-tier', '--max-tier', '--max-cost-class', '--from', '--to', '--text']);
    let result: unknown;
    if (verb === 'seats') result = await listSeats({ home });
    else if (verb === 'handoffs') result = await (opts['--apply'] ? applySeatHandoffs : planSeatHandoffs)({ home });
    else if (verb === 'handoff') {
      if (!opts['--seat']) throw new Error('Missing --seat.');
      result = await (opts['--apply'] ? applySeatHandoff : planSeatHandoff)(opts['--seat'], { home });
    } else if (verb === 'create') {
      if (!opts['--dry-run']) throw new Error('Live bot creation disabled; use --dry-run. Triggers are not live.');
      result = await planPhantomBot({ schema: 'phantom-bot.v1', id: opts['--id'], outcome: opts['--outcome'], profile: opts['--profile'], repos: [], triggers: [],
        lanePolicy: { needs: opts['--needs']?.split(',') ?? [], min_tier: opts['--min-tier'] ?? 'fast', max_tier: opts['--max-tier'] ?? 'frontier', max_cost_class: opts['--max-cost-class'] ?? 'included' },
        memory: { pointer: `~/.phantom/bots/${opts['--id']}/memory` }, channels: [], needsYou: [] }, home);
    } else if (verb === 'list') result = await listPhantomBots(home);
    else if (verb === 'message') {
      if (!opts['--from'] || !opts['--to'] || !opts['--text']) throw new Error('Missing --from, --to or --text.');
      result = await sendSeatMessage({ from: opts['--from'], to: opts['--to'], text: opts['--text'] }, { home });
    } else if (verb === 'show' || verb === 'explain') {
      const bot = await readPhantomBot(name, home); result = verb === 'show' ? bot : await explainPhantomBot(bot);
    } else throw new Error('Unknown bots verb.');
    out(JSON.stringify(result, null, 2)); return 0;
  } catch (error) { out(JSON.stringify({ ok: false, error: (error as Error).message })); return 1; }
}
