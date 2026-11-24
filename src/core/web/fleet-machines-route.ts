/**
 * core/web/fleet-machines-route.ts — GET /api/fleet/machines: which computer is
 * answering and which tailnet peers the fleet can see. Read-only; composes the
 * runtime-identity and tailnet-peers readers (both already redact home paths
 * and IPs). A reader that throws yields the unavailable shape with a fixed
 * reason, never the thrown text.
 */
import { readRuntimeIdentity, defaultRuntimeIdentityDeps, type RuntimeIdentity } from '../fleet/runtime-identity.js';
import { readTailnetPeers, defaultTailnetPeersDeps, type TailnetPeers } from '../fleet/tailnet-peers.js';

export interface FleetMachines {
  asOf: string;
  answering: {
    host: string;
    installedVersion: string;
    sourceVersion: string;
    versionDrift: boolean | 'unknown';
    fleetStateAgeSeconds: number | 'unknown';
    fleetStateStale: boolean | 'unknown';
  };
  peers: { name: string; os: string; online: boolean | 'unknown'; ageSeconds: number | 'unknown' }[];
  reasons: string[];
}

export interface FleetMachinesDeps {
  now(): Date;
  identity(): RuntimeIdentity;
  peers(): TailnetPeers;
}

export const MACHINES_UNAVAILABLE_REASON = 'machines: reader unavailable';

export function defaultFleetMachinesDeps(): FleetMachinesDeps {
  const identityDeps = defaultRuntimeIdentityDeps();
  const peerDeps = defaultTailnetPeersDeps();
  return { now: () => new Date(), identity: () => readRuntimeIdentity(identityDeps), peers: () => readTailnetPeers(peerDeps) };
}

export function readFleetMachines(deps: FleetMachinesDeps = defaultFleetMachinesDeps()): FleetMachines {
  const reasons: string[] = [];
  let asOf: string;
  try { asOf = deps.now().toISOString(); } catch { asOf = 'unknown'; }
  const answering: FleetMachines['answering'] = {
    host: 'unknown', installedVersion: 'unknown', sourceVersion: 'unknown',
    versionDrift: 'unknown', fleetStateAgeSeconds: 'unknown', fleetStateStale: 'unknown',
  };
  try {
    const id = deps.identity();
    answering.host = id.host;
    answering.installedVersion = id.installedVersion;
    answering.sourceVersion = id.sourceVersion;
    answering.versionDrift = id.versionDrift;
    answering.fleetStateAgeSeconds = id.fleetState.ageSeconds;
    answering.fleetStateStale = id.fleetState.stale;
    reasons.push(...id.reasons);
  } catch { reasons.push(MACHINES_UNAVAILABLE_REASON); }
  let peers: FleetMachines['peers'] = [];
  try {
    const p = deps.peers();
    peers = p.peers.map(({ name, os, online, ageSeconds }) => ({ name, os, online, ageSeconds }));
    reasons.push(...p.reasons);
  } catch { if (!reasons.includes(MACHINES_UNAVAILABLE_REASON)) reasons.push(MACHINES_UNAVAILABLE_REASON); }
  return { asOf, answering, peers, reasons };
}
