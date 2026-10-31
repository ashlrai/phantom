/** Paired evaluation decision only. A JSON claim grants no lane mutation authority. */
export interface TuneObservation {
  taskId: string;
  passed: boolean;
  mergeGatePassed: boolean;
  latencyMs: number;
  tokensPerSecond: number;
}
function valid(rows: TuneObservation[]): boolean {
  return rows.length >= 5 && rows.length <= 1000 && new Set(rows.map(r => r.taskId)).size === rows.length && rows.every(r =>
    typeof r.taskId === 'string' && /^[a-f0-9]{64}$/.test(r.taskId) &&
    typeof r.passed === 'boolean' && typeof r.mergeGatePassed === 'boolean' &&
    Number.isFinite(r.latencyMs) && r.latencyMs > 0 && Number.isFinite(r.tokensPerSecond) && r.tokensPerSecond > 0);
}
export function evaluateAdapter(baseline: TuneObservation[], candidate: TuneObservation[], heldoutIds: string[]) {
  if (!valid(baseline) || !valid(candidate) || new Set(heldoutIds).size !== heldoutIds.length ||
      baseline.length !== heldoutIds.length || candidate.length !== heldoutIds.length ||
      !heldoutIds.every(id => baseline.some(r => r.taskId === id) && candidate.some(r => r.taskId === id))) {
    throw new Error('Invalid or unpaired held-out evaluation');
  }
  const summary = (rows: TuneObservation[]) => ({
    passRate: rows.filter(r => r.passed).length / rows.length,
    mergeGateRate: rows.filter(r => r.mergeGatePassed).length / rows.length,
    latencyMs: rows.reduce((n, r) => n + r.latencyMs, 0) / rows.length,
    tokensPerSecond: rows.reduce((n, r) => n + r.tokensPerSecond, 0) / rows.length,
  });
  const before = summary(baseline); const after = summary(candidate);
  const eligible = after.passRate > before.passRate && after.mergeGateRate >= before.mergeGateRate &&
    after.latencyMs <= before.latencyMs && after.tokensPerSecond >= before.tokensPerSecond;
  return { v: 1, decision: eligible ? 'eligible-for-review' : 'reject', baseline: before, candidate: after, tasks: heldoutIds.length };
}
