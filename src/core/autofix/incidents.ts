/**
 * Incident input for autofix (Eng Ops self_aware.py).
 *
 * Files live at ~/.ashlr-runs/bus/core/INCIDENT-<key>.md.
 * The key is parsed from the filename only and must match
 * ^[a-z0-9._-]{1,96}$. The markdown body is never read and never
 * placed in a command, argument or environment value.
 * A fixed table maps the prefix to one fixer. Unknown prefixes are refused.
 */
import { join } from 'node:path';

import { laneTargetFromSlots, newerReleasePublished, tagOf } from './fixers.js';
import { LANE_RE, RESIDENT_LABEL, type AutofixSnapshot, type IncidentStatusLine, type LaunchdJob } from './types.js';

export const INCIDENT_KEY_RE = /^[a-z0-9._-]{1,96}$/;
const INCIDENT_FILE_RE = /^INCIDENT-([a-z0-9._-]{1,96})\.md$/;
const LABEL_RE = /^ai\.ashlr\.[a-z0-9.-]{1,64}$/;

/** Prefixes Eng Ops files today. c and f are not in the table. */
export const INCIDENT_FIXER_TABLE = {
  a: 'release-stuck-draft',
  b: 'launchd-crashloop',
  d: 'stuck-lane',
  e: 'outside-load',
  g: 'autorun-hold',
} as const;

export type IncidentPrefix = keyof typeof INCIDENT_FIXER_TABLE;
export type IncidentFixer = (typeof INCIDENT_FIXER_TABLE)[IncidentPrefix];

export interface ParsedIncident {
  key: string;
  prefix: IncidentPrefix;
  fixer: IncidentFixer;
}

export interface RejectedIncident {
  key: string;
  reason: 'unknown-prefix';
}

export const REAL_INCIDENT_FILENAMES = [
  'INCIDENT-a_phantom_v3.30.35.md',
  'INCIDENT-b_exit_ai.ashlr.reader1_1.md',
  'INCIDENT-b_runs_ai.ashlr.local-runtime.md',
  'INCIDENT-d_devin-flash.md',
  'INCIDENT-e_load.md',
  'INCIDENT-g_v3.30.35_audit_changed_or_invalid_held.md',
] as const;

export function parseIncidentFilename(name: string): ParsedIncident | RejectedIncident | null {
  const match = INCIDENT_FILE_RE.exec(name);
  if (!match) return null;
  const key = match[1]!;
  const prefix = key.includes('_') ? key.slice(0, key.indexOf('_')) : key;
  if (!Object.hasOwn(INCIDENT_FIXER_TABLE, prefix)) return { key, reason: 'unknown-prefix' };
  const known = prefix as IncidentPrefix;
  return { key, prefix: known, fixer: INCIDENT_FIXER_TABLE[known] };
}

/** Label from a b_ key. A trailing _<digits> on b_exit is an exit suffix, not part of the label. */
export function launchdLabelFromKey(key: string): string | null {
  let rest = '';
  if (key.startsWith('b_exit_')) rest = key.slice('b_exit_'.length).replace(/_\d+$/, '');
  else if (key.startsWith('b_runs_')) rest = key.slice('b_runs_'.length);
  else return null;
  return LABEL_RE.test(rest) ? rest : null;
}

export function laneFromKey(key: string): string | null {
  if (!key.startsWith('d_')) return null;
  const lane = key.slice(2);
  return LANE_RE.test(lane) ? lane : null;
}

export function incidentDir(runsDir: string): string {
  return join(runsDir, 'bus', 'core');
}

export function incidentsLedgerPath(runsDir: string): string {
  return join(runsDir, 'ledger', 'incidents.jsonl');
}

export function readIncidentStatuses(text: string | null): IncidentStatusLine[] {
  if (!text) return [];
  const lines: IncidentStatusLine[] = [];
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue;
    try {
      const parsed = JSON.parse(raw) as Partial<IncidentStatusLine>;
      if (typeof parsed.key !== 'string' || !INCIDENT_KEY_RE.test(parsed.key)) continue;
      if (parsed.status !== 'fixed' && parsed.status !== 'failed' && parsed.status !== 'intentional' && parsed.status !== 'refused') continue;
      if (typeof parsed.reason !== 'string' || typeof parsed.ts !== 'string') continue;
      lines.push({ key: parsed.key, status: parsed.status, reason: parsed.reason, ts: parsed.ts });
    } catch { /* skip */ }
  }
  return lines;
}

export function terminalIncident(lines: readonly IncidentStatusLine[], key: string): IncidentStatusLine | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (line.key === key && line.status !== 'failed') return line;
  }
  return null;
}

export function formatIncidentLine(line: IncidentStatusLine): string {
  return JSON.stringify({ key: line.key, status: line.status, reason: line.reason, ts: line.ts });
}

export function securityReportForHold(key: string, ts: string): string {
  return `${JSON.stringify({
    schema: 'autofix.autorun-hold.v1',
    key,
    ts,
    action: 'detect-only',
    note: 'Release autorun hold is detect-only. Filed for Security. The incident body was not read and was not passed to a command.',
  }, null, 2)}\n`;
}

export function holdReportPath(runsDir: string, key: string): string {
  return join(runsDir, 'ledger', 'autofix-security', `INCIDENT-${key}.json`);
}

export function jobForLabel(snapshot: AutofixSnapshot, label: string, plistMtimeMs: number | null, rollbackMtimeMs: number | null): LaunchdJob {
  const found = snapshot.launchdJobs.find((job) => job.label === label);
  if (found) return found;
  return {
    label,
    domain: 'gui',
    disabled: false,
    samples: [],
    logTail: '',
    plistMtimeMs,
    rollbackMtimeMs,
    authorityGoverned: label === RESIDENT_LABEL,
  };
}

export function slotsTarget(snapshot: AutofixSnapshot, slotsText: string | null, lane: string): number | null {
  const fromFile = laneTargetFromSlots(slotsText, lane);
  if (fromFile !== null) return fromFile;
  const view = snapshot.lanes.find((item) => item.lane === lane);
  return typeof view?.target === 'number' ? view.target : null;
}

export function tagFromIncidentKey(key: string): string | null {
  return tagOf(key);
}

export function supersededReason(key: string, releases: AutofixSnapshot['releases']): string | null {
  const tag = tagOf(key);
  if (!tag) return null;
  return newerReleasePublished(tag, releases) ? 'superseded' : null;
}
