/**
 * supply-card.ts — the view-model behind the Supply card (desktop Command, phone Home).
 *
 * Built ONLY from the typed SupplyDoctorReport that `phm doctor supply --json` prints, never from CLI
 * text, so the card and the command cannot disagree. Pure: no I/O, no clock (age comes from the
 * report's own generatedAt). Every fact the report could not read is "unknown" and names its path.
 *
 * Source grouping: the ingest's source is the drop sub-directory a job came from. `gap` is the
 * self-tick gap hook, `leader` is the Leader's own drops, and every other directory is Core.
 */
// Type-only: the card ships to the browser, and supply-doctor.ts reads files.
import type { SupplyDoctorReport } from './supply-doctor.js';

export type SupplyTone = 'ok' | 'warn' | 'unknown';
export interface SupplyCardModel {
  tone: SupplyTone;
  /** The report's one-line verdict, first on the card. */
  verdict: string;
  /** Jobs landed in 24 h per source, always leader, Core, gap in that order; null count = unknown. */
  sources: { label: 'Leader' | 'Core' | 'Gap'; count: number | null }[];
  /** "unknown (<path> is missing)" when ingested.tsv could not be read; otherwise empty. */
  sourcesNote: string | null;
  /** The reject reason with the most drops in 24 h, or a plain sentence. */
  rejects: string;
  /** Age of the last job the gap hook landed, or a plain sentence. */
  lastLanded: string;
  /** When the self-tick last ran and what its hooks produced, or "no self-tick run recorded". */
  selfTickLine: string;
  /** The exact command that prints every number. */
  command: 'phm doctor supply --json';
}

/** Only a well-formed doctor.supply.v1 object is a report (an older or newer server returns null). */
export function asSupplyReport(raw: unknown): SupplyDoctorReport | null {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Partial<SupplyDoctorReport>;
  return r.schema === 'doctor.supply.v1' && typeof r.verdict === 'string' && !!r.ingested && !!r.rejected && !!r.selfSupply && !!r.hook ? r as SupplyDoctorReport : null;
}

const groupOf = (source: string): 'Leader' | 'Core' | 'Gap' => source === 'gap' ? 'Gap' : source.toLowerCase() === 'leader' ? 'Leader' : 'Core';

/** The ingest writes the host's local time ("2026-11-19 14:40:00"); the report's generatedAt is ISO. */
function ageText(lastLanded: string, generatedAt: string): string {
  const then = Date.parse(lastLanded.replace(' ', 'T'));
  const now = Date.parse(generatedAt);
  if (!Number.isFinite(then) || !Number.isFinite(now) || then > now) return `Last landed job: ${lastLanded}.`;
  const minutes = Math.floor((now - then) / 60_000);
  const age = minutes < 1 ? 'just now' : minutes < 60 ? `${minutes} min ago` : minutes < 1440 ? `${Math.floor(minutes / 60)} h ago` : `${Math.floor(minutes / 1440)} d ago`;
  return `Last landed job: ${age}.`;
}

export function supplyCardModel(report: SupplyDoctorReport): SupplyCardModel {
  const known = report.ingested.state === 'known';
  const counts = { Leader: 0, Core: 0, Gap: 0 };
  if (report.ingested.state === 'known') for (const s of report.ingested.sources) counts[groupOf(s.source)] += s.count24h;
  const sources = (['Leader', 'Core', 'Gap'] as const).map(label => ({ label, count: known ? counts[label] : null }));
  const rejected = report.rejected;
  let rejects: string;
  if (rejected.state === 'unknown') rejects = `Rejected drops: unknown (${rejected.path} is ${rejected.why}).`;
  else {
    const top = Object.entries(rejected.byReason).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    rejects = top ? `Top reject reason: ${top[0]}, ${top[1]} in 24 h.` : 'Nothing rejected in 24 h.';
  }
  const landed = report.selfSupply.landed24h;
  return {
    tone: landed === null ? 'unknown' : landed > 0 ? 'ok' : 'warn',
    verdict: report.verdict,
    sources,
    sourcesNote: report.ingested.state === 'unknown' ? `Jobs per source: unknown (${report.ingested.path} is ${report.ingested.why}).` : null,
    rejects,
    lastLanded: report.selfSupply.lastLanded ? ageText(report.selfSupply.lastLanded, report.generatedAt)
      : known ? 'No self-supplied job has landed yet.' : `Last landed job: unknown (${report.ingested.path} is ${report.ingested.state === 'unknown' ? report.ingested.why : 'unreadable'}).`,
    // An older Mac's report has no selfTick; say so instead of showing nothing. (The live build is on the Leader card.)
    selfTickLine: `Self-tick: ${(report as Partial<SupplyDoctorReport>).selfTick?.line ?? 'unknown (this Mac’s build does not report it yet)'}.`,
    command: 'phm doctor supply --json',
  };
}
