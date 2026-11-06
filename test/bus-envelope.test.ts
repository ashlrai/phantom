import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  BUS_PRIORITIES,
  MAX_BUS_ADDRESS_LENGTH,
  MAX_BUS_ENVELOPE_BYTES,
  MAX_BUS_ENVELOPE_DEPTH,
  parseBusEnvelope,
  validateBusEnvelope,
  type BusEnvelope,
  type BusEnvelopeIssueCode,
} from '../src/core/fleet/bus-envelope.js';
import type { FleetBusEnvelope } from '../src/core/fleet/event-bus.js';

function envelope(...args: [] | [unknown]): BusEnvelope<unknown> {
  const body = args.length === 0 ? null : args[0];
  return { id: 'msg-1', from: 'codex-cmp', to: 'fleet', priority: 'P1', ttl: 60_000, body };
}

function rejected(input: unknown, code?: BusEnvelopeIssueCode, path?: string): void {
  const result = validateBusEnvelope(input);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('Expected rejection');
  expect(result.issues).toHaveLength(1);
  if (code) expect(result.issues[0].code).toBe(code);
  if (path) expect(result.issues[0].path).toBe(path);
}

function nested(depth: number): unknown {
  let body: unknown = null;
  for (let index = 0; index < depth; index++) body = [body];
  return body;
}

describe('bus v1 envelope', () => {
  it.each([null, false, true, 0, -3.5, '', 'hello', [], {}, [1, null], { arbitrary: ['東京', true] }])(
    'accepts an opaque JSON body: %j', (body) => {
      const input = envelope(body);
      const result = validateBusEnvelope(input);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('Expected valid envelope');
      expect(result.value).toEqual(input);
      expect(result.json).toBe(JSON.stringify(input));
      expect(result.byteLength).toBe(Buffer.byteLength(result.json, 'utf8'));
      expect(result.issues).toEqual([]);
      expect(parseBusEnvelope(result.json)).toEqual(result);
    },
  );

  it.each(BUS_PRIORITIES)('accepts priority %s', (priority) => {
    expect(validateBusEnvelope({ ...envelope(), priority }).ok).toBe(true);
  });

  it.each([1, Number.MAX_SAFE_INTEGER])('accepts TTL boundary %s', (ttl) => {
    expect(validateBusEnvelope({ ...envelope(), ttl }).ok).toBe(true);
  });

  it('reuses the fleet event catalogue without interpreting its body', () => {
    const event: FleetBusEnvelope<'goal:done'> = {
      ...envelope(),
      body: { kind: 'goal:done', payload: { goalId: 'g-1', objective: 'finish', repo: null } },
    };
    expect(validateBusEnvelope(event).ok).toBe(true);
    // A transport contract does not validate the sender's application schema.
    expect(validateBusEnvelope(envelope({ kind: 'future:event', payload: 123 })).ok).toBe(true);
  });

  it('returns a detached snapshot without mutating or normalizing the input', () => {
    const body = { decomposed: 'e\u0301', list: [1, 2] };
    const input = Object.freeze(envelope(body));
    const result = validateBusEnvelope(input);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected valid envelope');
    body.list.push(3);
    expect(result.value.body).toEqual({ decomposed: 'e\u0301', list: [1, 2] });
    expect(result.value).not.toBe(input);
    expect(result.value.body).not.toBe(body);
  });

  it('preserves prototype-shaped keys as opaque JSON data', () => {
    const body = JSON.parse('{"__proto__":{"polluted":true},"constructor":null,"toJSON":"data"}');
    const result = validateBusEnvelope(envelope(body));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected valid envelope');
    expect(result.value.body).toEqual(body);
    expect(Object.hasOwn(result.value.body as object, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(result.value.body)).toBe(Object.prototype);
    expect(Object.hasOwn(Object.prototype, 'polluted')).toBe(false);
  });

  it('accepts null-prototype records, frozen data and repeated acyclic references', () => {
    const shared = Object.freeze({ a: 1 });
    const body = Object.assign(Object.create(null), { left: shared, right: shared });
    const input = Object.assign(Object.create(null), envelope(Object.freeze(body)));
    expect(validateBusEnvelope(input).ok).toBe(true);
  });

  it('uses standard JSON number encoding for negative zero', () => {
    const result = validateBusEnvelope(envelope(-0));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected valid envelope');
    expect(result.value.body).toBe(0);
    expect(result.json).toBe(JSON.stringify(envelope(-0)));
  });

  it.each([null, undefined, [], 'json', 1, true, new Date()])('rejects a non-object envelope: %j', (input) => {
    rejected(input, 'invalid-envelope', '$');
  });

  it.each(['id', 'from', 'to', 'priority', 'ttl', 'body'])('requires own field %s', (key) => {
    const input = { ...envelope() } as Record<string, unknown>;
    delete input[key];
    rejected(input, 'invalid-envelope');
    rejected(Object.assign(Object.create({ [key]: envelope()[key as keyof BusEnvelope] }), input), 'invalid-envelope');
  });

  it('rejects unknown, symbol and non-enumerable envelope fields', () => {
    rejected({ ...envelope(), version: 1 }, 'invalid-envelope');
    rejected({ ...envelope(), [Symbol('extra')]: true }, 'invalid-envelope');
    rejected(Object.defineProperty(envelope(), 'hidden', { value: true }), 'invalid-envelope');
    rejected(Object.defineProperty(envelope(), 'body', { enumerable: false }), 'invalid-json', '$.body');
  });

  const badTokens = ['', ' ', 'has space', '\ta', 'a\n', 'a\r', 'a\r\n', 'a\u0000', '\u007f', 'é', '🚀', 'x'.repeat(129), null, 1];
  for (const field of ['id', 'from', 'to']) {
    it.each(badTokens)(`rejects invalid ${field} token: %j`, (value) => {
      rejected({ ...envelope(), [field]: value }, 'invalid-field', `$.${field}`);
    });
    it(`accepts 128-character ${field} tokens and literal routing punctuation`, () => {
      expect(validateBusEnvelope({ ...envelope(), [field]: 'x'.repeat(128) }).ok).toBe(true);
      expect(validateBusEnvelope({ ...envelope(), [field]: 'agent:worker/1@pool_*' }).ok).toBe(true);
    });
  }

  it.each(['p0', 'P4', 'high', 0, null, undefined])('rejects priority %j', (priority) => {
    rejected({ ...envelope(), priority }, 'invalid-field', '$.priority');
  });

  it.each([0, -0, -1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, '1000', null, undefined])(
    'rejects TTL %j', (ttl) => rejected({ ...envelope(), ttl }, 'invalid-field', '$.ttl'),
  );
});

describe('bounded strict JSON body', () => {
  it.each([undefined, () => null, Symbol('body'), 1n, NaN, Infinity, -Infinity, new Date(), new Map(), new Set(), /x/, Buffer.from('x')])(
    'rejects non-JSON body %s', (body) => rejected({ ...envelope(), body }, 'invalid-json'),
  );

  it.each([undefined, () => null, Symbol('nested'), 1n, NaN, Infinity])('rejects nested non-JSON %s', (value) => {
    rejected(envelope({ nested: value }), 'invalid-json');
    rejected(envelope([value]), 'invalid-json');
  });

  it('rejects sparse arrays, array extras and custom prototypes', () => {
    rejected(envelope(new Array(1)), 'invalid-json');
    rejected(envelope(Object.assign([1], { extra: 2 })), 'invalid-json');
    rejected(envelope(Object.assign([1], { [Symbol('extra')]: 2 })), 'invalid-json');
    rejected(envelope(Object.create({ inherited: 1 })), 'invalid-json');
    class CustomArray extends Array {}
    rejected(envelope(new CustomArray(1, 2)), 'invalid-json');
  });

  it('rejects cycles while allowing shared references', () => {
    const body: Record<string, unknown> = {};
    body.self = body;
    rejected(envelope(body), 'invalid-json');
    const array: unknown[] = [];
    array.push(array);
    rejected(envelope(array), 'invalid-json');
  });

  it('never calls getters, toJSON hooks or proxy traps', () => {
    const getter = vi.fn(() => { throw new Error('private body contents'); });
    const toJSON = vi.fn(() => null);
    rejected(Object.defineProperty(envelope(), 'id', { enumerable: true, get: getter }), 'invalid-json');
    rejected(envelope(Object.defineProperty({}, 'secret', { enumerable: true, get: getter })), 'invalid-json');
    rejected(envelope(Object.defineProperty([1], '0', { enumerable: true, get: getter })), 'invalid-json');
    rejected(envelope({ toJSON }), 'invalid-json');
    const trap = vi.fn(() => { throw new Error('proxy trap'); });
    const proxy = new Proxy({}, { ownKeys: trap, getPrototypeOf: trap, get: trap });
    rejected(envelope(proxy), 'invalid-json');
    rejected(proxy, 'invalid-envelope');
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    rejected(envelope(revoked.proxy), 'invalid-json');
    expect(getter).not.toHaveBeenCalled();
    expect(toJSON).not.toHaveBeenCalled();
    expect(trap).not.toHaveBeenCalled();
  });

  it('rejects hidden and symbol body properties', () => {
    rejected(envelope(Object.defineProperty({}, 'hidden', { value: 1 })), 'invalid-json');
    rejected(envelope({ [Symbol('secret')]: 1 }), 'invalid-json');
  });

  it('reports static diagnostics without reflecting input values or object keys', () => {
    const marker = 'private-marker-must-not-be-logged';
    const input = envelope({ [marker]: undefined });
    expect(JSON.stringify(validateBusEnvelope(input))).not.toContain(marker);
    expect(JSON.stringify(validateBusEnvelope({ ...envelope(), priority: marker }))).not.toContain(marker);
  });

  it('accepts depth 32 and rejects depth 33 or deeply nested attacks', () => {
    expect(validateBusEnvelope(envelope(nested(MAX_BUS_ENVELOPE_DEPTH - 1))).ok).toBe(true);
    rejected(envelope(nested(MAX_BUS_ENVELOPE_DEPTH)), 'too-deep');
    rejected(envelope(nested(10_000)), 'too-deep');
  });

  it('caps the full envelope at exactly 65536 UTF-8 bytes, including headers', () => {
    const overhead = Buffer.byteLength(JSON.stringify(envelope('')), 'utf8');
    const body = 'a'.repeat(MAX_BUS_ENVELOPE_BYTES - overhead);
    const result = validateBusEnvelope(envelope(body));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected exact-cap envelope');
    expect(result.byteLength).toBe(MAX_BUS_ENVELOPE_BYTES);
    expect(parseBusEnvelope(result.json).ok).toBe(true);
    rejected(envelope(body + 'a'), 'too-large');
    rejected({ ...envelope(body), id: 'longer-id' }, 'too-large');
  });

  it.each(['🚀', 'é', '\u0000', '"', '\\'])('counts encoded bytes for %j', (unit) => {
    const overhead = Buffer.byteLength(JSON.stringify(envelope('')), 'utf8');
    const unitBytes = Buffer.byteLength(JSON.stringify(unit), 'utf8') - 2;
    const count = Math.floor((MAX_BUS_ENVELOPE_BYTES - overhead) / unitBytes);
    const padding = MAX_BUS_ENVELOPE_BYTES - overhead - count * unitBytes;
    const body = unit.repeat(count) + 'a'.repeat(padding);
    expect(validateBusEnvelope(envelope(body)).ok).toBe(true);
    rejected(envelope(body + 'a'), 'too-large');
  });

  it('counts object keys, punctuation and large collections against the cap', () => {
    rejected(envelope({ ['a'.repeat(MAX_BUS_ENVELOPE_BYTES)]: null }), 'too-large');
    rejected(envelope(new Array(40_000).fill(null)), 'too-large');
    rejected(envelope('x'.repeat(MAX_BUS_ENVELOPE_BYTES * 2)), 'too-large');
  });
});

describe('received JSON text', () => {
  it.each([undefined, null, {}, Buffer.from('{}'), '', '{', '{"id":', 'undefined', '\ufeff{}'])('rejects invalid text %s', (text) => {
    expect(parseBusEnvelope(text)).toMatchObject({ ok: false, issues: [{ code: 'invalid-json' }] });
  });

  it('validates parsed headers and bodies rather than accepting arbitrary JSON', () => {
    expect(parseBusEnvelope('null').ok).toBe(false);
    expect(parseBusEnvelope('{}').ok).toBe(false);
    expect(parseBusEnvelope(JSON.stringify({ ...envelope(), ttl: 0 })).ok).toBe(false);
    expect(parseBusEnvelope(JSON.stringify(envelope())).ok).toBe(true);
    expect(parseBusEnvelope(JSON.stringify(envelope()).replace('"body":null', '"body":1e400')).ok).toBe(false);
  });

  it('caps received bytes before parsing, including whitespace and noncompact escapes', () => {
    const text = JSON.stringify(envelope());
    const atCap = text + ' '.repeat(MAX_BUS_ENVELOPE_BYTES - text.length);
    expect(parseBusEnvelope(atCap).ok).toBe(true);
    expect(parseBusEnvelope(atCap + ' ')).toMatchObject({ ok: false, issues: [{ code: 'too-large' }] });
    expect(parseBusEnvelope(' '.repeat(MAX_BUS_ENVELOPE_BYTES + 1) + '{')).toMatchObject({
      ok: false, issues: [{ code: 'too-large' }],
    });
    const escaped = JSON.stringify(envelope('a'.repeat(12_000))).replaceAll('a', '\\u0061');
    expect(validateBusEnvelope(JSON.parse(escaped)).ok).toBe(true);
    expect(parseBusEnvelope(escaped)).toMatchObject({ ok: false, issues: [{ code: 'too-large' }] });
    const multibyte = JSON.stringify(envelope('é'.repeat(40_000)));
    expect(multibyte.length).toBeLessThan(MAX_BUS_ENVELOPE_BYTES);
    expect(parseBusEnvelope(multibyte)).toMatchObject({ ok: false, issues: [{ code: 'too-large' }] });
  });
});

describe('published JSON Schema matches the runtime contract', () => {
  const schema = JSON.parse(readFileSync(new URL('../schema/bus.v1.schema.json', import.meta.url), 'utf8'));

  it('declares the exact fields, priority order, safe TTL range and runtime-only bounds', () => {
    expect(schema.$schema).toBe('http://json-schema.org/draft-07/schema#');
    expect(schema.type).toBe('object');
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(Object.keys(envelope()));
    expect(Object.keys(schema.properties)).toEqual(schema.required);
    expect(schema.properties.priority).toMatchObject({ type: 'string', enum: [...BUS_PRIORITIES] });
    expect(schema.properties.ttl).toMatchObject({ type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
    expect(schema.properties.body.type).toBeUndefined();
    expect(Object.keys(schema.properties.body)).toEqual(['description']);
    expect(schema['x-maxBytes']).toBe(MAX_BUS_ENVELOPE_BYTES);
    expect(schema['x-maxDepth']).toBe(MAX_BUS_ENVELOPE_DEPTH);
    expect(schema.$comment).toContain('cannot enforce');
    expect(schema.$comment).toContain('MUST');
  });

  it('declares the same token constraints, including rejecting trailing newlines', () => {
    const token = schema.definitions.token;
    expect(token).toMatchObject({ type: 'string', minLength: 1, maxLength: MAX_BUS_ADDRESS_LENGTH });
    for (const field of ['id', 'from', 'to']) expect(schema.properties[field].$ref).toBe('#/definitions/token');
    const pattern = new RegExp(token.pattern);
    for (const value of ['x', 'agent:worker/1@pool_*', 'x'.repeat(128), '', 'a\n', 'a\r', 'has space', 'é', '\u007f']) {
      const schemaAccepts = value.length >= token.minLength && value.length <= token.maxLength && pattern.test(value);
      expect(schemaAccepts).toBe(validateBusEnvelope({ ...envelope(), id: value }).ok);
    }
  });

  it('provides runtime-valid examples', () => {
    for (const example of schema.examples) expect(validateBusEnvelope(example).ok).toBe(true);
  });
});
