import type { RuntimeSnapshot } from './runtime-snapshot.js';

const escape = (value: string): string => value.replace(/[\r\n]+/g, ' ').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Bounded metadata-only Slack lines; stateRoot and process details stay local. */
export function formatRuntimeStatusLines(snapshot: RuntimeSnapshot): string[] {
  const { coordination: claims, lastFleetStateRead: fleet } = snapshot;
  const source = snapshot.sourceVersion === undefined || snapshot.sourceVersion === snapshot.installedVersion
    ? '' : ` source v${snapshot.sourceVersion}`;
  const fleetReason = snapshot.reasons.find(reason => reason.startsWith('lastFleetStateRead:'))
    ?? snapshot.reasons[0] ?? 'state unavailable';
  const execution = snapshot.execution;
  const claimExecution = execution?.state === 'known' && typeof claims.activeClaims === 'number'
    ? ` (${execution.running} running, ${execution.claimedNoWorker} no worker${execution.unknown > 0 ? `, ${execution.unknown} unknown` : ''})`
    : '';
  const executionUnknown = execution?.state === 'UNKNOWN'
    ? ` (running UNKNOWN: ${execution.reason ?? 'execution: read failed'})` : '';
  return [
    `Runtime: ${snapshot.host} (${snapshot.tailnetName}) v${snapshot.installedVersion}${source} as of ${snapshot.asOf}`,
    typeof fleet.ageSeconds === 'number'
      ? `Fleet state: last write ${fleet.ageSeconds}s ago`
      : `Fleet state: UNKNOWN (${fleetReason})`,
    typeof claims.activeClaims === 'number'
      ? `Claims: ${claims.activeClaims} live${claimExecution}, newest return ${typeof claims.newestReturnAgeSeconds === 'number'
        ? `${claims.newestReturnAgeSeconds}s ago` : `UNKNOWN (${claims.reason ?? 'return unavailable'})`}${executionUnknown}`
      : `Claims: UNKNOWN (${claims.reason ?? 'coordination unavailable'})${executionUnknown}`,
  ].map(escape);
}
