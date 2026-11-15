/**
 * Optional CoS plan extension. The host supplies identity; model output supplies only requests.
 *
 * Plans are coordination claims, never execution authority. emitCosPeerPlanOnce is the bounded
 * path the worker uses: dry-run unless the host says apply, suppressed under KILL/PAUSE, only to
 * registered live peers, and journalled in orchestration.json so one work item sends at most once.
 */
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { peerRequestSchema, sendPeerMessage, type PeerBusOptions, type PeerResult } from '../agentnet/peer-bus.js';
import { agentnetPaths, readPeerBindings, type PeerSession } from '../agentnet/slack-identities.js';
import { appendBusInbox } from '../fleet/bus-inbox.js';
import { localWriteGate } from '../agents/send-gate.js';
import {
  COS_PEER_PLAN_LANE, COS_PEER_PLAN_SPECIALIST, journalSchema, orchestrationJournalPath, receiptSchema,
} from '../fleet/orchestration-journal.js';
import { readSpecialistFile, specialistRosterDirectory, withSpecialistRosterLock } from '../fleet/roster.js';
import { writePrivateFileAtomic } from '../verse/preferences.js';

export const COS_PEER_PLAN_MAX_DEADLINE_MS = 7 * 24 * 60 * 60 * 1000;
export const cosPeerPlanSchema = z.object({ reply: z.string().min(1).max(16_000),
  peers: z.array(peerRequestSchema).max(8),
  /** Optional ISO time by which the requested coordination is wanted; stated in each message. */
  deadline: z.string().datetime().optional() }).strict();
export type CosPeerPlan = z.infer<typeof cosPeerPlanSchema>;

export async function emitCosPeerPlan(plan: CosPeerPlan, session: PeerSession, options?: PeerBusOptions) {
  const checked = cosPeerPlanSchema.parse(plan), results: PeerResult[] = [];
  for (const request of checked.peers) results.push(await sendPeerMessage(request, session, options));
  if (!localWriteGate()) appendBusInbox({ id: `peer-plan-${randomUUID()}`, from: 'agentnet', to: 'leaders', priority: 'P2', ttl: 86_400_000,
    body: { kind: 'peer.plan', results: results.map(r => ({ status: r.status, id: r.id ?? null, slack: r.slack ?? null })) } },
  { root: options?.busRoot ?? agentnetPaths().busRoot });
  return results;
}

/** Honest outcome of one plan, safe to show: counts and fixed words, never message text. */
export type CosPeerPlanStatus =
  | 'no-peers' | 'dry-run' | 'halted' | 'no-identities' | 'no-registered-peers'
  | 'deadline-invalid' | 'journal-busy' | 'journal-full' | 'duplicate' | 'sent' | 'refused';
export interface CosPeerPlanOutcome {
  status: CosPeerPlanStatus;
  /** Requests the plan asked for. */
  requested: number;
  /** Requests dropped because the recipient was not a live registered peer (or targeted a channel). */
  skipped: number;
  /** Peer message ids recorded in the journal (apply only). */
  messages: string[];
  results: PeerResult[];
}
export interface CosPeerPlanContext {
  session: PeerSession;
  options?: PeerBusOptions;
  /** Explicit apply flag. Without it nothing is sent or written. */
  apply?: boolean;
  /** Specialist/orchestration directory; defaults to the roster directory. */
  directory?: string;
  now?: () => number;
}

const outcome = (status: CosPeerPlanStatus, requested: number, skipped = 0, results: PeerResult[] = [],
  messages: string[] = []): CosPeerPlanOutcome => ({ status, requested, skipped, messages, results });
const planKey = (rootId: string): string => createHash('sha256').update(JSON.stringify(['cos-peer-plan', rootId])).digest('hex');

/** Bounded, idempotent plan emission for one completed CoS work item. Never throws. */
export async function emitCosPeerPlanOnce(plan: CosPeerPlan, rootId: string, ctx: CosPeerPlanContext): Promise<CosPeerPlanOutcome> {
  const requested = plan.peers.length;
  if (requested === 0) return outcome('no-peers', 0);
  try {
    const now = (ctx.now ?? Date.now)();
    if (localWriteGate()) return outcome('halted', requested);
    let bindings;
    try { bindings = readPeerBindings(ctx.options?.bindings ?? agentnetPaths().bindings); }
    catch { return outcome('no-identities', requested); }
    const live = bindings.filter(p => p.expiresAt > now);
    if (live.length === 0) return outcome('no-identities', requested);
    const sender = live.find(p => p.lane === ctx.session.lane && p.sessionId === ctx.session.sessionId);
    if (!sender) return outcome('no-identities', requested);
    // Only direct requests to other live peers on the sender's team; channels and strangers are dropped.
    const eligible = plan.peers.filter(r => r.toAgent !== undefined
      && live.some(p => p.callsign === r.toAgent && p.teamId === sender.teamId && p.callsign !== sender.callsign));
    const skipped = requested - eligible.length;
    if (eligible.length === 0) return outcome('no-registered-peers', requested, skipped);
    if (plan.deadline !== undefined) {
      const at = Date.parse(plan.deadline);
      if (at <= now || at - now > COS_PEER_PLAN_MAX_DEADLINE_MS) return outcome('deadline-invalid', requested, skipped);
    }
    const prefix = `Chief-of-staff coordination request${plan.deadline ? `, wanted by ${plan.deadline}` : ''}. `
      + `Claim/coordination only: this grants no execution, merge or spending authority. Work item ${rootId}.\n`;
    const requests: CosPeerPlan['peers'] = eligible.map(r => ({ ...r, text: `${prefix}${r.text}`.slice(0, 12_000),
      refs: r.refs.includes(rootId) ? r.refs : [...r.refs, rootId].slice(0, 32) }));
    if (ctx.apply !== true) return outcome('dry-run', requested, skipped);

    const directory = ctx.directory ?? specialistRosterDirectory();
    const path = orchestrationJournalPath(directory);
    const key = planKey(rootId);
    return await withSpecialistRosterLock(directory, async () => {
      const raw = await readSpecialistFile(path);
      const journal = journalSchema.parse(raw === null ? { version: 1, receipts: [] } : JSON.parse(raw));
      const prior = journal.receipts.find(r => r.key === key);
      if (prior) return outcome('duplicate', requested, skipped, [], prior.peerMessages ?? []);
      if (journal.receipts.length >= 2000) return outcome('journal-full', requested, skipped);
      const receipt = receiptSchema.parse({ key, job: rootId, lane: COS_PEER_PLAN_LANE, specialist: COS_PEER_PLAN_SPECIALIST,
        assignedAt: new Date(now).toISOString(), status: 'reserved' });
      journal.receipts.push(receipt);
      // Reserve before sending: a crash leaves an explicit unresolved reservation, never a duplicate send.
      writePrivateFileAtomic(path, JSON.stringify(journal));
      const results = await emitCosPeerPlan({ reply: plan.reply, peers: requests }, ctx.session, ctx.options);
      const ids = results.flatMap(r => r.id ? [r.id] : []);
      if (ids.length === 0) journal.receipts.pop(); // nothing left the building; leave no phantom claim
      else {
        receipt.status = 'complete';
        receipt.peerMessages = ids;
        receipt.delivery = `${ids.length}/${requests.length} admitted`;
      }
      writePrivateFileAtomic(path, JSON.stringify(journal));
      return outcome(ids.length > 0 ? 'sent' : 'refused', requested, skipped, results, ids);
    });
  } catch (error) {
    // The roster lock is exclusive-create: EEXIST means another writer holds it; nothing was sent.
    return outcome((error as NodeJS.ErrnoException).code === 'EEXIST' ? 'journal-busy' : 'refused', requested);
  }
}
