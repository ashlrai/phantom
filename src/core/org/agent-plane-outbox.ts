/**
 * Durable org-membership bus outbox. Recovered from ashlrai/phantom PR #5809 (head
 * 57bd29084a9359e13cad8a55db44fa43cb8aa2bd), src/core/org/agent-plane.ts: only the
 * pending-event delivery loop of syncAgentPlane/writePlane. proposeAgent, initialPlane and the
 * chart writers are NOT recovered; absent or invalid storage is refused, never initialized.
 *
 * Contract: replays existing undelivered ledger entries to the bus in revision order and flips
 * only their busDelivered flag. Events are planning metadata (grantsExecutionAuthority false),
 * never a staffing, claim, or send grant.
 */
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { appendBusInbox, type BusInboxPost } from '../fleet/bus-inbox.js';
import { acquireLocalStoreLockWithOutcome, releaseLocalStoreLock } from '../fleet/local-store-lock.js';
import { localWriteGate } from '../agents/send-gate.js';
import { assurePrivateStoragePath } from '../util/private-storage.js';
import { writePrivateFileAtomically } from '../util/private-file-write.js';
import { OrgStoreError, ORG_STORE_MAX_BYTES, orgRunsRoot, readAgentPlane } from './agent-plane-reader.js';
import { metadata, planeSchema, type OrgPlane } from './agent-plane-schema.js';

/** org.membership body, as in the source PR's bus-v2-schema.ts (not exported by current master). */
const roleId = z.string().regex(/^[a-z][a-z0-9-]{0,63}(?![\s\S])/);
export const orgMembershipBodySchema = z.object({
  kind: z.literal('org.membership'), roleId, revision: z.number().int().positive().safe(),
  tier: z.enum(['LEADER', 'ORCHESTRATOR', 'WORKER_SESSION']), reportsTo: roleId.nullable(), status: z.enum(['active', 'retired']),
  needs: z.array(z.string().regex(/^[a-z][a-z0-9._-]{0,63}(?![\s\S])/)).max(32),
  claimKey: z.string().regex(/^org:[a-z][a-z0-9-]{0,63}(?![\s\S])/), grantsExecutionAuthority: z.literal(false),
}).strict().refine(body => body.claimKey === `org:${body.roleId}`, 'org claim must identify the role');

/** planned: not yet attempted; posted/duplicate: delivered; blocked: known not delivered; unknown: delivery unconfirmed. */
export type OutboxState = 'planned' | 'posted' | 'duplicate' | 'blocked' | 'unknown';
export interface OutboxEvent { revision: number; roleId: string; id: string; state: OutboxState; reason?: string }
export interface OutboxResult { events: OutboxEvent[]; persisted: boolean; complete: boolean }
export interface OutboxDeps {
  busRoot?: string;
  gate?: () => unknown;
  post?: (envelope: unknown, options: { root?: string }) => BusInboxPost;
  write?: typeof writePrivateFileAtomically;
}

const refuse = (message: string): never => { throw new OrgStoreError(message); };

/** Envelope for one edit, with the source PR's stable event ID and body. */
function envelopes(plane: OrgPlane) {
  const rows: Array<{ revision: number; roleId: string; envelope: unknown }> = [];
  for (const entry of plane.ledger.filter(row => !row.busDelivered)) {
    for (const edit of entry.edits) {
      const role = (edit.after ?? edit.before)!;
      const body = orgMembershipBodySchema.parse({ kind: 'org.membership', roleId: role.id, revision: entry.revision,
        tier: role.tier, reportsTo: role.reportsTo, status: edit.after?.status ?? 'retired', needs: role.needs,
        claimKey: `org:${role.id}`, grantsExecutionAuthority: false });
      rows.push({ revision: entry.revision, roleId: role.id, envelope: { id: `org-${plane.storeId}-${entry.revision}-${role.id}`,
        from: entry.proposal.actor, to: 'org', priority: 'P2', ttl: 86_400_000, body } });
    }
  }
  return rows;
}

const eventId = (envelope: unknown) => (envelope as { id: string }).id;

/** Read only: what an apply would replay. Never locks, writes, or posts. */
export function previewOrgOutbox(root = orgRunsRoot()): OutboxEvent[] {
  return envelopes(readAgentPlane(root)).map(row => ({ revision: row.revision, roleId: row.roleId, id: eventId(row.envelope), state: 'planned' as const }));
}

export function applyOrgOutbox(root = orgRunsRoot(), deps: OutboxDeps = {}): OutboxResult {
  const gate = deps.gate ?? localWriteGate;
  const post = deps.post ?? appendBusInbox;
  const write = deps.write ?? writePrivateFileAtomically;
  const anchor = resolve(root);
  const dir = join(anchor, 'org');
  if (gate()) refuse('Org writes paused or killed.');
  readAgentPlane(anchor); // refuse absent, unsafe, invalid or oversized storage before taking the lock
  if (!assurePrivateStoragePath(dir, 'directory', 'inspect-existing', { anchorPath: anchor }).ok) refuse('Org store refused: unsafe directory.');
  const lock = acquireLocalStoreLockWithOutcome(join(dir, 'writer.lock'), 0, { anchorPath: anchor, exactPrivateStorage: true });
  if (lock.state !== 'acquired') return refuse('Org store busy or unavailable; retry.');
  try {
    const plane = readAgentPlane(anchor); // re-read under the lock; the preview may be stale
    const events: OutboxEvent[] = [];
    let persisted = true;
    let stopped = false;
    for (const entry of plane.ledger.filter(row => !row.busDelivered)) {
      const rows = envelopes({ ...plane, ledger: [entry] });
      for (const row of rows) {
        const base = { revision: row.revision, roleId: row.roleId, id: eventId(row.envelope) };
        if (stopped) { events.push({ ...base, state: 'planned', reason: 'Not attempted: an earlier revision is undelivered.' }); continue; }
        if (gate()) { events.push({ ...base, state: 'blocked', reason: 'Org writes paused or killed.' }); stopped = true; continue; }
        let result: BusInboxPost;
        try { result = post(row.envelope, { root: deps.busRoot }); } catch { result = { status: 'unavailable' }; }
        if (result.status === 'posted' || result.status === 'duplicate') { events.push({ ...base, state: result.status }); continue; }
        const unconfirmed = result.status === 'unavailable' || result.status === 'retryable';
        events.push({ ...base, state: unconfirmed ? 'unknown' : 'blocked', reason: `Bus ${result.status}; entry stays undelivered.` });
        stopped = true;
      }
      if (stopped) break; // preserve revision ordering; retry replays this entry with the same stable IDs
      try {
        if (gate()) { stopped = true; persisted = false; break; }
        entry.busDelivered = true; // the only mutation: every role, proposal, budget, revision and ledger row is otherwise untouched
        metadata(planeSchema, plane);
        const json = JSON.stringify(plane, null, 2);
        if (Buffer.byteLength(json) > ORG_STORE_MAX_BYTES) throw new Error('full');
        write(join(dir, `.pending-${randomUUID()}`), join(dir, 'agents.json'), json, { anchorPath: anchor, label: 'Org plane' });
      } catch {
        entry.busDelivered = false;
        persisted = false; stopped = true;
        break;
      }
    }
    return { events, persisted, complete: !stopped };
  } finally { releaseLocalStoreLock(lock.lock); }
}
