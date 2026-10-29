import { readFileSync } from 'node:fs';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AshlrConfig } from '../src/core/types.js';
import {
  HANDOFF_KINDS,
  deserializeHandoff,
  parseHandoff,
  serializeHandoff,
  type HandoffKind,
  type HandoffMessage,
} from '../src/core/fleet/handoff.js';
import { emit, onFleetEvent, type FleetBusEnvelope } from '../src/core/fleet/event-bus.js';
import { parseBusEnvelope } from '../src/core/fleet/bus-envelope.js';

const schema = JSON.parse(readFileSync(new URL('../schema/handoff.v1.schema.json', import.meta.url), 'utf8'));
const validateSchema = new AjvJsonSchemaValidator().getValidator<HandoffMessage>(schema);
const cfg = { foundry: {} } as AshlrConfig;
const disposers: Array<() => void> = [];

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
});

function message(kind: HandoffKind = 'plan') {
  return {
    version: 1 as const,
    kind,
    taskId: 'RQ-OT-P3-HANDOFF-SCHEMA',
    fromProvider: 'codex',
    toProvider: 'claude',
    payloadRefs: ['artifact:plans/one-team-v1.json'],
  };
}

function rejected(value: unknown): void {
  let error: unknown;
  try { parseHandoff(value); } catch (caught) { error = caught; }
  // Never let a failed assertion print submitted credential-shaped fixtures.
  expect(error instanceof TypeError).toBe(true);
  expect(error instanceof Error ? error.message : null).toBe('Invalid handoff message');
}

function subscribe(handler: (payload: HandoffMessage) => void | Promise<void>): void {
  disposers.push(onFleetEvent('handoff', handler));
}

describe('handoff v1 schema and wire contract', () => {
  it('declares exactly the supported kinds', () => {
    expect([...HANDOFF_KINDS].sort()).toEqual(['ask', 'delegate', 'plan', 'result', 'review', 'takeover']);
  });

  it.each(['plan', 'delegate', 'ask', 'review', 'takeover', 'result'] as const)(
    'validates and round trips %s', kind => {
      const input = message(kind);
      expect(validateSchema(input).valid).toBe(true);
      expect(parseHandoff(input)).toEqual(input);
      expect(deserializeHandoff(serializeHandoff(input))).toEqual(input);
    },
  );

  it('accepts future provider names without a provider catalogue change', () => {
    const input = { ...message(), fromProvider: 'provider-2030', toProvider: 'local-runtime' };
    expect(validateSchema(input).valid).toBe(true);
    expect(parseHandoff(input)).toEqual(input);
  });

  const structuralCases: Array<[string, () => unknown]> = [
    ['unknown kind', () => ({ ...message(), kind: 'execute' })],
    ['unknown version', () => ({ ...message(), version: 2 })],
    ['string version', () => ({ ...message(), version: '1' })],
    ['missing task id', () => { const { taskId: _, ...rest } = message(); return rest; }],
    ['empty task id', () => ({ ...message(), taskId: '' })],
    ['oversized task id', () => ({ ...message(), taskId: 'a'.repeat(129) })],
    ['task id whitespace', () => ({ ...message(), taskId: ' task' })],
    ['task id control characters', () => ({ ...message(), taskId: 'task\n' })],
    ['empty provider', () => ({ ...message(), fromProvider: '' })],
    ['uppercase provider', () => ({ ...message(), toProvider: 'Claude' })],
    ['provider trailing newline', () => ({ ...message(), toProvider: 'claude\n' })],
    ['oversized provider', () => ({ ...message(), toProvider: 'a'.repeat(65) })],
    ['extra top-level property', () => ({ ...message(), payload: 'inline content' })],
    ['empty references', () => ({ ...message(), payloadRefs: [] })],
    ['too many references', () => ({ ...message(), payloadRefs: Array.from({ length: 33 }, (_, i) => `artifact:item-${i}`) })],
    ['duplicate references', () => ({ ...message(), payloadRefs: ['artifact:item', 'artifact:item'] })],
    ['non-array references', () => ({ ...message(), payloadRefs: 'artifact:item' })],
    ['non-string reference', () => ({ ...message(), payloadRefs: [42] })],
    ['reference object', () => ({ ...message(), payloadRefs: [{ ref: 'artifact:item' }] })],
    ['oversized reference', () => ({ ...message(), payloadRefs: [`artifact:${'x'.repeat(248)}`] })],
    ['missing reference namespace', () => ({ ...message(), payloadRefs: ['item'] })],
    ['empty reference identity', () => ({ ...message(), payloadRefs: ['artifact:'] })],
    ['oversized reference namespace', () => ({ ...message(), payloadRefs: [`${'a'.repeat(33)}:item`] })],
    ['URL reference', () => ({ ...message(), payloadRefs: ['https://example.com/item'] })],
    ['query-bearing reference', () => ({ ...message(), payloadRefs: ['artifact:item?value=1'] })],
    ['encoded reference', () => ({ ...message(), payloadRefs: ['artifact:item%2Fvalue'] })],
    ['reference trailing newline', () => ({ ...message(), payloadRefs: ['artifact:item\n'] })],
    ['null message', () => null],
    ['array message', () => []],
  ];

  it.each(structuralCases)('schema and runtime reject %s', (_name, make) => {
    const input = make();
    expect(validateSchema(input).valid).toBe(false);
    rejected(input);
  });

  it('accepts exact structural boundaries', () => {
    const input = {
      ...message(),
      taskId: 'z'.repeat(128),
      fromProvider: 'z'.repeat(64),
      payloadRefs: Array.from({ length: 32 }, (_, i) => `artifact:${i}-${'x'.repeat(244 - String(i).length)}`),
    };
    expect(input.payloadRefs.every(ref => ref.length === 254)).toBe(true);
    input.payloadRefs[0] = `artifact:${'x'.repeat(247)}`;
    expect(input.payloadRefs[0].length).toBe(256);
    expect(validateSchema(input).valid).toBe(true);
    expect(parseHandoff(input)).toEqual(input);
  });

  it('rejects malformed and oversized wire messages with fixed diagnostics', () => {
    for (const input of ['{', '{} trailing', 'null', ' '.repeat(16 * 1024 + 1)]) {
      expect(() => deserializeHandoff(input)).toThrow('Invalid handoff message');
    }
  });

  it('validates serialization rather than trusting a typed caller', () => {
    expect(() => serializeHandoff({ ...message(), kind: 'unknown' })).toThrow('Invalid handoff message');
  });
});

describe('handoff admission security', () => {
  it('rejects secret-shaped field names even when values are empty', () => {
    for (const key of ['apiKey', 'password', 'token', 'clientSecret', 'authorization', 'credentials']) {
      const input = { ...message(), [key]: '' };
      expect(validateSchema(input).valid).toBe(false);
      rejected(input);
    }
  });

  it('rejects nested secret-shaped fields', () => {
    const input = { ...message(), payloadRefs: [{ ref: 'artifact:item', token: 'TEST' }] };
    expect(validateSchema(input).valid).toBe(false);
    rejected(input);
  });

  it('rejects credential shapes in allowed text fields without disclosing values', () => {
    // All credential-shaped fixtures are assembled at runtime, never literals.
    const secrets = [
      ['sk', '-', 'TEST'.repeat(8)].join(''),
      ['ghp', '_', 'TEST'.repeat(8)].join(''),
      ['xai', '-', 'TEST'.repeat(8)].join(''),
      ['cog', '_', 'TEST'.repeat(8)].join(''),
      ['sk', '_live_', 'TEST'.repeat(8)].join(''),
      ['sk', '_test_', 'TEST'.repeat(8)].join(''),
      ['Bearer', ' ', 'TEST'.repeat(8)].join(''),
      ['AKIA', 'X'.repeat(16)].join(''),
    ];
    for (const secret of secrets) {
      rejected({ ...message(), taskId: secret });
      rejected({ ...message(), fromProvider: secret });
      rejected({ ...message(), toProvider: secret });
      rejected({ ...message(), payloadRefs: [`artifact:${secret}`] });
    }
  });

  it('rejects accessor properties without invoking them', () => {
    const getter = vi.fn(() => 'task');
    const input = Object.defineProperty(message(), 'taskId', { get: getter });
    rejected(input);
    expect(getter).not.toHaveBeenCalled();
  });

  it('rejects accessor array elements without invoking them', () => {
    const getter = vi.fn(() => 'artifact:item');
    const input = message();
    Object.defineProperty(input.payloadRefs, '0', { get: getter });
    rejected(input);
    expect(getter).not.toHaveBeenCalled();
  });

  it('rejects nonplain objects, hidden fields and symbol properties', () => {
    class Envelope { constructor() { Object.assign(this, message()); } }
    rejected(new Envelope());
    rejected(Object.assign(Object.create({ inherited: true }), message()));
    rejected(Object.defineProperty(message(), 'token', { value: 'TEST', enumerable: false }));
    rejected({ ...message(), [Symbol('token')]: 'TEST' });
  });

  it('rejects array holes and additional properties', () => {
    const sparse = message();
    sparse.payloadRefs = new Array<string>(1);
    rejected(sparse);
    const additional = message();
    Object.defineProperty(additional.payloadRefs, 'token', { value: 'TEST' });
    rejected(additional);
    const symbolic = message();
    Object.defineProperty(symbolic.payloadRefs, Symbol('token'), { value: 'TEST' });
    rejected(symbolic);
  });

  it('rejects hostile inspection without exposing the underlying exception', () => {
    const input = new Proxy(message(), { ownKeys() { throw new Error('TEST private detail'); } });
    rejected(input);
  });
});

describe('handoff fleet bus delivery', () => {
  it('preserves handoffs in the fleet bus wire envelope', async () => {
    const envelope: FleetBusEnvelope<'handoff'> = {
      id: 'handoff-1', from: 'codex', to: 'claude', priority: 'P1', ttl: 1000,
      body: { kind: 'handoff', payload: message() },
    };
    const result = parseBusEnvelope(JSON.stringify(envelope));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Envelope validation failed');
    expect(result.value.body).toEqual(envelope.body);
    const body = result.value.body as { kind: 'handoff'; payload: unknown };
    const handler = vi.fn();
    subscribe(handler);
    await emit(body.kind, parseHandoff(body.payload), cfg);
    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0]?.[0]).toEqual(envelope.body.payload);
  });

  it.each(['plan', 'delegate', 'ask', 'review', 'takeover', 'result'] as const)(
    'carries validated %s messages through the existing bus', async kind => {
      const handler = vi.fn();
      subscribe(handler);
      const input = deserializeHandoff(serializeHandoff(message(kind)));
      await emit('handoff', input, cfg);
      expect(handler).toHaveBeenCalledOnce();
      expect(handler.mock.calls[0]?.[0]).toEqual(input);
    },
  );

  it('drops malformed direct emissions before any handler runs', async () => {
    const handler = vi.fn();
    subscribe(handler);
    for (const input of [{ ...message(), kind: 'unknown' }, { ...message(), token: 'TEST' }, null]) {
      await expect(emit('handoff', input as HandoffMessage, cfg)).resolves.toBeUndefined();
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it('honors the existing event bus off switch', async () => {
    const handler = vi.fn();
    subscribe(handler);
    await emit('handoff', message(), { foundry: { eventBus: false } } as AshlrConfig);
    expect(handler).not.toHaveBeenCalled();
  });

  it('delivers detached, deeply frozen data to every subscriber', async () => {
    const input = message();
    const received: HandoffMessage[] = [];
    subscribe(payload => {
      received.push(payload);
      input.taskId = 'changed-by-caller';
      input.payloadRefs[0] = 'artifact:changed-by-caller';
      Reflect.set(payload, 'taskId', 'changed-by-handler');
      Reflect.set(payload.payloadRefs, '0', 'artifact:changed-by-handler');
    });
    subscribe(payload => { received.push(payload); });
    await emit('handoff', input, cfg);
    expect(received).toHaveLength(2);
    for (const payload of received) {
      expect(payload).toEqual(message());
      expect(payload).not.toBe(input);
      expect(payload.payloadRefs).not.toBe(input.payloadRefs);
      expect(Object.isFrozen(payload)).toBe(true);
      expect(Object.isFrozen(payload.payloadRefs)).toBe(true);
    }
  });

  it('continues delivery after a handler fails and supports unsubscribe', async () => {
    subscribe(() => { throw new Error('TEST handler failure'); });
    const handler = vi.fn();
    const unsubscribe = onFleetEvent('handoff', handler);
    disposers.push(unsubscribe);
    await expect(emit('handoff', message(), cfg)).resolves.toBeUndefined();
    expect(handler).toHaveBeenCalledOnce();
    unsubscribe();
    unsubscribe();
    await emit('handoff', message(), cfg);
    expect(handler).toHaveBeenCalledOnce();
  });
});
