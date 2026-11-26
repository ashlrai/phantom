import { isAbsolute } from 'node:path';
import { QUEUE_TIER_SCOPE, isQueueTier, type QueueTier } from '../drive/queue-tier.js';
import {
  hasExactOwnKeys as exact, isPlainObject as object, isUniverseId as id, isSha256Hex,
  UNIVERSE_GIT_OID_RE,
} from '../universe/artifacts.js';
import { fileOperationsPathKey, validFileOperationsPath } from '../universe/generation.js';

type Oracle = { command: string[]; executableDigest: string };
type Lane = { workerId: string; tier: QueueTier };
type WorkerLane = Lane & { fleetLane?: string };
export interface SwarmPilotSpec {
  id: string;
  goal: string;
  seed: { repo: string; revision: string };
  githubRepo: string;
  planner: Lane;
  workers: WorkerLane[];
  files: string[];
  oracles: Record<string, Oracle>;
  integrationOracle: string;
  baselineUsdEstimate: number | null;
}
export interface SwarmPilotNode {
  id: string;
  task: string;
  dependsOn: string[];
  files: string[];
  oracle: string;
  tier: Exclude<QueueTier, 'frontier'>;
}

const text = (v: unknown, max: number): v is string =>
  typeof v === 'string' && v.trim().length > 0 && v.length <= max && !v.includes('\0');
const lane = (v: unknown, worker = false): v is WorkerLane =>
  object(v) && exact(v, worker && Object.hasOwn(v, 'fleetLane') ? ['workerId', 'tier', 'fleetLane'] : ['workerId', 'tier']) &&
  id(v.workerId) && text(v.tier, 8) && isQueueTier(v.tier) &&
  (!Object.hasOwn(v, 'fleetLane') || id(v.fleetLane));
const files = (v: unknown): v is string[] => Array.isArray(v) && v.length > 0 &&
  v.length <= QUEUE_TIER_SCOPE.frontier.maxFiles && v.every(validFileOperationsPath) &&
  new Set(v.map(fileOperationsPathKey)).size === v.length;

export function readSwarmPilotSpec(v: unknown): SwarmPilotSpec {
  const planner = object(v) ? v.planner : null;
  if (!object(v) || !exact(v, ['id', 'goal', 'seed', 'githubRepo', 'planner', 'workers', 'files', 'oracles',
    'integrationOracle', 'baselineUsdEstimate']) || !id(v.id) || v.id.length > 36 || !text(v.goal, 4000) ||
    !object(v.seed) || !exact(v.seed, ['repo', 'revision']) || !text(v.seed.repo, 4096) || !isAbsolute(v.seed.repo) ||
    !text(v.seed.revision, 64) || !UNIVERSE_GIT_OID_RE.test(v.seed.revision) ||
    !text(v.githubRepo, 201) || !/^[\w-]+\/[\w.-]+$/.test(v.githubRepo) ||
    !lane(planner) || planner.tier !== 'frontier' || !Array.isArray(v.workers) || v.workers.length < 1 ||
    v.workers.length > 16 || !v.workers.every(w => lane(w, true)) || v.workers.some(w => w.tier === 'frontier' || w.workerId === planner.workerId) ||
    new Set(v.workers.map(w => w.workerId)).size !== v.workers.length || !files(v.files) ||
    !object(v.oracles) || Object.keys(v.oracles).length > 16 || !id(v.integrationOracle) ||
    !Object.hasOwn(v.oracles, v.integrationOracle) || !(v.baselineUsdEstimate === null ||
      typeof v.baselineUsdEstimate === 'number' && Number.isFinite(v.baselineUsdEstimate) && v.baselineUsdEstimate >= 0)) {
    throw new Error('invalid-swarm-pilot-spec');
  }
  for (const [key, oracle] of Object.entries(v.oracles)) {
    if (!id(key) || !object(oracle) || !exact(oracle, ['command', 'executableDigest']) || !isSha256Hex(oracle.executableDigest) ||
      !Array.isArray(oracle.command) || oracle.command.length < 1 || oracle.command.length > 16 ||
      !oracle.command.every((arg: unknown) => text(arg, 4096)) || !isAbsolute(oracle.command[0]!)) {
      throw new Error('invalid-pinned-oracle');
    }
  }
  return v as unknown as SwarmPilotSpec;
}

export function parseSwarmPilotGraph(output: string, spec: SwarmPilotSpec): SwarmPilotNode[] {
  const raw: unknown = JSON.parse(output);
  if (!Array.isArray(raw) || raw.length < 2 || raw.length > 8) throw new Error('invalid-swarm-graph-size');
  const assigned = new Set<string>();
  const nodes = new Map<string, SwarmPilotNode>();
  for (const v of raw) {
    if (!object(v) || !exact(v, ['id', 'task', 'dependsOn', 'files', 'oracle', 'tier']) ||
      !id(v.id) || v.id.length > 16 || nodes.has(v.id) || !text(v.task, 1200) || !Array.isArray(v.dependsOn) ||
      v.dependsOn.length >= raw.length || !v.dependsOn.every(id) || new Set(v.dependsOn).size !== v.dependsOn.length ||
      !files(v.files) || !v.files.every(f => spec.files.includes(f) && !assigned.has(f)) ||
      !id(v.oracle) || v.oracle === spec.integrationOracle || !Object.hasOwn(spec.oracles, v.oracle) ||
      !text(v.tier, 8) || !isQueueTier(v.tier) || v.tier === 'frontier' || !spec.workers.some(w => w.tier === v.tier) ||
      v.files.length > QUEUE_TIER_SCOPE[v.tier].maxFiles || v.files.length > 16 ||
      new Set(v.files.map(f => f.split('/')[0])).size > QUEUE_TIER_SCOPE[v.tier].maxAreas) {
      throw new Error('invalid-swarm-graph-node');
    }
    v.files.forEach(f => assigned.add(f));
    nodes.set(v.id, v as unknown as SwarmPilotNode);
  }
  const ordered: SwarmPilotNode[] = [];
  const done = new Set<string>();
  while (done.size < nodes.size) {
    const next = [...nodes.values()].find(node => !done.has(node.id) && node.dependsOn.every(dep => done.has(dep)));
    if (!next) throw new Error('swarm-graph-cycle-or-unknown-dependency');
    ordered.push(next);
    done.add(next.id);
  }
  return ordered;
}
