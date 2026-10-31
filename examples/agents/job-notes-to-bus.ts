#!/usr/bin/env -S npx tsx
/* global process */
/**
 * Post one job's worker notes to the local bus:
 *   npx tsx examples/agents/job-notes-to-bus.ts --job JOB_ID --from ADDRESS --to ADDRESS --id MESSAGEID
 *
 * Reads <job>.notes.md once through getFleetJobText (bounded, no symlink
 * following, credential-scrubbed) and appends exactly one validated envelope
 * through appendBusInbox. Priority is fixed at P2 with a ten-minute TTL
 * (600_000 ms). The body is
 *   {"kind":"worker-notes","jobId":<job>,"text":<notes>,"truncated":<bool>}
 * — the shape bus-notes-context.ts selects as upstream context.
 *
 * Missing or unreadable notes never post, and a reader failure never reaches
 * the bus. Notes that cannot fit the 64 KiB envelope limit fail as
 * notes-too-large instead of being silently re-truncated: citations stay
 * complete or the post fails loudly, and the reader's own bound and
 * scrubbing are never bypassed. Output is the transport receipt
 * (status, id, cursor) or one stable JSON error; note text is never emitted.
 *
 * Exits 0 posted/duplicate, 1 notes-missing/notes-unreadable/notes-unavailable/
 * job-mismatch or another transport failure, 2 invalid-arguments/
 * invalid-envelope, 3 retryable, 4 full, 5 conflict, 6 notes-too-large.
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MAX_BUS_ENVELOPE_BYTES, validateBusEnvelope } from '../../src/core/fleet/bus-envelope.js';
import { appendBusInbox, type BusInboxOptions } from '../../src/core/fleet/bus-inbox.js';
import { isFleetJobId } from '../../src/core/fleet/runs-job-detail.js';
import { getFleetJobText, type FleetJobTextV1 } from '../../src/core/fleet/runs-job-texts.js';

export const JOB_NOTES_TTL_MS = 10 * 60 * 1000;
const USAGE = 'usage: npx tsx examples/agents/job-notes-to-bus.ts --job ID --from ADDRESS --to ADDRESS --id MESSAGEID';
const KEYS = ['--job', '--from', '--to', '--id'];

export interface JobNotesToBusDependencies {
  read?: typeof getFleetJobText;
  readerOptions?: { runsDir?: string; maxBytes?: number };
  append?: typeof appendBusInbox;
  inboxOptions?: BusInboxOptions;
  now?: () => number;
  write?: (text: string) => void;
}

/** Read once and attempt one append; never retry a post implicitly. */
export async function runJobNotesToBus(args: readonly string[], deps: JobNotesToBusDependencies = {}): Promise<number> {
  const write = deps.write ?? (text => process.stdout.write(text));
  const emit = (value: unknown, code: number) => { write(`${JSON.stringify(value)}\n`); return code; };
  if (args.length === 1 && args[0] === '--help') return emit({ usage: USAGE }, 0);
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]!, value = args[i + 1];
    if (!KEYS.includes(key) || value === undefined || value.startsWith('--') || values.has(key)) {
      return emit({ error: 'invalid-arguments', usage: USAGE }, 2);
    }
    values.set(key, value);
  }
  const job = values.get('--job') ?? '';
  if (values.size !== KEYS.length || !isFleetJobId(job)) return emit({ error: 'invalid-arguments', usage: USAGE }, 2);
  // Validate transport fields before any potentially expensive reads.
  const header = { id: values.get('--id'), from: values.get('--from'), to: values.get('--to'), priority: 'P2', ttl: JOB_NOTES_TTL_MS };
  const initial = validateBusEnvelope({ ...header, body: null });
  if (!initial.ok) return emit({ error: 'invalid-envelope', issues: initial.issues }, 2);

  let notes: FleetJobTextV1;
  try {
    notes = await (deps.read ?? getFleetJobText)(job, 'notes', deps.readerOptions);
  } catch {
    return emit({ error: 'notes-unavailable' }, 1);
  }
  if (!notes || typeof notes.text !== 'string' || typeof notes.truncated !== 'boolean') return emit({ error: 'notes-unavailable' }, 1);
  if (notes.job !== job || notes.kind !== 'notes') return emit({ error: 'job-mismatch' }, 1);
  if (notes.state === 'missing') return emit({ error: 'notes-missing' }, 1);
  if (notes.state !== 'ok') return emit({ error: 'notes-unreadable' }, 1);

  const checked = validateBusEnvelope({
    ...header,
    body: { kind: 'worker-notes', jobId: job, text: notes.text, truncated: notes.truncated },
  });
  if (!checked.ok) {
    if (checked.issues.some(issue => issue.code === 'too-large')) {
      return emit({ error: 'notes-too-large', limitBytes: MAX_BUS_ENVELOPE_BYTES }, 6);
    }
    return emit({ error: 'invalid-envelope', issues: checked.issues }, 2);
  }
  const post = (deps.append ?? appendBusInbox)(checked.value, { ...deps.inboxOptions, ...(deps.now ? { now: deps.now } : {}) });
  if (post.status === 'posted' || post.status === 'duplicate') return emit(post, 0);
  return emit(post, post.status === 'retryable' ? 3 : post.status === 'full' ? 4 : post.status === 'conflict' ? 5 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await runJobNotesToBus(process.argv.slice(2));
}
