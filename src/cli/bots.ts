import { applySeatHandoff, applySeatHandoffs, filterSeatHandoffsPlan, listSeats, planSeatHandoff, planSeatHandoffs, sendSeatMessage, type SeatHandoffsFilter, type SeatState } from '../core/bots/seats.js';
import { explainPhantomBot, listPhantomBots, planPhantomBot, readPhantomBot } from '../core/agents/phantom-bot.js';

const VALUE_FLAGS = ['--seat', '--id', '--outcome', '--profile', '--needs', '--min-tier', '--max-tier', '--max-cost-class', '--from', '--to', '--text'];
// `handoffs` alone takes the read-filter flags; other verbs keep refusing
// them as invalid options instead of silently ignoring a filter they cannot
// apply. wantsHelp still needs the union so `-h` after --state/--contains
// reads as a value, not help.
const HANDOFFS_VALUE_FLAGS = [...VALUE_FLAGS, '--state', '--contains'];
const HANDOFFS_FLAGS = ['--json', '--dry-run', '--apply', '--eligible', '--ineligible', '--pending'];
const VALUE_FLAG_SET = new Set([...VALUE_FLAGS, '--state', '--contains']);
const SEAT_STATES: readonly SeatState['state'][] = ['active', 'draining', 'idle'];
const CONTAINS_MAX = 512;

// A -h token is help only when it is not the value of a preceding option
// (e.g. `bots message --text -h` sends the text "-h"). --help can never be
// an option value, so it counts anywhere.
function wantsHelp(args: string[]): boolean {
  return args.includes('--help')
    || args.some((a, i) => a === '-h' && !(i > 0 && VALUE_FLAG_SET.has(args[i - 1]!)));
}

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

/** Parse the `handoffs` read-filter flags into the shared
 * `SeatHandoffsFilter`; validation lives here so the core filter stays a
 * pure projection. An invalid value or the contradictory
 * `--eligible`/`--ineligible` pair throws before any store read. */
function seatHandoffsFilter(opts: Record<string, string>): SeatHandoffsFilter {
  const filter: SeatHandoffsFilter = {};
  if (opts['--seat'] !== undefined) filter.seat = opts['--seat'];
  if (opts['--state'] !== undefined) {
    if (!SEAT_STATES.includes(opts['--state'] as SeatState['state'])) throw new Error('Invalid --state: expected active, draining or idle.');
    filter.state = opts['--state'] as SeatState['state'];
  }
  if (opts['--eligible'] !== undefined && opts['--ineligible'] !== undefined) throw new Error('Choose --eligible or --ineligible, not both.');
  if (opts['--eligible'] !== undefined) filter.eligible = true;
  else if (opts['--ineligible'] !== undefined) filter.eligible = false;
  if (opts['--pending'] !== undefined) filter.pending = true;
  if (opts['--contains'] !== undefined) {
    const raw = opts['--contains'];
    if (raw.trim() === '' || raw.length > CONTAINS_MAX) throw new Error(`Invalid --contains: expected a non-empty search text of at most ${CONTAINS_MAX} characters.`);
    filter.contains = raw;
  }
  return filter;
}

export async function runBotsCli(argv: string[], out = console.log, home?: string): Promise<number> {
  try {
    const [verb, ...args] = argv;
    if (!verb || ['help', '--help', '-h'].includes(verb) || wantsHelp(args)) {
      out('phm bots list|seats|handoffs [--seat <id>] [--state <active|draining|idle>] [--eligible|--ineligible] [--pending] [--contains <text>] [--apply]|handoff --seat <id> [--apply]|show <id>|explain <id>|create --dry-run --id <id> --outcome <text> --profile <id>|message --from <seat> --to <seat|owner> --text <text> [--json]'); return 0;
    }
    const name = ['show', 'explain'].includes(verb) ? args.shift()! : '';
    const fleet = verb === 'handoffs';
    const opts = options(args, fleet ? HANDOFFS_FLAGS : ['--json', '--dry-run', '--apply'], fleet ? HANDOFFS_VALUE_FLAGS : VALUE_FLAGS);
    let result: unknown;
    if (verb === 'seats') result = await listSeats({ home });
    else if (verb === 'handoffs') {
      const filter = seatHandoffsFilter(opts);
      if (opts['--apply']) {
        if (Object.keys(filter).length > 0) throw new Error('handoffs filters narrow the dry-run read only; --apply drains every eligible seat — use handoff --seat <id> --apply for one seat.');
        result = await applySeatHandoffs({ home });
      } else {
        result = filterSeatHandoffsPlan(await planSeatHandoffs({ home }), filter);
      }
    }
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
