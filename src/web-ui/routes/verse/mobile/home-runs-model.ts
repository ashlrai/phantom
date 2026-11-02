import type { FleetRunsMerge } from './runs-queries.js';
import type { Tone } from './ui-parts.js';

/** The fields Home reads from the fleet endpoint; counts can be unknown. */
export interface FleetRuns {
  lastTick: string | null;
  claudeLane: string | null;
  switches: string[];
  lanes: Array<{ lane: string; running: number | null; target: number | null; queued: number | null; held: boolean; heldReason?: string | null; merged24h?: number | null }>;
  mergesLastHour: { count: number | null; items?: FleetRunsMerge[] };
  codexPersonal: { usedPct: number | null; resetsAt: string | null } | null;
}

const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const stringOrNull = (v: unknown): v is string | null => v === null || typeof v === 'string';
const numberOrNull = (v: unknown): v is number | null => v === null || (typeof v === 'number' && Number.isFinite(v));

/** Validate the portion of the wire contract Home displays. */
export function isHomeFleetRuns(v: unknown): v is FleetRuns {
  if (!record(v) || v['v'] !== 1 || !stringOrNull(v['lastTick']) || !stringOrNull(v['claudeLane'])
    || !Array.isArray(v['switches']) || !v['switches'].every((s: unknown) => typeof s === 'string')
    || !Array.isArray(v['lanes']) || !v['lanes'].every((lane: unknown) => record(lane)
      && typeof lane['lane'] === 'string' && numberOrNull(lane['running']) && numberOrNull(lane['target'])
      && numberOrNull(lane['queued']) && typeof lane['held'] === 'boolean'
      && (lane['heldReason'] === undefined || stringOrNull(lane['heldReason']))
      && (lane['merged24h'] === undefined || numberOrNull(lane['merged24h'])))
    || !record(v['mergesLastHour']) || !numberOrNull(v['mergesLastHour']['count'])
    || (v['mergesLastHour']['items'] !== undefined && (!Array.isArray(v['mergesLastHour']['items'])
      || !v['mergesLastHour']['items'].every((m: unknown) => record(m) && typeof m['repo'] === 'string'
        && typeof m['number'] === 'number' && Number.isFinite(m['number']) && typeof m['title'] === 'string')))) return false;
  const codex = v['codexPersonal'];
  return codex === null || (record(codex) && numberOrNull(codex['usedPct']) && stringOrNull(codex['resetsAt']));
}

const count = (n: number | null): string => n === null ? '—' : String(n);
function total(lanes: FleetRuns['lanes'], key: 'running' | 'target'): string {
  return lanes.some((lane) => lane[key] === null) ? '—' : String(lanes.reduce((sum, lane) => sum + (lane[key] ?? 0), 0));
}
function duration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h`;
  return `${Math.floor(hours / 24)} d`;
}
function parsed(at: string | null): number | null {
  if (at === null) return null;
  const value = Date.parse(at);
  return Number.isFinite(value) ? value : null;
}

export function homeRunsView(runs: FleetRuns | null, nowMs: number): {
  headline: string; lanes: Array<{ lane: string; text: string; tone: Tone; heldReason?: string | null; merged24h?: number | null }>;
  merges: string; codex: string | null; tick: string; incident: string | null;
} {
  const lanes = runs?.lanes ?? [];
  const tickAt = parsed(runs?.lastTick ?? null);
  const codex = runs?.codexPersonal ?? null;
  const resetsAt = parsed(codex?.resetsAt ?? null);
  return {
    headline: runs ? `${total(lanes, 'running')} running · ${total(lanes, 'target')} target` : '— running · — target',
    lanes: lanes.filter((lane) => lane.target !== 0 || lane.queued !== 0).map((lane) => ({
      lane: lane.lane,
      ...(lane.heldReason !== undefined && { heldReason: lane.heldReason }),
      ...(lane.merged24h !== undefined && { merged24h: lane.merged24h }),
      text: `${count(lane.running)}/${count(lane.target)} · ${count(lane.queued)} queued`,
      tone: lane.held ? 'danger' : lane.running === 0 && (lane.queued ?? 0) > 0 && (lane.target ?? 0) > 0 ? 'warning' : 'success',
    })),
    merges: runs?.mergesLastHour.count == null ? 'merges unknown' : `${runs.mergesLastHour.count} merged last hour`,
    codex: codex ? `Personal Codex ${count(codex.usedPct)} % used · ${resetsAt === null ? 'reset unknown' : `resets in ${duration(resetsAt - nowMs)}`}` : null,
    tick: tickAt === null ? 'tick —' : `tick ${duration(nowMs - tickAt)} ago`,
    incident: /^down/i.test(runs?.claudeLane ?? '') ? 'Claude lane down' : runs?.switches.includes('HOLD') ? 'HOLD is on' : null,
  };
}
