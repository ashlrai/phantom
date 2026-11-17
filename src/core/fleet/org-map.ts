import type { FleetLiveSnapshotV1 } from './fleet-types.js';
import type { FleetSessionsV1 } from './runs-sessions.js';
import type { FleetEdges } from './fleet-edges.js';

export interface FleetMapNode {
  id: string; kind: 'leader' | 'lane' | 'job' | 'guardian' | 'channel';
  label: string; provider: string; status: string;
  jobId?: string; lane?: string; model?: string; repo?: string; ageSeconds?: number | null;
}
export interface FleetMapEdge { id: string; kind: 'reports-to' | 'message'; from: string; to: string; count?: number }
export interface FleetOrgMap {
  schema: 'fleet.map.v2'; generatedAt: string | null; messageWindowMinutes: number;
  nodes: FleetMapNode[]; edges: FleetMapEdge[];
  sources: { fleet: 'available' | 'unknown'; sessions: FleetSessionsV1['sourceState'] | 'unknown'; messages: FleetEdges['source'] | 'unknown' };
  unmappedMessages: number | null; truncated: boolean;
}
export const ORG_LANES = ['codex-personal', 'codex-cmp', 'claude', 'claude-api', 'devin', 'devin-flash', 'codex-local', 'zai', 'gemini', 'grok', 'cursor'] as const;
const providers: Record<string, string> = {
  'codex-personal': 'OpenAI', 'codex-cmp': 'OpenAI', codex: 'OpenAI', claude: 'Anthropic', 'claude-api': 'Anthropic', 'claude-cli': 'Anthropic',
  devin: 'Cognition', 'devin-flash': 'Cognition', 'devin-cli': 'Cognition', zai: 'Z.ai', gemini: 'Google', grok: 'xAI', 'grok-cli': 'xAI', cursor: 'Cursor',
};
const providerFor = (lane: string) => Object.hasOwn(providers, lane) ? providers[lane]! : 'unknown';
const known = (value: string | null | undefined) => value?.trim() || 'unknown';
const age = (value: number | null | undefined) => value != null && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
export function mapWindowMinutes(value: string | undefined): number {
  if (value === undefined) return 60;
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 1440) throw new Error('Minutes must be 1..1440');
  return Number(value);
}

/** Pure graph shared by CLI and both views. Reporting edges are structure, never health evidence. */
export function fleetOrgMap(snapshot: FleetLiveSnapshotV1 | null, options: {
  sessions?: FleetSessionsV1 | null; messages?: FleetEdges | null; minutes?: number; now?: number;
} = {}): FleetOrgMap {
  const { sessions, messages } = options;
  const now = options.now ?? Date.now();
  const nodes: FleetMapNode[] = [
    { id: 'leader', kind: 'leader', label: 'Leader (CEO)', provider: 'unknown', status: 'unknown' },
    { id: 'guardian', kind: 'guardian', label: 'Guardian', provider: 'unknown', status: 'unknown' },
    ...['iMessage', 'Slack', 'Telegram', 'email', 'desktop'].map(label => ({ id: `channel:${label.toLowerCase()}`, kind: 'channel' as const, label, provider: 'unknown', status: 'unknown' })),
  ];
  const edges: FleetMapEdge[] = [];
  const reportsTo = (from: string, to: string) => edges.push({ id: `reports:${from}:${to}`, kind: 'reports-to', from, to });
  nodes.slice(1).forEach(node => reportsTo(node.id, 'leader'));
  const lanes = new Set<string>();
  const addLane = (lane: string | null | undefined) => {
    const name = known(lane), id = `lane:${name}`;
    if (!lanes.has(name)) {
      lanes.add(name); nodes.push({ id, kind: 'lane', label: name, provider: providerFor(name), status: 'unknown' }); reportsTo(id, 'leader');
    }
    return id;
  };
  ORG_LANES.forEach(addLane);
  snapshot?.lanes.forEach(lane => addLane(lane.lane));
  const jobs = new Set<string>();
  const addJob = (jobId: string, lane: string | null, model: string | null, repo: string | null, status: string, seconds: number | null, title = jobId) => {
    if (jobs.has(jobId)) return;
    jobs.add(jobId);
    const parent = addLane(lane), id = `job:${jobId}`;
    nodes.push({ id, kind: 'job', label: title || jobId, jobId, lane: known(lane), model: known(model), repo: known(repo),
      provider: providerFor(lane ?? ''), status, ageSeconds: age(seconds) });
    reportsTo(id, parent);
  };
  // Session evidence wins over the older engine-only snapshot; stale claims never become running jobs.
  const sessionIds = new Set([...(sessions?.sessions ?? []), ...(sessions?.recent ?? [])].map(row => row.job));
  for (const row of sessions?.sessions ?? []) {
    if (!['queued', 'parked', 'finished', 'exited'].includes(row.status)) addJob(row.job, row.lane, row.model, row.repo, row.status, row.elapsedSeconds);
  }
  for (const row of snapshot?.runs ?? []) {
    const id = row.taskId || row.id;
    if (sessionIds.has(id) || sessionIds.has(row.id) || row.endedAt || row.outcome || ['queued', 'parked'].includes(row.phase)) continue;
    addJob(id, row.lane, row.model, row.repo, row.phase, row.startedAt ? (now - Date.parse(row.startedAt)) / 1000 : null, row.title);
  }
  // Resolve only exact observed addresses. Unknown peers are counted, never guessed into a lane.
  const addresses = new Map<string, string | null>();
  for (const node of nodes) for (const address of [node.id, node.jobId ?? node.label]) {
    addresses.set(address, addresses.has(address) && addresses.get(address) !== node.id ? null : node.id);
  }
  let unmappedMessages = messages?.source === 'available' ? 0 : null;
  for (const edge of messages?.source === 'available' ? messages.edges ?? [] : []) {
    const from = addresses.get(edge.from.address), to = addresses.get(edge.to.address);
    if (!from || !to) { unmappedMessages! += edge.messages; continue; }
    const id = `message:${from}:${to}`, existing = edges.find(row => row.id === id);
    if (existing) existing.count! += edge.messages;
    else edges.push({ id, kind: 'message', from, to, count: edge.messages });
  }
  return { schema: 'fleet.map.v2', generatedAt: sessions?.generatedAt ?? snapshot?.generatedAt ?? null,
    messageWindowMinutes: mapWindowMinutes(options.minutes === undefined ? undefined : String(options.minutes)), nodes, edges,
    sources: { fleet: snapshot ? 'available' : 'unknown', sessions: sessions?.sourceState ?? 'unknown', messages: messages?.source ?? 'unknown' },
    unmappedMessages, truncated: sessions?.truncated ?? false };
}
