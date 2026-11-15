/** Pure, bounded reachability evidence for the owner's Slack thread. */
import { stripVTControlCharacters } from 'node:util';
import type { FleetBridgeCheck } from '../../mcp/fleet-bridge-check.js';
import { sanitizeIdentityText } from './runtime-identity.js';

const FOOTER = 'Reachability only; this is not an assignment or claim.';

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

/** Ages and asOf belong to the check's snapshot; the reply clock never refreshes them. */
export function formatBridgeCheckReply(check: FleetBridgeCheck, _now: Date): string {
  const fleetState = check.runtime['lastFleetStateRead'];
  const age = fleetState !== null && typeof fleetState === 'object'
    ? (fleetState as Record<string, unknown>)['ageSeconds'] : undefined;
  const identity = (['host', 'stateRoot'] as const)
    .filter(key => typeof check.runtime[key] === 'string' && (check.runtime[key] as string).trim() !== '')
    .map(key => ` · ${key} ${text(check.runtime[key]).slice(0, 64)}`).join('');
  const details = [
    `Runtime: ${text(check.runtime.status).slice(0, 32)}${age === undefined ? '' : ` · fleet-state age ${ageText(age)}`}${identity}`,
    `Claims: ${check.claims.live === null ? 'unknown' : `${numericText(check.claims.live)} live, newest ${ageText(check.claims.newestAgeSec)}`}`,
    `Peers: ${text(check.peers.status).slice(0, 32)}`,
    FOOTER,
  ].join('\n');
  const heading = `Bridge: ${check.verdict} as of ${text(check.asOf)}${check.verdict === 'BLOCKED' ? ` · missing ${check.missing.map(text).join(', ') || 'unknown'}` : ''}`;
  const budget = 600 - details.length - 1;
  return `${heading.length > budget ? `${heading.slice(0, budget - 1)}…` : heading}\n${details}`;
}
