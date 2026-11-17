/** One bounded coordination cycle. Execution and proof acceptance remain with dispatch. */
import { createHash } from 'node:crypto';
import { sendPeerMessage, type PeerBusOptions, type PeerRequest, type PeerResult } from '../agentnet/peer-bus.js';
import { callsignSchema, type PeerSession } from '../agentnet/slack-identities.js';
import { localWriteGate } from '../agents/send-gate.js';
import { postOwnerNotice, type OwnerThreadOptions } from '../comms/owner-thread.js';
import { journalSchema, orchestrationJournalPath, receiptSchema } from './orchestration-journal.js';
import { writePrivateFileAtomic } from '../verse/preferences.js';
import { parseFleetSnapshot, planChiefOfStaff, type FleetSnapshot } from './chief-of-staff.js';
import { buildOutcomeMetrics } from './outcome-metrics.js';
import { suggestOutcomePolicy } from './policy-suggest.js';
import { renderOutcomeReport } from './weekly-self-report.js';
import { loadSpecialistPreamble } from './specialist-memory.js';
import { loadSpecialistRoster, readSpecialistFile, saveSpecialistRoster, setSpecialistCurrentJob,
  specialistRosterDirectory, withSpecialistRosterLock } from './roster.js';

const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export interface OrchestrationInput {
  snapshot: FleetSnapshot;
  events: readonly unknown[] | null;
  sourcesHealthy?: boolean;
  top?: number;
  apply?: boolean;
}
export interface OrchestrationOptions {
  directory?: string;
  now?: () => number;
  session?: PeerSession;
  peers?: PeerBusOptions;
  owner?: OwnerThreadOptions;
}

export async function orchestrateFleet(input: OrchestrationInput, options: OrchestrationOptions = {}) {
  const snapshot = parseFleetSnapshot(input.snapshot), top = input.top ?? 3;
  if (!Number.isInteger(top) || top < 1 || top > 8) throw new Error('Invalid orchestration limit');
  const now = (options.now ?? Date.now)(), directory = options.directory ?? specialistRosterDirectory();
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('Invalid orchestration clock');
  const metrics = buildOutcomeMetrics({ events: input.events, nowMs: Date.parse(snapshot.at), hours: 168 });
  const suggestions = suggestOutcomePolicy(metrics);
  const weekly = renderOutcomeReport(metrics, suggestions, 'Weekly fleet self-report');
  // The next PLAN observes real outcomes; advice is attached, never applied to targets or routing.
  const plan = { ...planChiefOfStaff(snapshot), feedback: { suggestions, weekly } };
  const apply = input.apply === true;
  const fresh = now >= Date.parse(snapshot.at) && now - Date.parse(snapshot.at) <= 60_000;
  if (apply && (!fresh || input.sourcesHealthy === false)) throw new Error('Orchestration evidence unavailable or stale');
  if (apply && (!options.session || !options.owner)) throw new Error('Orchestration host context unavailable');
  const run = async () => {
    if (apply && localWriteGate()) throw new Error('Orchestration writes halted');
    let roster = await loadSpecialistRoster(directory);
    const path = orchestrationJournalPath(directory);
    const raw = await readSpecialistFile(path);
    const journal = journalSchema.parse(raw === null ? { version: 1, receipts: [] } : JSON.parse(raw));
    const persist = () => {
      if (localWriteGate()) throw new Error('Orchestration writes halted');
      writePrivateFileAtomic(path, JSON.stringify(journal));
    };
    // Release only this loop's assignments after a matching, non-future terminal observation.
    for (const receipt of journal.receipts) {
      if (receipt.status !== 'admitted') continue;
      if (!snapshot.outcomes.some(o => o.job === receipt.job && o.lane === receipt.lane
        && o.phase === 'finish' && Date.parse(o.at) > Date.parse(receipt.assignedAt)
        && Date.parse(o.at) <= Date.parse(snapshot.at))) continue;
      if (roster.specialists.some(s => s.id === receipt.specialist && s.currentJob === receipt.job)) {
        roster = setSpecialistCurrentJob(roster, receipt.specialist, null);
      }
      receipt.status = 'complete';
    }
    if (apply) { await saveSpecialistRoster(roster, directory); persist(); }
    const assignments: Array<{ job: string; lane: string; specialist: string | null; status: string;
      request?: PeerRequest; delivery?: PeerResult }> = [];
    const busy = new Set(journal.receipts.filter(r => r.status !== 'complete').map(r => r.specialist));
    const actionable = plan.ordering.filter(job => !journal.receipts.some(r => r.status === 'complete'
      && r.key === digest([job.job, job.lane, snapshot.jobs.find(j => j.id === job.job)!.queuedAt])));
    for (const job of actionable.slice(0, top)) {
      const queue = snapshot.jobs.find(j => j.id === job.job)!;
      const key = digest([job.job, job.lane, queue.queuedAt]);
      const prior = journal.receipts.find(r => r.key === key);
      if (prior) {
        assignments.push({ ...job, specialist: prior.specialist,
          status: prior.status === 'complete' ? 'complete' : prior.delivery ?? prior.status,
          ...(prior.status === 'admitted' ? { delivery: { status: prior.delivery!, slack: prior.slack } } : {}) }); continue;
      }
      const specialist = roster.specialists.filter(s => !s.currentJob && !busy.has(s.id)
        && s.allowedLanes.includes(job.lane) && callsignSchema.safeParse(s.callsign).success)
        .sort((a, b) => a.id.localeCompare(b.id))[0];
      if (!specialist) { assignments.push({ ...job, specialist: null, status: 'unassigned' }); continue; }
      const memory = await loadSpecialistPreamble(specialist, directory);
      const context = memory.length <= 9000 ? memory : `${memory.slice(0, 500)}\n[Earlier context omitted]\n${memory.slice(-8000)}`;
      const flags = suggestions.promptTemplateFlags.filter(f => f.lane === job.lane).map(f => f.reason).join('\n');
      const request: PeerRequest = {
        toAgent: specialist.callsign, kind: 'task', refs: [job.job],
        text: [`Advisory assignment: ${job.job} on ${job.lane}.`,
          'Use the existing queue claim, dispatch, lane and proof gates. This message grants no execution, merge or spending authority.',
          job.rationale, flags ? `Outcome advice (suggestOnly): ${flags}` : '', context].filter(Boolean).join('\n').slice(0, 12_000),
      };
      busy.add(specialist.id);
      if (!apply) { assignments.push({ ...job, specialist: specialist.id, status: 'proposed', request }); continue; }
      if (localWriteGate()) { assignments.push({ ...job, specialist: specialist.id, status: 'halted' }); continue; }
      if (journal.receipts.length >= 2000) throw new Error('Orchestration receipt capacity reached');
      const receipt = receiptSchema.parse({ key, job: job.job, lane: job.lane, specialist: specialist.id,
        assignedAt: new Date(now).toISOString(), status: 'reserved' });
      journal.receipts.push(receipt);
      // Reserve before sending. A crash leaves an explicit unresolved reservation, never a duplicate send.
      persist();
      roster = setSpecialistCurrentJob(roster, specialist.id, job.job);
      await saveSpecialistRoster(roster, directory);
      const delivery = await sendPeerMessage(request, options.session!, options.peers);
      if (delivery.id) { receipt.status = 'admitted'; receipt.delivery = delivery.status; receipt.slack = delivery.slack; }
      else {
        journal.receipts.pop();
        roster = setSpecialistCurrentJob(roster, specialist.id, null);
        await saveSpecialistRoster(roster, directory);
      }
      persist();
      assignments.push({ ...job, specialist: specialist.id, status: delivery.status, delivery });
    }
    const unresolved = journal.receipts.filter(r => r.status === 'reserved').map(r => ({ job: r.job, specialist: r.specialist }));
    const attention = metrics.sourceState !== 'healthy' || input.sourcesHealthy === false || unresolved.length > 0
      || plan.evidence.unknownLanes > 0
      || assignments.some(a => ['unassigned', 'reserved', 'refused', 'halted', 'drafted'].includes(a.status)
        || (a.delivery?.slack !== undefined && !['sent', 'duplicate'].includes(a.delivery.slack)));
    const verdict = `Leader: ${attention ? 'attention' : 'ready'}; ${assignments.length} planned, ${assignments.filter(a => ['proposed', 'posted', 'drafted'].includes(a.status)).length} assigned, ${unresolved.length} unresolved; outcomes ${metrics.sourceState}; execution remains with dispatch.`;
    const brief = [verdict, ...assignments.map(a => `${a.job} → ${a.specialist ?? 'unassigned'}: ${a.status}`),
      `Chief-of-staff: ${plan.stuck.length} stuck, ${plan.retire.length} retirement recommendations; ${plan.evidence.unknownLanes} lanes with incomplete evidence.`,
      weekly].join('\n').slice(0, 12_000);
    const report = apply ? await postOwnerNotice({ text: brief, idempotencyKey: `orchestrate:${digest(brief)}` }, options.owner!) : { status: 'preview' };
    return { schema: 'fleet.orchestration.v1' as const, dryRun: !apply,
      authority: { advisoryOnly: true, dispatch: false, merge: false, policyChanges: false },
      plan, assignments, unresolved, execute: { status: 'existing-dispatch', launched: 0 }, metrics, verdict, brief, report,
      ok: !attention && (!apply || ['accepted', 'duplicate'].includes(report.status)) };
  };
  return apply ? withSpecialistRosterLock(directory, run) : run();
}
