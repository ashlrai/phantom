const GIB = 1024 ** 3;

/**
 * Declared per-host node profile. Static data: a profile never grants authority, joins a node or
 * opens a port. It only bounds what a host may advertise and gives the roster a name to show when
 * the host has not joined or has gone quiet. Reachability is tailnet-only by policy; `tailnetIp`
 * is informational and nothing in this module connects to it.
 *
 * This module is deliberately import-free: it is the data leaf web/api.ts and the CLI may pull
 * into the Tier-1 authority import closure without dragging live capacity readers with it. The
 * values still bound what a host advertises, so edits here remain a reviewed act (the closure
 * snapshot tripwires on growth; this file's membership is reviewed with the #6222 closure repair).
 */
export interface NodeProfile {
  /** Registry node id passed to `phm node join --node`. */
  id: string;
  label: string;
  hostname: string;
  tailnetIp: string;
  owners: readonly string[];
  /** Physical RAM the profile was sized for; sizing still uses the live `totalmem()`. */
  ramBytes: number;
  /** Hard ceiling on concurrent CLI agents regardless of free RAM. */
  maxCliAgents: number;
  /** When false the node never advertises local model lanes (oMLX or other). */
  localModels: boolean;
  /** Admission needs at least this much unallocated RAM (percent of physical) ... */
  memoryFloorPercent: number;
  /** ... and no more than this much swap in use (GiB). */
  maxSwapGb: number;
}

export const NODE_PROFILES: readonly NodeProfile[] = [
  {
    id: 'mbp8', label: 'MacBook Pro (8 GB)', hostname: 'masons-macbook-pro', tailnetIp: '100.89.122.8',
    owners: ['ashlr'], ramBytes: 8 * GIB, maxCliAgents: 2, localModels: false, memoryFloorPercent: 15, maxSwapGb: 2,
  },
];
