/** Thin argv adapter over the local bus core. Exit 0 success, 1 operational error, 2 usage. */
import { randomUUID } from 'node:crypto';
import { MAX_BUS_ENVELOPE_BYTES, validateBusEnvelope } from '../core/fleet/bus-envelope.js';
import { BusMailboxError, createBusMailbox, validateBusAddress, type BusMailbox } from '../core/fleet/bus-mailbox.js';

export const BUS_USAGE = `Usage: phm bus <send|inbox|ack> [--json]
  send --from <label> --to <label> --body <json> [--id <id>] [--priority P0|P1|P2|P3] [--ttl <ms>]
  inbox --to <label> [--limit <1..1000>]
  ack <id> --to <label>

Local durable mailboxes under $ASHLR_HOME/bus (default ~/.ashlr/bus).
Send defaults: random UUID, priority P2, TTL 300000 ms. Retry with the same ID
and identical envelope for deduplication; retries do not renew TTL.
Inbox reads pending, unexpired messages in priority/acceptance order, default
limit 100; hasMore reports truncation. Reading never acknowledges a message.
Ack is idempotent and checks the recipient. Labels are not authenticated identities.
Use --name=value for flag-shaped values, and ack --to <label> [--json] -- <id>
for a flag-shaped message ID.
No remote dispatch or agent execution. Use Phantom Secrets phm_<name> references.
History is retained, with at most 5000 messages and 64 MiB including reserved
acknowledgment space. Capacity refusal preserves existing inboxes and acknowledgments.
JSON mode emits one object, including errors. --help / -h performs no work.`;

class UsageError extends Error {}

const OPTIONS: Record<string, readonly string[]> = {
  send: ['--from', '--to', '--body', '--id', '--priority', '--ttl'],
  inbox: ['--to', '--limit'],
  ack: ['--to'],
};

function integer(raw: string, name: string, max = Number.MAX_SAFE_INTEGER): number {
  const n = Number(raw);
  if (!/^[0-9]+$/.test(raw) || !Number.isSafeInteger(n) || n < 1 || n > max) {
    throw new UsageError(`${name} requires a positive integer${max === 1000 ? ' at most 1000' : ''}.`);
  }
  return n;
}

/** Factory injection keeps parsing tests independent of persistence; production always uses the real core. */
export async function cmdBus(argv: string[], load: () => BusMailbox = createBusMailbox): Promise<number> {
  const separator = argv.indexOf('--');
  const json = argv.slice(0, separator < 0 ? undefined : separator).includes('--json');
  const output = (value: unknown, human: string): void => { console.log(json ? JSON.stringify(value) : human); };
  try {
    const args: string[] = [];
    const values = new Map<string, string>();
    let literalStart = Infinity;
    const sub = argv.find(token => token !== '--json');
    const allowed = sub && Object.hasOwn(OPTIONS, sub) ? OPTIONS[sub] : undefined;
    let help = false;
    let seenJson = false;
    // Parse values before interpreting booleans: a quoted body of "--help"
    // must not bypass validation or turn an intended send into a help request.
    for (let i = 0; i < argv.length; i++) {
      const token = argv[i]!;
      if (token === '--') { literalStart = args.length; args.push(...argv.slice(i + 1)); break; }
      const equal = token.indexOf('=');
      const option = equal > 0 ? token.slice(0, equal) : token;
      if (allowed?.includes(option)) {
        if (values.has(option)) throw new UsageError(`Duplicate ${option} option.`);
        const value = equal > 0 ? token.slice(equal + 1) : argv[++i];
        if (value === undefined || (equal < 0 && value.startsWith('--'))) throw new UsageError(`${option} requires a value.`);
        values.set(option, value);
      } else if (token === '--json') {
        if (seenJson) throw new UsageError('Duplicate --json option.');
        seenJson = true;
      } else if (token === '--help' || token === '-h') {
        help = true;
      } else { args.push(token); }
    }
    if (help && (sub === '--help' || sub === '-h' || allowed)) { output({ ok: true, usage: BUS_USAGE }, BUS_USAGE); return 0; }
    if (!allowed || !sub) throw new UsageError('Expected send, inbox or ack.');
    const operands = args.slice(1);
    for (const token of args.slice(1, literalStart)) {
      if (token.startsWith('-')) throw new UsageError('Unknown bus option.');
    }
    if (operands.length !== (sub === 'ack' ? 1 : 0)) throw new UsageError('Unexpected or missing bus operand.');
    const required = (name: string): string => {
      const value = values.get(name);
      if (value === undefined || value.length === 0) throw new UsageError(`${name} is required.`);
      return value;
    };
    const to = required('--to');
    validateBusAddress(to);
    if (sub === 'send') {
      const body = required('--body');
      if (body.length > MAX_BUS_ENVELOPE_BYTES || Buffer.byteLength(body) > MAX_BUS_ENVELOPE_BYTES) {
        throw new UsageError('Body exceeds the bus envelope size limit.');
      }
      let parsed: unknown;
      try { parsed = JSON.parse(body); } catch { throw new UsageError('--body requires valid JSON.'); }
      const checked = validateBusEnvelope({
        id: values.get('--id') ?? randomUUID(), from: required('--from'), to,
        priority: values.get('--priority') ?? 'P2', ttl: integer(values.get('--ttl') ?? '300000', '--ttl'), body: parsed,
      });
      if (!checked.ok) throw new UsageError('Invalid bus envelope: check labels, priority, TTL, JSON depth and size.');
      const result = load().send(checked.value);
      output({ ok: true, ...result }, `Message ${result.replayed ? 'already accepted' : 'accepted'}: ${result.id}`);
    } else if (sub === 'inbox') {
      const limit = integer(values.get('--limit') ?? '100', '--limit', 1000);
      const result = load().inbox(to, limit);
      output({ ok: true, ...result }, result.messages.length
        ? result.messages.map(m => `${m.id} ${m.priority} ${m.from} -> ${m.to}\n${JSON.stringify(m.body)}`).join('\n') +
          (result.hasMore ? '\nMore pending messages; increase --limit or acknowledge processed messages.' : '')
        : 'No pending messages.');
    } else {
      const id = operands[0]!;
      validateBusAddress(id);
      const result = load().ack(id, to);
      output({ ok: true, ...result }, `Acknowledged: ${result.id}`);
    }
    return 0;
  } catch (error) {
    // Never echo raw argv, JSON parser exceptions or filesystem error paths.
    const usage = error instanceof UsageError || (error instanceof BusMailboxError && error.code === 'invalid-address');
    const message = error instanceof UsageError || error instanceof BusMailboxError ? error.message : 'Bus operation failed.';
    if (json) output({ ok: false, error: { code: usage ? 'usage' : error instanceof BusMailboxError ? error.code : 'operation-failed', message } }, '');
    else console.error(`phm bus: ${message}${usage ? '\n' + BUS_USAGE : ''}`);
    return usage ? 2 : 1;
  }
}
