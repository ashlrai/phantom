/** Read-only work status from existing receipts; never sends or dispatches. */
import { join } from 'node:path';
import { ashlrHome } from '../core/cloud/store.js';
import { readSlackJournal } from '../core/agents/slack-journal.js';
import { collectBusWorkItemEvidence } from '../core/comms/work-item-bus-evidence.js';
import { classifyWorkItem, formatWorkItemStatusLine } from '../core/comms/work-item-state.js';
import { scrubSecrets } from '../core/util/scrub.js';

const usage = 'Usage: ashlr fleet work-status <id> [--json]\n'
  + 'Read a bus message id or exact Slack journal event/envelope/request id. No writes or sends.';

export async function cmdFleetWorkStatus(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(usage); return 0; }
  const id = args[0];
  if (!id || !/^[\x21-\x7e]{1,256}$/.test(id) || id.startsWith('-') || args.length > 2
    || (args.length === 2 && args[1] !== '--json')) { console.error(usage); return 2; }
  const now = Date.now();
  const { evidence, sources } = collectBusWorkItemEvidence(id, { root: join(ashlrHome(), 'fleet'), now });
  const journal = readSlackJournal({ limit: 4096 });
  // An exact ingress identity proves receipt only, even when the bus append failed.
  const ingress = journal.entries.find(row => row.decision === 'ingested' && Date.parse(row.at) <= now
    && [row.eventId, row.envelopeId, row.requestId].includes(id));
  if (evidence.receivedAt === undefined && ingress) {
    evidence.receivedAt = new Date(ingress.at).toISOString();
  }
  const result = { ...classifyWorkItem(evidence, new Date(now).toISOString()),
    ...(evidence.owner ? { owner: evidence.owner } : {}),
    sources: { ...sources, journal: journal.state } };
  if (result.source === 'receivedAt') result.source = sources.inbox === 'found'
    ? 'bus-inbox/messages.json' : 'slack-bridge/journal.jsonl';
  if (journal.state !== 'ok') result.missing.push(`journal ${journal.state}`);
  if (sources.claims === 'missing') result.missing.push('claim store missing');
  if (sources.inbox !== 'found' && !ingress) result.missing.push('ingress receipt');
  if (sources.inbox === 'unavailable') result.missing.push('bus inbox unavailable');
  if (sources.claims === 'unavailable') result.missing.push('claim store unavailable');
  // Scrub each value before serialization, preserving valid JSON even for escaped input.
  console.log(args[1] === '--json'
    ? JSON.stringify(result, (_key, value: unknown) => typeof value === 'string' ? scrubSecrets(value) : value)
    : formatWorkItemStatusLine(result));
  return 0;
}
