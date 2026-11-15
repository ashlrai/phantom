interface ClaimExecutionRow {
  claimId: string;
  jobId: string | null;
  agent: string;
  repo: string;
  state: 'RUNNING' | 'CLAIMED_NO_WORKER' | 'UNKNOWN';
  worker: { pid: number; lane: string; ageSeconds: number | 'unknown' } | null;
  expiresInSeconds: number | 'unknown';
}

export type ParsedClaimExecution = { kind: 'unavailable' } | {
  kind: 'ok';
  asOf: string;
  ledger: 'known' | 'unavailable';
  processes: 'healthy' | 'unavailable';
  rows: ClaimExecutionRow[];
  counts: { running: number; claimedNoWorker: number; unknown: number };
  reasons: string[];
};

const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): string => typeof v === 'string' && v.trim() !== '' ? v.slice(0, 200) : 'unknown';
const seconds = (v: unknown): number | 'unknown' => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : 'unknown';

export function parseClaimExecution(body: unknown): ParsedClaimExecution {
  if (!object(body) || body.v !== 1 || body.authority !== 'none' || !object(body.report)) return { kind: 'unavailable' };
  const report = body.report;
  if (report.schema !== 'fleet.claim-execution.v1' || report.authority !== 'none' || !Array.isArray(report.rows)) return { kind: 'unavailable' };
  const ledger = report.ledger === 'known' ? 'known' : 'unavailable';
  const processes = report.processes === 'healthy' ? 'healthy' : 'unavailable';
  const reasons = Array.isArray(report.reasons)
    ? report.reasons.filter((r): r is string => typeof r === 'string' && r.trim() !== '').slice(0, 5).map(r => r.slice(0, 200)) : [];
  const rows: ClaimExecutionRow[] = [];
  const counts = { running: 0, claimedNoWorker: 0, unknown: 0 };
  for (const raw of report.rows) {
    if (rows.length === 20) break;
    if (!object(raw) || (raw.state !== 'RUNNING' && raw.state !== 'CLAIMED_NO_WORKER' && raw.state !== 'UNKNOWN')) continue;
    const candidate = object(raw.worker) ? raw.worker : null;
    const worker = candidate && typeof candidate.pid === 'number' && Number.isSafeInteger(candidate.pid) && candidate.pid > 0
      ? { pid: candidate.pid, lane: text(candidate.lane), ageSeconds: seconds(candidate.ageSeconds) } : null;
    const state = ledger !== 'known' || processes !== 'healthy' || (raw.state === 'RUNNING' && worker === null) ? 'UNKNOWN' : raw.state;
    rows.push({
      claimId: text(raw.claimId), jobId: typeof raw.jobId === 'string' && raw.jobId.trim() !== '' ? text(raw.jobId) : null,
      agent: text(raw.agent), repo: text(raw.repo), state, worker: state === 'RUNNING' ? worker : null,
      expiresInSeconds: seconds(raw.expiresInSeconds),
    });
    counts[state === 'RUNNING' ? 'running' : state === 'CLAIMED_NO_WORKER' ? 'claimedNoWorker' : 'unknown']++;
  }
  // A list containing only unsupported rows is not evidence of an empty ledger.
  if (report.rows.length > 0 && rows.length === 0 && reasons.length < 5) reasons.push('claim rows unavailable');
  return { kind: 'ok', asOf: text(report.asOf), ledger, processes, rows, counts, reasons };
}

export function claimExecutionHeadline(parsed: ParsedClaimExecution): { text: string; tone: 'ok' | 'warn' | 'unknown' } {
  if (parsed.kind === 'unavailable') return { text: 'Claim execution unknown: report unavailable', tone: 'unknown' };
  const { counts, reasons } = parsed;
  if (parsed.ledger !== 'known' || parsed.processes !== 'healthy' || (parsed.rows.length === 0 && reasons.length > 0)) {
    const reason = reasons[0] ?? (parsed.ledger !== 'known' ? 'coordination ledger unavailable' : 'process table unavailable');
    return { text: `Claim execution unknown: ${reason}`, tone: 'unknown' };
  }
  if (parsed.rows.length === 0) return { text: 'No live claims', tone: 'ok' };
  const parts = [`${counts.running} running`];
  if (counts.claimedNoWorker > 0) parts.push(`${counts.claimedNoWorker} claimed with no worker`);
  if (counts.unknown > 0) parts.push(`${counts.unknown} unknown`);
  return { text: parts.join(', '), tone: counts.claimedNoWorker > 0 ? 'warn' : counts.unknown > 0 ? 'unknown' : 'ok' };
}
