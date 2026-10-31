import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { parseBusEnvelope, validateBusEnvelope } from '../src/core/fleet/bus-envelope.js';

// Read the published contract independently of the validator's constants.
const schema = JSON.parse(readFileSync(new URL('../schema/bus.v1.schema.json', import.meta.url), 'utf8')) as {
  'x-maxBytes': number;
  'x-maxDepth': number;
  required: string[];
  properties: {
    id: { $ref: string };
    from: { $ref: string };
    to: { $ref: string };
    priority: { enum: string[] };
    ttl: { minimum: number; maximum: number };
  };
  definitions: { token: { minLength: number; maxLength: number; pattern: string } };
};

function envelope(body: unknown = null) {
  return { id: 'message', from: 'sender', to: 'recipient', priority: 'P1', ttl: 1, body };
}

function expectRejected(result: ReturnType<typeof validateBusEnvelope>, code: string, path: string) {
  expect(result).toMatchObject({ ok: false, issues: [{ code, path }] });
  if (!result.ok) expect(result.issues).toHaveLength(1);
}

function expectWireRoundTrip(input: { id: string; from: string; to: string; priority: string; ttl: unknown; body: unknown }) {
  const expectedJson = JSON.stringify(input);
  const sent = validateBusEnvelope(input);
  expect(sent.ok).toBe(true);
  if (!sent.ok) throw new Error('Expected a valid outbound envelope');
  expect(sent.json).toBe(expectedJson);
  expect(sent.byteLength).toBe(Buffer.byteLength(expectedJson, 'utf8'));
  expect(sent.value).toEqual(input);
  expect(sent.value).not.toBe(input);
  const received = parseBusEnvelope(sent.json);
  expect(received.ok).toBe(true);
  if (!received.ok) throw new Error('Expected a valid inbound envelope');
  expect(received).toEqual(sent);
  expect(received.value).not.toBe(sent.value);
  return { sent, received };
}

describe('bus v1 independent wire boundary regressions', () => {
  it('pins the published limits and six fields used by interoperability cases', () => {
    expect(schema['x-maxBytes']).toBe(65_536);
    expect(schema['x-maxDepth']).toBe(32);
    expect(schema.required).toEqual(['id', 'from', 'to', 'priority', 'ttl', 'body']);
    expect(schema.properties.ttl).toMatchObject({ minimum: 1, maximum: 9_007_199_254_740_991 });
    expect(schema.definitions.token).toMatchObject({ minLength: 1, maxLength: 128 });
  });

  it.each([
    ['multibyte values and keys', '鍵🚀', 'é🚀'],
    ['quotes, backslashes and controls', '"\\\n', '"\\\u0000\n'],
    ['mixed Unicode and escaping', '東京"', '🚀é\\\t'],
  ])('round-trips exactly 65536 encoded bytes with %s', (_name, key, unit) => {
    // Native JSON serialization is the independent wire-size oracle; the key,
    // escaping and multibyte content all consume part of the same byte budget.
    const make = (payload: string) => ({ ...envelope(), body: { [key]: payload } });
    const overhead = Buffer.byteLength(JSON.stringify(make('')), 'utf8');
    const unitBytes = Buffer.byteLength(JSON.stringify(unit), 'utf8') - 2;
    const available = schema['x-maxBytes'] - overhead;
    const payload = unit.repeat(Math.floor(available / unitBytes)) + 'x'.repeat(available % unitBytes);
    const input = make(payload);
    const { sent, received } = expectWireRoundTrip(input);
    expect(Buffer.byteLength(sent.json, 'utf8')).toBe(65_536);
    expect(sent.byteLength).toBe(65_536);
    expect(sent.value.body).not.toBe(input.body);
    expect(received.value.body).not.toBe(sent.value.body);
    input.body[key] = 'changed locally';
    expect((sent.value.body as Record<string, string>)[key]).toBe(payload);
    (sent.value.body as Record<string, string>)[key] = 'changed after sending';
    expect((received.value.body as Record<string, string>)[key]).toBe(payload);

    const oversized = make(payload + 'x');
    const oversizedJson = JSON.stringify(oversized);
    expect(Buffer.byteLength(oversizedJson, 'utf8')).toBe(65_537);
    expectRejected(validateBusEnvelope(oversized), 'too-large', '$');
    expectRejected(parseBusEnvelope(oversizedJson), 'too-large', '$');
  });

  it.each([' ', '\n', '\t', '\r'])('counts received %j whitespace at the byte cap', (whitespace) => {
    const compact = JSON.stringify(envelope({ text: 'é🚀', escaped: '"\\\n' }));
    const padding = schema['x-maxBytes'] - Buffer.byteLength(compact, 'utf8');
    const atCap = whitespace + compact + whitespace.repeat(padding - 1);
    expect(Buffer.byteLength(atCap, 'utf8')).toBe(65_536);
    const received = parseBusEnvelope(atCap);
    expect(received.ok).toBe(true);
    if (!received.ok) throw new Error('Expected valid padded wire text');
    expect(received.json).toBe(compact);
    expect(received.byteLength).toBe(Buffer.byteLength(compact, 'utf8'));
    expectRejected(parseBusEnvelope(atCap + whitespace), 'too-large', '$');
  });

  it('counts noncompact Unicode escapes in received bytes before normalization', () => {
    const compact = JSON.stringify(envelope('a'));
    const escaped = compact.replace('"body":"a"', '"body":"\\u0061"');
    const padding = schema['x-maxBytes'] - Buffer.byteLength(escaped, 'utf8');
    const atCap = escaped + ' '.repeat(padding);
    expect(Buffer.byteLength(atCap, 'utf8')).toBe(65_536);
    const received = parseBusEnvelope(atCap);
    expect(received.ok).toBe(true);
    if (!received.ok) throw new Error('Expected escaped wire text at the limit');
    expect(received.json).toBe(compact);
    expectRejected(parseBusEnvelope(atCap + ' '), 'too-large', '$');
  });

  it.each(['array', 'object'] as const)('enforces root-zero depth for %s bodies over the wire', (kind) => {
    const nested = (layers: number): unknown => {
      let value: unknown = 'leaf';
      for (let i = 0; i < layers; i++) value = kind === 'array' ? [value] : { next: value };
      return value;
    };
    // The body is depth 1, so 31 containers put the leaf at depth 32.
    const valid = envelope(nested(schema['x-maxDepth'] - 1));
    expectWireRoundTrip(valid);
    const invalid = envelope(nested(schema['x-maxDepth']));
    expectRejected(validateBusEnvelope(invalid), 'too-deep', '$.body');
    expectRejected(parseBusEnvelope(JSON.stringify(invalid)), 'too-deep', '$.body');
  });

  it.each([
    ['minimum', 1, true],
    ['maximum safe integer', Number.MAX_SAFE_INTEGER, true],
    ['zero', 0, false],
    ['fraction', 1.5, false],
    ['above maximum safe integer', Number.MAX_SAFE_INTEGER + 1, false],
    ['numeric string', '1', false],
  ])('checks TTL %s against the published range on send and receive', (_label, ttl, valid) => {
    const input = { ...envelope(), ttl };
    if (valid) {
      expectWireRoundTrip(input);
    } else {
      expectRejected(validateBusEnvelope(input), 'invalid-field', '$.ttl');
      expectRejected(parseBusEnvelope(JSON.stringify(input)), 'invalid-field', '$.ttl');
    }
  });

  const addressFields = ['id', 'from', 'to'] as const;
  const token = schema.definitions.token;
  const addressCases: [string, string, boolean][] = [
    ['lowest printable ASCII', '!', true],
    ['highest printable ASCII', '~', true],
    ['both endpoints at maximum length', '!'.repeat(token.maxLength - 1) + '~', true],
    ['empty', '', false],
    ['over maximum length', 'x'.repeat(token.maxLength + 1), false],
    ['below printable ASCII', ' ', false],
    ['above printable ASCII', '\u007f', false],
    ['trailing line feed', 'address\n', false],
    ['trailing carriage return', 'address\r', false],
    ['trailing CRLF', 'address\r\n', false],
  ];
  for (const field of addressFields) {
    it.each(addressCases)(`checks ${field} %s against schema and both wire directions`, (_label, value, valid) => {
      expect(schema.properties[field].$ref).toBe('#/definitions/token');
      const schemaAccepts = value.length >= token.minLength && value.length <= token.maxLength
        && new RegExp(token.pattern).test(value);
      expect(schemaAccepts).toBe(valid);
      const input = { ...envelope(), [field]: value };
      if (valid) {
        expectWireRoundTrip(input);
      } else {
        expectRejected(validateBusEnvelope(input), 'invalid-field', `$.${field}`);
        expectRejected(parseBusEnvelope(JSON.stringify(input)), 'invalid-field', `$.${field}`);
      }
    });
  }

  it.each(schema.properties.priority.enum)('round-trips schema priority %s', (priority) => {
    expectWireRoundTrip({ ...envelope(), priority });
  });

  it.each(schema.required)('rejects an accessor for envelope field %s without executing it', (field) => {
    const getter = vi.fn(() => { throw new Error('getter must not run'); });
    const input = Object.defineProperty(envelope(), field, { enumerable: true, get: getter });
    expectRejected(validateBusEnvelope(input), 'invalid-json', `$.${field}`);
    expect(getter).not.toHaveBeenCalled();
  });

  it.each(['object property', 'array element', 'toJSON getter', 'toJSON method'])(
    'rejects a nested %s without invoking user code', (kind) => {
      const hook = vi.fn(() => { throw new Error('hook must not run'); });
      let body: unknown;
      if (kind === 'array element') body = Object.defineProperty([null], '0', { enumerable: true, get: hook });
      else if (kind === 'toJSON method') body = { toJSON: hook };
      else body = Object.defineProperty({}, kind === 'toJSON getter' ? 'toJSON' : 'value', { enumerable: true, get: hook });
      expectRejected(validateBusEnvelope(envelope({ nested: body })), 'invalid-json', '$.body');
      expect(hook).not.toHaveBeenCalled();
    },
  );
});
