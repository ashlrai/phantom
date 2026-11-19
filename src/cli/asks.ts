/** `phm asks`: thin handler. Parses argv and prints what core/fleet/asks.ts returns. */
import {
  answerAsk, askAnswerText, asksText, listAsks, raiseAsk, type AskAnswerResult, type AsksList, type AsksOptions,
} from '../core/fleet/asks.js';
import { listAskBatch, batchChoicesText, type AskBatch } from '../core/fleet/asks-batch.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const usage = `Usage: phm asks [--json]
       phm asks list [--json]
       phm asks answer <id> yes|no|done|later [--json]
       phm asks add password|2fa|device|payment|outreach "<one-line request>" [--json]
Things only Mason can do (a password, a 2FA code, a device approval, a payment, a message to someone outside the team),
each answered with one word.
  phm asks list         one batch, oldest first, same question merged, with each allowed answer (--json: schema asks.batch.v1)
  phm asks              list open asks: short id, kind, age and the request (--json: schema asks.v1)
  answer <id> <word>    record yes, no, done or later once, with source cli and the time; a repeat changes nothing
  add <kind> <request>  raise an ask; never put the secret itself in the request
Anything that is not one of the five kinds is refused: the fleet decides this itself.
From Telegram, Mason can reply "yes <id>", "no <id>" or "done <id>".`;

export interface AsksCliDeps { options?: AsksOptions; list?: typeof listAsks; answer?: typeof answerAsk; raise?: typeof raiseAsk; batch?: typeof listAskBatch }

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
  if (rest[0] === 'add' && rest.length >= 3) {
    const raised = (deps.raise ?? raiseAsk)(rest[1]?.toLowerCase(), rest.slice(2).join(' '), options);
    print(json, raised, raised.ok ? `${raised.duplicate ? 'Already asked' : 'Asked'}: ${raised.id}` : `Not asked: ${raised.reason}.`.replace(/\.\.$/, '.'));
    return raised.ok ? 0 : 1;
  }
  console.error(`phm asks: unknown or incomplete arguments\n${usage}`);
  return 2;
}
