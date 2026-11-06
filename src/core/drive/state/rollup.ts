import type { buildRollup } from '../../observability/rollup.js';
import { validateSnapshot, type MetricsRecord } from './schema.js';

/** Read rollup.ts outputs, retaining only numeric totals and a fixed window. */
export function metricsFromRollup(
  rollup: ReturnType<typeof buildRollup>,
  revision: Pick<MetricsRecord, 'id' | 'nodeId' | 'fencingToken' | 'updatedAt'>,
): MetricsRecord {
  const { tokensIn, tokensOut, estCostUsd, sessions, commits } = rollup.totals;
  const record = {
    kind: 'metrics.v1', id: revision.id, nodeId: revision.nodeId,
    fencingToken: revision.fencingToken, updatedAt: revision.updatedAt,
    window: rollup.window, since: Date.parse(rollup.since),
    tokensIn, tokensOut, estCostUsd, sessions, commits,
  };
  return validateSnapshot({ schema: 'drive-state.v1', records: [record] }).records[0] as MetricsRecord;
}
