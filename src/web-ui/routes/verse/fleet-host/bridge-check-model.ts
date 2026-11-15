/** Strict display model for the bridge-check verdict. Unknown stays unknown; READY is never inferred. */

export const BRIDGE_SECTIONS = ['runtime', 'claims', 'peers'] as const;
export type BridgeSectionName = (typeof BRIDGE_SECTIONS)[number];

export interface BridgeSectionView {
  name: BridgeSectionName;
  status: string;
  source: string;
  asOf: string;
  reason: string | null;
}

export interface BridgeCheckView {
  verdict: 'READY' | 'BLOCKED';
  /** Oldest section asOf, else the check's own asOf; null when no timestamp parses. */
  asOf: string | null;
  sections: BridgeSectionView[];
  missing: string[];
  /** Top-level reason, set when the server degraded to the fixed reader-failed body. */
  reason: string | null;
}

const HEALTHY: ReadonlySet<string> = new Set(['ok', 'empty']);

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

function parseSection(name: BridgeSectionName, raw: unknown): BridgeSectionView | null {
  if (!isRecord(raw) || !isText(raw['status']) || !isText(raw['source']) || !isText(raw['asOf'])) return null;
  const reason = raw['reason'];
  if (reason !== undefined && typeof reason !== 'string') return null;
  return { name, status: raw['status'], source: raw['source'], asOf: raw['asOf'], reason: reason ? reason : null };
}

/** Returns null on any unexpected shape. A READY claim must be backed by every section reading cleanly. */
export function parseBridgeCheck(body: unknown): BridgeCheckView | null {
  if (!isRecord(body) || body['v'] !== 1 || body['authority'] !== 'none') return null;
  const check = body['check'];
  if (!isRecord(check)) return null;
  const verdict = check['verdict'];
  if (verdict !== 'READY' && verdict !== 'BLOCKED') return null;
  if (!isText(check['asOf'])) return null;
  const missing = check['missing'];
  if (!Array.isArray(missing) || !missing.every(isText)) return null;
  const topReason = check['reason'];
  if (topReason !== undefined && typeof topReason !== 'string') return null;

  const sections: BridgeSectionView[] = [];
  for (const name of BRIDGE_SECTIONS) {
    if (check[name] === undefined) continue;
    const section = parseSection(name, check[name]);
    if (!section) return null;
    sections.push(section);
  }
  if (verdict === 'READY') {
    if (missing.length > 0 || sections.length !== BRIDGE_SECTIONS.length) return null;
    if (sections.some(s => !HEALTHY.has(s.status) || s.reason !== null)) return null;
  }
  const times = sections.map(s => Date.parse(s.asOf)).filter(Number.isFinite);
  const oldest = times.length > 0 ? new Date(Math.min(...times)).toISOString()
    : Number.isFinite(Date.parse(check['asOf'])) ? check['asOf'] : null;
  return { verdict, asOf: oldest, sections, missing, reason: topReason ? topReason : null };
}

export function sectionFailing(section: BridgeSectionView): boolean {
  return !HEALTHY.has(section.status) || section.reason !== null;
}

/** "Bridge: READY" or "Bridge: BLOCKED (<first failing section>: <reason>)". */
export function bridgeCheckHeadline(view: BridgeCheckView): string {
  if (view.verdict === 'READY') return 'Bridge: READY';
  const failing = view.sections.find(sectionFailing);
  if (failing) return `Bridge: BLOCKED (${failing.name}: ${failing.reason ?? failing.status})`;
  return `Bridge: BLOCKED (${view.missing[0] ?? 'bridge-check'}: ${view.reason ?? 'unknown'})`;
}

export function bridgeCheckAsOf(view: BridgeCheckView): string {
  return view.asOf === null ? 'as of unknown' : `as of ${view.asOf}`;
}
