/** `phm asks`: thin handler. Parses argv and prints what core/fleet/asks.ts returns. */
import {
  answerAsk, askAnswerText, asksText, formatAge, listAsks, raiseAsk, type AskAnswerResult, type AsksList, type AsksOptions,
} from '../core/fleet/asks.js';
import { asksSyncText, syncAsks } from '../core/fleet/asks-sync.js';
import { readMasonUsage } from '../core/fleet/asks-ledger.js';
import { listAskBatch, batchChoicesText, type AskBatch } from '../core/fleet/asks-batch.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const usage = `Usage: phm asks [--json]
       phm asks list [--json]
       phm asks answer <id> <reply> [--json]
       phm asks add <kind> "<one-line request>" [--subject <name>] [--unblocks "<what it unblocks>"] [--expires <UTC time>] [--json]
       phm asks usage [<pool>] [--json]
       phm asks sync [--dry-run] [--json]
Things only Mason can do (a password, a 2FA code, a device approval, a payment, a message to someone outside the team,
his usage percent for a lane, a yes or no on spending a credit), each answered with one word or one number.
  phm asks list         one batch, oldest first, same question merged, with each allowed answer (--json: schema asks.batch.v1)
  phm asks              list open asks, soonest expiry first (unknown expiry last, expired hidden): short id, kind, age,
                        the request, why it matters and each allowed answer (--json: schema asks.v1)
  answer <id> <reply>   record the reply once (yes, no, done or later; a number 0-100 for a usage ask), with source cli and the
                        time, in the answers ledger; a repeat changes nothing; a reply the ask does not accept records nothing
  add <kind> <request>  raise an ask; kinds: password, 2fa, device, payment, outreach, usage (needs --subject <pool>), approval;
                        never put the secret itself in the request; --expires 2026-11-24T00:00:00Z hides it after that time
  usage [<pool>]        Mason's latest stated usage for a pool (default grok-ultra), with its time and age (--json: asks.usage.v1)
  sync [--dry-run]      raise one ask per pool that needs a sign-in or has a credit ending unused, expiring at its reset; a re-run
                        adds nothing and a cleared pool closes its ask; it never signs in or spends (--json: asks.sync.v1)
An approval answer is a record only: nothing is spent and no billing call is made.
Anything that is not one of the kinds is refused: the fleet decides this itself.
From Telegram, Mason can reply "yes <id>", "no <id>" or "done <id>".`;

const flagValue = (args: string[], name: string): { value?: string; rest: string[] } => {
  const at = args.indexOf(name);
  return at < 0 ? { rest: args } : { value: args[at + 1], rest: [...args.slice(0, at), ...args.slice(at + 2)] };
};

export interface AsksCliDeps { options?: AsksOptions; list?: typeof listAsks; answer?: typeof answerAsk; raise?: typeof raiseAsk; batch?: typeof listAskBatch; sync?: typeof syncAsks }

const batchText = (batch: AskBatch): string =>
  batch.ledger === 'unavailable' ? 'Asks: unknown (the needs-you ledger could not be read).'
    : batch.count === 0 ? 'Nothing needs you.'
      : [`Needs you (${batch.count})`, ...batch.asks.map(ask => `${ask.number}. ${ask.question} [${batchChoicesText(ask)}] ${ask.whatHappens}`)].join('\n');

const print = (json: boolean, value: unknown, text: string) => console.log(json ? JSON.stringify(sanitizePublicJson(value)) : text);
const exitOf = (outcome: AskAnswerResult): number =>
  outcome.status === 'answered' || outcome.status === 'already-answered' ? 0 : outcome.status === 'invalid' ? 2 : 1;

export async function cmdAsks(args: string[], deps: AsksCliDeps = {}): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) { console.log(usage); return 0; }
  const json = args.includes('--json');
  const rest = args.filter(arg => arg !== '--json');
  const options = deps.options ?? {};
  if (rest.length === 0) {
    const list: AsksList = (deps.list ?? listAsks)(options);
    print(json, list, asksText(list).join('\n'));
    return list.ledger === 'unavailable' ? 1 : 0;
  }
  if (rest[0] === 'list' && rest.length === 1) {
    const batch: AskBatch = (deps.batch ?? listAskBatch)(options);
    print(json, batch, batchText(batch));
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
    const raised = (deps.raise ?? raiseAsk)(expires.rest[1]?.toLowerCase(), expires.rest.slice(2).join(' '), options,
      { ...(subject.value ? { subject: subject.value } : {}), ...(unblocks.value ? { unblocks: unblocks.value } : {}), ...(expires.value ? { expires: expires.value } : {}) });
    print(json, raised, raised.ok ? `${raised.duplicate ? 'Already asked' : 'Asked'}: ${raised.id}` : `Not asked: ${raised.reason}.`.replace(/\.\.$/, '.'));
    return raised.ok ? 0 : 1;
  }
  console.error(`phm asks: unknown or incomplete arguments\n${usage}`);
  return 2;
}
