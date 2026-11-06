import { readFileSync, readdirSync } from 'node:fs';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import type { JsonSchemaType } from '@modelcontextprotocol/sdk/validation';
import { describe, expect, it } from 'vitest';

const fixtures = new URL('./fixtures/graph/', import.meta.url);
const schema = JSON.parse(readFileSync(new URL('../schema/graph.v1.schema.json', import.meta.url), 'utf8')) as JsonSchemaType;
// Use the declared SDK's public validator rather than an undeclared transitive
// AJV import or a home-grown subset of JSON Schema. No runtime loader is added.
const validate = new AjvJsonSchemaValidator().getValidator(schema);

type RecordValue = Record<string, unknown>;
type TestGraph = RecordValue & {
  sources: RecordValue;
  nodes: RecordValue[];
  edges: RecordValue[];
  issues: RecordValue[];
};

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(name, fixtures), 'utf8'));
}

function golden(): TestGraph {
  return fixture('graph.v1.json') as TestGraph;
}

function expectInvalid(value: unknown): void {
  const result = validate(value);
  expect(result.valid).toBe(false);
  expect(result.errorMessage).toBeTruthy();
}

const malformed = readdirSync(new URL('malformed/', fixtures)).filter(name => name.endsWith('.json')).sort();

describe('graph.v1 JSON Schema', () => {
  it('has a stable Draft 7 identity and only local references', () => {
    expect(schema.$schema).toBe('http://json-schema.org/draft-07/schema#');
    expect(schema.$id).toBe('https://ashlr.ai/schema/graph.v1.schema.json');
    const refs = JSON.stringify(schema).matchAll(/"\$ref":"([^"]+)"/g);
    const targets = [...refs].map(match => match[1]);
    expect(targets.length).toBeGreaterThan(0);
    expect(targets.every(target => target.startsWith('#/definitions/'))).toBe(true);
  });

  it.each(['graph.v1.json', 'empty.v1.json', 'incomplete.v1.json'])('accepts %s without modifying it', name => {
    const value = fixture(name);
    const before = JSON.stringify(value);
    const result = validate(value);
    expect(result.valid, result.errorMessage).toBe(true);
    expect(JSON.stringify(value)).toBe(before);
  });

  it('keeps all registry node and edge kinds represented in the golden fixture', () => {
    const value = golden();
    expect([...new Set(value.nodes.map(node => node.kind))].sort()).toEqual(['agent', 'engine-account', 'mcp', 'model']);
    expect([...new Set(value.edges.map(edge => edge.kind))].sort()).toEqual(['can-delegate', 'can-message', 'reviews', 'routes-to']);
    const ids = new Set(value.nodes.map(node => node.id));
    expect(value.edges.every(edge => ids.has(edge.from) && ids.has(edge.to))).toBe(true);
    expect(value.edges.some(edge => edge.source === 'seats')).toBe(true);
    expect(value.edges.some(edge => edge.source === 'fleet')).toBe(true);
  });

  it('keeps the malformed fixture inventory populated', () => {
    expect(malformed.length).toBe(15);
  });

  it.each(malformed)('rejects malformed/%s', name => {
    expectInvalid(fixture(`malformed/${name}`));
  });

  it.each(['schema', 'readOnly', 'complete', 'sources', 'nodes', 'edges', 'issues'])('requires root field %s', key => {
    const value = golden();
    delete value[key];
    expectInvalid(value);
  });

  it.each([null, [], 'graph.v1', 1, true])('rejects a non-object root: %j', value => {
    expectInvalid(value);
  });

  it.each(['sources', 'nodes', 'edges', 'issues', 'complete'])('rejects null for %s', key => {
    expectInvalid({ ...golden(), [key]: null });
  });

  it('requires both source statuses and rejects unknown source properties', () => {
    for (const key of ['fleet', 'seats']) {
      const value = golden();
      delete value.sources[key];
      expectInvalid(value);
    }
    expectInvalid({ ...golden(), sources: { fleet: 'loaded', seats: 'loaded', extra: 'loaded' } });
  });

  it.each(['missing', 'invalid', 'unavailable'])('allows explicit incomplete %s sources', state => {
    for (const source of ['fleet', 'seats']) {
      const value = golden();
      value.complete = false;
      value.sources[source] = state;
      value.issues = [{ source, code: state }];
      const result = validate(value);
      expect(result.valid, result.errorMessage).toBe(true);
    }
  });

  it.each(['unknown-seat', 'unknown-model', 'unknown-mcp', 'unknown-agent'])('allows unresolved %s on loaded inputs', code => {
    const value = golden();
    value.complete = false;
    value.issues = [{ source: 'fleet', code }];
    expect(validate(value).valid).toBe(true);
  });

  it('requires every field of every node, edge and issue variant', () => {
    const value = golden();
    value.complete = false;
    value.issues = [{ source: 'fleet', code: 'unknown-seat' }];
    for (const collection of ['nodes', 'edges', 'issues'] as const) {
      for (let index = 0; index < value[collection].length; index++) {
        for (const key of Object.keys(value[collection][index])) {
          const changed = structuredClone(value);
          delete changed[collection][index][key];
          expectInvalid(changed);
        }
      }
    }
  });

  it('rejects private and unknown fields on every node, edge and issue variant', () => {
    const value = golden();
    value.complete = false;
    value.issues = [{ source: 'fleet', code: 'invalid' }];
    for (const collection of ['nodes', 'edges', 'issues'] as const) {
      for (let index = 0; index < value[collection].length; index++) {
        for (const key of ['command', 'args', 'env', 'token', 'profilePath', 'message']) {
          const changed = structuredClone(value);
          changed[collection][index][key] = 'fixture-only';
          expectInvalid(changed);
        }
      }
    }
  });

  it.each(['', 'a b', 'a\n', 'a\r', 'a\t', 'a\u0000', 'é', '_a', 'a'.repeat(257)])('rejects invalid public identity %j', id => {
    const value = golden();
    value.nodes[0].agentId = id;
    expectInvalid(value);
  });

  it.each(['agentId', 'engine', 'accountId', 'modelId', 'serverId'])('checks identifier constraints on %s', key => {
    const value = golden();
    const node = value.nodes.find(node => Object.hasOwn(node, key))!;
    for (const invalid of [null, 1, false, [], {}, 'bad value']) {
      node[key] = invalid;
      expectInvalid(value);
    }
  });

  it.each(['agent', 'engine-account', 'model', 'mcp'])('accepts encoded punctuation and maximum identity lengths for %s', kind => {
    const value = golden();
    const node = value.nodes.find(node => node.kind === kind)!;
    // Every permitted punctuation character, followed by the longest encoded
    // source identifier, catches raw delimiter/namespace collisions and caps.
    for (const id of ['a_.:@/+%-', `a${'%'.repeat(255)}`]) {
      const encoded = encodeURIComponent(id);
      if (kind === 'agent') Object.assign(node, { id: `agent:${encoded}`, agentId: id });
      if (kind === 'engine-account') Object.assign(node, { id: `engine-account:${encoded}/${encoded}`, engine: id, accountId: id, seatIds: [id] });
      if (kind === 'model') Object.assign(node, { id: `model:${encoded}/${encoded}`, engine: id, modelId: id });
      if (kind === 'mcp') Object.assign(node, { id: `mcp:${encoded}`, serverId: id });
      // Cross-record endpoint identity is deliberately left to GRAPH-1.
      value.edges = [];
      const result = validate(value);
      expect(result.valid, result.errorMessage).toBe(true);
    }
  });

  it.each([
    ['agent', 'agent:'], ['agent', 'agent:a/b'], ['agent', 'agent:a%zz'],
    ['agent', 'agent:a%2f'], ['agent', 'agent:a\n'], ['model', 'model:local'],
    ['engine-account', 'engine-account:a/b/c'], ['mcp', 'mcp:a:b'],
  ])('rejects malformed %s node ID %j', (kind, id) => {
    const value = golden();
    value.nodes.find(node => node.kind === kind)!.id = id;
    expectInvalid(value);
  });

  it('rejects node namespaces inconsistent with the discriminant', () => {
    for (const node of golden().nodes) {
      const value = golden();
      value.nodes = [{ ...node, id: node.kind === 'agent' ? 'mcp:a' : 'agent:a' }];
      expectInvalid(value);
    }
  });

  it.each(['', 'reviews:a%zz/b', 'reviews:a%/b', 'reviews:a%3a/b', 'reviews:a/b\n', 'reviews:a/b/c'])('rejects malformed edge ID %j', id => {
    const value = golden();
    value.edges[0].id = id;
    expectInvalid(value);
  });

  it.each([null, [], [''], ['a', 'a'], [1], Array.from({ length: 10001 }, (_, index) => `seat-${index}`)].map(seatIds => ({ seatIds })))('rejects invalid account seatIds (%#)', ({ seatIds }) => {
    const value = golden();
    value.nodes.find(node => node.kind === 'engine-account')!.seatIds = seatIds;
    expectInvalid(value);
  });

  it('accepts future engines and the 10,000-seat boundary', () => {
    const value = golden();
    const node = value.nodes.find(node => node.kind === 'engine-account')!;
    Object.assign(node, { id: 'engine-account:future-engine/work', engine: 'future-engine', seatIds: Array.from({ length: 10000 }, (_, index) => `seat-${index}`) });
    value.edges = [];
    expect(validate(value).valid).toBe(true);
  });

  it('rejects reversed or wrong-kind routes and non-fleet agent relationships', () => {
    for (const edge of golden().edges) {
      const value = golden();
      const invalid = { ...edge };
      if (edge.kind === 'routes-to') Object.assign(invalid, { from: edge.to, to: edge.from });
      else invalid.source = 'seats';
      value.edges = [invalid];
      expectInvalid(value);
    }
  });

  it('rejects exact duplicates in every collection', () => {
    const value = golden();
    value.complete = false;
    value.issues = [{ source: 'fleet', code: 'invalid' }];
    for (const collection of ['nodes', 'edges', 'issues'] as const) {
      const changed = structuredClone(value);
      changed[collection].push(structuredClone(changed[collection][0]));
      expectInvalid(changed);
    }
  });
});
