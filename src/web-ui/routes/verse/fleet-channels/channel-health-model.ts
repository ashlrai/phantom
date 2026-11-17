import { formatRelative } from '../autonomy/format.js';

// View of `channelHealth` on GET /api/verse/fleet/comms-status. Declared here on
// purpose: the web bundle never imports server code, and every field is narrowed
// because an older or partial server may send anything.
export type ChannelHealthState = 'LIVE' | 'DEGRADED' | 'BLOCKED' | 'UNKNOWN';
export type ChannelHealthChannelKey = 'slack' | 'imessage';

export interface ChannelHealthRow {
  channel: ChannelHealthChannelKey;
  configured: boolean | null;
  processAlive: boolean | 'unknown';
  runtimeHost: string | null;
  lastInboundAt: string | null;
  lastReplyAt: string | null;
  unansweredCount: number;
  state: ChannelHealthState;
  missing: string[];
  // Request-coverage proof. Optional so hand-built rows (older callers) still type-check;
  // narrowRow always sets them, and an absent coverage is treated as 'unknown'.
  coverage?: ChannelCoverage;
  answeredCount?: number | null;
  ingress?: ChannelIngress | null;
}

export type ChannelCoverage = 'idle' | 'unproven' | 'verified' | 'unknown';
export interface ChannelIngress { posted: number; duplicate: number; failed: number; unverified: number }

export type ChannelHealthView =
  | { available: false }
  | { available: true; asOf: string | null; channels: ChannelHealthRow[] };

const STATES: readonly ChannelHealthState[] = ['LIVE', 'DEGRADED', 'BLOCKED', 'UNKNOWN'];
const LABELS: Record<ChannelHealthChannelKey, string> = { slack: 'Slack', imessage: 'iMessage' };
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

const count0 = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null);

function narrowProof(raw: unknown): Pick<ChannelHealthRow, 'coverage' | 'answeredCount' | 'ingress'> {
  if (!isRecord(raw)) return { coverage: 'unknown', answeredCount: null, ingress: null };
  const coverage = (['idle', 'unproven', 'verified'] as const).find(c => c === raw.requestCoverage) ?? 'unknown';
  const d = isRecord(raw.durableIngress) ? raw.durableIngress : null;
  const [posted, duplicate, failed, unverified] = ['posted', 'duplicate', 'failed', 'unverified'].map(k => (d ? count0(d[k]) : null));
  const ingress = posted !== null && duplicate !== null && failed !== null && unverified !== null ? { posted, duplicate, failed, unverified } : null;
  return { coverage, answeredCount: count0(raw.answeredCount), ingress };
}

function narrowRow(raw: unknown): ChannelHealthRow | null {
  if (!isRecord(raw) || (raw.channel !== 'slack' && raw.channel !== 'imessage')) return null;
  const count = typeof raw.unansweredCount === 'number' && Number.isFinite(raw.unansweredCount) ? Math.max(0, Math.floor(raw.unansweredCount)) : 0;
  return {
    channel: raw.channel,
    configured: typeof raw.configured === 'boolean' ? raw.configured : null,
    processAlive: typeof raw.processAlive === 'boolean' ? raw.processAlive : 'unknown',
    runtimeHost: str(raw.runtimeHost),
    lastInboundAt: str(raw.lastInboundAt),
    lastReplyAt: str(raw.lastReplyAt),
    unansweredCount: count,
    state: STATES.find(s => s === raw.state) ?? 'UNKNOWN',
    missing: Array.isArray(raw.missing) ? raw.missing.filter((m): m is string => typeof m === 'string' && m !== '') : [],
    ...narrowProof(raw.proof),
  };
}

/** Read `raw.channelHealth`; absent (older server) or errored means not available. */
export function narrowChannelHealth(raw: unknown): ChannelHealthView {
  const health = isRecord(raw) ? raw.channelHealth : undefined;
  if (!isRecord(health) || health.error !== undefined || !Array.isArray(health.channels)) return { available: false };
  const channels = health.channels.flatMap(c => { const row = narrowRow(c); return row ? [row] : []; });
  return { available: true, asOf: str(health.asOf), channels };
}

/** "Slack LIVE, last reply 4m ago" / "iMessage BLOCKED: missing bridge process, config.imessage". */
export function channelHealthLine(ch: ChannelHealthRow, now: number): string {
  const label = LABELS[ch.channel];
  if (ch.state === 'LIVE') return `${label} LIVE, ${ch.lastReplyAt ? `last reply ${formatRelative(ch.lastReplyAt, now)}` : 'no reply yet'}`;
  const parts = ch.missing.length > 0 ? `missing ${ch.missing.join(', ')}` : ch.processAlive === 'unknown' ? 'process state unknown' : '';
  return parts ? `${label} ${ch.state}: ${parts}` : `${label} ${ch.state}`;
}

/** Secondary line saying whether recent requests are proven answered; null when the server sent no usable proof. */
export function channelCoverageLine(ch: ChannelHealthRow): string | null {
  let line: string;
  switch (ch.coverage) {
    case 'verified': line = `requests answered in thread${ch.answeredCount != null ? ` (${ch.answeredCount})` : ''}`; break;
    case 'unproven': line = `${ch.unansweredCount} ${ch.unansweredCount === 1 ? 'request' : 'requests'} waiting, no reply receipt bound`; break;
    case 'idle': line = 'no request in the last hour, LIVE shows process and config only'; break;
    default: return null;
  }
  return ch.ingress && ch.ingress.failed > 0 ? `${line}; durable ingress failed ${ch.ingress.failed}` : line;
}
