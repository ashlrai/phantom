import { apiGet, ApiError } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';

export type MissionHealth = 'clear' | 'watch' | 'attention' | 'unknown';
export interface MissionAttention { id: string; text: string }
export interface MissionJob { resource: string; label: string; model: string | null; running: number; queued: number }
export interface MissionDecision { at: string; resource: string | null; label: string | null; model: string | null; job: string | null; why: string }
export interface MissionResource { id: string; label: string; leftPct: number | null; creditsLeft: number | null; resetAt: string | null }
export interface MissionPull { repo: string; number: number; url: string }
export interface MissionMerges { repo: string; perHour: number; pulls: MissionPull[] }
export interface MissionMain { repo: string; health: 'green' | 'red' | 'unknown'; fixJobs: string[]; note: string | null }
export interface MissionIncident { id: string; title: string; status: 'open' | 'fixed' | 'unknown'; what: string; applied: string | null }
export interface MissionMemory { freePct: number | null; pressure: 'calm' | 'tight' | 'holding' | 'unknown'; stale: boolean | null; stopped: number | null; note: string }
export interface MissionPlan { title: string | null; points: string[] }
export interface MissionControl {
  schema: 'fleet.mission.v1';
  generatedAt: string;
  overview: { health: MissionHealth; headline: string; shipped: string; attention: string | null; items: MissionAttention[] };
  jobs: MissionJob[];
  decisions: MissionDecision[];
  resources: MissionResource[];
  merges: MissionMerges[];
  mains: MissionMain[];
  incidents: MissionIncident[];
  memory: MissionMemory;
  plan: MissionPlan;
}

const str = (value: unknown): value is string => typeof value === 'string';
const num = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const nil = (check: (value: unknown) => boolean) => (value: unknown) => value === null || check(value);
const list = (check: (value: unknown) => boolean) => (value: unknown) => Array.isArray(value) && value.every(check);
const obj = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

function isMissionControl(value: unknown): value is MissionControl {
  if (!obj(value) || value.schema !== 'fleet.mission.v1' || !obj(value.overview)) return false;
  const overview = value.overview;
  const health = overview.health;
  if (health !== 'clear' && health !== 'watch' && health !== 'attention' && health !== 'unknown') return false;
  if (!str(overview.headline) || !str(overview.shipped) || !nil(str)(overview.attention)) return false;
  if (!list((item) => obj(item) && str(item.id) && str(item.text))(overview.items)) return false;
  if (!list((job) => obj(job) && str(job.label) && nil(str)(job.model) && num(job.running) && num(job.queued))(value.jobs)) return false;
  if (!list((row) => obj(row) && str(row.at) && str(row.why))(value.decisions)) return false;
  if (!list((row) => obj(row) && str(row.label))(value.resources)) return false;
  if (!list((row) => obj(row) && str(row.repo) && num(row.perHour))(value.merges)) return false;
  if (!list((row) => obj(row) && str(row.repo))(value.mains)) return false;
  if (!list((row) => obj(row) && str(row.title))(value.incidents)) return false;
  if (!obj(value.memory) || !str(value.memory.note) || !obj(value.plan) || !list(str)(value.plan.points)) return false;
  return nil(str)(value.plan.title);
}

export const missionQuery: QueryDef<MissionControl | null> = {
  key: 'verse-fleet-mission',
  async fetch(signal) {
    try {
      const value = await apiGet<unknown>('/api/verse/fleet/runs/mission', signal);
      if (!isMissionControl(value)) throw new Error('Invalid mission response.');
      return value;
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  },
};
