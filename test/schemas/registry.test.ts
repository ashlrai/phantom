import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import type { ConductorCycleSummary } from '../../src/core/goals/conductor.js';

const ROOT = new URL('../../schemas/', import.meta.url);
const DIALECT = 'http://json-schema.org/draft-07/schema#';
const IDS = ['fleet.v1', 'loop.v1', 'ci_time.v1', 'ecosystem-changelog.v1'] as const;
type SchemaId = typeof IDS[number];
type Row = Record<string, unknown>;

function readJson(url: URL): Row {
  return JSON.parse(readFileSync(url, 'utf8')) as Row;
}

const registry = readJson(new URL('registry.json', ROOT));
const paths = registry['schemas'] as Record<SchemaId, string>;
const provider = new AjvJsonSchemaValidator();
const schemas = Object.fromEntries(IDS.map(id => [id, readJson(new URL(paths[id], ROOT))]));
const validators = Object.fromEntries(IDS.map(id => [id, provider.getValidator(schemas[id])]));

function objectAt(data: unknown, path = ''): Row {
  let value = data;
  for (const key of path ? path.split('.') : []) value = (value as Row)[key];
  if (value === null || typeof value !== 'object') throw new Error(`Expected object at ${path}`);
  return value as Row;
}

function replace(data: unknown, path: string, value: unknown): void {
  const parts = path.split('.');
  const key = parts.pop()!;
  objectAt(data, parts.join('.'))[key] = value;
}

function fixture(id: SchemaId): Row {
  return readJson(new URL(`./fixtures/${id}.json`, import.meta.url));
}

// Exercise every nested fleet record, alongside the checked-in degraded snapshot.
// Values are synthetic; no test reads the operator's state or calls a provider.
function populated(id: SchemaId): Row {
  const data = fixture(id);
  if (id !== 'fleet.v1') return data;
  const at = '2026-10-26T12:00:00.000Z';
  data['readings'] = [{ pool: 'codex-cmp', used_pct: 25, at, source: 'manual', age_seconds: 0 }];
  Object.assign(objectAt(data, 'pools.1'), {
    source: 'manual', used_pct: 25, remaining_pct: 75, reading_at: at,
    age_seconds: 0, burn_pct_per_hour: 1, runway_hours: 75,
    actual: [{ at, used_pct: 25 }], planner: [{ at, used_pct: 30 }],
  });
  data['router'] = {
    source: 'known',
    decisions: [{
      ts: at, jobId: 'job-1', jobType: 'work', poolId: 'codex-cmp', consumer: 'codex',
      policyId: 'synthetic', canary: false, propensity: 1, solver: 'greedy',
      fallback: null, grantsMergeAuthority: false, netValue: 1,
    }],
    regret: [{
      jobId: 'job-1', jobType: 'work', chosenPool: 'codex-cmp', chosenConsumer: 'codex',
      betterPool: null, betterConsumer: null, chosenValue: 1, betterValue: null, regret: null,
    }],
  };
  data['agents'] = [{ agent: 'codex', repo: 'ashlrai/phantom', task: 'schema registry', claim_id: 'claim-1', expires_at: at }];
  Object.assign(objectAt(data, 'repos.0'), {
    source: 'known', complete: true,
    open: [{
      number: 1, state: 'open', title: 'Synthetic PR',
      url: 'https://github.com/ashlrai/phantom/pull/1', ci: 'passed',
      cost: [{ pool: 'codex-cmp', value: 1, unit: 'pool-unit' }],
    }],
    merged: [],
  });
  data['coordination'] = {
    state: 'known', expiredClaims: 0,
    claims: [{ id: 'claim-1', repo: 'ashlrai/phantom', task: 'schema registry', agent: 'codex', claimedAt: at, expiresAt: at }],
    messages: [{ id: 'msg-1', from: 'codex', to: 'fleet', body: 'Synthetic observation', at, expiresAt: at }],
    proposals: [{ id: 'proposal-1', repo: 'ashlrai/phantom', task: 'schema registry', to: 'fleet', at, expiresAt: at }],
  };
  return data;
}

function walk(value: unknown, visit: (node: Row) => void): void {
  if (value === null || typeof value !== 'object') return;
  if (!Array.isArray(value)) visit(value as Row);
  for (const child of Object.values(value)) walk(child, visit);
}

describe('versioned JSON Schema registry', () => {
  it('indexes every schema exactly once with a local, versioned path', () => {
    expect(registry).toEqual({ version: 1, schemas: Object.fromEntries(IDS.map(id => [id, `${id}.schema.json`])) });
    expect(readdirSync(ROOT).filter(path => path.endsWith('.schema.json')).sort()).toEqual(Object.values(paths).sort());
    expect(new Set(Object.values(schemas).map(schema => schema['$id'])).size).toBe(IDS.length);
  });

  for (const id of IDS) {
    it(`${id} is a valid, closed draft-07 schema with only resolvable local references`, () => {
      const schema = schemas[id];
      // AJV's bundled draft-07 meta-schema is available offline through the SDK.
      const validateSchema = provider.getValidator({ $ref: DIALECT });
      expect(validateSchema(schema).valid).toBe(true);
      expect(schema).toMatchObject({
        $schema: DIALECT, $id: `https://phm.dev/schemas/${paths[id]}`,
        type: 'object', additionalProperties: false, properties: { schema: { const: id } },
      });
      walk(schema, node => {
        if ('$ref' in node) {
          expect(node['$ref']).toMatch(/^#\/definitions\/[^/]+$/);
          const name = (node['$ref'] as string).split('/').at(-1)!;
          expect(Object.hasOwn(objectAt(schema, 'definitions'), name)).toBe(true);
        }
        if (node['type'] === 'object') {
          expect(node['additionalProperties']).toBe(false);
          for (const key of (node['required'] as string[] | undefined) ?? []) {
            expect(Object.hasOwn(objectAt(node, 'properties'), key)).toBe(true);
          }
        }
      });
    });

    it(`${id} accepts its fixture and populated nested records without mutation`, () => {
      for (const data of [fixture(id), populated(id)]) {
        const before = structuredClone(data);
        const result = validators[id](data);
        expect(result.valid, result.errorMessage).toBe(true);
        expect(data).toEqual(before);
      }
    });

    it.each([null, [], 'text', 1, true])(`${id} rejects a non-object payload: %j`, data => {
      expect(validators[id](data).valid).toBe(false);
    });

    it.each(['unknown.v1', id.replace('.v1', '.v2'), ...IDS.filter(other => other !== id)])(
      `${id} rejects discriminator %s`, discriminator => {
        const data = populated(id);
        data['schema'] = discriminator;
        expect(validators[id](data).valid).toBe(false);
      },
    );

    it.each(['yesterday', '2026-13-01T12:00:00Z', '2026-10-26', '2026-10-26T12:00:00'])(
      `${id} rejects invalid or timezone-free observation time %s`, generatedAt => {
        const data = populated(id);
        data['generated_at'] = generatedAt;
        expect(validators[id](data).valid).toBe(false);
      },
    );
  }

  it('uses an actual meta-schema validator, including malformed schema rejection', () => {
    expect(provider.getValidator({ $ref: DIALECT })({ type: 'strnig' }).valid).toBe(false);
  });

  it('retains the conductor summary type and optional refusal metadata', () => {
    const summary: ConductorCycleSummary = {
      goalsAdvanced: 0, milestonesAdvanced: 0, proposalsFiled: 0, goalsDone: 0,
      daemonFallback: false, killSwitchTripped: false, goalActivity: [],
      activationRefused: true, activationRefusalReason: 'Authority unavailable',
      activationPermitId: 'synthetic-permit', staleLanesRecovered: 0,
    };
    const data = { ...fixture('loop.v1'), summary };
    expect(validators['loop.v1'](data).valid).toBe(true);
    const optional = ['activationRefused', 'activationRefusalReason', 'activationPermitId', 'staleLanesRecovered'];
    for (const key of optional) delete objectAt(data, 'summary')[key];
    expect(validators['loop.v1'](data).valid).toBe(true);
  });

  it('accepts zero measured duration, fractional milliseconds and every documented CI conclusion', () => {
    const data = fixture('ci_time.v1');
    const conclusionSchema = objectAt(schemas['ci_time.v1'], 'properties.jobs.items.properties.conclusion');
    const conclusions = [
      'success', 'failure', 'cancelled', 'skipped', 'timed_out',
      'action_required', 'neutral', 'stale', 'startup_failure', null,
    ];
    expect(conclusionSchema['enum']).toEqual(conclusions);
    for (const conclusion of conclusions) {
      replace(data, 'jobs.0.conclusion', conclusion);
      for (const duration of [0, 0.25, null]) {
        replace(data, 'jobs.0.durationMs', duration);
        expect(validators['ci_time.v1'](data).valid).toBe(true);
      }
    }
  });
});

const OBJECT_PATHS: Record<SchemaId, string[]> = {
  'fleet.v1': [
    '', 'readings.0', 'windows.0', 'pools.1', 'pools.1.actual.0', 'router',
    'router.decisions.0', 'router.regret.0', 'agents.0', 'repos.0', 'repos.0.open.0',
    'repos.0.open.0.cost.0', 'coordination', 'coordination.claims.0',
    'coordination.messages.0', 'coordination.proposals.0', 'sources',
  ],
  'loop.v1': ['', 'summary', 'summary.goalActivity.0'],
  'ci_time.v1': ['', 'run', 'jobs.0'],
  'ecosystem-changelog.v1': [
    '', 'window', 'totals', 'recent14d',
    'repositories.0', 'repositories.0.sources.0', 'repositories.0.changes.0',
  ],
};

describe('required fields and closed nested records', () => {
  for (const id of IDS) {
    for (const path of OBJECT_PATHS[id]) {
      const required = Object.keys(objectAt(populated(id), path))
        .filter(key => !(id === 'loop.v1' && path === 'summary' && key === 'staleLanesRecovered'));
      it.each(required)(`${id} rejects missing ${path || 'root'}.%s`, key => {
        const data = populated(id);
        delete objectAt(data, path)[key];
        expect(validators[id](data).valid).toBe(false);
      });
      it(`${id} rejects an unexpected field in ${path || 'root'}`, () => {
        const data = populated(id);
        objectAt(data, path)['unexpected'] = 'typo';
        expect(validators[id](data).valid).toBe(false);
      });
    }
  }
});

const INVALID: [SchemaId, string, unknown][] = [
  ['fleet.v1', 'readings.0.pool', 'unknown-pool'],
  ['fleet.v1', 'readings.0.used_pct', 101],
  ['fleet.v1', 'readings.0.source', 'estimate'],
  ['fleet.v1', 'readings.0.at', 'bad-date'],
  ['fleet.v1', 'windows.0.reset', 'bad-date'],
  ['fleet.v1', 'windows.0.reset_every_days', -1],
  ['fleet.v1', 'pools.1.used_pct', -1],
  ['fleet.v1', 'pools.1.source', 'guessed'],
  ['fleet.v1', 'pools.1.runway_hours', 'unknown'],
  ['fleet.v1', 'pools.1.reading_at', 'bad-date'],
  ['fleet.v1', 'pools.1.actual.0.used_pct', -1],
  ['fleet.v1', 'pools.1.planner.0.at', 'bad-date'],
  ['fleet.v1', 'router.source', 'offline'],
  ['fleet.v1', 'router.decisions.0.grantsMergeAuthority', true],
  ['fleet.v1', 'router.regret.0.chosenValue', {}],
  ['fleet.v1', 'agents.0.expires_at', 'bad-date'],
  ['fleet.v1', 'repos.0.open.0.number', 1.5],
  ['fleet.v1', 'repos.0.open.0.url', 'https://example.com/pull/1'],
  ['fleet.v1', 'repos.0.open.0.url', 'https://githubXcom/ashlrai/phantom/pull/1'],
  ['fleet.v1', 'repos.0.open.0.ci', 'green'],
  ['fleet.v1', 'repos.0.open.0.cost.0.value', -1],
  ['fleet.v1', 'repos.0.open.0.cost.0.unit', 'USD'],
  ['fleet.v1', 'coordination.expiredClaims', -1],
  ['fleet.v1', 'sources.github', false],
  ['loop.v1', 'summary.goalsAdvanced', -1],
  ['loop.v1', 'summary.milestonesAdvanced', 0.5],
  ['loop.v1', 'summary.proposalsFiled', null],
  ['loop.v1', 'summary.goalsDone', '0'],
  ['loop.v1', 'summary.daemonFallback', 0],
  ['loop.v1', 'summary.killSwitchTripped', 'false'],
  ['loop.v1', 'summary.staleLanesRecovered', -1],
  ['loop.v1', 'summary.activationRefused', 'yes'],
  ['loop.v1', 'summary.activationRefusalReason', false],
  ['loop.v1', 'summary.activationPermitId', null],
  ['loop.v1', 'summary.goalActivity', {}],
  ['loop.v1', 'summary.goalActivity.0.fractionDone', -0.1],
  ['loop.v1', 'summary.goalActivity.0.fractionDone', 1.1],
  ['loop.v1', 'summary.goalActivity.0.goalId', ''],
  ['loop.v1', 'summary.goalActivity.0.proposalFiled', 1],
  ['ci_time.v1', 'repository', 'phantom'],
  ['ci_time.v1', 'revision', 'main'],
  ['ci_time.v1', 'run.id', 9007199254740992],
  ['ci_time.v1', 'run.id', '1e10'],
  ['ci_time.v1', 'run.attempt', 0],
  ['ci_time.v1', 'run.attempt', 1.5],
  ['ci_time.v1', 'jobs.0.id', '0'],
  ['ci_time.v1', 'jobs.0.name', ''],
  ['ci_time.v1', 'jobs.0.startedAt', 'bad-date'],
  ['ci_time.v1', 'jobs.0.finishedAt', '2026-10-26'],
  ['ci_time.v1', 'jobs.0.durationMs', -1],
  ['ci_time.v1', 'jobs.0.durationMs', '2000'],
  ['ci_time.v1', 'jobs.0.conclusion', 'passed'],
];

describe('telemetry value constraints', () => {
  it.each(INVALID)('%s rejects invalid %s = %j', (id, path, value) => {
    const data = populated(id);
    replace(data, path, value);
    const result = validators[id](data);
    expect(result.valid).toBe(false);
    expect(result.errorMessage).toBeTruthy();
  });

  it('preserves fleet bounds for pool/repository inventory and observation arrays', () => {
    for (const [path, length] of [['pools', 7], ['pools', 9], ['repos', 6], ['repos', 8], ['readings', 1001]] as const) {
      const data = populated('fleet.v1');
      const items = data[path] as unknown[];
      data[path] = Array.from({ length }, (_, index) => items[index % items.length]);
      expect(validators['fleet.v1'](data).valid).toBe(false);
    }
  });
});
