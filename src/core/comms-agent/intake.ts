/**
 * Comms inbox intake — the write path into the document `phm comms-agent
 * run` triages. A feeder (a mail bridge, an operator, another agent) drops
 * one inbox document — the same `{messages:[...]}` shape the store keeps —
 * and intake merges it into the pending inbox atomically.
 *
 * Delivery is at-least-once: a message id already pending or already
 * archived is a duplicate and is skipped, so a retried drop can neither
 * duplicate pending mail nor resurrect a resolved or bulk-archived message.
 * Repeats inside the document itself dedupe the same way. An intake that
 * accepts nothing writes nothing — the store's mtime is not churned by a
 * pure-duplicate drop.
 */
import { parseInboxDocument, type InboxMessage } from './triage.js';
import { readArchiveIds, readInbox, writeInbox } from './store.js';

/** Largest batch one intake accepts; a bigger drop splits across calls. */
export const COMMS_INTAKE_MAX_MESSAGES = 200;
/** Largest intake document the CLI reads, covering the schema maximum of
 * `COMMS_INTAKE_MAX_MESSAGES` full-size messages with headroom. */
export const COMMS_INTAKE_MAX_FILE_BYTES = 16 * 1024 * 1024;

export interface CommsIntakeResult {
  /** New messages written to the pending inbox. */
  accepted: number;
  /** Messages skipped because the id is already pending or archived —
   * including repeats inside the document itself. */
  duplicates: number;
  /** Pending depth after the merge — a real count, never a guess. */
  pending: number;
}

export async function intakeCommsInbox(runsDir: string, document: unknown): Promise<CommsIntakeResult> {
  const parsed = parseInboxDocument(document);
  if (!parsed) throw new Error('Inbox intake is not a Comms inbox document.');
  if (parsed.messages.length > COMMS_INTAKE_MAX_MESSAGES) {
    throw new Error(`Inbox intake is limited to ${COMMS_INTAKE_MAX_MESSAGES} messages.`);
  }
  const [inbox, archived] = await Promise.all([readInbox(runsDir), readArchiveIds(runsDir)]);
  const seen = new Set<string>([...archived, ...inbox.messages.map(message => message.id)]);
  const acceptedMessages: InboxMessage[] = [];
  const acceptedRows: Record<string, unknown>[] = [];
  let duplicates = 0;
  parsed.messages.forEach((message, index) => {
    if (seen.has(message.id)) {
      duplicates += 1;
      return;
    }
    seen.add(message.id);
    acceptedMessages.push(message);
    // The stored row keeps every field triage does not use; its id is
    // rewritten to the canonical trimmed form so the row and the message
    // can never disagree about identity.
    acceptedRows.push({ ...parsed.rows[index]!, id: message.id });
  });
  if (acceptedMessages.length > 0) {
    await writeInbox(runsDir, [...inbox.messages, ...acceptedMessages], [...inbox.rows, ...acceptedRows]);
  }
  return { accepted: acceptedMessages.length, duplicates, pending: inbox.messages.length + acceptedMessages.length };
}
