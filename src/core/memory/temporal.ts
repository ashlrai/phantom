import { canonicalJson } from '../authority/canonical-json.js';
import { memoryScopeVisible, sameMemoryScope, sameMemorySlot } from './scope.js';
import type { MemoryExclusionReason, MemoryFactEvent, MemoryPackQuery, MemorySnapshot, MemoryTemporalView } from './types.js';

/** Pure projection over a validated detached snapshot; no latest-import or confidence winner. */
export function projectMemoryTemporal(snapshot: MemorySnapshot, query: MemoryPackQuery): MemoryTemporalView {
  const events = [...snapshot.events].sort((a, b) => a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0);
  const excluded = new Map<string, MemoryExclusionReason>();
  const scoped = new Map<string, MemoryFactEvent>();
  for (const event of events) {
    if (!memoryScopeVisible(event, query)) excluded.set(event.eventId, 'scope');
    else if (event.recordedAt > snapshot.recordedThrough || (event.kind === 'fact' && event.recordedAt > (query.knownAt ?? snapshot.recordedThrough))) excluded.set(event.eventId, 'not-recorded');
    else if (event.reviewState !== 'approved' && event.reviewState !== 'withdrawn') excluded.set(event.eventId, 'unreviewed');
    else {
      scoped.set(event.eventId, event);
      if (event.reviewState === 'withdrawn') excluded.set(event.eventId, 'withdrawn');
    }
  }
  const links = new Map<string, string[]>();
  for (const event of scoped.values()) {
    // Deletion is not ancestry: tombstone targets are applied one by one below and never
    // void the whole deletion because another named target is missing, foreign or unreviewed.
    const edges = [...event.supersedes, ...event.derivedFrom];
    links.set(event.eventId, edges);
    if (edges.some(id => {
      const target = scoped.get(id);
      if (!target || !sameMemoryScope(event, target) || target.kind !== 'fact') return true;
      if (event.supersedes.includes(id)) return !sameMemorySlot(event, target) || event.revision <= target.revision
        || event.validFrom === null || target.validFrom === null || event.validFrom < target.validFrom;
      return false;
    })) excluded.set(event.eventId, 'invalid-lineage');
  }
  // Iterative DFS bounds stack use even at the event cap. Cycles cannot be silent winners.
  const done = new Set<string>();
  const active = new Map<string, number>();
  for (const start of links.keys()) {
    if (done.has(start)) continue;
    const stack: Array<{ id: string; next: number }> = [{ id: start, next: 0 }];
    active.set(start, 0);
    while (stack.length) {
      const frame = stack[stack.length - 1]!;
      const next = links.get(frame.id)?.[frame.next++];
      if (next === undefined) { active.delete(frame.id); done.add(frame.id); stack.pop(); continue; }
      const index = active.get(next);
      if (index !== undefined) stack.slice(index).forEach(item => excluded.set(item.id, 'cyclic-lineage'));
      else if (links.has(next) && !done.has(next)) { active.set(next, stack.length); stack.push({ id: next, next: 0 }); }
    }
  }
  // Tombstones are retained deletion decisions, not historical facts; asOf cannot resurrect them.
  for (const event of scoped.values()) {
    if (event.kind === 'tombstone' && !excluded.has(event.eventId)) {
      event.tombstones.forEach(id => {
        const target = scoped.get(id);
        // Never relabel unusable lineage: a tombstoned invalid withdrawal must not become a valid revocation.
        if (target?.kind === 'fact' && sameMemoryScope(event, target)
          && !['invalid-lineage', 'cyclic-lineage'].includes(excluded.get(id) ?? '')) excluded.set(id, 'tombstoned');
      });
      excluded.set(event.eventId, 'tombstone-event');
    }
  }
  for (const event of scoped.values()) {
    if (excluded.has(event.eventId)) continue;
    if (event.validFrom === null) excluded.set(event.eventId, 'unknown-validity');
    else if (event.validFrom > query.time.at) excluded.set(event.eventId, 'not-yet-valid');
    else if (event.validUntil !== null && event.validUntil <= query.time.at) excluded.set(event.eventId, 'expired');
  }
  // Eligible approved revisions resolve only their exact predecessor and exact slot.
  for (const event of scoped.values()) {
    // A retired, expired or tombstoned successor never resurrects its predecessor.
    // Historical queries before the successor's effective date still admit the predecessor.
    // An admitted, effective correction whose lineage is unusable is an unresolved reviewed
    // objection: its in-scope predecessors are refused rather than served as the stale value.
    if (event.kind === 'fact' && event.validFrom !== null && event.validFrom <= query.time.at) {
      const reason = ['invalid-lineage', 'cyclic-lineage'].includes(excluded.get(event.eventId) ?? '') ? 'conflict' : 'superseded';
      event.supersedes.forEach(id => {
        const target = scoped.get(id);
        // Like deletion, refusal never reaches an unrelated slot: only the same slot or the same fact.
        const sameFact = target !== undefined && target.projectId === event.projectId && target.ownerId === event.ownerId && target.factId === event.factId;
        if (target && !excluded.has(id) && (reason === 'superseded' || sameMemorySlot(event, target) || sameFact)) excluded.set(id, reason);
      });
    }
  }
  // A durable reviewed revocation never silently falls back to an older same-fact answer.
  // Future/unseen revocations do not alter an earlier valid-time or knowledge-time view.
  const revocationRevision = new Map<string, number>();
  const revocations = new Map<string, Map<number, string[]>>();
  // Keyed like revision grouping below: a visible reviewed withdrawal is honored even when its audience list differs.
  const factKey = (event: MemoryFactEvent): string => canonicalJson([event.projectId, event.ownerId, event.factId]);
  for (const event of scoped.values()) {
    if (event.reviewState !== 'withdrawn' || event.validFrom === null || event.validFrom > query.time.at
      || ['invalid-lineage', 'cyclic-lineage'].includes(excluded.get(event.eventId) ?? '')) continue;
    const key = factKey(event);
    const decisions = revocations.get(key) ?? new Map<number, string[]>();
    decisions.set(event.revision, [...(decisions.get(event.revision) ?? []), event.eventId]); revocations.set(key, decisions);
    revocationRevision.set(key, Math.max(revocationRevision.get(key) ?? 0, event.revision));
  }
  for (const previous of scoped.values()) {
    if (!excluded.has(previous.eventId) && (revocationRevision.get(factKey(previous)) ?? 0) > previous.revision)
      excluded.set(previous.eventId, 'revoked');
  }
  for (const previous of scoped.values()) {
    if (excluded.has(previous.eventId)) continue;
    const concurrent = revocations.get(factKey(previous))?.get(previous.revision);
    if (concurrent?.length) { excluded.set(previous.eventId, 'revision-conflict'); concurrent.forEach(id => excluded.set(id, 'revision-conflict')); }
  }
  const candidates = [...scoped.values()].filter(event => !excluded.has(event.eventId));
  const slots = new Map<string, MemoryFactEvent[]>();
  const revisions = new Map<string, MemoryFactEvent[]>();
  for (const event of candidates) {
    // Different audience sets may overlap the admitted audience: they still conflict in one visible slot.
    const scope = [event.projectId, event.ownerId];
    const slot = canonicalJson([...scope, event.subjectKey, event.slotKey]);
    const revision = canonicalJson([...scope, event.factId]);
    slots.set(slot, [...(slots.get(slot) ?? []), event]);
    revisions.set(revision, [...(revisions.get(revision) ?? []), event]);
  }
  for (const group of revisions.values()) {
    if (group.length > 1) group.forEach(event => excluded.set(event.eventId, 'revision-conflict'));
  }
  for (const group of slots.values()) {
    if (new Set(group.map(event => event.text)).size > 1) group.forEach(event => {
      if (!excluded.has(event.eventId)) excluded.set(event.eventId, 'conflict');
    });
  }
  // Reverse propagation is linear in bounded edges. Any ineligible parent invalidates a derived claim.
  const children = new Map<string, string[]>();
  for (const event of scoped.values()) for (const parent of event.derivedFrom) children.set(parent, [...(children.get(parent) ?? []), event.eventId]);
  const queue = [...excluded.keys()];
  for (let i = 0; i < queue.length; i++) for (const id of children.get(queue[i]!) ?? []) {
    if (!excluded.has(id)) { excluded.set(id, 'dependency-ineligible'); queue.push(id); }
  }
  return { eligible: events.filter(event => !excluded.has(event.eventId)),
    exclusions: events.flatMap(event => { const reason = excluded.get(event.eventId); return reason ? [{ eventId: event.eventId, reason }] : []; }) };
}
