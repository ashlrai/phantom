import { randomUUID } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { appendBusInbox } from '../fleet/bus-inbox.js';
import { acquireLocalStoreLockWithOutcome, releaseLocalStoreLock } from '../fleet/local-store-lock.js';
import { localWriteGate } from '../agents/send-gate.js';
import { orgMembershipBodySchema } from '../agents/bus-v2-schema.js';
import { assurePrivateStoragePath } from '../util/private-storage.js';
import { readStableRegularFile } from '../util/stable-file-read.js';
import { writePrivateFileAtomically } from '../util/private-file-write.js';
import { ensurePrivateDirectory } from '../verse/preferences.js';
import { initialPlane, metadata, planeSchema, proposalSchema, validateChart, type OrgPlane } from './agent-plane-schema.js';

export const orgRunsRoot = () => process.env['ASHLR_RUNS_DIR'] ?? join(homedir(), '.ashlr-runs');
const maxBytes = 4 * 1024 * 1024;
export function readAgentPlane(root = orgRunsRoot()): OrgPlane {
  const file = join(resolve(root), 'org', 'agents.json');
  try { lstatSync(file); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return initialPlane();
    throw new Error('Org store unavailable.');
  }
  const read = readStableRegularFile(file, { anchorPath: resolve(root), maxFileBytes: maxBytes, remainingBytes: maxBytes });
  if (!read.ok) throw new Error('Org store unavailable.');
  let raw: unknown;
  try { raw = JSON.parse(read.text); } catch { throw new Error('Invalid org store.'); }
  const plane = metadata(planeSchema, raw);
  validateChart(plane.agents);
  if (plane.revision !== plane.ledger.length || plane.ledger.some((entry, index) => entry.revision !== index + 1)) throw new Error('Invalid org ledger.');
  return plane;
}

/** One atomic document contains both chart and audit/outbox; no unaudited chart commit. */
export function proposeAgent(raw: unknown, apply = false, root = orgRunsRoot(), busRoot?: string): OrgPlane {
  const proposal = metadata(proposalSchema, raw);
  return writePlane(root, busRoot, plane => {
    if (proposal.expectedRevision !== plane.revision) throw new Error('Org revision changed; read and re-propose.');
    const actor = plane.agents.find(role => role.id === proposal.actor && role.status === 'active');
    if (proposal.actor !== 'board' && (!actor || actor.tier === 'WORKER_SESSION')) throw new Error('Proposals require board, leader or an active orchestrator.');
    const next = new Map(plane.agents.map(role => [role.id, role]));
    const change = proposal.change;
    if (change.kind === 'upsert') next.set(change.role.id, change.role);
    if (change.kind === 'retire') {
      if (!next.has(change.id)) throw new Error('Unknown role.');
      for (const role of next.values()) if (role.id === change.id || role.reportsTo === change.id) next.set(role.id, { ...role, status: 'retired' });
    }
    if (change.kind === 'revoke') {
      const previous = plane.ledger.find(entry => entry.revision === change.revision && entry.applied);
      if (!previous) throw new Error('No applied revision to revoke.');
      for (const edit of previous.edits) {
        const id = (edit.after ?? edit.before)!.id;
        if (JSON.stringify(next.get(id) ?? null) !== JSON.stringify(edit.after)) throw new Error('Role changed since that edit; re-scope explicitly.');
        if (edit.before) next.set(id, edit.before); else next.delete(id);
      }
    }
    validateChart([...next.values()]);
    const ids = new Set([...next.keys(), ...plane.agents.map(role => role.id)]);
    const edits = [...ids].map(id => ({ before: plane.agents.find(role => role.id === id) ?? null, after: next.get(id) ?? null }))
      .filter(edit => JSON.stringify(edit.before) !== JSON.stringify(edit.after));
    if (actor?.tier === 'ORCHESTRATOR' && edits.some(edit => [edit.before, edit.after].some(role => role && (role.tier !== 'WORKER_SESSION' || role.reportsTo !== actor.id)))) throw new Error('Orchestrators may only re-scope their worker sessions.');
    if (apply) plane.agents = [...next.values()];
    plane.ledger.push({ revision: ++plane.revision, at: new Date().toISOString(), proposal, applied: apply, edits, busDelivered: !apply || edits.length === 0 });
  });
}

export function syncAgentPlane(root = orgRunsRoot(), busRoot?: string): OrgPlane {
  return writePlane(root, busRoot, () => {});
}

function writePlane(root: string, busRoot: string | undefined, update: (plane: OrgPlane) => void): OrgPlane {
  const checkGate = () => { if (localWriteGate()) throw new Error('Org writes paused or killed.'); };
  checkGate();
  root = resolve(root);
  const dir = join(root, 'org');
  ensurePrivateDirectory(root); ensurePrivateDirectory(dir);
  if (!assurePrivateStoragePath(dir, 'directory', 'inspect-existing', { anchorPath: root }).ok) throw new Error('Unsafe org directory.');
  const lock = acquireLocalStoreLockWithOutcome(join(dir, 'writer.lock'), 0, { anchorPath: root, exactPrivateStorage: true });
  if (lock.state !== 'acquired') throw new Error('Org store busy or unavailable; retry.');
  try {
    const plane = readAgentPlane(root);
    update(plane);
    const save = () => {
      metadata(planeSchema, plane);
      const json = JSON.stringify(plane, null, 2);
      if (Buffer.byteLength(json) > maxBytes) throw new Error('Org ledger full; preserve it before archival.');
      checkGate();
      writePrivateFileAtomically(join(dir, `.pending-${randomUUID()}`), join(dir, 'agents.json'), json, { anchorPath: root, label: 'Org plane' });
    };
    save();
    for (const entry of plane.ledger.filter(row => !row.busDelivered)) {
      let delivered = true;
      for (const edit of entry.edits) {
        checkGate();
        const role = (edit.after ?? edit.before)!;
        const body = orgMembershipBodySchema.parse({ kind: 'org.membership', roleId: role.id, revision: entry.revision,
          tier: role.tier, reportsTo: role.reportsTo, status: edit.after?.status ?? 'retired', needs: role.needs,
          claimKey: `org:${role.id}`, grantsExecutionAuthority: false });
        const result = appendBusInbox({ id: `org-${plane.storeId}-${entry.revision}-${role.id}`, from: entry.proposal.actor, to: 'org', priority: 'P2', ttl: 86_400_000, body }, { root: busRoot });
        if (result.status !== 'posted' && result.status !== 'duplicate') { delivered = false; break; }
      }
      if (!delivered) break; // Preserve revision ordering and retry the durable outbox with org sync.
      entry.busDelivered = true;
      save();
    }
    return plane;
  } finally { releaseLocalStoreLock(lock.lock); }
}

export function orgBoardView(plane: OrgPlane) {
  return { schema: 'org.board.v1', revision: plane.revision, board: 'Mason', grantsExecutionAuthority: false,
    agents: plane.agents, pendingProposals: plane.ledger.filter(row => !row.applied),
    recentEdits: plane.ledger.filter(row => row.applied).slice(-20), pendingBusEvents: plane.ledger.filter(row => !row.busDelivered).length };
}
