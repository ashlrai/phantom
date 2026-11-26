import type { FleetLiveSnapshotV1 } from './fleet-types.js';
import type { FleetSessionV1, FleetSessionsV1 } from './runs-sessions.js';
import type { FleetEdges } from './fleet-edges.js';
import { providerFor, type ProviderName } from './provider.js';
import type { FleetOrgTree } from './org-tree.js';
import type { PortableFleetLane } from './portable-lanes.js';

export interface FleetMapNode {
  id: string; kind: 'leader' | 'lane' | 'job' | 'guardian' | 'channel';
  machine?: string;
  label: string; provider: ProviderName; status: string;
  jobId?: string; lane?: string; model?: string; repo?: string; ageSeconds?: number | null;
  /** Jobs only. Start instant, and whether a worker process was seen when the map was built. */
  startedAt?: string | null; processLive?: 'yes' | 'no' | 'unknown';
  /** Jobs only. The publish record has a RESULT line, so the job is done, not running. */
  published?: boolean;
  /** Jobs only. Verified session PR URL; older maps may omit it. */
  prUrl?: string | null;
  /** Jobs only. Dispatch tier (frontier, work, ...) and the task title as one line; null when no source reported them. */
  tier?: string | null; goal?: string | null;
}
/** `provider` is the sender's (`from`) provider: who is behind the reporting agent or the message. */
export interface FleetMapEdge {
  id: string; kind: 'reports-to' | 'message'; from: string; to: string; provider: ProviderName; count?: number;
  /** Message edges only: the newest message on this edge (ISO). */
  lastAt?: string;
}
export interface FleetOrgMap {
  schema: 'fleet.map.v2'; generatedAt: string | null; messageWindowMinutes: number;
  nodes: FleetMapNode[]; edges: FleetMapEdge[];
  sources: { fleet: 'available' | 'unknown'; sessions: FleetSessionsV1['sourceState'] | 'unknown'; messages: FleetEdges['source'] | 'unknown' };
  unmappedMessages: number | null; truncated: boolean;
  /** The same facts as a leader > lanes > jobs tree (`phm org`). Set by the reader; views fall back to `fleetOrgTree(map)`. */
  tree?: FleetOrgTree;
}
export const ORG_LANES = ['codex-personal', 'codex-cmp', 'claude', 'claude-api', 'devin', 'devin-flash', 'codex-local', 'zai', 'gemini', 'grok', 'cursor'] as const;
const known = (value: string | null | undefined) => value?.trim() || 'unknown';
const age = (value: number | null | undefined) => value != null && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
/** A title as one plain line of at most 120 characters; null when empty or only the job id. */
function oneLine(title: string | null | undefined, jobId: string): string | null {
  const line = (title ?? '').replace(/\s+/g, ' ').trim();
  return !line || line === jobId ? null : line.length > 120 ? `${line.slice(0, 119)}…` : line;
}
export function mapWindowMinutes(value: string | undefined): number {
  const minutes = mapWindowMinutesOrNull(value);
  if (minutes === null) throw new Error('Minutes must be 1..1440');
  return minutes;
}

/** The same window rule without the throw: null where the value is not a whole number of minutes in range. */
export function mapWindowMinutesOrNull(value: string | undefined): number | null {
  if (value === undefined) return 60;
  if (!/^\d+$/.test(value)) return null;
  const minutes = Number(value);
  return minutes >= 1 && minutes <= 1440 ? minutes : null;
}

/** Pure graph shared by CLI and both views. Reporting edges are structure, never health evidence. */
export function fleetOrgMap(snapshot: FleetLiveSnapshotV1 | null, options: {
  sessions?: FleetSessionsV1 | null; messages?: FleetEdges | null; minutes?: number; now?: number;
  profileLanes?: readonly PortableFleetLane[];
  observedLanes?: readonly string[];
} = {}): FleetOrgMap {
  const { sessions, messages } = options;
  const now = options.now ?? Date.now();
  const nodes: FleetMapNode[] = [
    { id: 'leader', kind: 'leader', label: 'Leader (CEO)', provider: 'unknown' as const, status: 'unknown' },
    { id: 'guardian', kind: 'guardian', label: 'Guardian', provider: 'unknown', status: 'unknown' },
    ...['iMessage', 'Slack', 'Telegram', 'email', 'desktop'].map(label => ({ id: `channel:${label.toLowerCase()}`, kind: 'channel' as const, label, provider: 'unknown' as const, status: 'unknown' })),
  ];
  const edges: FleetMapEdge[] = [];
  const reportsTo = (from: FleetMapNode, to: string) => edges.push({ id: `reports:${from.id}:${to}`, kind: 'reports-to', from: from.id, to, provider: from.provider });
  nodes.slice(1).forEach(node => reportsTo(node, 'leader'));
  const lanes = new Set<string>();
  const profileLanes = new Map(options.profileLanes?.map(lane => [lane.id, lane]));
  const addLane = (lane: string | null | undefined) => {
    const name = known(lane), id = `lane:${name}`;
    if (!lanes.has(name)) {
      const profile = profileLanes.get(name);
      const node: FleetMapNode = { id, kind: 'lane', lane: name, label: profile?.label ?? name,
        provider: providerFor(profile?.provider, name).name, status: profile?.state ?? 'unknown' };
      lanes.add(name); nodes.push(node); reportsTo(node, 'leader');
    }
    return id;
  };
  for (const profile of profileLanes.values()) if (profile.state === 'ready') addLane(profile.id);
  options.observedLanes?.forEach(addLane);
  for (const lane of snapshot?.lanes ?? []) {
    if ((lane.slots !== null && lane.slots > 0) || (lane.busy !== null && lane.busy > 0)) addLane(lane.lane);
  }
  const jobs = new Set<string>();
  interface JobFacts { jobId: string; lane: string | null; model: string | null; repo: string | null; status: string; seconds: number | null;
    startedAt: string | null; processLive?: FleetMapNode['processLive']; title?: string | null; tier?: string | null; published?: boolean; prUrl?: string | null }
  const addJob = ({ jobId, lane, model, repo, status, seconds, startedAt, processLive = 'unknown', title, tier = null, published = false, prUrl = null }: JobFacts) => {
    if (jobs.has(jobId)) return;
    jobs.add(jobId);
    const parent = addLane(lane), id = `job:${jobId}`, goal = oneLine(title, jobId);
    const node: FleetMapNode = { id, kind: 'job', label: goal ?? jobId, jobId, lane: known(lane), model: known(model), repo: known(repo),
      provider: providerFor(model, profileLanes.get(known(lane))?.provider, lane).name, status, ageSeconds: age(seconds),
      startedAt: startedAt && Number.isFinite(Date.parse(startedAt)) ? startedAt : null, processLive, tier: tier?.trim() || null, goal, prUrl, ...(published ? { published } : {}) };
    nodes.push(node); reportsTo(node, parent);
  };
  // A session row never carries its prompt; the engine snapshot's task title is the goal when both name the job.
  const titles = new Map<string, string>();
  for (const run of snapshot?.runs ?? []) for (const key of [run.id, run.taskId]) if (key) titles.set(key, run.title);
  // Session evidence wins over the older engine-only snapshot; stale claims never become running jobs.
  const fromSession = (row: FleetSessionV1): JobFacts => ({ jobId: row.job, lane: row.lane, model: row.model, repo: row.repo, status: row.status,
    seconds: row.elapsedSeconds, startedAt: row.startedAt, processLive: row.live, title: titles.get(row.job) ?? null, tier: row.tier, published: row.published === true, prUrl: row.prUrl ?? null });
  const sessionIds = new Set([...(sessions?.sessions ?? []), ...(sessions?.recent ?? [])].map(row => row.job));
  for (const row of sessions?.sessions ?? []) {
    if (!['queued', 'parked', 'finished', 'exited'].includes(row.status)) addJob(fromSession(row));
  }
  // Current readers move valid published attempts to the bounded recent tail.
  for (const row of sessions?.recent ?? []) {
    if (row.status === 'finished' && row.published === true) addJob(fromSession(row));
  }
  for (const row of snapshot?.runs ?? []) {
    const id = row.taskId || row.id;
    if (sessionIds.has(id) || sessionIds.has(row.id) || row.endedAt || row.outcome || ['queued', 'parked'].includes(row.phase)) continue;
    addJob({ jobId: id, lane: row.lane, model: row.model, repo: row.repo, status: row.phase, seconds: row.startedAt ? (now - Date.parse(row.startedAt)) / 1000 : null, startedAt: row.startedAt, title: row.title });
  }
  // Resolve only exact observed addresses. Unknown peers are counted, never guessed into a lane.
  const byId = new Map(nodes.map(node => [node.id, node]));
  const addresses = new Map<string, string | null>();
  for (const node of nodes) for (const address of new Set([node.id, node.jobId ?? node.lane ?? node.label])) {
    addresses.set(address, addresses.has(address) && addresses.get(address) !== node.id ? null : node.id);
  }
  let unmappedMessages = messages?.source === 'available' ? 0 : null;
  for (const edge of messages?.source === 'available' ? messages.edges ?? [] : []) {
    const from = addresses.get(edge.from.address), to = addresses.get(edge.to.address);
    if (!from || !to) { unmappedMessages! += edge.messages; continue; }
    const id = `message:${from}:${to}`, existing = edges.find(row => row.id === id);
    const lastAt = Number.isFinite(edge.lastAt) ? new Date(edge.lastAt).toISOString() : undefined;
    if (existing) {
      existing.count! += edge.messages;
      if (lastAt && (!existing.lastAt || lastAt > existing.lastAt)) existing.lastAt = lastAt;
    } else edges.push({ id, kind: 'message', from, to, provider: byId.get(from)!.provider, count: edge.messages, ...(lastAt ? { lastAt } : {}) });
  }
  return { schema: 'fleet.map.v2', generatedAt: sessions?.generatedAt ?? snapshot?.generatedAt ?? null,
    messageWindowMinutes: mapWindowMinutes(options.minutes === undefined ? undefined : String(options.minutes)), nodes, edges,
    sources: { fleet: snapshot ? 'available' : 'unknown', sessions: sessions?.sourceState ?? 'unknown', messages: messages?.source ?? 'unknown' },
    unmappedMessages, truncated: sessions?.truncated ?? false };
}
