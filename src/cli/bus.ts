/**
 * `phm bus` - the vendor-neutral agent bus (bus.message.v1), thin over src/core/bus/ops.ts.
 *
 *   phm bus send --to <agent> [--role r] [--topic t] [--kind k] [--thread id] [--ref r]... "<markdown>"
 *   phm bus read [--topic t] [--for label] [--since 2h|ISO] [--unacked] [--limit n] [--json]
 *   phm bus ack <id> [--topic t] [--json]
 *
 * Identity (--agent, --vendor, --node) defaults to PHM_BUS_AGENT / PHM_BUS_VENDOR / PHM_BUS_NODE,
 * which dispatchd sets for launched jobs. Labels are routing hints, never authentication.
 */
import { readFileSync } from 'node:fs';

import { busAck, busRead, busSend } from '../core/bus/ops.js';
import { BUS_KINDS, BUS_VENDORS, type BusMessage } from '../core/bus/message.js';

export interface BusCliIo {
  out(line: string): void;
  err(line: string): void;
  readStdin(): string;
}

const HELP = [
  'Usage: phm bus <send|read|ack|help>',
  '  send --to <agent> [--role r] [--topic t] [--kind k] [--thread id] [--ref r]... "<markdown>"   ("-" reads the body from stdin)',
  '  read [--topic t] [--for label] [--since 2h|ISO] [--unacked] [--limit n] [--json]',
  '  ack  <id> [--topic t] [--json]',
  `Identity: --agent a --vendor ${BUS_VENDORS.join('|')} --node n (defaults: PHM_BUS_AGENT, PHM_BUS_VENDOR, PHM_BUS_NODE).`,
  `Kinds: ${BUS_KINDS.join('|')}. Store: ~/.ashlr-runs/bus/<topic>.jsonl, append-only. Labels are routing hints, not authentication.`,
].join('\n');

const VALUE_FLAGS = new Set(['--to', '--role', '--topic', '--kind', '--thread', '--ref', '--agent', '--vendor', '--node', '--for', '--since', '--limit']);
const BOOL_FLAGS = new Set(['--json', '--unacked', '--help', '-h']);

interface Parsed { values: Map<string, string[]>; flags: Set<string>; rest: string[] }

function parse(args: string[]): Parsed | { error: string } {
  const values = new Map<string, string[]>();
  const flags = new Set<string>();
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (BOOL_FLAGS.has(a)) flags.add(a);
    else if (VALUE_FLAGS.has(a)) {
      const v = args[++i];
      if (v === undefined) return { error: `${a} needs a value` };
      values.set(a, [...(values.get(a) ?? []), v]);
    } else if (a.startsWith('--')) return { error: `unknown option ${a}` };
    else rest.push(a);
  }
  return { values, flags, rest };
}

const one = (p: Parsed, flag: string): string | undefined => p.values.get(flag)?.at(-1);

function line(m: BusMessage): string {
  const to = [m.to.agent && `@${m.to.agent}`, m.to.role && `role:${m.to.role}`, m.to.topic && `#${m.to.topic}`].filter(Boolean).join(' ');
  return `${m.createdAt} ${m.id} [${m.kind}] ${m.from.agent}(${m.from.vendor}@${m.from.node}) -> ${to} thread=${m.thread}\n  ${m.body.replace(/\n/g, '\n  ')}`;
}

const defaultIo: BusCliIo = {
  out: s => process.stdout.write(`${s}\n`),
  err: s => process.stderr.write(`${s}\n`),
  readStdin: () => readFileSync(0, 'utf8'),
};

export async function runBusCli(args: string[], io: BusCliIo = defaultIo): Promise<number> {
  const [verb, ...tail] = args;
  if (verb === undefined || verb === 'help' || verb === '--help' || verb === '-h') {
    io.out(HELP);
    return 0;
  }
  const p = parse(tail);
  if ('error' in p) { io.err(`phm bus: ${p.error}`); return 2; }
  if (p.flags.has('--help') || p.flags.has('-h')) { io.out(HELP); return 0; }
  const json = p.flags.has('--json');
  const identity = { agent: one(p, '--agent'), vendor: one(p, '--vendor'), node: one(p, '--node') };
  const fail = (issues: string[], code = 1): number => {
    if (json) io.out(JSON.stringify({ ok: false, issues }));
    else for (const i of issues) io.err(`phm bus ${verb}: ${i}`);
    return code;
  };

  if (verb === 'send') {
    const raw = p.rest.join(' ');
    const body = raw === '-' ? io.readStdin() : raw;
    const to = { agent: one(p, '--to'), role: one(p, '--role'), topic: one(p, '--topic') };
    const r = busSend({
      ...identity, body, kind: one(p, '--kind'), thread: one(p, '--thread'), refs: p.values.get('--ref'),
      to: Object.fromEntries(Object.entries(to).filter(([, v]) => v !== undefined)),
    });
    if (!r.ok) return fail(r.issues);
    io.out(json ? JSON.stringify(r) : `${r.status} ${r.id} thread=${r.thread} topic=${r.topic}${r.redacted ? ' (secret-like text redacted)' : ''}`);
    return 0;
  }

  if (verb === 'read') {
    const limitText = one(p, '--limit');
    const limit = limitText === undefined ? undefined : Number(limitText);
    if (limit !== undefined && !Number.isInteger(limit)) return fail(['--limit must be an integer'], 2);
    const r = busRead({ ...identity, topic: one(p, '--topic'), for: one(p, '--for'), since: one(p, '--since'), unacked: p.flags.has('--unacked'), limit });
    if (!r.ok) return fail(r.issues);
    if (json) io.out(JSON.stringify({ ok: true, reader: r.reader, truncated: r.truncated, messages: r.messages }));
    else if (r.messages.length === 0) io.out('no messages');
    else for (const m of r.messages) io.out(line(m));
    return 0;
  }

  if (verb === 'ack') {
    const id = p.rest[0];
    if (id === undefined) return fail(['ack needs a message id'], 2);
    const r = busAck({ ...identity, id, topic: one(p, '--topic') });
    if (!r.ok) return fail(r.issues);
    io.out(json ? JSON.stringify(r) : `${r.status} ${r.id} by ${r.by.agent}(${r.by.vendor})`);
    return 0;
  }

  io.err(`phm bus: unknown verb "${verb}"\n${HELP}`);
  return 2;
}
