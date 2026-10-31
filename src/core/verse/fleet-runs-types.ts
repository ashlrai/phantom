export const VERSE_FLEET_RUNS_PATH = '/api/verse/fleet/runs';
export const VERSE_FLEET_RUNS_INBOX_PATH = '/api/verse/fleet/runs/inbox';
export const FLEET_RUNS_INBOX_MAX_CHARS = 6000;
export interface FleetRunsV1 {
  v: 1; generatedAt: string;
  sources: Record<'runsDir'|'workers'|'inbox'|'codex'|'merges', 'healthy'|'degraded'|'missing'|'not-landed'>;
  lastTick: string|null; paused: boolean|null; memFreePct: number|null; diskFreeGb: number|null; switches: string[]; claudeLane: string|null;
  host: import('../fleet/host-load.js').HostLoad | null;
  lanes: Array<{ lane: string; running: number; target: number; queued: number; held: boolean; heldReason: string|null; tokensLastHour: number|null; merged24h: number|null; mergeRate24h: number|null }>;
  workers: Array<{ job: string; repo: string; lane: string; tier: string; ageSeconds: number|null }>;
  leaders: Array<{ label: string; ageSeconds: number|null }>; orchestratorAgents: number|null;
  publishesLastHour: Array<{ job: string; lane: string|null; url: string|null; at: string }>;
  mergesLastHour: { count: number|null; items: Array<{ repo: string; number: number; title: string }> };
  events: Array<{ at: string; kind: string; text: string }>;
  codexPersonal: { usedPct: number|null; resetsAt: string|null; asOf: string|null } | null;
  inbox: Array<{ at: string; source: string; text: string }>;
  drop: { pending: Array<{ lane: string; file: string }>; done: number } | null;
}
export interface FleetRunsInboxBody { text: string; source?: string }
