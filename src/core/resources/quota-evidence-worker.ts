/** Fixed worker: fresh local custody only; no provider transport or file publication. */
import { parentPort, workerData } from 'node:worker_threads';
import { canonical } from '../universe/artifacts.js';
import { inspectResourceQuotaRefreshOwner } from './quota-refresh-lease.js';
import { createEngineeringWorkerRpcClient } from './engineering-worker-rpc.js';
import { prepareSharedQuotaEvidence, RESOURCE_SHARED_QUOTA_EVIDENCE_TTL_MS,
  type SharedQuotaScope } from './quota-shared-evidence.js';
import { captureQuotaEvidenceRejectPins } from './quota-evidence-pins.js';
import type { QuotaEvidenceSnapshot } from './quota-evidence-background.js';
if (!parentPort || workerData?.schemaVersion !== 1 || Object.keys(workerData).sort().join(',') !== 'closeBuffer,schemaVersion,scope') throw new Error('Invalid quota publisher worker');
const scope = workerData.scope as SharedQuotaScope;
const rpc = createEngineeringWorkerRpcClient({ port: parentPort, closeFlag: new Int32Array(workerData.closeBuffer),
  timeoutMs: RESOURCE_SHARED_QUOTA_EVIDENCE_TTL_MS, maxBytes: 256 * 1024 });
let sequence = 0;
parentPort.on('message', (value: unknown) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid quota publisher command');
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join(',') !== 'id,owner,snapshot,startedAt,type' || row.type !== 'publish' ||
    !Number.isSafeInteger(row.id) || Number(row.id) <= sequence || !Number.isSafeInteger(row.startedAt)) throw new Error('Invalid quota publisher command');
  sequence = Number(row.id);
  try {
    if (rpc.isClosed() || Date.now() < Number(row.startedAt) || Date.now() >= Number(row.startedAt) + RESOURCE_SHARED_QUOTA_EVIDENCE_TTL_MS ||
      canonical(inspectResourceQuotaRefreshOwner(scope.root)) !== canonical(row.owner)) throw new Error();
    const pins = captureQuotaEvidenceRejectPins(scope);
    const snapshot = row.snapshot as QuotaEvidenceSnapshot;
    const evidence = prepareSharedQuotaEvidence({ ...scope, evidence: snapshot.evidence, now: Number(row.startedAt) });
    if (rpc.isClosed() || canonical(inspectResourceQuotaRefreshOwner(scope.root)) !== canonical(row.owner) ||
      canonical(captureQuotaEvidenceRejectPins(scope)) !== canonical(pins)) throw new Error();
    if (rpc.call('quota.commit', { id: row.id, evidence, pins }) !== true) throw new Error();
    parentPort!.postMessage({ type: 'result', id: row.id, ok: true });
  } catch { parentPort!.postMessage({ type: 'result', id: row.id, ok: false }); }
});
parentPort.postMessage({ type: 'ready' });
