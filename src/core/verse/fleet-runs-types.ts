export const VERSE_FLEET_RUNS_PATH = '/api/verse/fleet/runs';
export const VERSE_FLEET_RUNS_GLANCE_PATH = '/api/verse/fleet/runs/glance';
export const VERSE_FLEET_RUNS_INBOX_PATH = '/api/verse/fleet/runs/inbox';
export const FLEET_RUNS_INBOX_MAX_CHARS = 6000;
export interface FleetRunsV1 {
  /** Fresh, structured observations explaining unused capacity; absent on older servers. */
  whyIdle?: string[];
  v: 1; generatedAt: string;
  sources: Record<'runsDir'|'workers'|'inbox'|'codex'|'merges', 'healthy'|'degraded'|'missing'|'not-landed'>;
  lastTick: string|null; paused: boolean|null; memFreePct: number|null; diskFreeGb: number|null; switches: string[]; claudeLane: string|null;
  host: import('../fleet/host-load.js').HostLoad | null;
  lanes: Array<{ lane: string; running: number; target: number; queued: number; held: boolean; heldReason: string|null; tokensLastHour: number|null; merged24h: number|null; mergeRate24h: number|null }>;
  workers: Array<{ job: string; repo: string; lane: string; tier: string; ageSeconds: number|null; overrun?: { ratio: number; medianMs: number } }>;
  claimed?: Array<{ job: string; lane: string; tier: string; at: string }>;
  leaders: Array<{ label: string; ageSeconds: number|null }>; orchestratorAgents: number|null;
  publishesLastHour: Array<{ job: string; lane: string|null; url: string|null; at: string }>;
  mergesLastHour: { count: number|null; perHour?: number|null; medianOpenToMergeMs?: number|null; items: Array<{ repo: string; number: number; title: string; openedAt?: string|null; mergedAt?: string|null; openToMergeMs?: number|null }> };
  events: Array<{ at: string; kind: string; text: string }>;
  codexPersonal: { usedPct: number|null; resetsAt: string|null; asOf: string|null } | null;
  inbox: Array<{ at: string; source: string; text: string }>;
  outbox?: Array<{ at: string; text: string }>;
  /** Additive: the Leader chat (inbox + replies, time-ordered, with state); absent when either journal was unread. */
  leaderChat?: import('../fleet/leader-chat-types.js').LeaderChat;
  drop: { pending: Array<{ lane: string; file: string }>; done: number } | null;
  /** Additive: launched or staffed but not actually running (`phm fleet held --json` prints the same rows). */
  notRunning?: import('../fleet/fleet-held.js').NotRunningRow[];
}
export interface FleetRunsInboxBody { text: string; source?: string }
