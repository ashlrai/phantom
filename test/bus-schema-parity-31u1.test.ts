import { readFileSync } from 'node:fs';
import Ajv from 'ajv';
import { describe, expect, it } from 'vitest';
import {
  BUS_PRIORITIES,
  MAX_BUS_ADDRESS_LENGTH,
  MAX_BUS_ENVELOPE_BYTES,
  MAX_BUS_ENVELOPE_DEPTH,
  validateBusEnvelope,
} from '../src/core/fleet/bus-envelope.js';

// Compile the checked-in draft-07 schema itself; x-* annotations are not validation keywords.
const schema = JSON.parse(readFileSync(new URL('../schema/bus.v1.schema.json', import.meta.url), 'utf8'));
const validateSchema = new Ajv({ allErrors: true }).compile(schema);
const fields = ['id', 'from', 'to', 'priority', 'ttl', 'body'] as const;
const tokenFields = ['id', 'from', 'to'] as const;

function envelope(body: unknown = null): Record<string, unknown> {
  return { id: 'fake-message', from: 'fake-sender', to: 'fake-recipient', priority: 'P1', ttl: 1, body };
}

function expectBoth(input: unknown, valid: boolean): void {
  expect(validateSchema(input), JSON.stringify(validateSchema.errors)).toBe(valid);
  expect(validateBusEnvelope(input).ok).toBe(valid);
}

describe('bus v1 checked-in schema conformance', () => {
  it('declares exactly the six required fields and rejects missing or extra fields', () => {
    expect(schema.$schema).toBe('http://json-schema.org/draft-07/schema#');
    expect(schema.type).toBe('object');
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toHaveLength(fields.length);
    expect([...schema.required].sort()).toEqual([...fields].sort());
    expect(Object.keys(schema.properties).sort()).toEqual([...fields].sort());
    expectBoth(envelope(), true);
    for (const field of fields) {
      const missing = envelope();
      delete missing[field];
      expectBoth(missing, false);
    }
    expectBoth({ ...envelope(), extra: null }, false);
  });

  it('pins the published priority order and checks each value against both contracts', () => {
    expect(schema.properties.priority.type).toBe('string');
    expect(schema.properties.priority.enum).toEqual(['P0', 'P1', 'P2', 'P3']);
    expect(schema.properties.priority.enum).toEqual([...BUS_PRIORITIES]);
    for (const priority of ['P0', 'P1', 'P2', 'P3']) expectBoth({ ...envelope(), priority }, true);
    for (const priority of ['P4', 'p0', '', 0, null]) expectBoth({ ...envelope(), priority }, false);
  });

  it('declares a shared printable ASCII token with matching length bounds', () => {
    expect(schema.definitions.token).toMatchObject({
      type: 'string', minLength: 1, maxLength: 128, pattern: '^[!-~]+(?![\\s\\S])',
    });
    expect(schema.definitions.token.maxLength).toBe(MAX_BUS_ADDRESS_LENGTH);
    for (const field of tokenFields) expect(schema.properties[field].$ref).toBe('#/definitions/token');
  });

  const tokenCases: [string, unknown, boolean][] = [
    ['empty', '', false],
    ['one lowest printable character', '!', true],
    ['one highest printable character', '~', true],
    ['127 characters', 'x'.repeat(127), true],
    ['128 characters', 'x'.repeat(127) + '~', true],
    ['129 characters', 'x'.repeat(129), false],
    ['space before printable ASCII', ' ', false],
    ['DEL after printable ASCII', '\x7f', false],
    ['embedded space', 'fake id', false],
    ['trailing newline', 'fake-id\n', false],
    ['trailing carriage return', 'fake-id\r', false],
    ['trailing CRLF', 'fake-id\r\n', false],
    ['non-ASCII character', 'é', false],
    ['non-string', 123, false],
  ];
  for (const field of tokenFields) {
    it.each(tokenCases)(`${field}: %s`, (_label, value, valid) => {
      expectBoth({ ...envelope(), [field]: value }, valid);
    });
    it(`${field}: accepts every printable ASCII character and rejects adjacent controls`, () => {
      for (let code = 0x20; code <= 0x7f; code++) {
        expectBoth({ ...envelope(), [field]: String.fromCharCode(code) }, code >= 0x21 && code <= 0x7e);
      }
    });
  }

  it('declares positive safe integer TTL bounds', () => {
    expect(schema.properties.ttl).toMatchObject({ type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
  });

  it.each([
    ['negative', -1, false],
    ['zero', 0, false],
    ['minimum', 1, true],
    ['above minimum', 2, true],
    ['below maximum', Number.MAX_SAFE_INTEGER - 1, true],
    ['maximum', Number.MAX_SAFE_INTEGER, true],
    ['above maximum', Number.MAX_SAFE_INTEGER + 1, false],
    ['fraction', 1.5, false],
    ['numeric string', '1', false],
    ['null', null, false],
  ])('TTL %s', (_label, ttl, valid) => {
    expectBoth({ ...envelope(), ttl }, valid);
  });

  it('accepts every published example and leaves the JSON body unconstrained', () => {
    expect(schema.examples.length).toBeGreaterThan(0);
    expect(Object.keys(schema.properties.body)).toEqual(['description']);
    for (const example of schema.examples) expectBoth(example, true);
    for (const body of [null, false, 0, '', [], {}, { fake: ['value', null] }]) {
      expectBoth(envelope(body), true);
    }
  });

  it('matches the runtime byte and root-zero depth constants in schema annotations', () => {
    expect(schema['x-maxBytes']).toBe(65_536);
    expect(schema['x-maxBytes']).toBe(MAX_BUS_ENVELOPE_BYTES);
    expect(schema['x-maxDepth']).toBe(32);
    expect(schema['x-maxDepth']).toBe(MAX_BUS_ENVELOPE_DEPTH);
    expect(schema.$comment).toContain('cannot enforce');
  });

  it('treats size and depth as runtime constraints, not JSON Schema validation keywords', () => {
    const oversized = envelope('x'.repeat(schema['x-maxBytes']));
    let deep: unknown = null;
    for (let i = 0; i < schema['x-maxDepth']; i++) deep = [deep];
    for (const [input, code] of [[oversized, 'too-large'], [envelope(deep), 'too-deep']] as const) {
      expect(validateSchema(input)).toBe(true);
      expect(validateBusEnvelope(input)).toMatchObject({ ok: false, issues: [{ code }] });
    }
  });

  it('enforces strict JavaScript JSON data separately from the schema JSON domain', () => {
    // Undefined has no JSON representation; a schema validator is not the oracle here.
    expect(validateBusEnvelope(envelope({ fake: undefined }))).toMatchObject({
      ok: false, issues: [{ code: 'invalid-json', path: '$.body' }],
    });
  });
});
