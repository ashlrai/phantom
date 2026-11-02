import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { listBusInboxAfter, type BusInboxOptions, type BusInboxReceipt } from './bus-inbox.js';
import { projectBusThread } from './bus-thread-context.js';
import { readFleetRunsDirState } from './runs-dir-state.js';
import { dispatchEventsCandidates } from './dispatch-events-path.js';
import { sanitizePublicJson } from '../util/public-json.js';
import { scrubSecrets } from '../util/scrub.js';
import { learnOutcomes, outcomeLearningView } from '../routing/outcome-learning.js';

export interface ContextPackOptions extends BusInboxOptions {
  job: string; lane: string; runsDir: string; maxTokens?: number; merges?: number;
}
export const contextIdentifier = (value: string): boolean => /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(value) && scrubSecrets(value) === value;
// One UTF-8 byte per token is a conservative upper bound for byte-based tokenizers.
export const packTokens = (json: string): number => Buffer.byteLength(json + '\n', 'utf8');

export function compactContext(job: string, lane: string, sections: { name: string; rows: unknown[] }[], cap: number): string {
  const safe = sanitizePublicJson({ schema: 'fleet.ctxpack.v1', job, lane, sections }) as { sections: typeof sections };
  const encode = (): string => scrubSecrets(JSON.stringify(safe, (key, value: unknown) =>
    /(?:password|passwd|credential|secret|api[_-]?key|token|authorization)$/i.test(key) ? '[REDACTED]' : value));
  while (packTokens(encode()) > cap) {
    const last = safe.sections.at(-1);
    if (!last) throw new Error('Pack metadata exceeds budget. Increase --max-tokens or shorten --job and --lane.');
    if (last.rows.length) last.rows.pop();
    else safe.sections.pop();
  }
  const result = encode();
  try { JSON.parse(result); } catch { throw new Error('Cannot serialize scrubbed context. Repair malformed source records and retry.'); }
  return result;
}

async function eventsFile(runsDir: string): Promise<{ path: string; text: string }> {
  for (const path of dispatchEventsCandidates(runsDir)) {
    let file: Awaited<ReturnType<typeof open>> | undefined;
    try {
      file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 8 * 1024 * 1024) throw new Error('size');
      return { path, text: await file.readFile('utf8') };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Cannot read outcome log. Restore a regular dispatch-events.log under 8 MiB in the runs directory.');
    } finally { await file?.close(); }
  }
  throw new Error('Outcome log missing. Start the fleet to create queue/dispatch-events.log in the runs directory.');
}

export async function buildContextPack(options: ContextPackOptions): Promise<string> {
  const { job, lane, runsDir } = options;
  const cap = options.maxTokens ?? 2000, count = options.merges ?? 5;
  if (!contextIdentifier(job) || !contextIdentifier(lane) || !Number.isInteger(cap) || cap < 256 || cap > 2000 || !Number.isInteger(count) || count < 0 || count > 100) {
    throw new Error('Use safe job/lane IDs, --max-tokens 256..2000, and --merges 0..100.');
  }
  const now = (options.now ?? Date.now)();
  const [state, events] = await Promise.all([readFleetRunsDirState({ runsDir, now: () => now }), eventsFile(runsDir)]);
  const rows: BusInboxReceipt[] = [];
  let cursor = 0;
  for (let pageNumber = 0; pageNumber < 12; pageNumber++) {
    const page = listBusInboxAfter(cursor, 100, { ...options, now: () => now });
    if (page.status !== 'ok') throw new Error('Bus unavailable. Run phm comms bus status and restore private bus storage permissions before retrying.');
    rows.push(...page.messages);
    cursor = page.nextCursor;
    if (page.messages.length < 100) break;
  }
  const relevant = rows.filter(row => {
    const text = JSON.stringify(row.envelope);
    return new RegExp(`(^|[^A-Za-z0-9._-])${job.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9._-]|$)`).test(text);
  });
  const selected = new Map<number, BusInboxReceipt>();
  for (const row of relevant) {
    let parent = row;
    const seen = new Set<string>();
    while (!seen.has(parent.envelope.id)) {
      seen.add(parent.envelope.id);
      const body = parent.envelope.body;
      const id = body && typeof body === 'object' && !Array.isArray(body) ? body['inReplyTo'] : null;
      const ancestor = rows.find(candidate => candidate.envelope.id === id);
      if (!ancestor) break;
      parent = ancestor;
    }
    for (const message of projectBusThread(rows, parent.envelope.id)) selected.set(message.cursor, message);
  }
  const threads = [...selected.values()].sort((a, b) => a.envelope.priority.localeCompare(b.envelope.priority) || b.cursor - a.cursor)
    .map(({ cursor: at, envelope: { id, from, to, priority, body } }) => ({ cursor: at, id, from, to, priority, body }));
  const merges = events.text.split(/\r?\n/).filter(line => /\b(?:MERGED|MERGE)\b|\bOUTCOME \S+ merged\b|\bstate=merged\b|"state"\s*:\s*"merged"/.test(line)).reverse().slice(0, count);
  const learning = outcomeLearningView(learnOutcomes(events.text));
  const json = compactContext(job, lane, [
    { name: 'fleet', rows: [{ lastTick: state.lastTick, sources: state.sources, paused: state.paused, lanes: state.lanes.sort((a, b) => a.lane.localeCompare(b.lane)).map(({ lane, running, target, queued, held }) => ({ lane, running, target, queued, held })), finished: learning.finished }] },
    { name: 'blockers', rows: [...state.lanes.filter(row => row.held).map(row => ({ lane: row.lane, reason: row.heldReason })),
      ...threads.filter(row => row.body && typeof row.body === 'object' && !Array.isArray(row.body) && row.body['status'] === 'blocked' &&
        !projectBusThread(rows, row.id).some(reply => reply.cursor > row.cursor && reply.envelope.body && typeof reply.envelope.body === 'object' && !Array.isArray(reply.envelope.body) &&
          ['resolved', 'closed', 'unblocked'].includes(String(reply.envelope.body['status']))))] },
    { name: 'merges', rows: merges }, { name: 'threads', rows: threads },
  ], cap);
  let log: Awaited<ReturnType<typeof open>> | undefined;
  try {
    log = await open(events.path, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    if (!(await log.stat()).isFile()) throw new Error('file');
    // Same outcome store, ignored by assignment/outcome folding, no pack contents persisted.
    await log.writeFile(`${new Date(now).toISOString().slice(0, 19).replace('T', ' ')} CTXPACK job=${job} lane=${lane} pack_tokens=${packTokens(json)}\n`);
  } catch { throw new Error('Cannot record pack_tokens. Restore write access to the existing dispatch event log, then retry.'); }
  finally { await log?.close(); }
  return json;
}
