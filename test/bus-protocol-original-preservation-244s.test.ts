// Preservation of PR #3947's test/bus-protocol-v1.test.ts, recovered verbatim
// from source commit 6b83e96aea5a632fcaaef0f057020122993565e7 and exercised
// against the current real exports (validateBusEnvelope, bus-protocol). No
// protocol implementation is mocked; only the file name changed.
import { describe, expect, it } from 'vitest';
import { validateBusEnvelope } from '../src/core/fleet/bus-envelope.js';
import { isClaimableWork, isTopicName, isTopicPattern, protocolIssue, protocolOf, topicMatches } from '../src/core/fleet/bus-protocol.js';

const envelope = (to: string, body: unknown) => ({ id: 'fake-1', from: 'fake-planner', to, priority: 'P2', ttl: 60000, body });
const protocol = (fields: Record<string, unknown>) => ({ protocol: { version: 1, kind: 'task', ...fields } });

describe('topic names and patterns', () => {
  it('accepts namespaced names and refuses bare namespaces, unknown namespaces and malformed segments', () => {
    for (const topic of ['fleet.deploy', 'repo.phantom.main', 'human.mason', 'fleet.a-1_b.c']) expect(isTopicName(topic)).toBe(true);
    for (const topic of ['fleet', 'deploy', 'team.x', 'Fleet.deploy', 'fleet..x', 'fleet.-x', 'fleet.a.b.c.d.e', 'fleet.x ', `fleet.${'a'.repeat(65)}`]) {
      expect(isTopicName(topic), topic).toBe(false);
    }
  });

  it('accepts exact names and namespace prefixes ending in .* only', () => {
    for (const pattern of ['fleet.deploy', 'fleet.*', 'repo.phantom.*', 'human.mason', 'human.mason.*']) expect(isTopicPattern(pattern), pattern).toBe(true);
    for (const pattern of ['*', 'fleet*', 'fleet.*.x', 'fleet.', 'fleet.**', 'team.*', 'fleet.a.b.c.d.*', '.*']) expect(isTopicPattern(pattern), pattern).toBe(false);
  });

  it('matches on segment boundaries so fleet.* never matches fleetx.deploy', () => {
    expect(topicMatches('fleet.*', 'fleet.deploy')).toBe(true);
    expect(topicMatches('fleet.*', 'fleet.deploy.now')).toBe(true);
    expect(topicMatches('fleet.*', 'fleetx.deploy')).toBe(false);
    expect(topicMatches('fleet.deploy', 'fleet.deploy')).toBe(true);
    expect(topicMatches('fleet.deploy', 'fleet.deploy.now')).toBe(false);
    expect(topicMatches('fleet.deploy.*', 'fleet.deploy')).toBe(false);
    expect(topicMatches('fleet.*', 'fleet')).toBe(false);
  });
});

describe('protocol validation on the envelope', () => {
  it('leaves legacy bodies untouched, including the work convention', () => {
    expect(validateBusEnvelope(envelope('agent-a', { kind: 'work', text: 'x' })).ok).toBe(true);
    expect(validateBusEnvelope(envelope('agent-a', null)).ok).toBe(true);
  });

  it('accepts a versioned protocol with a topic equal to the to field and an opaque payload ref', () => {
    const checked = validateBusEnvelope(envelope('fleet.deploy', protocol({ topic: 'fleet.deploy', payload_ref: 'artifact:run-42/log.txt' })));
    expect(checked.ok).toBe(true);
    if (checked.ok) expect(protocolOf(checked.value.body)).toEqual({ version: 1, kind: 'task', topic: 'fleet.deploy', payload_ref: 'artifact:run-42/log.txt' });
  });

  it('refuses malformed protocol objects with a protocol path and a static message', () => {
    const bad: Array<[string, string, unknown, string]> = [
      ['non-object', 'agent-a', { protocol: 'task' }, 'Protocol must be an object.'],
      ['array', 'agent-a', { protocol: [] }, 'Protocol must be an object.'],
      ['unknown field', 'agent-a', protocol({ extra: true }), 'Protocol has unrecognized fields.'],
      ['wrong version', 'agent-a', { protocol: { version: 2, kind: 'task' } }, 'Protocol version must be 1.'],
      ['missing version', 'agent-a', { protocol: { kind: 'task' } }, 'Protocol version must be 1.'],
      ['legacy kind as protocol kind', 'agent-a', { protocol: { version: 1, kind: 'work' } }, 'Protocol kind must be task, result, review, status or question.'],
      ['bare namespace topic', 'deploy', protocol({ topic: 'deploy' }), 'Protocol topic must be a namespaced name (fleet, repo or human) equal to the envelope to field.'],
      ['unknown namespace topic', 'team.x', protocol({ topic: 'team.x' }), 'Protocol topic must be a namespaced name (fleet, repo or human) equal to the envelope to field.'],
      ['topic differs from to', 'fleet.deploy', protocol({ topic: 'fleet.other' }), 'Protocol topic must be a namespaced name (fleet, repo or human) equal to the envelope to field.'],
      ['payload ref with space', 'agent-a', protocol({ payload_ref: 'a b' }), 'Protocol payload_ref must be a printable token of 1 to 256 characters.'],
      ['payload ref too long', 'agent-a', protocol({ payload_ref: 'x'.repeat(257) }), 'Protocol payload_ref must be a printable token of 1 to 256 characters.'],
      ['empty payload ref', 'agent-a', protocol({ payload_ref: '' }), 'Protocol payload_ref must be a printable token of 1 to 256 characters.'],
    ];
    for (const [label, to, body, message] of bad) {
      const checked = validateBusEnvelope(envelope(to, body));
      expect(checked.ok, label).toBe(false);
      if (!checked.ok) expect(checked.issues, label).toEqual([{ code: 'invalid-field', path: '$.body.protocol', message }]);
      expect(protocolIssue({ to, body }), label).toBe(message);
    }
  });

  it('reports no protocol issue for bodies without the reserved key', () => {
    expect(protocolIssue({ to: 'agent-a', body: { protocolish: 1 } })).toBeUndefined();
    expect(protocolIssue({ to: 'agent-a', body: ['protocol'] })).toBeUndefined();
  });
});

describe('claimable work', () => {
  it('claims protocol tasks and the legacy work convention, never other kinds', () => {
    expect(isClaimableWork({ protocol: { version: 1, kind: 'task' } })).toBe(true);
    expect(isClaimableWork({ kind: 'work' })).toBe(true);
    expect(isClaimableWork({ protocol: { version: 1, kind: 'result' } })).toBe(false);
    expect(isClaimableWork({ kind: 'note' })).toBe(false);
    expect(isClaimableWork(['work'])).toBe(false);
    expect(isClaimableWork(null)).toBe(false);
  });
});
