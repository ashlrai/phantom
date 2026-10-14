/** Manual local coordinator. It neither sends tasks nor qualifies saved provider profiles. */
import { join } from 'node:path';
import { ashlrHome } from '../cloud/store.js';
import { CompanionCoordinationStore, companionHash, companionId, companionObject, companionText, companionSafeText, companionTime, companionToken,
  companionTaskScope, normalizeCompanionTaskInput, validCompanionIdentity, validCompanionReviewer, validCompanionTaskInput } from './coordination-store.js';
import { COMPANION_LIMITS, companionCanonical, companionDigest, companionIdentityEqual, companionTaskId, companionTextDigest,
  type CompanionAttempt, type CompanionCommand, type CompanionCoordinator, type CompanionEvent, type CompanionFailure,
  type CompanionHostHooks, type CompanionHostObservation, type CompanionLedger, type CompanionNotification,
  type CompanionTask, type CompanionWrite } from './coordination-types.js';
export type * from './coordination-types.js';

function refuse(reason: CompanionFailure): never { throw { reason }; }
function failure(reason: CompanionFailure): CompanionWrite { return { ok: false, reason, dispatchAuthorized: false }; }
function validateCommand(value: unknown): value is CompanionCommand {
  if (!companionObject(value, ['kind', 'commandId', 'expectedRevision'], ['task', 'taskId', 'assignee', 'ownerId', 'leaseMs',
    'attemptId', 'epoch', 'packetDigest', 'result', 'report', 'sourceReference', 'reportId', 'checkedResultDigest', 'reviewer', 'acceptanceMet', 'eventId'])) return false;
  const command = value as CompanionCommand;
  const base = ['kind', 'commandId', 'expectedRevision'];
  const shape = (keys: string[]) => companionObject(command, [...base, ...keys]);
  if (!companionToken(command.commandId) || !Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 0) return false;
  if (command.kind === 'create') return shape(['task']) && validCompanionTaskInput(command.task);
  if (!companionId('taskId' in command ? command.taskId : null)) return false;
  switch (command.kind) {
    case 'assign': return shape(['taskId', 'assignee', 'ownerId', 'leaseMs']) && validCompanionIdentity(command.assignee) &&
      companionToken(command.ownerId) && Number.isSafeInteger(command.leaseMs) && command.leaseMs > 0 && command.leaseMs <= COMPANION_LIMITS.leaseMaxMs;
    case 'handoff': return shape(['taskId', 'attemptId', 'epoch', 'ownerId']) && companionHash(command.attemptId) &&
      Number.isSafeInteger(command.epoch) && command.epoch > 0 && companionToken(command.ownerId);
    case 'report': return shape(['taskId', 'attemptId', 'epoch', 'packetDigest', 'result', 'report', 'sourceReference']) &&
      companionHash(command.attemptId) && Number.isSafeInteger(command.epoch) && command.epoch > 0 && companionHash(command.packetDigest) &&
      companionSafeText(command.result, COMPANION_LIMITS.resultBytes) && companionSafeText(command.report, COMPANION_LIMITS.reportBytes) && companionSafeText(command.sourceReference, 2000);
    case 'operator-review': return shape(['taskId', 'reportId', 'checkedResultDigest', 'reviewer', 'acceptanceMet']) && companionHash(command.reportId) &&
      companionHash(command.checkedResultDigest) && validCompanionReviewer(command.reviewer) && typeof command.acceptanceMet === 'boolean';
    case 'cancel': return shape(['taskId', 'attemptId']) && companionHash(command.attemptId);
    case 'notification-ack': return shape(['taskId', 'eventId']) && companionHash(command.eventId);
    default: return false;
  }
}
function event(task: CompanionTask, commandId: string, kind: string, at: string, attemptId: string | null = null,
  reportId: string | null = null, source: CompanionEvent['source'] = 'local-manual'): void {
  if (task.events.length >= COMPANION_LIMITS.events) refuse('capacity');
  task.events.push({ seq: task.events.length + 1, commandId, type: kind, at, attemptId, reportId, source });
  task.updatedAt = at;
}
function notify(task: CompanionTask, reason: CompanionNotification['reason'], at: string): void {
  task.notification = { eventId: companionDigest([task.id, task.events.at(-1)?.commandId, reason]), state: 'pending', reason, at };
}
function current(task: CompanionTask, attemptId: string): CompanionAttempt {
  const attempt = task.attempts.at(-1);
  if (!attempt || attempt.id !== attemptId) refuse('held');
  return attempt;
}
function apply(state: CompanionLedger, command: CompanionCommand, taskId: string, at: string): void {
  if (command.kind === 'create') {
    const scope = normalizeCompanionTaskInput(command.task);
    const existing = state.tasks[taskId];
    if (existing) {
      if (companionCanonical(companionTaskScope(existing)) !== companionCanonical(scope)) refuse('conflict');
      // Semantic duplicate creation retains the existing task; no second task or notification.
      return;
    }
    if (Object.keys(state.tasks).length >= COMPANION_LIMITS.tasks) refuse('capacity');
    const task: CompanionTask = { ...scope, id: taskId, createdAt: at, updatedAt: at, state: 'draft',
      attempts: [], reports: [], verifications: [], events: [], notification: null };
    event(task, command.commandId, command.kind, at); state.tasks[taskId] = task; return;
  }
  const task = state.tasks[taskId];
  if (!task) refuse('not-found');
  if (at < task.updatedAt) refuse('held');
  switch (command.kind) {
    case 'assign': {
      const previous = task.attempts.at(-1);
      const canceledBeforeIntent = previous?.contact === 'not-contacted' && previous.handoffAt === null &&
        previous.cancelRequestedAt !== null && previous.providerRunId === null;
      if (task.state === 'verified' || previous && !['proved-unstarted', 'cancel-confirmed'].includes(previous.contact) && !canceledBeforeIntent) refuse('held');
      if (task.attempts.length >= task.maxAttempts) refuse('capacity');
      const epoch = task.attempts.length + 1;
      const attempt: CompanionAttempt = { id: companionDigest([taskId, epoch, command.commandId]), epoch,
        assignee: structuredClone(command.assignee), ownerId: command.ownerId, claimedAt: at,
        leaseExpiresAt: new Date(Date.parse(at) + command.leaseMs).toISOString(), packetDigest: task.packetDigest,
        contact: 'not-contacted', handoffAt: null, cancelRequestedAt: null, providerRunId: null, observationReference: null };
      // All earlier reports remain history but cannot verify a later ownership epoch.
      for (const report of task.reports) report.stale = true;
      task.attempts.push(attempt); task.state = 'assigned';
      event(task, command.commandId, command.kind, at, attempt.id); break;
    }
    case 'handoff': {
      const attempt = current(task, command.attemptId);
      if (attempt.epoch !== command.epoch || attempt.ownerId !== command.ownerId || attempt.contact !== 'not-contacted' ||
        attempt.cancelRequestedAt !== null || Date.parse(attempt.leaseExpiresAt) <= Date.parse(at)) refuse('held');
      attempt.contact = 'intent'; attempt.handoffAt = at; task.state = 'handoff-intent';
      event(task, command.commandId, command.kind, at, attempt.id); break;
    }
    case 'report': {
      const attempt = task.attempts.find(item => item.id === command.attemptId);
      if (!attempt || attempt.epoch !== command.epoch) refuse('held');
      const id = companionDigest([taskId, attempt.id, command.packetDigest, companionTextDigest(command.result),
        companionTextDigest(command.report), companionTextDigest(command.sourceReference)]);
      if (task.reports.some(report => report.id === id)) return;
      if (task.reports.length >= COMPANION_LIMITS.reports) refuse('capacity');
      const stale = attempt !== task.attempts.at(-1) || command.packetDigest !== task.packetDigest ||
        ['proved-unstarted', 'cancel-confirmed'].includes(attempt.contact) || task.state === 'verified';
      const report = { id, attemptId: attempt.id, epoch: attempt.epoch,
        packetDigest: command.packetDigest, producer: structuredClone(attempt.assignee), result: command.result, resultDigest: companionTextDigest(command.result),
        report: command.report, reportDigest: companionTextDigest(command.report), source: 'manual-unverified' as const,
        sourceReference: command.sourceReference, submittedAt: at, stale };
      // A new current result supersedes earlier drafts from this ownership epoch.
      // Their bytes and review history remain available, but cannot verify the latest result.
      if (!stale) for (const previous of task.reports) {
        if (previous.attemptId === attempt.id) previous.stale = true;
      }
      task.reports.push(report);
      const changedState = !stale && task.state !== 'cancel-requested' && task.state !== 'reported';
      if (changedState) task.state = 'reported';
      event(task, command.commandId, command.kind, at, attempt.id, report.id);
      if (!stale && task.state !== 'cancel-requested') notify(task, 'needs-review', at); break;
    }
    case 'operator-review': {
      const report = task.reports.find(item => item.id === command.reportId);
      if (!report || report.resultDigest !== command.checkedResultDigest || companionTextDigest(report.result) !== command.checkedResultDigest ||
        command.reviewer.kind === 'peer' && companionIdentityEqual(command.reviewer.identity, report.producer)) refuse('held');
      const id = companionDigest([taskId, report.id, command.checkedResultDigest, command.reviewer, command.acceptanceMet]);
      if (task.verifications.some(verification => verification.id === id)) return;
      if (task.verifications.length >= COMPANION_LIMITS.verifications) refuse('capacity');
      const attempt = task.attempts.find(item => item.id === report.attemptId);
      const applied = command.acceptanceMet && !report.stale && attempt === task.attempts.at(-1) &&
        attempt?.cancelRequestedAt === null && !['proved-unstarted', 'cancel-confirmed'].includes(attempt?.contact ?? '') && task.state !== 'verified';
      const beforeState = task.state;
      task.verifications.push({ id, reportId: report.id,
        checkedResultDigest: command.checkedResultDigest, reviewer: structuredClone(command.reviewer), acceptanceMet: command.acceptanceMet,
        applied, source: 'manual-operator-review', at });
      if (applied) task.state = 'verified';
      else if (!report.stale && !command.acceptanceMet && !['verified', 'cancel-requested'].includes(task.state)) task.state = 'needs-attention';
      event(task, command.commandId, command.kind, at, report.attemptId, report.id);
      if (task.state !== beforeState) notify(task, applied ? 'verified' : 'needs-attention', at); break;
    }
    case 'cancel': {
      const attempt = current(task, command.attemptId);
      if (task.state === 'verified' || attempt.cancelRequestedAt !== null) refuse('held');
      attempt.cancelRequestedAt = at; task.state = 'cancel-requested';
      // This records a request only. Neither local expiry nor missing receipts confirms remote cancellation.
      event(task, command.commandId, command.kind, at, attempt.id); notify(task, 'cancel-requested', at); break;
    }
    case 'notification-ack': {
      if (!task.notification || task.notification.eventId !== command.eventId || task.notification.state !== 'pending') refuse('held');
      task.notification.state = 'acknowledged'; event(task, command.commandId, command.kind, at); break;
    }
  }
}
function validObservation(value: unknown): value is CompanionHostObservation {
  if (!companionObject(value, ['taskId', 'attemptId', 'epoch', 'assignee', 'packetDigest', 'state', 'providerRunId', 'evidenceReference'])) return false;
  const observation = value as CompanionHostObservation;
  return companionId(observation.taskId) && companionHash(observation.attemptId) && Number.isSafeInteger(observation.epoch) && observation.epoch > 0 &&
    validCompanionIdentity(observation.assignee) && companionHash(observation.packetDigest) &&
    ['accepted', 'unknown', 'proved-unstarted', 'cancel-confirmed'].includes(observation.state) &&
    (observation.providerRunId === null || companionToken(observation.providerRunId)) &&
    (observation.state !== 'accepted' || observation.providerRunId !== null) && companionText(observation.evidenceReference, 2000);
}
export function createCompanionCoordinator(options: { directory?: string; now?: () => Date; host?: CompanionHostHooks } = {}): CompanionCoordinator {
  const store = new CompanionCoordinationStore(options.directory ?? join(ashlrHome(), 'companion-coordination'));
  const timestamp = (): string => {
    const at = (options.now?.() ?? new Date()).toISOString();
    if (!companionTime(at)) refuse('invalid'); return at;
  };
  return {
    list(filter = {}) {
      if (!companionObject(filter, [], ['tenantId', 'projectBindingId']) ||
        filter.tenantId !== undefined && !companionToken(filter.tenantId) || filter.projectBindingId !== undefined && !companionToken(filter.projectBindingId)) {
        return { sourceState: 'degraded', revision: 0, tasks: [] };
      }
      const read = store.read();
      return { sourceState: read.sourceState, revision: read.state?.revision ?? 0,
        tasks: structuredClone(Object.values(read.state?.tasks ?? {}).filter(task =>
          (filter.tenantId === undefined || task.tenantId === filter.tenantId) && (filter.projectBindingId === undefined || task.projectBindingId === filter.projectBindingId))) };
    },
    read(taskId) {
      if (!companionId(taskId)) return { sourceState: 'degraded', revision: 0, task: null };
      const read = store.read(); return { sourceState: read.sourceState, revision: read.state?.revision ?? 0,
        task: structuredClone(read.state?.tasks[taskId] ?? null) };
    },
    replay(command) {
      try { return validateCommand(command) ? store.replay(command.commandId, structuredClone(command)) : failure('invalid'); }
      catch { return failure('invalid'); }
    },
    execute(command) {
      try {
        if (!validateCommand(command)) return failure('invalid');
        const taskId = command.kind === 'create' ? companionTaskId(command.task) : command.taskId;
        // JSON/plain-data snapshot fixes caller-owned identity before lock acquisition.
        const snapshot = structuredClone(command); const at = timestamp();
        return store.transact(command.commandId, command.expectedRevision, snapshot, taskId, state => apply(state, snapshot, taskId, at));
      } catch { return failure('invalid'); }
    },
    reconcile(commandId, expectedRevision, taskId, attemptId) {
      if (!companionToken(commandId) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0 ||
        !companionId(taskId) || !companionHash(attemptId)) return failure('held');
      try {
        const request = { kind: 'reconcile', commandId, expectedRevision, taskId, attemptId };
        const replay = store.replay(commandId, request);
        if (replay) return replay;
        if (!options.host) return failure('held');
        const read = store.read(); const task = read.state?.tasks[taskId]; const attempt = task?.attempts.find(item => item.id === attemptId);
        if (!task || !attempt) return failure(read.sourceState === 'degraded' ? 'unavailable' : 'not-found');
        const observed = options.host.observe(structuredClone(task), structuredClone(attempt));
        if (!validObservation(observed)) return failure('held');
        const observation = structuredClone(observed); const at = timestamp();
        return store.transact(commandId, expectedRevision, request, taskId, state => {
          const currentTask = state.tasks[taskId]; const currentAttempt = currentTask?.attempts.find(item => item.id === attemptId);
          if (!currentTask || !currentAttempt || currentTask.id !== observation.taskId || currentAttempt.id !== observation.attemptId ||
            currentAttempt.epoch !== observation.epoch || !companionIdentityEqual(currentAttempt.assignee, observation.assignee) ||
            currentAttempt.packetDigest !== observation.packetDigest || at < currentTask.updatedAt) refuse('held');
          const canceledBeforeIntent = currentAttempt.contact === 'not-contacted' && currentAttempt.handoffAt === null &&
            currentAttempt.cancelRequestedAt !== null && currentAttempt.providerRunId === null && observation.providerRunId === null &&
            ['proved-unstarted', 'cancel-confirmed'].includes(observation.state);
          if (!currentAttempt.handoffAt && !canceledBeforeIntent) refuse('held');
          if (observation.state === 'proved-unstarted' && (currentAttempt.providerRunId !== null || ['accepted', 'cancel-confirmed'].includes(currentAttempt.contact)) ||
            observation.state === 'cancel-confirmed' && currentAttempt.cancelRequestedAt === null ||
            ['proved-unstarted', 'cancel-confirmed'].includes(currentAttempt.contact) && observation.state !== currentAttempt.contact ||
            currentAttempt.providerRunId !== null && observation.providerRunId !== null && currentAttempt.providerRunId !== observation.providerRunId) refuse('held');
          if (currentAttempt.contact === observation.state && currentAttempt.observationReference === observation.evidenceReference &&
            (observation.providerRunId === null || currentAttempt.providerRunId === observation.providerRunId)) return;
          const changedContact = currentAttempt.contact !== observation.state;
          currentAttempt.contact = observation.state;
          currentAttempt.providerRunId = observation.providerRunId ?? currentAttempt.providerRunId;
          currentAttempt.observationReference = observation.evidenceReference;
          if (currentAttempt === currentTask.attempts.at(-1) && !['verified', 'cancel-requested'].includes(currentTask.state)) currentTask.state = 'needs-attention';
          event(currentTask, commandId, 'reconcile', at, currentAttempt.id, null, 'host-observed');
          if (observation.state === 'unknown' && changedContact && !['verified', 'cancel-requested'].includes(currentTask.state)) notify(currentTask, 'needs-attention', at);
        });
      } catch { return failure('unavailable'); }
    },
  };
}
