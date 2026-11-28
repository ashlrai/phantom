/**
 * `phm comms-agent status|run|drafts [--status pending|sent|all] [--transport <transport>] [--to <recipient>] [--contains <text>] [--since <15m|2h|1d|ISO|epoch>] [--before <when>] [--id <draft-id>] [--limit <1..200>] [--json]`.
 * `phm comms-agent intake --file <path|-> [--dir <runs>] [--json]`.
 * Thin handler. The role, triage, intake and send policy live in src/core/comms-agent/.
 */
import { dirname, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import {
  COMMS_DRAFTS_CONTAINS_MAX, COMMS_DRAFTS_LIMIT_MAX, COMMS_DRAFTS_TO_MAX, COMMS_DRAFT_STATUSES,
  commsDrafts, commsStatus, runCommsAgent, type CommsDraftsFilter, type CommsDraftStatusFilter,
} from '../core/comms-agent/run.js';
import { isCommsTransport } from '../core/comms-agent/policy.js';
import { commsRunsRoot } from '../core/comms-agent/store.js';
import { COMMS_INTAKE_MAX_FILE_BYTES, intakeCommsInbox } from '../core/comms-agent/intake.js';
import { parseSince } from '../core/fleet/agent-messages.js';
import { readStableRegularFile } from '../core/util/stable-file-read.js';

const USAGE = `phm comms-agent status [--dir <runs>] [--json]
phm comms-agent run [--lanes <lane,lane>] [--dir <runs>] [--json]
phm comms-agent drafts [--status pending|sent|all] [--transport <transport>] [--to <recipient>] [--contains <text>] [--since <15m|2h|1d|ISO|epoch>] [--before <when>] [--id <draft-id>] [--limit <1..${COMMS_DRAFTS_LIMIT_MAX}>] [--dir <runs>] [--json]
phm comms-agent intake --file <path|-> [--dir <runs>] [--json]
The Comms role is under the Leader. The router picks the lane; none is hard-coded.
Sends require an owner standing approval. See docs/COMMS-AGENT.md.`;

const VERBS = ['status', 'run', 'drafts', 'intake'] as const;

function emit(json: boolean, value: unknown): void {
  console.log(JSON.stringify(value, null, json ? undefined : 2));
}

function publicError(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (message.startsWith('Inbox file') || message.startsWith('Inbox intake') || message.startsWith('Comms agent directory') || message === 'Refusing a symlink.' || message === 'Approval overrides are refused.') return message;
  return 'Comms agent run failed.';
}

/** Bounded stdin read for `intake --file -`; undefined when the stream fails
 * or exceeds the intake document cap — never a partial document. */
async function readIntakeStdin(stream: Readable): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for await (const chunk of stream) {
      if (typeof chunk !== 'string' && !(chunk instanceof Uint8Array)) return undefined;
      bytes += typeof chunk === 'string' ? Buffer.byteLength(chunk, 'utf8') : chunk.byteLength;
      if (bytes > COMMS_INTAKE_MAX_FILE_BYTES) return undefined;
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks, bytes).toString('utf8');
  } catch {
    return undefined;
  }
}

export async function cmdCommsAgent(args: string[], options: { stdin?: Readable } = {}): Promise<number> {
  const json = args.includes('--json');
  const help = args.includes('--help') || args.includes('-h');
  const valueOf = (flag: string): { ok: true; value?: string } | { ok: false } => {
    const index = args.indexOf(flag);
    if (index < 0) return { ok: true };
    const value = args[index + 1];
    if (!value || value.startsWith('-')) return { ok: false };
    return { ok: true, value };
  };
  const dir = valueOf('--dir');
  const lanesFlag = valueOf('--lanes');
  const statusFlag = valueOf('--status');
  const transportFlag = valueOf('--transport');
  const toFlag = valueOf('--to');
  const containsFlag = valueOf('--contains');
  const sinceFlag = valueOf('--since');
  const beforeFlag = valueOf('--before');
  const idFlag = valueOf('--id');
  const limitFlag = valueOf('--limit');
  // `--file` takes `-` for stdin, which the shared valueOf rule refuses, so
  // the intake document path parses on its own: a flag-looking or missing
  // value leaves intakeFile unset and the verb check fails it as usage.
  const fileIndex = args.indexOf('--file');
  const fileValue = fileIndex >= 0 ? args[fileIndex + 1] : undefined;
  const intakeFile = fileValue === '-' ? '-' : fileValue !== undefined && fileValue !== '' && !fileValue.startsWith('-') ? fileValue : undefined;
  if (!dir.ok || !lanesFlag.ok || !statusFlag.ok || !transportFlag.ok
      || !toFlag.ok || !containsFlag.ok || !sinceFlag.ok || !beforeFlag.ok || !idFlag.ok || !limitFlag.ok) {
    emit(json, { ok: false, error: 'Missing value for flag. See phm comms-agent --help.' });
    return 2;
  }
  const consumed = new Set<number>();
  for (const flag of ['--dir', '--lanes', '--status', '--transport', '--to', '--contains', '--since', '--before', '--id', '--limit', '--file']) {
    const index = args.indexOf(flag);
    if (index >= 0) { consumed.add(index); consumed.add(index + 1); }
  }
  const rest = args.filter((arg, index) => arg !== '--json' && arg !== '--help' && arg !== '-h' && !consumed.has(index));
  if (help) {
    if (json) emit(true, { usage: USAGE });
    else console.log(USAGE);
    return 0;
  }
  if (rest.length === 0) {
    emit(json, { ok: false, error: 'Use phm comms-agent status|run|drafts|intake --json' });
    if (!json) console.error(USAGE);
    return 2;
  }
  const [verb, ...extra] = rest;
  const usageFail = (): number => {
    emit(json, { ok: false, error: 'Use phm comms-agent status|run|drafts|intake --json' });
    if (!json) console.error(USAGE);
    return 2;
  };
  if (extra.length > 0 || !VERBS.includes(verb as typeof VERBS[number]) || rest.some(arg => arg.startsWith('-'))) {
    return usageFail();
  }
  // The read filters narrow the drafts verb only; on status|run|intake they
  // are a usage error rather than silently ignored flags.
  const draftsFlags = [statusFlag, transportFlag, toFlag, containsFlag, sinceFlag, beforeFlag, idFlag, limitFlag];
  const draftsFilter: CommsDraftsFilter = {};
  if (verb !== 'drafts' && draftsFlags.some(flag => flag.value !== undefined)) {
    return usageFail();
  }
  // --file feeds intake only, and intake cannot run without it: on the
  // other verbs it is a usage error rather than silently ignored input.
  if (verb !== 'intake' && fileIndex >= 0) return usageFail();
  if (verb === 'intake' && intakeFile === undefined) return usageFail();
  if (verb === 'drafts') {
    if (statusFlag.value !== undefined) {
      if (!(COMMS_DRAFT_STATUSES as readonly string[]).includes(statusFlag.value)) return usageFail();
      draftsFilter.status = statusFlag.value as CommsDraftStatusFilter;
    }
    if (transportFlag.value !== undefined) {
      if (!isCommsTransport(transportFlag.value)) return usageFail();
      draftsFilter.transport = transportFlag.value;
    }
    if (toFlag.value !== undefined) {
      const to = toFlag.value.trim();
      if (to === '' || to.length > COMMS_DRAFTS_TO_MAX) return usageFail();
      draftsFilter.to = to;
    }
    if (containsFlag.value !== undefined) {
      if (containsFlag.value.trim() === '' || containsFlag.value.length > COMMS_DRAFTS_CONTAINS_MAX) return usageFail();
      draftsFilter.contains = containsFlag.value;
    }
    if (sinceFlag.value !== undefined) {
      const since = parseSince(sinceFlag.value);
      if (since === null) return usageFail();
      draftsFilter.since = since;
    }
    if (beforeFlag.value !== undefined) {
      const before = parseSince(beforeFlag.value);
      if (before === null) return usageFail();
      draftsFilter.before = before;
    }
    if (idFlag.value !== undefined) {
      const id = idFlag.value.trim();
      if (id === '' || id.length > 128) return usageFail();
      draftsFilter.id = id;
    }
    if (limitFlag.value !== undefined) {
      if (!/^[0-9]+$/.test(limitFlag.value)) return usageFail();
      const limit = Number(limitFlag.value);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > COMMS_DRAFTS_LIMIT_MAX) return usageFail();
      draftsFilter.limit = limit;
    }
  }
  const runsDir = commsRunsRoot(dir.value);
  const lanes = lanesFlag.value ? lanesFlag.value.split(',').map(lane => lane.trim()).filter(Boolean) : [];
  try {
    if (verb === 'status') {
      emit(json, await commsStatus(runsDir));
      return 0;
    }
    if (verb === 'drafts') {
      emit(json, await commsDrafts(runsDir, draftsFilter));
      return 0;
    }
    if (verb === 'intake') {
      // intakeFile is proven set by the usage check above.
      let text: string | undefined;
      if (intakeFile === '-') {
        text = await readIntakeStdin(options.stdin ?? process.stdin);
      } else {
        const path = resolve(intakeFile!);
        const input = readStableRegularFile(path, {
          anchorPath: dirname(path),
          maxFileBytes: COMMS_INTAKE_MAX_FILE_BYTES,
          remainingBytes: COMMS_INTAKE_MAX_FILE_BYTES,
        });
        if (input.ok) text = input.text;
      }
      if (text === undefined) {
        emit(json, { ok: false, error: 'Inbox intake document is not readable.' });
        return 1;
      }
      let document: unknown;
      try { document = JSON.parse(text); }
      catch { emit(json, { ok: false, error: 'Inbox intake is not valid JSON.' }); return 1; }
      emit(json, { ok: true, schema: 'comms-agent.intake.v1', ...(await intakeCommsInbox(runsDir, document)) });
      return 0;
    }
    emit(json, await runCommsAgent({ runsDir, lanes }));
    return 0;
  } catch (error) {
    emit(json, { ok: false, error: publicError(error) });
    return 1;
  }
}
