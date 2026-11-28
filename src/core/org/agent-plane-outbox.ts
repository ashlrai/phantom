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
import { join } from 'node:path';
import { z } from 'zod';
import { appendBusInbox, type BusInboxPost } from '../fleet/bus-inbox.js';
import { acquireLocalStoreLockWithOutcome, releaseLocalStoreLock } from '../fleet/local-store-lock.js';
import { localWriteGate } from '../agents/send-gate.js';
import { assurePrivateStoragePath } from '../util/private-storage.js';
import { writePrivateFileAtomically } from '../util/private-file-write.js';
import {
  ORG_STORE_MAX_BYTES,
  orgPlanePaths,
  orgRunsRoot,
  readAgentPlane,
  refuseOrgStore,
  undeliveredLedgerEntries,
} from './agent-plane-reader.js';
import {
  ORG_PLANE_STATUSES,
  ORG_PLANE_TIERS,
  metadata,
  orgPlaneIdSchema,
  orgPlaneNeedTokenSchema,
  planeSchema,
  type OrgPlane,
} from './agent-plane-schema.js';

/** org.membership body, as in the source PR's bus-v2-schema.ts (not exported by current master). */
export const orgMembershipBodySchema = z.object({
  kind: z.literal('org.membership'), roleId: orgPlaneIdSchema, revision: z.number().int().positive().safe(),
  tier: z.enum(ORG_PLANE_TIERS), reportsTo: orgPlaneIdSchema.nullable(), status: z.enum(ORG_PLANE_STATUSES),
  needs: z.array(orgPlaneNeedTokenSchema).max(32),
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

interface OutboxEnvelope {
  id: string;
  from: string;
  to: 'org';
  priority: 'P2';
  ttl: number;
  body: z.infer<typeof orgMembershipBodySchema>;
}

/** Envelope for one edit, with the source PR's stable event ID and body. */
function envelopes(plane: OrgPlane): Array<{ revision: number; roleId: string; envelope: OutboxEnvelope }> {
  const rows: Array<{ revision: number; roleId: string; envelope: OutboxEnvelope }> = [];
  for (const entry of undeliveredLedgerEntries(plane)) {
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

/** Read only: what an apply would replay. Never locks, writes, or posts. */
export function previewOrgOutbox(root = orgRunsRoot()): OutboxEvent[] {
  return envelopes(readAgentPlane(root)).map(row => ({ revision: row.revision, roleId: row.roleId, id: row.envelope.id, state: 'planned' as const }));
}

export function applyOrgOutbox(root = orgRunsRoot(), deps: OutboxDeps = {}): OutboxResult {
  const gate = deps.gate ?? localWriteGate;
  const post = deps.post ?? appendBusInbox;
  const write = deps.write ?? writePrivateFileAtomically;
  const { anchor, dir, file, lockFile } = orgPlanePaths(root);
  if (gate()) refuseOrgStore('Org writes paused or killed.');
  readAgentPlane(anchor); // refuse absent, unsafe, invalid or oversized storage before taking the lock
  if (!assurePrivateStoragePath(dir, 'directory', 'inspect-existing', { anchorPath: anchor }).ok) refuseOrgStore('Org store refused: unsafe directory.');
  const lock = acquireLocalStoreLockWithOutcome(lockFile, 0, { anchorPath: anchor, exactPrivateStorage: true });
  if (lock.state !== 'acquired') refuseOrgStore('Org store busy or unavailable; retry.');
  try {
    const plane = readAgentPlane(anchor); // re-read under the lock; the preview may be stale
    const events: OutboxEvent[] = [];
    let persisted = true;
    let stopped = false;
    for (const entry of undeliveredLedgerEntries(plane)) {
      const rows = envelopes({ ...plane, ledger: [entry] });
      for (const row of rows) {
        const base = { revision: row.revision, roleId: row.roleId, id: row.envelope.id };
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
        write(join(dir, `.pending-${randomUUID()}`), file, json, { anchorPath: anchor, label: 'Org plane' });
      } catch {
        entry.busDelivered = false;
        persisted = false; stopped = true;
        break;
      }
    }
    return { events, persisted, complete: !stopped };
  } finally { releaseLocalStoreLock(lock.lock); }
}
