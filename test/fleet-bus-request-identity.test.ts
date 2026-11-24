import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { appendBusInbox, type BusInboxOptions } from '../src/core/fleet/bus-inbox.js';
import type { BusEnvelope } from '../src/core/fleet/bus-envelope.js';
import { requestBusRoundtrip } from '../src/core/fleet/bus-request-roundtrip.js';
import { registerAgentIdentity, stableAgentId } from '../src/core/agents/bus-identity.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'bus-request-id-')); roots.push(dir);
  return { dir, options: { root: join(dir, 'store') } satisfies BusInboxOptions };
}

const request = (): BusEnvelope => ({
  id: 'req-1', from: 'agent:requester', to: 'agent:responder',
  priority: 'P2', ttl: 60_000, body: { text: 'ping' },
});

const reply = (id: string, from: string, to: string, inReplyTo = 'req-1'): BusEnvelope => ({
  id, from, to, priority: 'P2', ttl: 60_000, body: { inReplyTo },
});

function register(options: BusInboxOptions, handle: string, aliases: string[] = []): void {
  expect(registerAgentIdentity({ handle, aliases }, { root: options.root }).status).toBe('created');
}

it('correlates a reply posted under any label of the addressed identities', async () => {
  const { options } = setup();
  register(options, 'requester', ['req-alias']);
  register(options, 'responder', ['resp-alias']);
  // The responder answers from its bare handle; the requester is addressed by
  // its stable id — neither spelling equals the request's `agent:` labels.
  const append: typeof appendBusInbox = (input, opts) => {
    const posted = appendBusInbox(input, opts);
    expect(appendBusInbox(reply('rep-1', 'responder', stableAgentId('requester')), opts).status).toBe('posted');
    return posted;
  };
  const result = await requestBusRoundtrip(request(), 5000, 100, options, { append });
  expect(result.outcome).toBe('replied');
  expect(result.reply?.envelope.id).toBe('rep-1');
});

it('does not correlate a reply from a different registered identity', async () => {
  const { options } = setup();
  register(options, 'requester');
  register(options, 'responder');
  register(options, 'impostor');
  const append: typeof appendBusInbox = (input, opts) => {
    const posted = appendBusInbox(input, opts);
    expect(appendBusInbox(reply('rep-foreign', 'impostor', 'agent:requester'), opts).status).toBe('posted');
    return posted;
  };
  const result = await requestBusRoundtrip(request(), 600, 100, options, { append });
  expect(result).toMatchObject({ outcome: 'timeout', reply: null });
});

it('keeps exact-label correlation for case-variant request refs', async () => {
  const { options } = setup();
  register(options, 'requester');
  register(options, 'responder');
  const cased: BusEnvelope = { ...request(), from: 'agent:Requester', to: 'agent:Responder' };
  const append: typeof appendBusInbox = (input, opts) => {
    const posted = appendBusInbox(input, opts);
    // The handle-spelled reply cannot correlate: the case-variant request
    // refs name no identity, so only the literal labels match.
    expect(appendBusInbox(reply('rep-handle', 'responder', 'requester'), opts).status).toBe('posted');
    expect(appendBusInbox(reply('rep-exact', 'agent:Responder', 'agent:Requester'), opts).status).toBe('posted');
    return posted;
  };
  const result = await requestBusRoundtrip(cased, 5000, 100, options, { append });
  expect(result.outcome).toBe('replied');
  expect(result.reply?.envelope.id).toBe('rep-exact');
});

it('keeps exact-label correlation when the identity registry is unreadable', async () => {
  const { options } = setup();
  register(options, 'requester', ['req-alias']);
  register(options, 'responder', ['resp-alias']);
  writeFileSync(join(options.root!, 'agent-identities', 'registry.json'), '{invalid', { mode: 0o600 });
  const append: typeof appendBusInbox = (input, opts) => {
    const posted = appendBusInbox(input, opts);
    // The alias-spelled reply cannot correlate without a readable registry;
    // the literal-label reply still can.
    expect(appendBusInbox(reply('rep-alias', 'resp-alias', 'req-alias'), opts).status).toBe('posted');
    expect(appendBusInbox(reply('rep-exact', 'agent:responder', 'agent:requester'), opts).status).toBe('posted');
    return posted;
  };
  const result = await requestBusRoundtrip(request(), 5000, 100, options, { append });
  expect(result.outcome).toBe('replied');
  expect(result.reply?.envelope.id).toBe('rep-exact');
});
