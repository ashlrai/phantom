import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { QUEUE_TIER_SCOPE } from '../drive/queue-tier.js';
import { killSwitchOn } from '../sandbox/policy.js';
import { readResourceJson, readResourcePoolHistory } from '../resources/pool-runtime.js';
import { validateResourceLocalModelConfig } from '../resources/local-model-refresh.js';
import { validateResourcePool } from '../resources/pool-policy.js';
import { validateResourceBindings } from '../resources/worker.js';
import { resourceCommissioningFences } from '../resources/pool-commissioning-custody.js';
import {
  canonical, defaultUniverseRoot, digest, evaluationExecutableDigest, inspectPrivateDirectory, isStrictIsoTimestamp,
  isUniverseId, pinSeed, privateDirectory, readArtifactSnapshot, UNIVERSE_GIT_OID_RE,
} from '../universe/artifacts.js';
import { deliverUniverseElite, validUniverseDeliveryBranch } from '../universe/delivery.js';
import { deliveryGit } from '../universe/delivery-git.js';
import { deliverUniverseIntegration } from '../universe/integration-delivery.js';
import { evaluateUniverseIntegration, readUniverseIntegrationEvaluation } from '../universe/integration-evaluate.js';
import { readUniverseIntegrationPlan } from '../universe/integration-plan.js';
import {
  checkResourceGenerationWorkspace, generateResourceCompletion, validateResourceGenerationRuntime,
} from '../universe/resource-generation.js';
import { runUniverse } from '../universe/runner.js';
import { initUniverse, manifestRecord, universePath } from '../universe/store.js';
import type { UniverseManifest, UniverseResourceGenerationConfig, UniverseTrial } from '../universe/types.js';
import type { UniverseIntegrationDefinition } from '../universe/integration-types.js';
import { defaultResourceLiveRunsDir } from '../usage/resource-live/feed.js';
import { readFleetResourcePlan } from '../usage/resource-live/fleet-plan.js';
import { writePrivateFileAtomically } from '../util/private-file-write.js';
import { parseSwarmPilotGraph, readSwarmPilotSpec, type SwarmPilotNode, type SwarmPilotSpec } from './pilot-plan.js';
import { inspectSwarmFleetLane } from './fleet-worker-lanes.js';

const TIMEOUT = 300_000;
const ATTEMPTS = 2;
const MAX_ACTIVE_NODES = 2;

function allocateWorkerWave(ready: SwarmPilotNode[], workers: SwarmPilotSpec['workers'],
  plan: Awaited<ReturnType<typeof readFleetResourcePlan>> | null, now: number) {
  const slots = new Map<string, number>();
  const deadlines = new Map<string, number>();
  if (plan) {
    for (const row of plan.lanes) {
      if (row.target_concurrency !== null && row.running !== null) slots.set(row.lane, Math.max(0, row.target_concurrency - row.running));
    }
    for (const row of plan.allowances) {
      const at = Date.parse(row.deadline_at ?? '');
      if (row.lane && row.action === 'burn' && at > now) deadlines.set(row.lane, Math.min(at, deadlines.get(row.lane) ?? Infinity));
    }
  }
  const wave: Array<{ node: SwarmPilotNode; attempts: string[][] }> = [];
  const take = (node: SwarmPilotNode) => {
    const eligible = workers.filter(worker => worker.tier === node.tier);
    const key = (worker: (typeof eligible)[number]) => worker.fleetLane ?? worker.workerId;
    const measured = eligible.map(key).filter(lane => (slots.get(lane) ?? 0) > 0);
    measured.sort((a, b) => (deadlines.get(a) ?? Number.MAX_SAFE_INTEGER) - (deadlines.get(b) ?? Number.MAX_SAFE_INTEGER));
    const chosen = measured[0];
    if (chosen !== undefined) {
      slots.set(chosen, slots.get(chosen)! - 1);
      return eligible.filter(worker => key(worker) === chosen).map(worker => worker.workerId);
    }
    return eligible.filter(worker => !slots.has(key(worker))).map(worker => worker.workerId);
  };
  for (const node of ready) {
    const first = take(node);
    if (first.length) wave.push({ node, attempts: [first] });
    if (wave.length === MAX_ACTIVE_NODES) break;
  }
  for (const entry of wave) {
    while (entry.attempts.length < ATTEMPTS) {
      const next = take(entry.node);
      if (!next.length) break;
      entry.attempts.push(next);
    }
  }
  return wave;
}

interface PilotWorkerLane {
  id: string;
  admissionReason(): 'unsupported-worker-lane' | 'subscription-only-lane-required' | 'local-model-readiness-required' | null;
}

interface PilotLaneAdapter {
  lane(id: string): PilotWorkerLane;
  generation(ids: string[], files: string[], maxOutputTokens: number): UniverseResourceGenerationConfig;
}

function openLanes(runtimePath: string, spec: SwarmPilotSpec) {
  const runtime = validateResourceGenerationRuntime(readResourceJson(runtimePath));
  const pool = validateResourcePool(readResourceJson(runtime.poolPath));
  const bindings = validateResourceBindings(readResourceJson(runtime.bindingsPath), pool);
  const localPath = runtime.localModelConfigPath;
  const localModels = localPath ? validateResourceLocalModelConfig(readResourceJson(localPath), pool, bindings) : null;
  const lane = (id: string): PilotWorkerLane => ({
    id,
    admissionReason() {
      const worker = pool.workers.find(row => row.id === id);
      if (!worker) return 'unsupported-worker-lane';
      if (worker.provider === 'local') return localModels?.workers.some(row => row.workerId === id)
        ? null : 'local-model-readiness-required';
      return runtime.quotaEvidenceMode === 'shared-collector' &&
        resourceCommissioningFences(readResourcePoolHistory(runtime.root, pool, bindings)).has(id)
        ? null : 'subscription-only-lane-required';
    },
  });
  const resource = { kind: 'resource-pool' as const, poolId: pool.id, poolDigest: digest(canonical({ pool, bindings })) };
  const adapter: PilotLaneAdapter = { lane, generation: (allowedWorkerIds, files, maxOutputTokens) =>
    ({ ...resource, allowedWorkerIds, files, maxOutputTokens }) };
  const reasons = [spec.planner, ...spec.workers].map(row => {
    const worker = adapter.lane(row.workerId);
    return { workerId: worker.id, reason: worker.admissionReason() };
  }).filter(row => row.reason !== null);
  const context = { resourceRuntime: runtimePath, expectedResourceRuntimeDigest: digest(canonical(runtime)) };
  const stopped = (ids: string[]) => killSwitchOn() || ids.some(id => lane(id).admissionReason() !== null);
  return { runtime, reasons, adapter, context, stopped };
}

function pinnedOracle(spec: SwarmPilotSpec, id: string): UniverseManifest['evaluation'] {
  const { command, executableDigest } = spec.oracles[id]!;
  const path = command[0]!;
  const rel = relative(spec.seed.repo, path);
  if (realpathSync(path) !== path || !(rel === '..' || rel.startsWith('../')) ||
      evaluationExecutableDigest(path) !== executableDigest) throw new Error('oracle-pin-mismatch');
  return { command, timeoutMs: TIMEOUT };
}

type Attempt = {
  variant: string; workerId: string | null; taskId: string | null; dispatch: string | null;
  usage: { inputTokens: number | null; outputTokens: number | null }; usageScope: string | null;
  status: string; durationMs: number; oracle: { status: string; score: number | null } | null; scope: 'accepted' | 'rejected' | null;
};
type Delivery = { branch: string; commit: string };
interface PilotLedger {
  schema: 'swarm.pilot.v1'; id: string; specDigest: string; githubRepo: string;
  status: 'running' | 'held' | 'delivered'; reason: string | null;
  baselineUsdEstimate: number | null; meteredCostUsd: number | null;
  planner: Attempt | null; graphDigest: string | null;
  nodes: Array<{ id: string; dependsOn: string[]; oracleId: string; attempts: Attempt[]; selected: string | null }>;
  integration: { status: string; score: number | null; oracleId: string } | null;
  delivery: Delivery | null;
}

function ledgerReport(row: PilotLedger, merge: { pr: number; commit: string; mergedAt: string } | null = null) {
  return { ...row, merge, costPerMergedChangeUsd: merge === null ? null : row.meteredCostUsd };
}

function changedLines(base: string, artifact: string, paths: string[]): number {
  let lines = 0;
  for (const file of paths) {
    const result = spawnSync('git', ['diff', '--no-index', '--numstat', '--no-ext-diff', '--no-textconv', '--',
      join(base, file), join(artifact, file)], {
      cwd: base, encoding: 'utf8', timeout: 5000, maxBuffer: 16_384,
      env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', LC_ALL: 'C' },
    });
    if (result.status === 0 && !result.error) continue;
    const match = /^(\d+)\t(\d+)\t/.exec(result.stdout ?? '');
    if (result.status !== 1 || result.error || !match) return Infinity;
    lines += Number(match[1]) + Number(match[2]);
  }
  return lines;
}

function attempt(trial: UniverseTrial): Attempt {
  const generation = trial.generation;
  return { variant: trial.variantId, workerId: generation?.resource?.workerId ?? null,
    taskId: generation?.resource?.taskId ?? null, dispatch: generation?.resource?.dispatch ?? null,
    usage: { inputTokens: generation?.usage.inputTokens ?? null, outputTokens: generation?.usage.outputTokens ?? null },
    usageScope: generation?.resource?.usageScope ?? null, status: generation?.status ?? trial.status, durationMs: trial.durationMs,
    oracle: generation?.status === 'succeeded' ? { status: trial.status, score: trial.score } : null, scope: null };
}

export async function runSwarmPilot(input: unknown, runtimePath: string, options: {
  apply?: boolean; root?: string;
} = {}) {
  const spec = readSwarmPilotSpec(input);
  const seed = pinSeed(spec.seed.repo, spec.seed.revision);
  if (seed.repo !== spec.seed.repo) throw new Error('noncanonical-seed-repository');
  const seedFiles = new Set(deliveryGit(seed.repo).entries(seed.revision).map(entry => entry.path));
  if (spec.files.some(file => !seedFiles.has(file))) throw new Error('swarm-scope-file-not-in-seed');
  for (const id of Object.keys(spec.oracles)) pinnedOracle(spec, id);
  const lanes = openLanes(runtimePath, spec);
  if (!options.apply || lanes.reasons.length) {
    const excluded = await Promise.all(lanes.reasons.map(async row => {
      const transport = row.reason === 'unsupported-worker-lane' ? await inspectSwarmFleetLane(row.workerId) : null;
      return transport ? { ...row, transport } : row;
    }));
    return { schema: 'swarm.pilot.preview.v1', status: lanes.reasons.length ? 'held' : 'preview',
      id: spec.id, baselineUsdEstimate: spec.baselineUsdEstimate, excluded };
  }
  if (process.platform !== 'darwin') throw new Error('fixed-evaluator-confinement-unsupported');
  const plannerIds = [spec.planner.workerId];
  if (lanes.stopped(plannerIds)) throw new Error('swarm-pilot-admission-held');
  checkResourceGenerationWorkspace(lanes.runtime.workspace, () => TIMEOUT);
  const root = privateDirectory(resolve(options.root ?? defaultUniverseRoot()));
  const directory = join(privateDirectory(join(root, 'swarm-pilots')), spec.id);
  mkdirSync(directory, { mode: 0o700 });
  const ledger: PilotLedger = { schema: 'swarm.pilot.v1', id: spec.id, specDigest: digest(canonical(spec)),
    githubRepo: spec.githubRepo, status: 'running', reason: null, meteredCostUsd: null,
    baselineUsdEstimate: spec.baselineUsdEstimate, planner: null, graphDigest: null, nodes: [], integration: null, delivery: null };
  const persist = () => writePrivateFileAtomically(join(directory, randomUUID()), join(directory, 'ledger.json'),
    canonical(ledger), { anchorPath: directory, label: 'swarm pilot ledger' });
  persist();
  const metric = { name: 'oracle', direction: 'maximize' as const, minImprovement: 0 };
  const initialize = (id: string, objective: string, oracle: string, variants: UniverseManifest['variants'], limit = ATTEMPTS) => {
    const evaluation = pinnedOracle(spec, oracle);
    if (existsSync(universePath(root, id))) throw new Error('swarm-universe-already-exists');
    const budget = { maxTrials: limit, maxParallel: limit, maxDurationMs: TIMEOUT, trialTimeoutMs: TIMEOUT };
    initUniverse({ schemaVersion: 1, id, name: id, objective, seed, metric, evaluation, budget, variants }, { root });
    const record = manifestRecord(universePath(root, id));
    if (record.evaluationExecutableDigest !== spec.oracles[oracle]!.executableDigest) throw new Error('oracle-pin-mismatch');
    return record;
  };
  let reason = 'planner-unavailable';
  try {
    const runId = randomUUID();
    const plannerStart = performance.now();
    const planner = await generateResourceCompletion(lanes.adapter.generation(plannerIds, spec.files.slice(0, 1), 4096), {
      resourceRuntime: lanes.context.resourceRuntime, expectedRuntimeDigest: lanes.context.expectedResourceRuntimeDigest,
      resourceUniverseRoot: root, candidatePath: directory, timeoutMs: TIMEOUT,
      signal: AbortSignal.timeout(TIMEOUT), isExecutionStopped: () => lanes.stopped(plannerIds),
      resourceIdentity: { universeId: spec.id, runId, variantId: 'planner' },
      messages: [{ role: 'system', content: 'Return ONLY a JSON array of 2–8 objects with keys id, task, dependsOn, files, oracle, tier. ' +
        'Use disjoint existing files and enrolled worker tiers. Each leaf must pass its named oracle on the original base with only ' +
        'its own edits. Dependencies supply interface context, not prior edits in the leaf checkout. Do not return shell commands.' },
      { role: 'user', content: canonical({ goal: spec.goal, files: spec.files, tiers: [...new Set(spec.workers.map(w => w.tier))],
        oracles: Object.keys(spec.oracles).filter(id => id !== spec.integrationOracle) }) }],
    });
    ledger.planner = { variant: 'planner', workerId: planner.resource.workerId, taskId: planner.resource.taskId,
      usage: planner.usage, usageScope: planner.resource.usageScope, status: planner.status,
      durationMs: Math.round(performance.now() - plannerStart), dispatch: planner.resource.dispatch, scope: null, oracle: null };
    persist();
    if (planner.status !== 'succeeded' || !planner.content) throw new Error();
    reason = 'invalid-planner-graph';
    const graph = parseSwarmPilotGraph(planner.content, spec);
    ledger.graphDigest = digest(canonical(graph));
    ledger.nodes = graph.map(n => ({ id: n.id, dependsOn: n.dependsOn, oracleId: n.oracle, attempts: [], selected: null }));
    persist();
    const source = new Map<string, { pin: UniverseIntegrationDefinition['sources'][number]; handoff: string; lines: number }>();
    const sourceNode = async ({ node, attempts }: ReturnType<typeof allocateWorkerWave>[number]) => {
      const allowedWorkerIds = [...new Set(attempts.flat())];
      const nodeId = `${spec.id}-n-${node.id}`;
      const row = ledger.nodes.find(n => n.id === node.id)!;
      const handoffs = node.dependsOn.map(id => ({ node: id, files: source.get(id)!.handoff }));
      const hypothesis = `${node.task}\nDependency handoffs (read-only excerpts): ${canonical(handoffs).slice(0, 2500)}`;
      const record = initialize(nodeId, node.task, node.oracle,
        attempts.map((ids, i) => ({ id: `attempt-${i}`, niche: `attempt-${i}`, hypothesis,
          generation: lanes.adapter.generation(ids, node.files, 8192) })), attempts.length);
      const run = await runUniverse(nodeId, { ...lanes.context, root,
        isExecutionStopped: () => lanes.stopped(allowedWorkerIds) });
      row.attempts = run.trials.map(attempt);
      persist();
      if (run.status !== 'completed') throw new Error();
      const candidates = run.trials.flatMap((trial, index) => {
        if (!trial.selected || trial.score === null || !trial.artifact) return [];
        const paths = trial.generation?.changedFiles ?? [];
        const lines = changedLines(record.seedArtifact.path, trial.artifact.path, paths);
        const ok = paths.length > 0 && paths.every(p => node.files.includes(p)) && lines <= QUEUE_TIER_SCOPE[node.tier].maxLines;
        row.attempts[index]!.scope = ok ? 'accepted' : 'rejected';
        return ok ? [{ trial, lines, paths, score: trial.score, artifact: trial.artifact }] : [];
      }).sort((a, b) => b.score - a.score || a.trial.variantId.localeCompare(b.trial.variantId));
      const winner = candidates[0];
      persist();
      if (!winner || lanes.stopped(allowedWorkerIds)) throw new Error();
      const handoff = canonical(readArtifactSnapshot(winner.artifact.path).entries.filter(e => winner.paths.includes(e.path))
        .map(e => ({ path: e.path, contents: e.data.toString('utf8').slice(0, 400) }))).slice(0, 800);
      const receipt = await deliverUniverseElite(nodeId, { root, trialId: winner.trial.id, branch: `codex/swarm-${nodeId}` });
      if (receipt.status !== 'delivered') throw new Error();
      row.selected = winner.trial.variantId;
      source.set(node.id, { pin: { universeId: nodeId, deliveryId: receipt.id, commit: receipt.commit, tree: receipt.tree },
        handoff, lines: winner.lines });
      persist();
    };
    while (source.size < graph.length) {
      const ready = graph.filter(n => !source.has(n.id) && n.dependsOn.every(dep => source.has(dep)));
      const now = Date.now();
      const plan = await readFleetResourcePlan(defaultResourceLiveRunsDir(), now).catch(() => null);
      const wave = allocateWorkerWave(ready, spec.workers, plan, now);
      reason = wave.length ? 'node-withheld-or-no-eligible-candidate' : 'worker-capacity-unavailable';
      if (!wave.length) throw new Error();
      const results = await Promise.allSettled(wave.map(sourceNode));
      if (results.some(r => r.status === 'rejected')) throw new Error();
    }
    reason = 'integration-scope-exceeded';
    const paths = graph.flatMap(n => n.files);
    if (new Set(paths.map(p => p.split('/')[0])).size > QUEUE_TIER_SCOPE.frontier.maxAreas ||
        [...source.values()].reduce((sum, item) => sum + item.lines, 0) > QUEUE_TIER_SCOPE.frontier.maxLines) throw new Error();
    reason = 'integration-withheld-or-rejected';
    const id = `${spec.id}-integrated`;
    if (killSwitchOn()) throw new Error();
    const record = initialize(id, spec.goal, spec.integrationOracle,
      [{ id: 'unused', niche: 'unused', hypothesis: 'Integration is evaluated without generation', command: ['/usr/bin/false'] }]);
    const integration: UniverseIntegrationDefinition = { schemaVersion: 1, id, target: {
      repo: seed.repo, baseCommit: seed.revision, allowedPaths: paths }, sources: graph.map(n => source.get(n.id)!.pin) };
    const plan = readUniverseIntegrationPlan(integration, { root });
    if (!plan.compositionReady || !plan.compositionDigest || killSwitchOn()) throw new Error();
    const evaluation = { schemaVersion: 1 as const, id, integration, expectedCompositionDigest: plan.compositionDigest,
      acceptance: { universeId: id, manifestDigest: record.manifestDigest, comparatorDigest: record.comparatorDigest },
      maxDurationMs: TIMEOUT };
    const result = await evaluateUniverseIntegration(evaluation, { root });
    ledger.integration = { status: result.status, score: result.score, oracleId: spec.integrationOracle };
    persist();
    const evidence = result.status === 'passed' && readUniverseIntegrationEvaluation(evaluation, { root });
    if (!evidence || killSwitchOn()) throw new Error();
    const receipt = await deliverUniverseIntegration({ schemaVersion: 1, evaluation, expectedEvaluationDigest: evidence.resultDigest,
      branch: `codex/swarm-${id}`, maxDurationMs: TIMEOUT }, { root });
    if (receipt.status !== 'delivered') throw new Error();
    ledger.delivery = { branch: receipt.branch, commit: receipt.commit };
    ledger.status = 'delivered';
    ledger.meteredCostUsd = 0;
  } catch {
    ledger.status = 'held';
    ledger.reason = reason;
  }
  persist();
  return ledgerReport(ledger);
}

export function readSwarmPilotReport(id: string, root = defaultUniverseRoot(), pr?: number) {
  if (!isUniverseId(id)) throw new Error('invalid-swarm-pilot-id');
  const directory = inspectPrivateDirectory(join(root, 'swarm-pilots', id));
  const row = readResourceJson(join(directory, 'ledger.json')) as PilotLedger;
  if (row.schema !== 'swarm.pilot.v1' || row.id !== id) throw new Error('invalid-swarm-pilot-ledger');
  if (pr === undefined) return ledgerReport(row);
  if (!Number.isSafeInteger(pr) || pr < 1 || !row.delivery || row.status !== 'delivered' ||
      !validUniverseDeliveryBranch(row.delivery.branch) || !UNIVERSE_GIT_OID_RE.test(row.delivery.commit) ||
      !/^[\w-]+\/[\w.-]+$/.test(row.githubRepo)) throw new Error('merge-receipt-unavailable');
  const response = JSON.parse(execFileSync('gh', ['pr', 'view', String(pr), '--repo', row.githubRepo,
    '--json', 'state,headRefOid,mergedAt,mergeCommit'], { cwd: directory, encoding: 'utf8', timeout: 15_000, maxBuffer: 16_384,
    stdio: ['ignore', 'pipe', 'pipe'] })) as { state: string; headRefOid: string; mergedAt: string; mergeCommit?: { oid: string } };
  if (response.state !== 'MERGED' || response.headRefOid !== row.delivery.commit || !isStrictIsoTimestamp(response.mergedAt) ||
      !response.mergeCommit || !UNIVERSE_GIT_OID_RE.test(response.mergeCommit.oid)) throw new Error('merge-receipt-mismatch');
  return ledgerReport(row, { pr, commit: response.mergeCommit.oid, mergedAt: response.mergedAt });
}
