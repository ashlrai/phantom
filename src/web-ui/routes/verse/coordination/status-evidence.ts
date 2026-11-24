/**
 * Pure formatter for the "Copy status for Dot" block (RQ-PHX-COORDANSWERDESK573).
 * Three facts (runtime identity, claims read, bridge owner), one line each with
 * its as-of time and source, plus an honest state. Missing data is "unknown",
 * never a guess; secrets and home paths are stripped. No React, no I/O.
 */
export type EvidenceState = 'RECEIVED' | 'ASSIGNED' | 'RUNNING' | 'BLOCKED' | 'VERIFIED';

export interface StatusEvidenceInput {
  runtime: { host: string | null; version: string | null; pid: number | string | null; asOf: string | null } | null;
  claims: { count: number | null; asOf: string | null } | null;
  owner: {
    name: string | null;
    /** Durable claim or task receipt. */
    receipt: string | null;
    /** PR, head or tests artifact; required for VERIFIED. */
    artifact: string | null;
    asOf: string | null;
  } | null;
  state: EvidenceState | null;
  now: number;
}

const STALE_MS = 10 * 60_000;

/** Strip credentials, tokens and home paths from free text. */
export function redact(text: string): string {
  return text
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s/@]*@\S*/gi, '[redacted-url]')
    .replace(/\b(?:gh[pousr]_|github_pat_|xox[a-z]-|sk-)[A-Za-z0-9_-]+/g, '[redacted-token]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted-token]')
    .replace(/\/(?:Users|home)\/[^/\s]+/g, '~');
}

function present(v: string | null | undefined): v is string {
  return typeof v === 'string' && v.trim() !== '';
}

function when(asOf: string | null, now: number): string {
  const ms = present(asOf) ? Date.parse(asOf) : NaN;
  if (!Number.isFinite(ms)) return 'as of unknown';
  return now - ms > STALE_MS ? `stale (as of ${asOf})` : `as of ${asOf}`;
}

/** The state is only as strong as its evidence: downgrade rather than overclaim. */
export function resolveState(input: StatusEvidenceInput): { state: EvidenceState; note: string | null } {
  const requested = input.state ?? 'RECEIVED';
  const o = input.owner;
  const owned = o !== null && present(o.name) && present(o.receipt);
  const downgrade = (state: EvidenceState, why: string) => ({ state, note: `requested ${requested}; ${why}` });
  if (requested === 'VERIFIED') {
    if (o === null || !present(o.artifact)) {
      return downgrade(owned ? 'ASSIGNED' : 'RECEIVED', 'no PR, head or tests artifact');
    }
    return { state: 'VERIFIED', note: null };
  }
  if ((requested === 'ASSIGNED' || requested === 'RUNNING') && !owned) {
    return downgrade('RECEIVED', 'no named owner with a durable claim or task receipt');
  }
  return { state: requested, note: null };
}

export function formatStatusEvidence(input: StatusEvidenceInput): string {
  const { now } = input;
  const { state, note } = resolveState(input);
  const r = input.runtime;
  const c = input.claims;
  const o = input.owner;
  const val = (v: string | null | undefined) => (present(v) ? v : 'unknown');

  const lines = [
    `Status: ${state}${note ? ` (${note})` : ''} · as of ${new Date(now).toISOString()}`,
    r === null
      ? 'Runtime: unknown · as of unknown · source runtime-identity (unavailable)'
      : `Runtime: host ${val(r.host)}, version ${val(r.version)}, pid ${r.pid === null || r.pid === '' ? 'unknown' : String(r.pid)} · ${when(r.asOf, now)} · source runtime-identity`,
    c === null || c.count === null
      ? 'Claims: unknown · as of unknown · source coordination-claims (unavailable)'
      : `Claims: ${c.count} live · ${when(c.asOf, now)} · source coordination-claims`,
    o === null || !present(o.name)
      ? 'Bridge owner: unknown · as of unknown · source work-board (no named owner)'
      : `Bridge owner: ${o.name} · receipt ${val(o.receipt)}${present(o.artifact) ? ` · artifact ${o.artifact}` : ''} · ${when(o.asOf, now)} · source work-board`,
  ];
  return redact(lines.join('\n'));
}
