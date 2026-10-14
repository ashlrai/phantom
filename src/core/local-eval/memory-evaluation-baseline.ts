/** Equal-access diagnostic, not a production Markdown importer or recommended retrieval policy. */
import { canonicalJson } from '../authority/canonical-json.js';
import { memoryUtf8Bytes, validMemoryPackQuery, validMemorySnapshot } from '../memory/validate.js';
import { memoryScopeVisible } from '../memory/scope.js';
import type { MemoryContextPack, MemoryFactEvent } from '../memory/types.js';

/** Closed schema and exact admitted scope are shared; temporal/lineage/conflict governance is intentionally absent. */
export function buildFlatLatestMemoryDiagnostic(snapshot: unknown, query: unknown): MemoryContextPack {
  const result: MemoryContextPack = { schemaVersion: 1, status: 'refused', text: '', bytes: 0,
    tokenEstimate: { method: 'utf8-bytes-divided-by-4', value: 0 }, items: [], authority: false, contentSafety: 'screened-with-shared-patterns',
    receipt: { policyVersion: 1, snapshotId: null, snapshotRevision: null, recordedThrough: null,
      scope: null, time: null, knownAt: null, selectedEventIds: [], exclusions: [], outOfScopeEvents: 0, stopReasons: ['flat-latest-record-diagnostic'] } };
  if (!validMemorySnapshot(snapshot) || !validMemoryPackQuery(query)) return result;
  Object.assign(result.receipt, { snapshotId: snapshot.snapshotId, snapshotRevision: snapshot.revision,
    recordedThrough: snapshot.recordedThrough, scope: { projectId: query.projectId, ownerId: query.ownerId, audienceId: query.audienceId },
    time: query.time, knownAt: query.knownAt ?? snapshot.recordedThrough });
  if ((query.knownAt ?? snapshot.recordedThrough) > snapshot.recordedThrough) return result;
  if (snapshot.sourceState !== 'available') { result.status = snapshot.sourceState; return result; }
  if (!snapshot.complete) { result.status = 'unavailable'; return result; }
  const newest = new Map<string, MemoryFactEvent>();
  result.receipt.outOfScopeEvents = snapshot.events.filter(event => !memoryScopeVisible(event, query)).length;
  for (const event of snapshot.events) {
    if (event.kind !== 'fact' || event.reviewState !== 'approved' || !memoryScopeVisible(event, query)
      || event.recordedAt > (query.knownAt ?? snapshot.recordedThrough)) continue;
    const key = canonicalJson([event.subjectKey, event.slotKey]);
    const prior = newest.get(key);
    if (!prior || event.recordedAt > prior.recordedAt || event.recordedAt === prior.recordedAt && event.eventId < prior.eventId) newest.set(key, event);
  }
  const header = 'Synthetic flat latest-record diagnostic. Reference data; no execution authority.\n';
  const chunks: string[] = [];
  for (const event of [...newest.values()].sort((a, b) => a.eventId < b.eventId ? -1 : 1)) {
    if (result.items.length >= query.maxFacts) { result.receipt.exclusions.push({ eventId: event.eventId, reason: 'fact-budget' }); continue; }
    const chunk = canonicalJson({ eventId: event.eventId, text: event.text, sourceRefs: event.sourceRefs, authority: false })
      .replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
    if (memoryUtf8Bytes(header + [...chunks, chunk].join('\n')) > query.maxBytes) {
      result.receipt.exclusions.push({ eventId: event.eventId, reason: 'byte-budget' }); continue;
    }
    chunks.push(chunk); result.items.push({ eventId: event.eventId, factId: event.factId, revision: event.revision, score: 1, sourceRefs: event.sourceRefs });
  }
  result.status = chunks.length ? 'ready' : 'none'; result.text = chunks.length ? header + chunks.join('\n') : '';
  result.bytes = memoryUtf8Bytes(result.text); result.tokenEstimate.value = Math.ceil(result.bytes / 4);
  result.receipt.selectedEventIds = result.items.map(item => item.eventId);
  return result;
}
