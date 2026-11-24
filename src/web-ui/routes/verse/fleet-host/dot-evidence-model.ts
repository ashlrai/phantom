/** Pure view model for GET /api/verse/fleet/runtime-identity/dot-evidence.
 * "unknown" stays "unknown": a missing or unavailable reading is never shown as 0 or offline. */
import { formatAge } from './runtime-identity-model.js';

export interface DotEvidenceRow { label: string; text: string; tone?: 'warn' | 'unknown' }
export interface DotEvidenceView { generatedAt: string; rows: DotEvidenceRow[]; missing: string[] }

const MISSING_TEXT: Record<string, string> = {
  'runtime-identity-unavailable': 'Runtime identity could not be read.',
  'fleet-state-stale': 'The fleet-state reading is stale.',
  'tailnet-unavailable': 'Tailnet peers could not be read.',
  'claims-store-unreadable': 'The claims store could not be read.',
  'slack-trace-unreadable': 'The Slack request trace could not be read.',
  'bridge-owner-unknown': 'No live claim names the Dot bridge owner.',
  'dot-evidence-unavailable': 'The evidence packet could not be built.',
};
export const missingReason = (code: string): string => MISSING_TEXT[code] ?? 'An evidence source is unavailable.';

export const NO_OWNER_TEXT = 'no named owner (no live claim names dot-handoff)';

const obj = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
const text = (v: unknown): string => (typeof v === 'string' && v !== '' ? v : 'unknown');
const count = (v: unknown): string => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? String(v) : 'unknown');
const unknownRow = (label: string): DotEvidenceRow => ({ label, text: 'unknown', tone: 'unknown' });

export function dotEvidenceView(raw: unknown): DotEvidenceView | null {
  const top = obj(raw);
  const packet = obj(top?.packet);
  if (!top || top.v !== 1 || typeof top.generatedAt !== 'string' || !packet) return null;
  const rows: DotEvidenceRow[] = [];

  const rt = obj(packet.runtime);
  if (!rt || rt.state === 'unavailable') {
    rows.push(unknownRow('Runtime host'), unknownRow('Fleet state'));
  } else {
    const drift = rt.versionDrift === true;
    rows.push({
      label: 'Runtime host',
      text: `${text(rt.host)} · ${text(rt.installedVersion)} installed / ${text(rt.sourceVersion)} source${drift ? ' · version drift' : ''}`,
      tone: drift ? 'warn' : undefined,
    });
    const fs = obj(rt.fleetState);
    const age = typeof fs?.ageSeconds === 'number' && Number.isFinite(fs.ageSeconds) && fs.ageSeconds >= 0 ? fs.ageSeconds : 'unknown';
    rows.push({
      label: 'Fleet state',
      text: `${formatAge(age)}${fs?.stale === true ? ' · stale' : fs?.stale === false ? '' : ' · stale: unknown'}`,
      tone: fs?.stale === true ? 'warn' : age === 'unknown' ? 'unknown' : undefined,
    });
  }

  const tn = obj(packet.tailnet);
  if (!tn || tn.state === 'unavailable' || !Array.isArray(tn.peers)) {
    rows.push(unknownRow('Tailnet'));
  } else {
    const peers = tn.peers.map(obj).filter((p): p is Record<string, unknown> => p !== null);
    const online = peers.filter(p => p.online === true).length;
    const unsure = peers.filter(p => p.online !== true && p.online !== false).length;
    rows.push({ label: 'Tailnet', text: `${text(tn.self)} · ${online} of ${peers.length} peers online${unsure ? ` (${unsure} unknown)` : ''}` });
  }

  const cl = obj(packet.claims);
  if (!cl || cl.state === 'unavailable' || !Array.isArray(cl.claims)) {
    rows.push(unknownRow('Live claims'));
  } else {
    const items = cl.claims.map(obj).filter((c): c is Record<string, unknown> => c !== null);
    const states = items.map(c => text(c.state));
    rows.push({ label: 'Live claims', text: items.length === 0 ? '0 live claims' : `${items.length} live · ${states.join(', ')}` });
  }

  const sl = obj(packet.slack);
  const sc = obj(sl?.counts);
  if (!sl || sl.state === 'unavailable' || !sc) {
    rows.push(unknownRow('Slack traces'));
  } else {
    rows.push({
      label: 'Slack traces',
      text: `${count(sc.total)} total · ${count(sc.answered)} answered · ${count(sc.unanswered)} unanswered · ${count(sc.uncertain)} uncertain · ${count(sc.busFailed)} bus-failed`,
    });
  }

  const owner = text(obj(packet.bridge)?.owner);
  rows.push(owner === 'unknown' ? { label: 'Bridge owner', text: NO_OWNER_TEXT, tone: 'unknown' } : { label: 'Bridge owner', text: owner });

  const missing = Array.isArray(packet.missing)
    ? packet.missing.filter((m): m is string => typeof m === 'string' && m !== '').map(missingReason) : [];
  return { generatedAt: top.generatedAt, rows, missing };
}
