/**
 * fleet.mission.v1 — the briefing both the desktop and `ashlr fleet mission`
 * read. Missing files stay unknown; counts are never invented as zero.
 * Free text is scrubbed before it reaches this shape. Loopback only.
 */
export type MissionSourceState = 'healthy' | 'missing' | 'degraded';
export type MissionHealth = 'clear' | 'watch' | 'attention' | 'unknown';
export type MissionPressure = 'calm' | 'tight' | 'holding' | 'unknown';

export interface MissionOverview {
  health: MissionHealth;
  /** One sentence: is the fleet moving, or does something need a look. */
  headline: string;
  /** One sentence: pulls merged in the last hour, or that merges were not reported. */
  shipped: string;
  /** One sentence when there is no item list; null when `items` carries the look-list. */
  attention: string | null;
  items: MissionAttention[];
}

export interface MissionAttention {
  id: string;
  text: string;
}

export interface MissionJob {
  resource: string;
  label: string;
  /** Null when the router has not chosen a model yet, or the running model was not recorded. */
  model: string | null;
  running: number;
  queued: number;
}

export interface MissionDecision {
  at: string;
  resource: string | null;
  label: string | null;
  model: string | null;
  job: string | null;
  /** Plain reason. Empty only when the log recorded none. */
  why: string;
}

export interface MissionResource {
  id: string;
  label: string;
  /** Percent of the window still unused. Null when the file did not say. */
  leftPct: number | null;
  /** Credit balance when the file has no percent. */
  creditsLeft: number | null;
  resetAt: string | null;
  source: 'resources.json' | 'usage-readings.log';
}

export interface MissionPull {
  repo: string;
  number: number;
  url: string;
}

export interface MissionMerges {
  repo: string;
  perHour: number;
  pulls: MissionPull[];
}

export interface MissionMain {
  repo: string;
  health: 'green' | 'red' | 'unknown';
  fixJobs: string[];
  note: string | null;
}

export interface MissionIncident {
  id: string;
  title: string;
  status: 'open' | 'fixed' | 'unknown';
  what: string;
  /** What a leader applied, when the note says so. */
  applied: string | null;
}

export interface MissionMemory {
  freePct: number | null;
  pressure: MissionPressure;
  stale: boolean | null;
  stopped: number | null;
  note: string;
}

export interface MissionPlan {
  title: string | null;
  points: string[];
}

export interface MissionSources {
  runs: MissionSourceState;
  models: MissionSourceState;
  resources: MissionSourceState;
  merges: MissionSourceState;
  mains: MissionSourceState;
  incidents: MissionSourceState;
  memory: MissionSourceState;
  plan: MissionSourceState;
  decisions: MissionSourceState;
}

export interface MissionControlV1 {
  schema: 'fleet.mission.v1';
  generatedAt: string;
  overview: MissionOverview;
  sources: MissionSources;
  jobs: MissionJob[];
  decisions: MissionDecision[];
  resources: MissionResource[];
  merges: MissionMerges[];
  mains: MissionMain[];
  incidents: MissionIncident[];
  memory: MissionMemory;
  plan: MissionPlan;
}

export const VERSE_FLEET_MISSION_PATH = '/api/verse/fleet/runs/mission';
