/** `phm asks`: thin handler. Parses argv and prints what core/fleet/asks.ts returns. */
import {
  answerAsk, askAnswerText, asksText, formatAge, listAsks, onlyMasonAsks, raiseAsk, type AskAnswerResult, type AsksList, type RaiseAskResult, type AsksOptions,
} from '../core/fleet/asks.js';
import { asksSyncText, syncAsks } from '../core/fleet/asks-sync.js';
import { readMasonUsage } from '../core/fleet/asks-ledger.js';
import { listAskBatchAll, raiseAskOrRead, type AskOrActionResult } from '../core/fleet/asks-sensor.js';
import { listAskBatch, batchChoicesText, type AskBatch } from '../core/fleet/asks-batch.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const usage = `Usage: phm asks [--all] [--json]
       phm asks list [--all] [--json]
       phm asks answer <id> <reply> [--json]
       phm asks add <kind> "<one-line request>" [--subject <name>] [--unblocks "<what it unblocks>"] [--expires <UTC time>] [--json]
       phm asks usage [<pool>] [--json]
       phm asks sync [--dry-run] [--json]
Each ask has a type: password, two-factor, device-approval, payment or other. Only the first four are shown by default:
they are what software cannot do for the owner. --all also shows type other (an outside message, a usage percent, a yes or no
on a record), each with what the fleet did instead, e.g. "read from sensor <name> at <time>".
  phm asks list         one batch, oldest first, same question merged, with each allowed answer (--json: schema asks.batch.v1)
  phm asks              list open asks, soonest expiry first (unknown expiry last, expired hidden): short id, kind, age,
                        the request, why it matters and each allowed answer (--json: schema asks.v1)
  answer <id> <reply>   record the reply once (yes, no, done or later; a number 0-100 for a usage ask), with source cli and the
                        time, in the answers ledger; a repeat changes nothing; a reply the ask does not accept records nothing
  add <kind> <request>  raise an ask; kinds: password, 2fa, device, payment, outreach, usage (needs --subject <pool>), approval;
                        never put the secret itself in the request; --expires 2026-11-24T00:00:00Z hides it after that time
  usage [<pool>]        The owner's latest stated usage for a pool (default grok-ultra), with its time and age (--json: asks.usage.v1)
  sync [--dry-run]      raise one ask per pool that needs a sign-in or has a credit ending unused, expiring at its reset; a re-run
                        adds nothing and a cleared pool closes its ask; it never signs in or spends (--json: asks.sync.v1)
A usage ask for a pool with a fresh sensor reading is not raised: the fleet uses the reading and records the action.
An approval answer is a record only: nothing is spent and no billing call is made.
Anything that is not one of the kinds is refused: the fleet decides this itself.
From Telegram, the owner can reply "yes <id>", "no <id>" or "done <id>".`;

const flagValue = (args: string[], name: string): { value?: string; rest: string[] } => {
  const at = args.indexOf(name);
  return at < 0 ? { rest: args } : { value: args[at + 1], rest: [...args.slice(0, at), ...args.slice(at + 2)] };
};

export interface AsksCliDeps { options?: AsksOptions; list?: typeof listAsks; answer?: typeof answerAsk; raise?: (...args: Parameters<typeof raiseAsk>) => RaiseAskResult | AskOrActionResult | Promise<RaiseAskResult | AskOrActionResult>; batch?: typeof listAskBatch; batchAll?: typeof listAskBatchAll; sync?: typeof syncAsks }

const batchText = (batch: AskBatch, all = false): string => {
  if (batch.ledger === 'unavailable') return 'Asks: unknown (the needs-you ledger could not be read).';
  const more = (batch.otherHidden ?? 0) > 0 ? ` ${batch.otherHidden} more the fleet handles: phm asks list --all` : '';
  const handled = batch.fleetHandled?.length
    ? [`Handled by the fleet (${batch.fleetHandled.length})`, ...batch.fleetHandled.map(item => `- ${item.question || 'asked for a reading'}: ${item.fleetDid}`)] : [];
  const open = batch.count === 0 ? [`Nothing needs you.${more}`]
    : [`Needs you (${batch.count})`, ...batch.asks.flatMap(ask => [
      `${ask.number}. [${ask.type}] ${ask.question} [${batchChoicesText(ask)}] ${ask.whatHappens}`,
      ...(all && ask.fleetDid ? [`   Fleet did instead: ${ask.fleetDid}`] : []),
    ]), ...(more ? [more.trim()] : [])];
  return [...open, ...handled].join('\n');
};

const print = (json: boolean, value: unknown, text: string) => console.log(json ? JSON.stringify(sanitizePublicJson(value)) : text);
const exitOf = (outcome: AskAnswerResult): number =>
  outcome.status === 'answered' || outcome.status === 'already-answered' ? 0 : outcome.status === 'invalid' ? 2 : 1;

export async function cmdAsks(args: string[], deps: AsksCliDeps = {}): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) { console.log(usage); return 0; }
  const json = args.includes('--json');
  const all = args.includes('--all');
  const rest = args.filter(arg => arg !== '--json' && arg !== '--all');
  const options = deps.options ?? {};
  if (rest.length === 0) {
    const full: AsksList = (deps.list ?? listAsks)(options);
    const list = all ? full : onlyMasonAsks(full);
    print(json, list, asksText(list).join('\n'));
    return list.ledger === 'unavailable' ? 1 : 0;
  }
  if (rest[0] === 'list' && rest.length === 1) {
    const batch: AskBatch = all ? await (deps.batchAll ?? listAskBatchAll)(options) : (deps.batch ?? listAskBatch)(options);
    print(json, batch, batchText(batch, all));
    return batch.ledger === 'unavailable' ? 1 : 0;
  }
  if (rest[0] === 'answer' && rest.length === 3) {
    const outcome = await (deps.answer ?? answerAsk)(rest[1], rest[2]?.toLowerCase(), 'cli', options);
    print(json, outcome, askAnswerText(outcome));
    return exitOf(outcome);
  }
  if (rest[0] === 'usage' && rest.length <= 2) {
    const pool = rest[1] ?? 'grok-ultra';
    const reading = readMasonUsage(pool, { ...(options.runsDir ? { runsDir: options.runsDir } : {}), ...(options.now ? { now: options.now } : {}) });
    const text = reading ? `${pool}: ${reading.pctUsed}% (you said so ${formatAge(Math.round(reading.ageMs / 1000))} ago, via ${reading.channel}).`
      : `${pool}: no reading from you yet. Answer the usage ask with a number from 0 to 100.`;
    print(json, { schema: 'asks.usage.v1', pool, reading }, text);
    return 0;
  }
  if (rest[0] === 'sync' && rest.slice(1).every(arg => arg === '--dry-run')) {
    const synced = await (deps.sync ?? syncAsks)({ ...options, dryRun: rest.includes('--dry-run') });
    print(json, synced, asksSyncText(synced));
    return synced.status === 'unknown' ? 1 : 0;
  }
  if (rest[0] === 'add' && rest.length >= 3) {
    const subject = flagValue(rest, '--subject'), unblocks = flagValue(subject.rest, '--unblocks'), expires = flagValue(unblocks.rest, '--expires');
    const raised = await (deps.raise ?? raiseAskOrRead)(expires.rest[1]?.toLowerCase(), expires.rest.slice(2).join(' '), options,
      { ...(subject.value ? { subject: subject.value } : {}), ...(unblocks.value ? { unblocks: unblocks.value } : {}), ...(expires.value ? { expires: expires.value } : {}) });
    print(json, raised, raised.ok ? ('handled' in raised ? `Not asked: the fleet ${raised.action}.` : `${raised.duplicate ? 'Already asked' : 'Asked'}: ${raised.id}`) : `Not asked: ${raised.reason}.`.replace(/\.\.$/, '.'));
    return raised.ok ? 0 : 1;
  }
  console.error(`phm asks: unknown or incomplete arguments\n${usage}`);
  return 2;
}
