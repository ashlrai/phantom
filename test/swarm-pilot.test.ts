import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { evaluationExecutableDigest } from '../src/core/universe/artifacts.js';
import { parseSwarmPilotGraph, readSwarmPilotSpec } from '../src/core/swarm/pilot-plan.js';
import { readSwarmPilotReport, runSwarmPilot } from '../src/core/swarm/pilot.js';
import type { UniverseManifest } from '../src/core/universe/types.js';

const port = vi.hoisted(() => ({
  generate: vi.fn(), run: vi.fn(), evaluate: vi.fn(), delivery: vi.fn(), deliverElite: vi.fn(),
  manifest: vi.fn(), init: vi.fn(), github: vi.fn(),
  localWorkers: ['planner', 'worker'],
}));
vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), execFileSync: port.github }));
vi.mock('../src/core/sandbox/policy.js', () => ({ killSwitchOn: () => false }));
vi.mock('../src/core/universe/artifacts.js', async original => ({
  ...await original<typeof import('../src/core/universe/artifacts.js')>(),
  pinSeed: (repo: string, revision: string) => ({ repo, revision }),
}));
vi.mock('../src/core/universe/delivery-git.js', () => ({ deliveryGit: () => ({
  entries: () => ['src/a.ts', 'src/b.ts', 'src/c.ts'].map(path => ({ path })),
}) }));
vi.mock('../src/core/universe/resource-generation.js', () => ({
  checkResourceGenerationWorkspace: vi.fn(), generateResourceCompletion: port.generate,
  validateResourceGenerationRuntime: () => ({ poolPath: 'pool', bindingsPath: 'bindings', localModelConfigPath: 'local' }),
}));
vi.mock('../src/core/resources/local-model-refresh.js', () => ({
  validateResourceLocalModelConfig: () => ({ workers: port.localWorkers.map(workerId => ({ workerId })) }),
}));
vi.mock('../src/core/resources/pool-runtime.js', async original => {
  const real = await original<typeof import('../src/core/resources/pool-runtime.js')>();
  return { ...real, readResourceJson: (path: string) => path.endsWith('ledger.json') ? real.readResourceJson(path) : {} };
});
vi.mock('../src/core/resources/pool-policy.js', () => ({ validateResourcePool: () => ({
  id: 'pool', workers: [{ id: 'planner', provider: 'local' }, { id: 'worker', provider: 'local' }, { id: 'native', provider: 'codex' }],
}) }));
vi.mock('../src/core/resources/worker.js', () => ({ validateResourceBindings: () => [] }));
vi.mock('../src/core/universe/runner.js', () => ({ runUniverse: port.run }));
vi.mock('../src/core/universe/store.js', () => ({
  universePath: (root: string, id: string) => join(root, 'universes', id),
  initUniverse: port.init, manifestRecord: port.manifest,
}));
vi.mock('../src/core/universe/delivery.js', () => ({
  deliverUniverseElite: port.deliverElite, validUniverseDeliveryBranch: (branch: string) => branch.startsWith('codex/'),
}));
vi.mock('../src/core/universe/integration-plan.js', () => ({
  readUniverseIntegrationPlan: () => ({ compositionReady: true, compositionDigest: 'c'.repeat(64) }),
}));
vi.mock('../src/core/universe/integration-evaluate.js', () => ({
  evaluateUniverseIntegration: port.evaluate, readUniverseIntegrationEvaluation: () => ({ resultDigest: 'd'.repeat(64) }),
}));
vi.mock('../src/core/universe/integration-delivery.js', () => ({ deliverUniverseIntegration: port.delivery }));

const commit = 'a'.repeat(40);
const mergedAt = '2026-11-02T00:00:00.000Z';
const graph = [
  { id: 'a', task: 'Change A', dependsOn: [], files: ['src/a.ts'], tier: 'fast', oracle: 'leaf' },
  { id: 'b', task: 'Change B', dependsOn: [], files: ['src/b.ts'], tier: 'fast', oracle: 'leaf' },
  { id: 'c', task: 'Change C', dependsOn: ['a', 'b'], files: ['src/c.ts'], tier: 'fast', oracle: 'leaf' },
];
let root: string;
let oracle: string;
let executableDigest: string;
let manifests: Map<string, UniverseManifest>;
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
beforeEach(() => {
  vi.resetAllMocks();
  port.localWorkers = ['planner', 'worker'];
  root = realpathSync(mkdtempSync(join(tmpdir(), 'swarm-pilot-')));
  oracle = join(root, 'oracle');
  writeFileSync(oracle, '#!/bin/sh\n', { mode: 0o700 });
  executableDigest = evaluationExecutableDigest(oracle);
  mkdirSync(join(root, 'base', 'src'), { recursive: true });
  for (const node of graph) writeFileSync(join(root, 'base', node.files[0]!), 'old\n');
  manifests = new Map();
  port.init.mockImplementation((value: UniverseManifest) => manifests.set(value.id, value));
  port.manifest.mockReturnValue({ seedArtifact: { path: join(root, 'base') }, evaluationExecutableDigest: executableDigest });
  port.generate.mockResolvedValue({ status: 'succeeded', content: JSON.stringify(graph),
    resource: { workerId: 'planner', taskId: 'planner-task', usageScope: null, dispatch: 'settled' },
    usage: { state: 'reported', inputTokens: 10, outputTokens: 5 } });
  port.deliverElite.mockResolvedValue({ id: 'b'.repeat(64), status: 'delivered', commit, tree: commit });
  port.evaluate.mockResolvedValue({ status: 'passed', score: 10 });
  port.delivery.mockResolvedValue({ status: 'delivered', branch: 'codex/swarm-demo-integrated', commit });
});
afterEach(() => {
  Object.defineProperty(process, 'platform', platform);
  rmSync(root, { recursive: true, force: true });
});

function spec(workerId = 'worker') {
  const pin = { command: [oracle], executableDigest };
  return { id: 'demo', goal: 'Improve modules', seed: { repo: join(root, 'seed'), revision: commit },
    githubRepo: 'owner/repo', planner: { workerId: 'planner', tier: 'frontier' }, workers: [{ workerId, tier: 'fast' }],
    files: graph.flatMap(n => n.files), oracles: { leaf: pin, final: pin }, integrationOracle: 'final', baselineUsdEstimate: 15 };
}

describe('resource-pool swarm pilot', () => {
  it('validates only pinned leaf IDs, disjoint scopes, and an acyclic graph', () => {
    const input = readSwarmPilotSpec(spec());
    expect(parseSwarmPilotGraph(JSON.stringify([...graph].reverse()), input).at(-1)?.id).toBe('c');
    expect(() => parseSwarmPilotGraph(JSON.stringify([{ ...graph[0], dependsOn: ['c'] }, ...graph.slice(1)]), input))
      .toThrow('swarm-graph-cycle-or-unknown-dependency');
    for (const invalid of [{ ...graph[1], oracle: 'untrusted' }, { ...graph[1], files: ['src/a.ts'] }]) {
      expect(() => parseSwarmPilotGraph(JSON.stringify([graph[0], invalid]), input)).toThrow('invalid-swarm-graph-node');
    }
  });

  it('defaults to preview and holds unsupported and uncommissioned lanes without inference', async () => {
    await expect(runSwarmPilot(spec(), '/runtime', { root })).resolves.toMatchObject({ status: 'preview' });
    await expect(runSwarmPilot(spec('flash'), '/runtime', { root, apply: true })).resolves.toMatchObject({
      status: 'held', excluded: [{ workerId: 'flash', reason: 'unsupported-worker-lane' }],
    });
    await expect(runSwarmPilot(spec('native'), '/runtime', { root, apply: true })).resolves.toMatchObject({
      status: 'held', excluded: [{ workerId: 'native', reason: 'subscription-only-lane-required' }],
    });
    writeFileSync(oracle, 'drift');
    await expect(runSwarmPilot(spec(), '/runtime', { root })).rejects.toThrow('oracle-pin-mismatch');
    expect(port.generate).not.toHaveBeenCalled();
  });

  it('holds a local worker without explicit inventory enrollment', async () => {
    port.localWorkers = ['planner'];
    await expect(runSwarmPilot(spec(), '/runtime', { root, apply: true })).resolves.toMatchObject({
      status: 'held', excluded: [{ workerId: 'worker', reason: 'local-model-readiness-required' }],
    });
    expect(port.generate).not.toHaveBeenCalled();
  });

  it.each(['passed', 'rejected'])('runs parallel leaves, selects eligible attempts, and handles a %s integration', async status => {
    Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' });
    let unblock!: () => void;
    const secondStarted = new Promise<void>(resolve => { unblock = resolve; });
    port.run.mockImplementation(async (id: string) => {
      const node = graph.find(n => n.id === id.at(-1))!;
      if (node.id === 'a') await secondStarted;
      if (node.id === 'b') unblock();
      if (node.id === 'c') {
        expect(port.deliverElite).toHaveBeenCalledTimes(2);
        expect(manifests.get(id)!.variants[0]!.hypothesis).toContain('accepted leaf');
      }
      const file = node.files[0]!;
      const trial = (index: number) => {
        const path = join(root, `${id}-${index}`);
        mkdirSync(join(path, 'src'), { recursive: true });
        writeFileSync(join(path, file), index === 0 ? 'too large\n'.repeat(85) : 'accepted leaf\n');
        return { id: `${id}-${index}`, variantId: `attempt-${index}`, status: 'passed', durationMs: 10, selected: true, score: 10 - index,
          artifact: { path }, generation: { status: 'succeeded', changedFiles: [file], usage: { inputTokens: 5, outputTokens: 2 } } };
      };
      return { status: 'completed', trials: [trial(0), trial(1)] };
    });
    port.evaluate.mockResolvedValue({ status, score: status === 'passed' ? 10 : null });
    const report = await runSwarmPilot(spec(), '/runtime', { root, apply: true });
    expect(port.generate).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      expectedRuntimeDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));
    expect(report).toMatchObject({ status: status === 'passed' ? 'delivered' : 'held', costPerMergedChangeUsd: null,
      integration: { status }, nodes: graph.map(n => ({ id: n.id, selected: 'attempt-1', attempts: [
        { scope: 'rejected', oracle: { status: 'passed' } }, { scope: 'accepted' },
      ] })) });
    expect(port.delivery).toHaveBeenCalledTimes(status === 'passed' ? 1 : 0);
    if (status === 'passed') {
      port.github.mockReturnValue(JSON.stringify({ state: 'MERGED', headRefOid: commit, mergedAt, mergeCommit: { oid: 'b'.repeat(40) } }));
      expect(readSwarmPilotReport('demo', root, 12)).toMatchObject({ costPerMergedChangeUsd: 0, baselineUsdEstimate: 15, merge: { pr: 12 } });
      port.github.mockReturnValue(JSON.stringify({ state: 'MERGED', headRefOid: 'd'.repeat(40), mergedAt, mergeCommit: { oid: commit } }));
      expect(() => readSwarmPilotReport('demo', root, 34)).toThrow('merge-receipt-mismatch');
    }
  });
});
