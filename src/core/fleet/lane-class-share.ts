/** Pure, read-only projection of supervisor metrics/jobs.jsonl. */
export type LaneJobClass = 'phx' | 'fixup' | 'filler' | 'other';
export interface LaneClassShare {
  lane: string;
  class: LaneJobClass;
  launches: number;
  tokens_total: number;
  prs_opened: number;
  prs_merged: number;
}

export function classifyLaneJob(id: string): LaneJobClass {
  if (/^RQ-FIXUP(?:-|$)/.test(id) || /^FIXUP(?:-|$)/.test(id)) return 'fixup';
  if (/^RQ-PHX(?:-|$)/.test(id)) return 'phx';
  if (/^RQ-[A-Z]+\d+A\d{8}Q8$/.test(id)) return 'filler';
  return 'other';
}

const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const identifier = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(v);

/** Each event contributes inside [now-hours, now]. Missing finishes contribute zero known tokens.
 * Launch rows supply lanes for later rows that omit them. Repeated finishes use the latest
 * total per job/lane; PR state observations dedupe by URL within each lane/class.
 */
export function laneClassShare(input: string | readonly unknown[], hours = 3, now = Date.now()) {
  if (!Number.isFinite(hours) || hours <= 0 || !Number.isFinite(now)) throw new Error('Invalid reporting window');
  const rows: Record<string, unknown>[] = [];
  let malformed = 0;
  for (const value of typeof input === 'string' ? input.split(/\r?\n/).filter(line => line.trim()) : input) {
    let row: unknown = value;
    if (typeof value === 'string') {
      try { row = JSON.parse(value); } catch { malformed++; continue; }
    }
    if (!object(row) || !identifier(row.job ?? row.job_id ?? row.id) || typeof row.ts !== 'string' || !Number.isFinite(Date.parse(row.ts)) || typeof row.event !== 'string' || (row.lane !== undefined && !identifier(row.lane))) {
      malformed++; continue;
    }
    rows.push(row);
  }
  rows.sort((a, b) => Date.parse(a.ts as string) - Date.parse(b.ts as string));
  const lanes = new Map<string, string>();
  const groups = new Map<string, { result: LaneClassShare; launches: Set<string>; tokens: Map<string, number>; opened: Set<string>; merged: Set<string> }>();
  for (const row of rows) {
    const id = String(row.job ?? row.job_id ?? row.id);
    const at = Date.parse(row.ts as string);
    if (at > now) continue;
    if (identifier(row.lane)) lanes.set(id, row.lane);
    const lane = (row.lane as string | undefined) ?? lanes.get(id);
    if (!lane || at < now - hours * 3_600_000 || !['launch', 'finish', 'outcome', 'publish'].includes(String(row.event))) continue;
    const cls = classifyLaneJob(id);
    const key = `${lane}:${cls}`;
    let group = groups.get(key);
    if (!group) {
      group = { result: { lane, class: cls, launches: 0, tokens_total: 0, prs_opened: 0, prs_merged: 0 }, launches: new Set(), tokens: new Map(), opened: new Set(), merged: new Set() };
      groups.set(key, group);
    }
    if (row.event === 'launch') group.launches.add(id);
    if (row.event === 'finish' && typeof row.tokens_total === 'number' && Number.isSafeInteger(row.tokens_total) && row.tokens_total >= 0) group.tokens.set(id, row.tokens_total);
    if ((row.event === 'outcome' || row.event === 'publish') && typeof row.url === 'string' && /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9]\d*$/.test(row.url)) {
      const state = String(row.state).toUpperCase();
      if (['OPEN', 'CLOSED', 'MERGED'].includes(state) || (row.event === 'publish' && row.class === 'pr')) group.opened.add(row.url);
      if (row.event === 'outcome' && state === 'MERGED') group.merged.add(row.url);
    }
  }
  return { schema: 'fleet.class-share.v1', hours, generatedAt: new Date(now).toISOString(), malformed,
    rows: [...groups.values()].map(g => ({ ...g.result, launches: g.launches.size, tokens_total: [...g.tokens.values()].reduce((a, b) => a + b, 0), prs_opened: g.opened.size, prs_merged: g.merged.size }))
      .sort((a, b) => a.lane.localeCompare(b.lane) || a.class.localeCompare(b.class)) };
}
