/**
 * RQ-PHX-REDTYPEDESKN1S133: typefix for #4992 (RQ-PHX-RECUTDESKN2S131).
 * The PR makes `sendPolicy` a required field of `CommsStatus`; every literal
 * construction site and every consumer must still hold together. These tests
 * pin the wire narrowing (absent or malformed policy is null, never repaired),
 * the user-facing line, and the Dot resource card that consumes the type.
 */
import { describe, expect, it } from 'vitest';
import {
  readCommsStatus,
  sendPolicyLine,
  type CommsStatus,
  type SendPolicyStatus,
} from '../src/web-ui/routes/verse/fleet-inbox/comms-status-model.js';
import { dotResourceFromStatus } from '../src/web-ui/routes/verse/resources/dot-resource-model.js';

const NOW = Date.parse('2026-11-09T12:00:00.000Z');

const wire = (sendPolicy?: unknown): Record<string, unknown> => ({
  version: 1,
  generatedAt: '2026-11-09T12:00:00.000Z',
  drafts: null,
  emailOutbox: null,
  sources: { drafts: 'healthy', emailOutbox: 'healthy', sendPolicy: 'healthy' },
  ...(sendPolicy === undefined ? {} : { sendPolicy }),
});

describe('readCommsStatus sendPolicy narrowing', () => {
  it('parses a well-formed policy', () => {
    const status = readCommsStatus(wire({ confirmed: true, teamIdentities: 2, channels: ['imessage', 'slack'] }));
    expect(status?.sendPolicy).toEqual({ confirmed: true, teamIdentities: 2, channels: ['imessage', 'slack'] });
  });

  it('reads an absent policy as null, not a failure', () => {
    const status = readCommsStatus(wire());
    expect(status).not.toBeNull();
    expect(status?.sendPolicy).toBeNull();
  });

  it.each([
    ['non-boolean confirmed', { confirmed: 'yes', teamIdentities: 1, channels: [] }],
    ['negative count', { confirmed: true, teamIdentities: -1, channels: [] }],
    ['non-array channels', { confirmed: true, teamIdentities: 1, channels: 'slack' }],
    ['non-string channel', { confirmed: true, teamIdentities: 1, channels: ['slack', 7] }],
    ['plain non-record', 'degraded'],
  ])('narrows a malformed policy (%s) to null without repairing it', (_name, sendPolicy) => {
    expect(readCommsStatus(wire(sendPolicy))?.sendPolicy).toBeNull();
  });
});

describe('sendPolicyLine', () => {
  const line = (p: SendPolicyStatus) => sendPolicyLine(p);

  it('refuses to imply sends when no team identity is allowlisted', () => {
    expect(line({ confirmed: true, teamIdentities: 0, channels: [] })).toContain('no team identity is allowlisted');
  });

  it('reports drafts-only until Mason confirms comms.toml himself', () => {
    const text = line({ confirmed: false, teamIdentities: 3, channels: ['slack'] });
    expect(text).toContain('drafts only');
    expect(text).toContain('~/.ashlr/comms.toml');
  });

  it('uses the singular for exactly one team identity', () => {
    expect(line({ confirmed: true, teamIdentities: 1, channels: ['slack'] })).toBe(
      'Team sends: confirmed by you · 1 team identity (slack)');
  });

  it('lists channels only when present', () => {
    expect(line({ confirmed: true, teamIdentities: 2, channels: ['imessage', 'slack'] })).toBe(
      'Team sends: confirmed by you · 2 team identities (imessage, slack)');
    expect(line({ confirmed: true, teamIdentities: 2, channels: [] })).toBe(
      'Team sends: confirmed by you · 2 team identities');
  });
});

describe('CommsStatus consumers', () => {
  it('a status carrying sendPolicy still drives the Dot card', () => {
    const status: CommsStatus = {
      generatedAt: '2026-11-09T11:59:00.000Z',
      sendPolicy: { confirmed: true, teamIdentities: 1, channels: ['imessage'] },
      imessage: {
        configuration: { state: 'configured', reason: '' },
        chatDb: { state: 'readable', reason: '' },
        cursor: { state: 'present', reason: '' },
        ackSource: 'healthy', lastAckAt: '2026-11-09T11:58:00.000Z', acks24h: 2, nextStep: null,
      },
      teammate: {
        windowHours: 24, targetMinutes: 5, texts: 2, answered: 1, unanswered: 1, medianMinutes: 3,
        withinTarget: 1, oldestUnanswered: { ageMinutes: 4 }, latestTextAt: '2026-11-09T11:57:00.000Z',
        sourceState: 'healthy',
      },
      teammateSource: 'healthy',
      drafts: null, emailOutbox: null,
      sources: { drafts: 'healthy', emailOutbox: 'healthy' },
    };
    const view = dotResourceFromStatus(status, NOW);
    expect(view.state).toBe('live');
    expect(view.pending).toBe(1);
  });
});
