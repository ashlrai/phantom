/**
 * Read-only Mac-fleet briefing. Composes the runs directory, lane models,
 * usage journal and memory view that the desktop already trusts, and adds
 * only the files those readers do not cover: queue/resources.json,
 * supervisor/status-*.md, leader/INCIDENTS.md and leader/VISION.md.
 *
 * Never writes. A missing or unreadable file degrades its own slice.
 * Symlinks are not followed. Free text is scrubbed; paths and prompts drop out.
 */
import { constants } from 'node:fs';
import { open, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { getLaneModelSnapshot } from './lane-models.js';
import { parseJobsJsonl, parseUsageJournals } from './lane-console.js';
import { memoryView } from './memory-view.js';
import { readFleetRunsDirState, type FleetRunsClaim, type FleetRunsLane } from './runs-dir-state.js';
import { scrubSecrets } from '../util/scrub-secrets.js';
import type {
  MissionAttention,
  MissionControlV1,
  MissionDecision,
  MissionHealth,
  MissionIncident,
  MissionJob,
  MissionMain,
  MissionMemory,
  MissionMerges,
  MissionOverview,
  MissionPlan,
  MissionPressure,
  MissionResource,
  MissionSourceState,
  MissionSources,
} from './mission-control-types.js';

export type {
  MissionControlV1,
  MissionDecision,
  MissionIncident,
  MissionJob,
  MissionMain,
  MissionOverview,
  MissionResource,
} from './mission-control-types.js';
export { VERSE_FLEET_MISSION_PATH } from './mission-control-types.js';

const HOUR_MS = 60 * 60 * 1000;
const RESOURCE_ID = /^[a-z0-9][a-z0-9._@-]{0,63}$/;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,80}$/;
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;
const REPO = /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/;
const STATUS_FILE = /^status-([a-z0-9][a-z0-9._-]{0,80})\.md$/i;
const EVENT_ROW = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([A-Z][A-Z0-9_-]{0,63})(?: (.*))?$/;
const DECISION_KINDS = new Set(['ROUTE', 'ROUTER', 'PICK', 'LAUNCH', 'LANE_HOLD', 'DECIDE']);
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const LABELS: Readonly<Record<string, string>> = {
  'codex-personal': 'Personal Codex',
  'codex-cmp': 'CMP Codex',
  claude: 'Claude',
  'claude-api': 'Claude',
  devin: 'Devin',
  'codex-local': 'Local models',
  omlx: 'Local models',
};

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const enoent = (error: unknown): boolean => record(error)?.code === 'ENOENT';

export function resourceLabel(id: string): string {
  return LABELS[id] ?? id.replace(/[-_]+/g, ' ').replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

export function prose(text: string, max = 240): string {
  return scrubSecrets(text)
    .replace(/(?:[A-Za-z]:\\|~\/|\/)[^\s"'<>]*/g, '[path]')
    .replace(/\bprompt\s*[:=].*/gi, 'prompt=[redacted]')
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function percent(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) return null;
  return Math.round(value * 10) / 10;
}

function credits(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1_000_000) return null;
  return Math.round(value * 10) / 10;
}

function stamp(value: unknown): string | null {
  if (typeof value !== 'string' || !ISO.test(value)) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  const day = value.slice(0, 10);
  return new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) === day ? value : null;
}

function identity(value: string): string | null {
  const id = value.toLowerCase();
  return RESOURCE_ID.test(id) ? id : null;
}

export function parseResources(value: unknown, source: MissionResource['source']): MissionResource[] {
  const rows: { id: string; row: Record<string, unknown> }[] = [];
  const take = (idRaw: unknown, row: Record<string, unknown>) => {
    const id = typeof idRaw === 'string' ? identity(idRaw) : null;
    if (id) rows.push({ id, row });
  };
  if (Array.isArray(value)) {
    for (const item of value) {
      const row = record(item);
      if (row) take(row.id ?? row.resource ?? row.pool ?? row.lane, row);
    }
  } else {
    const obj = record(value);
    const nested = obj ? obj.resources ?? obj.lanes ?? obj.pools : null;
    if (Array.isArray(nested)) {
      for (const item of nested) {
        const row = record(item);
        if (row) take(row.id ?? row.resource ?? row.pool ?? row.lane, row);
      }
    } else if (obj) {
      for (const [key, item] of Object.entries(obj)) {
        if (key === 'v' || key === 'schema' || key === 'generatedAt') continue;
        const row = record(item);
        if (row) take(row.id ?? key, row);
      }
    }
  }
  const out: MissionResource[] = [];
  const seen = new Set<string>();
  for (const { id, row } of rows) {
    if (seen.has(id)) continue;
    seen.add(id);
    const left = percent(row.left_pct ?? row.leftPct ?? row.remaining_pct ?? row.remainingPct ?? row.usage_left ?? row.usageLeft ?? row.left);
    const used = percent(row.weekly_used_pct ?? row.used_pct ?? row.usedPct ?? row.pctUsed);
    out.push({
      id,
      label: resourceLabel(id),
      leftPct: left ?? (used === null ? null : Math.round((100 - used) * 10) / 10),
      creditsLeft: left === null && used === null ? credits(row.credits_remaining ?? row.creditsRemaining ?? row.remaining) : null,
      resetAt: stamp(row.reset_at ?? row.resets_at ?? row.resetAt ?? row.resetsAt),
      source,
    });
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}

export function parseSupervisorStatus(filename: string, text: string): MissionMain | null {
  const named = STATUS_FILE.exec(filename);
  if (!named) return null;
  const repoField = /^repo:\s*([a-z0-9_.-]+\/[a-z0-9_.-]+)\s*$/im.exec(text);
  const heading = /^#\s+([a-z0-9_.-]+\/[a-z0-9_.-]+)\s*$/im.exec(text);
  const repo = (repoField?.[1] ?? heading?.[1] ?? named[1] ?? '').toLowerCase();
  if (!repo || repo.includes('..')) return null;
  const statusLine = /^(?:status|health|main):\s*(green|red|healthy|failing|ok|bad)\s*$/im.exec(text);
  const word = statusLine?.[1]?.toLowerCase();
  let health: MissionMain['health'] = 'unknown';
  if (word === 'green' || word === 'healthy' || word === 'ok') health = 'green';
  else if (word === 'red' || word === 'failing' || word === 'bad') health = 'red';
  const fixJobs = [...text.matchAll(/\bRQ-[A-Z0-9][A-Z0-9-]{1,40}\b/g)]
    .map((match) => match[0])
    .filter((id, index, all) => all.indexOf(id) === index)
    .slice(0, 12);
  const noteLine = text.split(/\r?\n/).map((line) => line.trim())
    .find((line) => line && !line.startsWith('#') && !/^(?:repo|status|health|main|fix):/i.test(line));
  return { repo, health, fixJobs, note: noteLine ? prose(noteLine, 160) || null : null };
}

function incidentStatus(text: string): MissionIncident['status'] {
  const field = /^status:\s*(open|fixed|unknown)\s*$/im.exec(text);
  if (field) return field[1] as MissionIncident['status'];
  if (/^(?:OPEN|FIXED|UNKNOWN)\b/.test(text)) {
    const word = text.slice(0, text.indexOf(' ') > 0 ? text.indexOf(' ') : text.length).toLowerCase();
    if (word === 'open' || word === 'fixed' || word === 'unknown') return word;
  }
  return 'unknown';
}

function incidentTitle(raw: string): string {
  return prose(raw.replace(/^(?:OPEN|FIXED|UNKNOWN)\b\s*/i, ''), 120);
}

export function parseIncidents(text: string): MissionIncident[] {
  const headed = text.split(/\n(?=##\s+)/).filter((chunk) => /^##\s+/m.test(chunk));
  const chunks = headed.length ? headed : text.split(/\n/).filter((line) => /^\s*-\s+/.test(line));
  const incidents: MissionIncident[] = [];
  for (const chunk of chunks) {
    const heading = /^##\s+(.+)$/m.exec(chunk);
    const bullet = /^\s*-\s+(.+)$/.exec(chunk.trim());
    const title = incidentTitle(heading?.[1] ?? bullet?.[1]?.split(/[—–]|Applied:/i)[0] ?? '');
    if (!title) continue;
    const appliedLine = /^(?:applied|leaders?):\s*(.+)$/im.exec(chunk);
    const inlineApplied = !appliedLine ? /(?:^|\s)applied:\s*(.+)$/i.exec(chunk.trim()) : null;
    const applied = prose((appliedLine?.[1] ?? inlineApplied?.[1] ?? '').trim(), 200) || null;
    const body = chunk
      .split(/\r?\n/)
      .filter((line) => !/^##\s+/.test(line) && !/^(?:applied|leaders?|status):/i.test(line.trim()))
      .join(' ');
    const what = prose(body.replace(/^\s*-\s+/, '').replace(/^(?:OPEN|FIXED|UNKNOWN)\b\s*/i, '').replace(/\bapplied:\s*.*/i, ''), 240) || title;
    incidents.push({
      id: `incident-${incidents.length + 1}`,
      title,
      status: incidentStatus((heading?.[1] ?? bullet?.[1] ?? chunk).trim()),
      what,
      applied,
    });
    if (incidents.length >= 20) break;
  }
  return incidents;
}

export function parsePlan(text: string): MissionPlan {
  let title: string | null = null;
  const points: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (!title && /^#\s+/.test(line)) {
      title = prose(line.replace(/^#\s+/, ''), 80) || null;
      continue;
    }
    const point = /^##\s+(.+)$/.exec(line)?.[1] ?? /^[-*]\s+(.+)$/.exec(line)?.[1];
    if (!point) continue;
    const clean = prose(point, 160);
    if (clean) points.push(clean);
    if (points.length >= 8) break;
  }
  return { title, points };
}

export function parseRouterDecisions(text: string, limit = 12): MissionDecision[] {
  const decisions: MissionDecision[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const match = EVENT_ROW.exec(raw.trim());
    if (!match || !DECISION_KINDS.has(match[3] ?? '')) continue;
    const at = `${match[1]}T${match[2]}Z`;
    if (!stamp(at)) continue;
    const rest = match[4] ?? '';
    const keys = new Map<string, string>();
    for (const pair of rest.matchAll(/\b(job|resource|pool|lane|model|agent)=(\S+)/g)) {
      keys.set(pair[1]!.toLowerCase(), pair[2]!);
    }
    const resource = identity(keys.get('resource') ?? keys.get('pool') ?? keys.get('lane') ?? '');
    const modelRaw = keys.get('model') ?? keys.get('agent') ?? '';
    const model = MODEL_ID.test(modelRaw) ? modelRaw : null;
    const jobRaw = keys.get('job') ?? '';
    const job = JOB_ID.test(jobRaw) ? jobRaw : null;
    const keyed = /\b(?:why|because)=(.+)$/i.exec(rest);
    const spoken = /(?:^|\s)because\s+(.+)$/i.exec(rest);
    const leftover = rest.replace(/\b(?:job|resource|pool|lane|model|agent)=\S+/g, ' ');
    const why = prose(keyed?.[1] ?? spoken?.[1] ?? leftover, 200);
    decisions.push({ at, resource, label: resource ? resourceLabel(resource) : null, model, job, why });
  }
  return decisions.slice(-Math.max(0, limit)).reverse();
}

export interface MissionModelHint {
  lane: string;
  tiers: { tier: string; model: string | null }[];
  lastLaunch: { model: string; tier: string | null } | null;
}

function modelFor(hints: readonly MissionModelHint[], lane: string, tier: string): string | null {
  const hint = hints.find((row) => row.lane === lane);
  const exact = hint?.tiers.find((row) => row.tier === tier && row.model);
  if (exact?.model) return exact.model;
  if (hint?.lastLaunch && (hint.lastLaunch.tier === null || hint.lastLaunch.tier === tier)) return hint.lastLaunch.model;
  return null;
}

export function projectJobs(
  lanes: readonly Pick<FleetRunsLane, 'lane' | 'running' | 'queued'>[],
  claimed: readonly Pick<FleetRunsClaim, 'lane' | 'tier'>[],
  hints: readonly MissionModelHint[],
): MissionJob[] {
  const jobs: MissionJob[] = [];
  const running = new Map<string, MissionJob>();
  const claimedByLane = new Map<string, number>();
  for (const claim of claimed) {
    const model = modelFor(hints, claim.lane, claim.tier);
    const key = `${claim.lane}\0${model ?? ''}`;
    const row = running.get(key) ?? { resource: claim.lane, label: resourceLabel(claim.lane), model, running: 0, queued: 0 };
    row.running += 1;
    running.set(key, row);
    claimedByLane.set(claim.lane, (claimedByLane.get(claim.lane) ?? 0) + 1);
  }
  jobs.push(...running.values());
  for (const lane of lanes) {
    const seen = claimedByLane.get(lane.lane) ?? 0;
    if (lane.running > seen) {
      const fallback = hints.find((row) => row.lane === lane.lane)?.lastLaunch?.model ?? null;
      jobs.push({ resource: lane.lane, label: resourceLabel(lane.lane), model: seen === 0 ? fallback : null, running: lane.running - seen, queued: 0 });
    }
    if (lane.queued > 0) jobs.push({ resource: lane.lane, label: resourceLabel(lane.lane), model: null, running: 0, queued: lane.queued });
  }
  return jobs.sort((a, b) => a.label.localeCompare(b.label) || (a.model ?? '').localeCompare(b.model ?? '') || b.running - a.running);
}

function pressure(level: string | number | null, freePct: number | null): MissionPressure {
  const word = typeof level === 'string' ? level.toLowerCase() : '';
  if (typeof level === 'number' && level >= 2) return 'holding';
  if (/pause|hold|stop|critical/.test(word)) return 'holding';
  if (/tight|high|warn/.test(word) || (freePct !== null && freePct < 15)) return 'tight';
  if (freePct !== null || word === 'normal' || word === 'run' || word === 'ok') return 'calm';
  return 'unknown';
}

function memoryNote(state: MissionPressure, stale: boolean | null): string {
  const base = state === 'holding' ? 'The machine is holding new work.'
    : state === 'tight' ? 'Memory is tight.'
      : state === 'calm' ? 'Memory is fine.'
        : 'Memory has not reported.';
  return stale ? `${base} The reading is old.` : base;
}

export function projectMerges(text: string, nowMs: number): MissionMerges[] {
  const byRepo = new Map<string, MissionMerges>();
  for (const event of parseJobsJsonl(text).events) {
    if (!event.merge || !event.pr || !event.at) continue;
    const at = Date.parse(event.at);
    if (!Number.isFinite(at) || at > nowMs || nowMs - at > HOUR_MS) continue;
    const match = /^([a-z\d_.-]+)\/([a-z\d_.-]+)#([1-9]\d*)$/i.exec(event.pr);
    if (!match) continue;
    const repo = `${match[1]}/${match[2]}`;
    if (!REPO.test(repo)) continue;
    const number = Number(match[3]);
    const url = `https://github.com/${repo}/pull/${number}`;
    const group = byRepo.get(repo) ?? { repo, perHour: 0, pulls: [] };
    if (!group.pulls.some((pull) => pull.number === number)) {
      group.pulls.push({ repo, number, url });
      group.perHour += 1;
    }
    byRepo.set(repo, group);
  }
  return [...byRepo.values()].sort((a, b) => b.perHour - a.perHour || a.repo.localeCompare(b.repo));
}

export function missionOverview(input: {
  reported: boolean;
  mergesReported: boolean;
  merges: number;
  mains: readonly MissionMain[];
  incidents: readonly MissionIncident[];
  resources: readonly Pick<MissionResource, 'id' | 'label' | 'leftPct'>[];
  memory: Pick<MissionMemory, 'pressure' | 'stale'>;
}): MissionOverview {
  const items: MissionAttention[] = [];
  let serious = false;
  for (const main of input.mains) {
    if (main.health !== 'red') continue;
    serious = true;
    const fixes = main.fixJobs.length;
    const fix = fixes === 0 ? '' : fixes === 1 ? ' 1 fix job is open.' : ` ${fixes} fix jobs are open.`;
    items.push({ id: `main:${main.repo}`, text: `${main.repo} main is red.${fix}` });
  }
  for (const incident of input.incidents) {
    if (incident.status !== 'open') continue;
    serious = true;
    items.push({ id: incident.id, text: incident.title });
  }
  for (const resource of input.resources) {
    if (resource.leftPct === null || resource.leftPct > 20) continue;
    if (resource.leftPct <= 0) serious = true;
    items.push({
      id: `resource:${resource.id}`,
      text: resource.leftPct <= 0 ? `${resource.label} is out of time.` : `${resource.label} is almost out of time.`,
    });
  }
  if (input.memory.pressure === 'holding') {
    serious = true;
    items.push({ id: 'memory', text: 'The machine is holding new work.' });
  } else if (input.memory.pressure === 'tight') {
    items.push({ id: 'memory', text: 'Memory is tight.' });
  } else if (input.memory.stale === true) {
    items.push({ id: 'memory-stale', text: 'The memory reading is old.' });
  }
  const shown = items.slice(0, 6);
  let health: MissionHealth;
  if (!input.reported) health = 'unknown';
  else if (serious) health = 'attention';
  else if (shown.length > 0) health = 'watch';
  else health = 'clear';
  const headline = health === 'unknown' ? 'The fleet has not reported yet.'
    : health === 'attention' ? 'Something needs a look.'
      : health === 'watch' ? 'Moving, with something to watch.'
        : 'Everything is moving.';
  const shipped = !input.mergesReported ? 'Merges have not reported.'
    : input.merges === 1 ? '1 pull merged this hour.'
      : input.merges === 0 ? 'Nothing merged this hour.'
        : `${input.merges} pulls merged this hour.`;
  const attention = health === 'unknown' ? 'There is nothing to read yet.'
    : shown.length === 0 ? 'Nothing needs you.'
      : null;
  return { health, headline, shipped, attention, items: shown };
}

const emptySources = (): MissionSources => ({
  runs: 'missing', models: 'missing', resources: 'missing', merges: 'missing',
  mains: 'missing', incidents: 'missing', memory: 'missing', plan: 'missing', decisions: 'missing',
});

export function emptyMission(nowMs: number): MissionControlV1 {
  const sources = emptySources();
  const memory: MissionMemory = { freePct: null, pressure: 'unknown', stale: null, stopped: null, note: 'Memory has not reported.' };
  return {
    schema: 'fleet.mission.v1',
    generatedAt: new Date(nowMs).toISOString(),
    overview: missionOverview({ reported: false, mergesReported: false, merges: 0, mains: [], incidents: [], resources: [], memory }),
    sources, jobs: [], decisions: [], resources: [], merges: [], mains: [], incidents: [], memory,
    plan: { title: null, points: [] },
  };
}

async function readText(path: string, limit: number, tail: boolean): Promise<{ state: MissionSourceState; text: string }> {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    return { state: enoent(error) ? 'missing' : 'degraded', text: '' };
  }
  try {
    const info = await file.stat();
    if (!info.isFile()) return { state: 'degraded', text: '' };
    if (!tail && info.size > limit) return { state: 'degraded', text: '' };
    const start = tail ? Math.max(0, info.size - limit) : 0;
    const bytes = Buffer.alloc(Math.min(info.size, limit));
    let offset = 0;
    while (offset < bytes.length) {
      const read = await file.read(bytes, offset, bytes.length - offset, start + offset);
      if (!read.bytesRead) break;
      offset += read.bytesRead;
    }
    let text = bytes.subarray(0, offset).toString('utf8');
    if (start) {
      const newline = text.indexOf('\n');
      text = newline < 0 ? '' : text.slice(newline + 1);
    }
    return { state: 'healthy', text };
  } catch {
    return { state: 'degraded', text: '' };
  } finally {
    await file.close();
  }
}

async function readMains(root: string): Promise<{ state: MissionSourceState; mains: MissionMain[] }> {
  let entries;
  try { entries = await readdir(join(root, 'supervisor'), { withFileTypes: true }); }
  catch (error) { return { state: enoent(error) ? 'missing' : 'degraded', mains: [] }; }
  const names = entries.filter((entry) => entry.isFile() && STATUS_FILE.test(entry.name)).map((entry) => entry.name).sort().slice(0, 24);
  if (!names.length) return { state: 'missing', mains: [] };
  let degraded = false;
  const mains: MissionMain[] = [];
  for (const name of names) {
    const read = await readText(join(root, 'supervisor', name), 64 * 1024, false);
    if (read.state !== 'healthy') { degraded = true; continue; }
    const parsed = parseSupervisorStatus(name, read.text);
    if (!parsed) degraded = true;
    else mains.push(parsed);
  }
  return { state: degraded ? 'degraded' : 'healthy', mains };
}

function runsRoot(given?: string): string | null {
  const dir = given ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
  return typeof dir === 'string' && isAbsolute(dir) && !dir.includes('\0') ? dir : null;
}

export async function readMissionControl(opts: { runsDir?: string; now?: () => number } = {}): Promise<MissionControlV1> {
  const nowMs = (opts.now ?? Date.now)();
  if (!Number.isFinite(nowMs)) return emptyMission(Date.now());
  const root = runsRoot(opts.runsDir);
  if (!root) return emptyMission(nowMs);
  const view = emptyMission(nowMs);
  view.generatedAt = new Date(nowMs).toISOString();
  const [runs, models, memstat, memguard, resourcesFile, usageFile, queueEvents, rootEvents, metrics, queueJobs, mains, incidentsFile, planFile] = await Promise.all([
    readFleetRunsDirState({ runsDir: root, now: () => nowMs }).catch(() => null),
    getLaneModelSnapshot({ runsDir: root, now: () => new Date(nowMs) }).catch(() => null),
    readText(join(root, 'memstat.json'), 1024 * 1024, false),
    readText(join(root, '.memguard2.json'), 1024 * 1024, false),
    readText(join(root, 'queue', 'resources.json'), 256 * 1024, false),
    readText(join(root, 'queue', 'usage-readings.log'), 256 * 1024, true),
    readText(join(root, 'queue', 'dispatch-events.log'), 256 * 1024, true),
    readText(join(root, 'dispatch-events.log'), 256 * 1024, true),
    readText(join(root, 'metrics', 'jobs.jsonl'), 512 * 1024, true),
    readText(join(root, 'queue', 'jobs.jsonl'), 512 * 1024, true),
    readMains(root),
    readText(join(root, 'leader', 'INCIDENTS.md'), 128 * 1024, false),
    readText(join(root, 'leader', 'VISION.md'), 64 * 1024, false),
  ]);
  if (runs) {
    view.sources.runs = runs.runsDirPresent ? runs.sources.status : 'missing';
    const hints: MissionModelHint[] = models?.lanes.map((lane) => ({
      lane: lane.lane, tiers: lane.tiers, lastLaunch: lane.lastLaunch,
    })) ?? [];
    view.sources.models = models ? models.sources.models.state : 'degraded';
    view.jobs = projectJobs(runs.lanes, runs.claimed, hints);
  }
  const resources = resourcesFile.state === 'healthy' ? safeJson(resourcesFile.text) : undefined;
  const resourcesBroken = resourcesFile.state === 'healthy' && resources === undefined;
  if (resourcesFile.state === 'healthy' && resources !== undefined) {
    view.resources = parseResources(resources, 'resources.json');
    view.sources.resources = view.resources.length ? 'healthy' : 'degraded';
  } else if (usageFile.state === 'healthy') {
    const journal = parseUsageJournals([usageFile.text]);
    view.resources = [...journal.latest.entries()].flatMap(([pool, row]) => {
      const id = identity(pool);
      if (!id || row.pctUsed === null) return [];
      return [{
        id, label: resourceLabel(id), leftPct: Math.round((100 - row.pctUsed) * 10) / 10,
        creditsLeft: null, resetAt: stamp(row.resetAt), source: 'usage-readings.log' as const,
      }];
    }).sort((a, b) => a.label.localeCompare(b.label));
    view.sources.resources = resourcesBroken || !view.resources.length || journal.dropped ? 'degraded' : 'healthy';
  } else {
    view.sources.resources = resourcesFile.state === 'missing' ? usageFile.state : 'degraded';
  }
  const events = queueEvents.state === 'healthy' ? queueEvents : rootEvents;
  view.sources.decisions = events.state;
  if (events.state === 'healthy') view.decisions = parseRouterDecisions(events.text);
  const jobs = metrics.state === 'healthy' ? metrics : queueJobs;
  view.sources.merges = jobs.state;
  if (jobs.state === 'healthy') view.merges = projectMerges(jobs.text, nowMs);
  view.sources.mains = mains.state;
  view.mains = mains.mains;
  view.sources.incidents = incidentsFile.state;
  if (incidentsFile.state === 'healthy') view.incidents = parseIncidents(incidentsFile.text);
  view.sources.plan = planFile.state;
  if (planFile.state === 'healthy') view.plan = parsePlan(planFile.text);
  const stat = memstat.state === 'healthy' ? safeJson(memstat.text) : null;
  const guard = memguard.state === 'healthy' ? safeJson(memguard.text) : null;
  if (memstat.state === 'missing' && memguard.state === 'missing') view.sources.memory = 'missing';
  else if (memstat.state === 'degraded' || memguard.state === 'degraded' || (memstat.state === 'healthy' && stat === undefined) || (memguard.state === 'healthy' && guard === undefined)) view.sources.memory = 'degraded';
  else view.sources.memory = 'healthy';
  if (view.sources.memory !== 'missing') {
    const projected = memoryView(stat, guard, nowMs);
    const level = projected.memguard.level;
    const freePct = projected.sample.free_pct;
    const state = pressure(level, freePct);
    view.memory = {
      freePct,
      pressure: state,
      stale: projected.sample.stale,
      stopped: projected.memguard.stopped?.length ?? null,
      note: memoryNote(state, projected.sample.stale),
    };
  }
  const reported = Object.values(view.sources).some((state) => state !== 'missing');
  view.overview = missionOverview({
    reported,
    mergesReported: view.sources.merges === 'healthy',
    merges: view.merges.reduce((sum, group) => sum + group.perHour, 0),
    mains: view.mains,
    incidents: view.incidents,
    resources: view.resources,
    memory: view.memory,
  });
  return view;
}

function safeJson(text: string): unknown {
  try { return JSON.parse(text) as unknown; } catch { return undefined; }
}

export function formatMission(view: MissionControlV1): string {
  const lines = [view.overview.headline, view.overview.shipped];
  if (view.overview.attention) lines.push(view.overview.attention);
  else for (const item of view.overview.items) lines.push(item.text);
  return lines.join('\n');
}
