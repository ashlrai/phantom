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

export interface BridgeRuntimeIdentity {
  host: string | null;
  stateRoot: string | null;
  fleetStateAgeSec: number | null;
}

export interface BridgeCheckView {
  verdict: 'READY' | 'BLOCKED';
  /** Oldest section asOf, else the check's own asOf; null when no timestamp parses. */
  asOf: string | null;
  sections: BridgeSectionView[];
  missing: string[];
  /** Top-level reason, set when the server degraded to the fixed reader-failed body. */
  reason: string | null;
  runtimeIdentity: BridgeRuntimeIdentity;
  claimsLive: number | null;
  claimsNewestAgeSec: number | null;
}

const HEALTHY: ReadonlySet<string> = new Set(['ok', 'empty']);

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

const MAX_DISPLAY = 64;

/** Display-only cleanup (local copy: the web bundle must not import src/core). Null when nothing is left. */
function cleanText(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const out = v.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .replace(/\/(?:Users|home)\/[^/\s]+/g, '~').trim().slice(0, MAX_DISPLAY).trim();
  return out.length > 0 ? out : null;
}
const cleanSeconds = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

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
  const runtime = isRecord(check['runtime']) ? check['runtime'] : {};
  const fleetState = isRecord(runtime['lastFleetStateRead']) ? runtime['lastFleetStateRead'] : {};
  const claims = isRecord(check['claims']) ? check['claims'] : {};
  return {
    verdict, asOf: oldest, sections, missing, reason: topReason ? topReason : null,
    runtimeIdentity: {
      host: cleanText(runtime['host']), stateRoot: cleanText(runtime['stateRoot']),
      fleetStateAgeSec: cleanSeconds(fleetState['ageSeconds']),
    },
    claimsLive: cleanSeconds(claims['live']), claimsNewestAgeSec: cleanSeconds(claims['newestAgeSec']),
  };
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

function ageText(sec: number | null): string {
  if (sec === null) return 'unknown';
  if (sec < 90) return `${Math.round(sec)}s`;
  if (sec < 5400) return `${Math.round(sec / 60)}m`;
  return `${Math.round(sec / 3600)}h`;
}

/** "host mac-mini · stateRoot ~/.ashlr-runs · fleet-state age 2m"; unknown for each missing part. */
export function bridgeRuntimeLine(view: BridgeCheckView): string {
  const r = view.runtimeIdentity;
  return `host ${r.host ?? 'unknown'} · stateRoot ${r.stateRoot ?? 'unknown'} · fleet-state age ${ageText(r.fleetStateAgeSec)}`;
}

/** "3 live, newest 4m" or "claims unknown". */
export function bridgeClaimsLine(view: BridgeCheckView): string {
  if (view.claimsLive === null) return 'claims unknown';
  return `${view.claimsLive} live, newest ${ageText(view.claimsNewestAgeSec)}`;
}
