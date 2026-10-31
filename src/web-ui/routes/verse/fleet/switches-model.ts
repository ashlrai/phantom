export interface FleetSwitch { id: string; on: boolean; since: string | null; effect: string }
export interface SwitchesState { switches: FleetSwitch[]; sourceState: 'healthy' | 'missing' | 'degraded' }
const known: Record<string, [string, string]> = {
  ORCH_OFF: ['Leaders off', 'stops leader passes'],
  OPUS_LEADER_OFF: ['Opus leader off', 'stops the hourly Opus leader'],
  PAUSE: ['Pause launches', 'no new launches'],
  PUBLISH_HOLD: ['Publish hold', 'no publishes'],
  HOLD: ['Hold dispatcher', 'holds the dispatcher'],
  QUEUE_DISABLE: ['Queue disabled', 'queue disabled'],
};
const record = (raw: unknown): raw is Record<string, unknown> => !!raw && typeof raw === 'object' && !Array.isArray(raw);
export function readSwitches(raw: unknown): SwitchesState | null {
  if (!record(raw) || raw.v !== 1 || !Array.isArray(raw.switches)
    || (raw.sourceState !== 'healthy' && raw.sourceState !== 'missing' && raw.sourceState !== 'degraded')) return null;
  const switches: FleetSwitch[] = [];
  for (const row of raw.switches) {
    if (!record(row) || typeof row.id !== 'string' || typeof row.on !== 'boolean'
      || !(row.since === null || typeof row.since === 'string') || typeof row.effect !== 'string'
      || switches.some(existing => existing.id === row.id)) return null;
    switches.push({ id: row.id, on: row.on, since: row.since, effect: row.effect });
  }
  return { switches, sourceState: raw.sourceState };
}
export const switchLabel = (id: string): string => Object.hasOwn(known, id) ? known[id]![0] : id;
export const switchEffect = (row: FleetSwitch): string => row.effect || (Object.hasOwn(known, row.id) ? known[row.id]![1] : '');
export function summary(rows: FleetSwitch[], sourceState: SwitchesState['sourceState'] = 'healthy'): string {
  if (sourceState !== 'healthy') return `Switch state ${sourceState}`;
  const on = rows.filter(row => row.on);
  return on.length ? `${on.length} on: ${on.map(row => switchLabel(row.id)).join(', ')}` : 'All clear';
}
export function sinceText(iso: string | null, nowMs: number): string {
  if (!iso || !Number.isFinite(Date.parse(iso))) return '';
  const seconds = Math.max(0, Math.round((nowMs - Date.parse(iso)) / 1000));
  const minutes = Math.round(seconds / 60), hours = Math.round(minutes / 60);
  return `on for ${seconds < 60 ? `${seconds} sec` : minutes < 60 ? `${minutes} min` : hours < 24 ? `${hours} hr` : `${Math.round(hours / 24)} d`}`;
}
