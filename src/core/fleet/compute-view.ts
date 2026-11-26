import { readFleetAwareness } from './awareness-read.js';
/** Read-only compute projection. Registry mirrors remain evidence, never authority. */
import { readLaunchVitals, type LaunchVitals } from './launch-vitals.js';
import { hostname, homedir } from 'node:os';
import { join } from 'node:path';
import { ashlrHome } from '../cloud/store.js';
import { actionableClaim } from '../drive/nodes/router.js';
import { parseState } from '../drive/nodes/state.js';
import { isHostStats, type HostStats } from '../drive/nodes/state.js';
import { nodeRamSlots, sampleHostStats } from '../drive/nodes/capacity.js';
import { readTelemetryFile } from '../resources/telemetry.js';
import { summarizeHosts, type ComputeHost, type ComputePoolTotals } from './compute-hosts.js';
import { scrubSecrets } from '../util/scrub.js';

export interface ComputeNode {
  id: string; local: boolean; owners: string[]; heartbeatAt: number | null;
  state: 'ready' | 'stale' | 'offline' | 'unknown'; slots: number | null; ramSlots: number | null;
  jobs: Array<{ job: string; owner: string | null }>;
  stats: HostStats | null;
  pressure: string | null; memguardPaused: boolean | null;
  /** Advertised capabilities from the pool record; null/absent when the node reported none. */
  caps?: string[] | null;
}
export interface FleetCompute {
  awareness?: Awaited<ReturnType<typeof readFleetAwareness>>;
  schema: 'fleet.compute.v1'; generatedAt: string; localNodeId: string; truncated: boolean;
  nodes: ComputeNode[];
  /** Additive rollup of workers per physical Mac; absent in payloads from older servers. */
  hosts?: ComputeHost[]; pool?: ComputePoolTotals; sources: Record<string, 'loaded' | 'unavailable' | 'invalid'>;
  operations?: { publishes24h: number | null; admission: { admit: boolean | null; gateReason: string | null; warnings: string[] | null; observedAt: string | null } };
  launchVitals?: LaunchVitals;
  dispatcherAt: string | null;
  lanes: Record<string, { hardCap: number | null; quotaOk: boolean | null }>;
}
const obj = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const clean = (s: string) => scrubSecrets(s).slice(0, 200);
const count = (v: unknown): number | null => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;

export async function readFleetCompute(options: {
  home?: string; runsDir?: string; now?: number; sample?: () => HostStats;
} = {}): Promise<FleetCompute> {
  const home = options.home ?? ashlrHome(), runs = options.runsDir ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
  const now = options.now ?? Date.now();
  const sources: FleetCompute['sources'] = {};
  const read = async (key: string, path: string): Promise<unknown> => {
    const text = await readTelemetryFile(path);
    if (text === null) { sources[key] = 'unavailable'; return null; }
    try { const v: unknown = JSON.parse(text); sources[key] = 'loaded'; return v; }
    catch { sources[key] = 'invalid'; return null; }
  };
  const [registry, pool, witness, config, fleet, status] = await Promise.all([
    read('registry', join(home, 'nodes', 'nodes.json')),
    read('pool', join(home, 'node-pool', 'primary-mirror.json')),
    read('witness', join(home, 'node-pool', 'nodes.json')),
    read('poolConfig', join(home, 'node-pool', 'config.json')),
    read('machine', join(runs, 'fleet.json')), read('dispatcher', join(runs, 'queue', 'status.json')),
  ]);
  const nodes = new Map<string, ComputeNode>();
  let truncated = false;
  const versions = new Map<string, number>();
  for (const [key, value] of [['registry', registry], ['pool', pool], ['witness', witness]] as const) {
    if (value === null) continue;
    try {
      const state = parseState(value);
      if (state.nodes.length > 512) truncated = true;
      const active = state.jobs.filter(job => actionableClaim(state, job, now));
      for (const n of state.nodes.slice(0, 512)) {
        if ((nodes.get(n.nodeId)?.heartbeatAt ?? -1) > n.heartbeatAt) continue;
        if (nodes.get(n.nodeId)?.heartbeatAt === n.heartbeatAt && (versions.get(n.nodeId) ?? 0) > state.observedAt) continue;
        versions.set(n.nodeId, state.observedAt);
        const age = now - n.heartbeatAt;
        const claims = active.filter(j => j.claim!.nodeId === n.nodeId);
        if (claims.length > 512) truncated = true;
        nodes.set(n.nodeId, { id: clean(n.nodeId), local: false, owners: (n.owners ?? []).map(clean),
          heartbeatAt: n.heartbeatAt || null, state: age < 0 || !n.heartbeatAt ? 'unknown' : n.expiresAt <= now || age >= 300_000 ? 'offline' : age > 90_000 ? 'stale' : 'ready',
          caps: n.caps ? n.caps.slice(0, 32).map(clean) : null, slots: n.slots ?? null, ramSlots: isHostStats(n.hostStats) ? nodeRamSlots(n.hostStats.ramTotal) : null, stats: isHostStats(n.hostStats) ? n.hostStats : null, pressure: null, memguardPaused: null,
          jobs: claims.slice(0, 512).map(j => ({ job: clean(j.id), owner: j.owner ? clean(j.owner) : null })) });
      }
    } catch { sources[key] = 'invalid'; }
  }
  // Bind only through explicit node-pool identity. Never guess that a node called "primary" is this host.
  const configured = obj(config).node;
  const localNodeId = typeof configured === 'string' && nodes.has(configured) ? configured : `@local:${clean(hostname())}`;
  let sample: HostStats | null = null;
  try { const s = (options.sample ?? sampleHostStats)(); if (isHostStats(s)) sample = s; } catch { /* explicit unknown */ }
  sources.local = sample ? 'loaded' : 'unavailable';
  const machine = obj(obj(obj(fleet).resources).machine);
  const freshMachine = typeof machine.sampledAtMs === 'number' && now >= machine.sampledAtMs && now - machine.sampledAtMs <= 90_000;
  const pressure = obj(machine.memoryPressure).level;
  const existing = nodes.get(localNodeId);
  nodes.set(localNodeId, { id: localNodeId, local: true, owners: existing?.owners ?? [],
    heartbeatAt: existing?.heartbeatAt ?? null, state: existing?.state ?? 'unknown', slots: existing?.slots ?? null,
    caps: existing?.caps ?? null, jobs: existing?.jobs ?? [], stats: sample, ramSlots: sample ? nodeRamSlots(sample.ramTotal) : null,
    pressure: freshMachine && ['normal', 'warning', 'critical'].includes(String(pressure)) ? String(pressure) : null,
    memguardPaused: freshMachine && typeof machine.memguardPaused === 'boolean' ? machine.memguardPaused : null });
  const lanes: FleetCompute['lanes'] = {};
  for (const [lane, row] of Object.entries(obj(obj(status).lanes)).slice(0, 128)) {
    if (!/^[a-z][a-z0-9-]{1,30}$/.test(lane)) continue;
    lanes[lane] = { hardCap: count(obj(row).hard_cap), quotaOk: typeof obj(row).quota_ok === 'boolean' ? obj(row).quota_ok as boolean : null };
  }
  const tick = obj(status).last_tick;
  const admission = obj(obj(status).admission);
  const stamp = admission.ts;
  const operations: NonNullable<FleetCompute['operations']> = {
    publishes24h: count(obj(status).publishes_24h),
    admission: { admit: typeof admission.admit === 'boolean' ? admission.admit : null,
      gateReason: typeof admission.gate_reason === 'string' ? clean(admission.gate_reason) : null,
      warnings: Array.isArray(admission.warnings) ? admission.warnings.filter((v): v is string => typeof v === 'string').slice(0, 32).map(clean) : null,
      observedAt: typeof stamp === 'string' && Number.isFinite(Date.parse(stamp)) ? stamp : null },
  };
  const [launchVitals, awareness] = await Promise.all([readLaunchVitals(runs), readFleetAwareness({ home, runsDir: runs, now })]);
  const all = [...nodes.values()], { hosts, totals } = summarizeHosts(all);
  return { launchVitals, awareness, schema: 'fleet.compute.v1', generatedAt: new Date(now).toISOString(), localNodeId, truncated,
    nodes: all, hosts, pool: totals, sources, operations, dispatcherAt: typeof tick === 'string' && Number.isFinite(Date.parse(tick)) ? tick : null, lanes };
}
