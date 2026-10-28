import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AshlrConfig, WorkItem } from '../src/core/types.js';
import {
  CODEX_ASTRA_MODEL_ID, CODEX_TERRA_MODEL_ID, DEFAULT_CODEX_MODEL_ID,
  KNOWN_MODELS, canonicalModelTag, catalogFor, costOf, pickModel,
  type ModelRoutingTier,
} from '../src/core/run/model-catalog.js';
import { modelForSelectedEngine, modelTierForTask, routeTask } from '../src/core/run/router.js';

const gates = vi.hoisted(() => ({
  quota: vi.fn(() => true),
  scores: vi.fn(() => new Map()),
}));
vi.mock('../src/core/fleet/quota.js', () => ({ withinLimit: gates.quota }));
vi.mock('../src/core/run/learned-router.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/core/run/learned-router.js')>(),
  operationalProducerScoresForRouting: gates.scores,
}));

function task(overrides: Partial<WorkItem> = {}): WorkItem {
  return { id: 'TEST-terra-job', repo: '/TEST/repo', source: 'todo',
    title: 'Implement a feature', detail: '', value: 3, effort: 3, score: 5,
    tags: [], ts: '2026-10-26T12:00:00.000Z', ...overrides };
}
function config(model?: string): AshlrConfig {
  return { version: 1, roots: [], editor: { name: 'vscode' },
    models: { providerChain: ['ollama'], routing: [] },
    foundry: { allowedBackends: ['codex', 'builtin'],
      ...(model ? { models: { codex: model } } : {}) } } as AshlrConfig;
}
const context = { availableEngines: ['codex', 'builtin'] };
const defaults: [ModelRoutingTier, string][] = [
  ['fast', CODEX_TERRA_MODEL_ID], ['mid', CODEX_TERRA_MODEL_ID],
  ['computer', CODEX_TERRA_MODEL_ID], ['work', DEFAULT_CODEX_MODEL_ID],
  ['frontier', CODEX_ASTRA_MODEL_ID],
];

beforeEach(() => {
  gates.quota.mockReset().mockReturnValue(true);
  gates.scores.mockReset().mockReturnValue(new Map());
});

describe('Terra catalog identity and estimates', () => {
  it('exposes exact context, efforts, pricing, speed and allowance estimates', () => {
    const terra = catalogFor('codex').find(entry => entry.apiModelId === CODEX_TERRA_MODEL_ID)!;
    const sol = KNOWN_MODELS.find(entry => entry.apiModelId === DEFAULT_CODEX_MODEL_ID)!;
    const astra = KNOWN_MODELS.find(entry => entry.apiModelId === CODEX_ASTRA_MODEL_ID)!;
    expect(terra.contextWindowTokens).toBe(1_050_000);
    expect(terra.reasoningEfforts).toEqual(['none', 'low', 'medium', 'high', 'xhigh', 'max']);
    expect(terra.costPerMTokIn).toBe(sol.costPerMTokIn * 0.5);
    expect(terra.costPerMTokOut).toBe(sol.costPerMTokOut * 0.5);
    expect(terra.relativeSpeed).toBe(3 * sol.relativeSpeed!);
    expect(terra.planAllowanceWeight).toBeLessThan(sol.planAllowanceWeight!);
    expect(terra.planAllowanceWeight).toBeLessThan(astra.planAllowanceWeight!);
    expect(terra.capabilities).toContain('long-context');
    expect(costOf(terra.id)).toBe(3);
  });

  it.each(['gpt-6.1-terra', 'codex:gpt-6.1-terra', ' codex:codex:gpt-6.1-terra '])(
    'parses canonical catalog spelling %s', spelling => {
      expect(canonicalModelTag('codex', spelling)).toBe(CODEX_TERRA_MODEL_ID);
    });

  it('keeps historical identity and ordinary catalog work defaults stable', () => {
    expect(canonicalModelTag('codex', 'gpt-5.5')).toBe('gpt-5.5');
    expect(pickModel({ engine: 'codex', maxEffort: 5 })?.apiModelId).toBe(DEFAULT_CODEX_MODEL_ID);
    expect(pickModel({ engine: 'codex', preferCheap: true })?.apiModelId).toBe(CODEX_TERRA_MODEL_ID);
  });
});

describe('Codex model tiers through production enrichment and legacy routing', () => {
  it.each(defaults)('%s defaults to %s in both paths', (tier, model) => {
    const item = task({ tags: [`tier=${tier}`] });
    expect(modelForSelectedEngine(item, 'codex', config()).model).toBe(model);
    expect(routeTask(item, config(), context).model).toBe(model);
  });

  it.each([
    task({ source: 'doc' }), task({ source: 'test' }),
    task({ title: 'Verify the refactor' }), task({ title: 'Run the tests' }),
    task({ title: 'FIXUP: address review feedback' }), task({ title: '[FIXUP] repair tests' }),
    task({ title: 'Draft the PR body' }), task({ title: 'Update pull request description' }),
    task({ title: 'Triage pending jobs' }), task({ tags: ['verify'] }),
  ])('classifies routine work as fast: $title ($source)', item => {
    expect(modelTierForTask(item)).toBe('fast');
    expect(modelForSelectedEngine(item, 'codex', config()).model).toBe(CODEX_TERRA_MODEL_ID);
  });

  it.each([
    task({ tags: ['computer-use'] }), task({ tags: ['gui'] }),
    task({ title: 'Inspect the GUI controls' }), task({ title: 'Browser automation smoke pass' }),
  ])('classifies computer work: $title', item => {
    expect(modelTierForTask(item)).toBe('computer');
    expect(routeTask(item, config(), context).model).toBe(CODEX_TERRA_MODEL_ID);
  });

  it('keeps difficult implementation on Sol and explicit frontier on Astra', () => {
    const work = task({ effort: 5, score: 9 });
    expect(modelForSelectedEngine(work, 'codex', config()).model).toBe(DEFAULT_CODEX_MODEL_ID);
    expect(routeTask(work, config(), context).model).toBe(DEFAULT_CODEX_MODEL_ID);
    expect(modelTierForTask(task({ source: 'doc', tags: ['tier:FRONTIER'] }))).toBe('frontier');
    expect(modelTierForTask(task({ tags: ['tier=fast', 'tier=frontier'] }))).toBe('frontier');
  });

  it('does not infer a tier from quoted task detail or malformed tags', () => {
    expect(modelTierForTask(task({ detail: 'tier=fast computer-use', tags: ['not-tier=fast'] }))).toBe('work');
  });

  it.each(defaults)('preserves explicit model pins for %s', tier => {
    const item = task({ tags: [`tier:${tier}`] });
    expect(modelForSelectedEngine(item, 'codex', config('operator-model')).model).toBe('operator-model');
    expect(routeTask(item, config('operator-model'), context).model).toBe('operator-model');
  });

  it('preserves quota refusal, including pinned models', () => {
    gates.quota.mockReturnValue(false);
    const item = task({ tags: ['tier=computer'] });
    expect(modelForSelectedEngine(item, 'codex', config('operator-model')).model).toBeNull();
    expect(routeTask(item, config(), context).engine).toBe('builtin');
  });

  it.each(['cli-agent', 'api-model'] as const)('preserves custom %s engine defaults', kind => {
    const cfg = config();
    cfg.foundry!.engines = { codex: {
      id: 'codex', kind, tier: 'frontier', bin: 'TEST-cli', argv: [],
      defaultModel: 'TEST-native-model',
      api: { envKey: 'TEST_API_KEY', protocol: 'openai',
        defaultBaseUrl: 'http://localhost:1234/v1', defaultModel: 'TEST-api-model' },
    } };
    expect(modelForSelectedEngine(task({ tags: ['tier=computer'] }), 'codex', cfg).model)
      .toBe(kind === 'api-model' ? 'TEST-api-model' : 'TEST-native-model');
    expect(routeTask(task({ tags: ['tier=computer'] }), cfg, context).model)
      .toBe(kind === 'api-model' ? 'TEST-api-model' : 'TEST-native-model');
  });

  it('fails closed on unknown autonomous subscription state and quota read errors', () => {
    const item = task({ tags: ['tier=fast'] });
    expect(routeTask(item, config(), { ...context, autonomous: true }).engine).toBe('builtin');
    gates.quota.mockImplementation(() => { throw new Error('TEST read failed'); });
    expect(modelForSelectedEngine(item, 'codex', config()).model).toBeNull();
  });

  it('does not switch engines when enriching a selected local backend', () => {
    expect(modelForSelectedEngine(task({ tags: ['tier=computer'] }), 'builtin', config()).engine).toBe('builtin');
    expect(routeTask(task({ tags: ['tier=computer'] }), config(), { availableEngines: ['builtin'] }).engine).toBe('builtin');
  });

  it.each(['work', 'frontier'] as const)('does not let legacy model scores promote Terra into %s', tier => {
    const cfg = config();
    cfg.foundry!.modelGranularRouting = { enabled: true, minShipRate: 0.6 };
    gates.scores.mockReturnValue(new Map([[`codex:${CODEX_TERRA_MODEL_ID}`, {
      key: `codex:${CODEX_TERRA_MODEL_ID}`, engine: 'codex', model: CODEX_TERRA_MODEL_ID,
      score: 1, samples: 100,
    }]]));
    const item = task({ tags: [`tier=${tier}`] });
    const expected = tier === 'work' ? DEFAULT_CODEX_MODEL_ID : CODEX_ASTRA_MODEL_ID;
    expect(modelForSelectedEngine(item, 'codex', cfg).model).toBe(expected);
    expect(routeTask(item, cfg, context).model).toBe(expected);
  });

  it('retains autonomous fail-closed subscription admission', () => {
    const item = task({ tags: ['tier=fast'] });
    expect(routeTask(item, config(), context).model).toBe(CODEX_TERRA_MODEL_ID);
    expect(routeTask(item, config(), { ...context, autonomous: true }).engine).toBe('builtin');
  });
});
