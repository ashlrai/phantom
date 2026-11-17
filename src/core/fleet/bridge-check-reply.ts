/** Pure, bounded reachability evidence for the owner's Slack thread. */
import { stripVTControlCharacters } from 'node:util';
import type { FleetBridgeCheck } from '../../mcp/fleet-bridge-check.js';
import { sanitizeIdentityText } from './runtime-identity.js';

const FOOTER = 'Reachability only; this is not an assignment or claim.';
const SECTION_SOURCE = { runtime: 'fleet-runtime', claims: 'coordination-ledger', peers: 'peer-ledger' } as const;

function text(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') return 'unknown';
  return sanitizeIdentityText(stripVTControlCharacters(value)
    .replace(/\p{Cc}/gu, ' ').replace(/\/(?:Users|home)\/[^/\s;,)]+/g, '~'), '').trim() || 'unknown';
}

function numericText(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? String(value) : 'unknown';
}

function ageText(value: unknown): string {
  const age = numericText(value);
  return age === 'unknown' ? age : `${age}s`;
}

/** Compact `[source asOf]` provenance when a section's evidence stamp differs
 * from its producer default or the check's own asOf; the producer timestamp is
 * sanitized but never rewritten to the reply clock. Unknown or malformed
 * provenance falls back to the defaults and renders nothing. */
function provenance(section: { source?: unknown; asOf?: unknown }, fallbackSource: string, checkAsOf: string): string {
  const source = typeof section.source === 'string' && section.source.trim() !== '' ? section.source : fallbackSource;
  const asOf = typeof section.asOf === 'string' && section.asOf.trim() !== '' ? section.asOf : checkAsOf;
  if (source === fallbackSource && asOf === checkAsOf) return '';
  return ` [${text(source).slice(0, 24)} ${text(asOf).slice(0, 40)}]`;
}

/** Ages and asOf belong to the check's snapshot; the reply clock never refreshes them. */
export function formatBridgeCheckReply(check: FleetBridgeCheck, _now: Date): string {
  const fleetState = check.runtime['lastFleetStateRead'];
  const age = fleetState !== null && typeof fleetState === 'object'
    ? (fleetState as Record<string, unknown>)['ageSeconds'] : undefined;
  const identity = (['host', 'stateRoot'] as const)
    .filter(key => typeof check.runtime[key] === 'string' && (check.runtime[key] as string).trim() !== '')
    .map(key => ` · ${key} ${text(check.runtime[key]).slice(0, 64)}`).join('');
  const detailsFor = (prov: boolean): string => [
    `Runtime: ${text(check.runtime.status).slice(0, 32)}${age === undefined ? '' : ` · fleet-state age ${ageText(age)}`}${identity}${prov ? provenance(check.runtime, SECTION_SOURCE.runtime, check.asOf) : ''}`,
    `Claims: ${check.claims.live === null ? 'unknown' : `${numericText(check.claims.live)} live, newest ${ageText(check.claims.newestAgeSec)}`}${prov ? provenance(check.claims, SECTION_SOURCE.claims, check.asOf) : ''}`,
    `Peers: ${text(check.peers.status).slice(0, 32)}${prov ? provenance(check.peers, SECTION_SOURCE.peers, check.asOf) : ''}`,
    FOOTER,
  ].join('\n');
  // Provenance is best-effort inside the fixed reply bound: if the stamped
  // sections would crowd out the heading entirely, the reply drops the suffixes
  // rather than the footer, status lines or the missing-evidence heading.
  let details = detailsFor(true);
  if (details.length > 560) details = detailsFor(false);
  const budget = 600 - details.length - 1;
  const heading = `Bridge: ${check.verdict} as of ${text(check.asOf)}${check.verdict === 'BLOCKED' ? ` · missing ${check.missing.map(text).join(', ') || 'unknown'}` : ''}`;
  return `${heading.length > budget ? `${heading.slice(0, budget - 1)}…` : heading}\n${details}`;
}
