import { describe, expect, it } from 'vitest';
import {
  readCommsStatus,
  sendPolicyLine,
} from '../src/web-ui/routes/verse/fleet-inbox/comms-status-model.js';
import type {
  CommsStatus,
  SendPolicyStatus,
} from '../src/web-ui/routes/verse/fleet-inbox/comms-status-model.js';

// RQ-PHX-REDTYPEDESKN1S131: CommsStatus.sendPolicy is a required field — a
// fixture that omitted it failed the Quick typecheck with TS2741. Keep the
// wire read and the policy line covered so the field cannot silently loosen.

const wire = {
  version: 1,
  generatedAt: '2026-11-11T12:00:00.000Z',
  sendPolicy: { confirmed: true, teamIdentities: 2, channels: ['imessage', 'slack'] },
  imessage: null,
  teammate: null,
  drafts: null,
  emailOutbox: null,
  sources: { drafts: 'healthy', emailOutbox: 'healthy', teammate: 'healthy' },
};

describe('CommsStatus.sendPolicy', () => {
  it('survives the strict wire reader into the required field', () => {
    const status: CommsStatus | null = readCommsStatus(wire);
    expect(status?.sendPolicy).toEqual({
      confirmed: true,
      teamIdentities: 2,
      channels: ['imessage', 'slack'],
    });
  });

  it('keeps sendPolicy required on the validated type', () => {
    const status: CommsStatus = {
      generatedAt: wire.generatedAt,
      sendPolicy: { confirmed: false, teamIdentities: 0, channels: [] },
      imessage: null,
      teammate: null,
      teammateSource: 'healthy',
      drafts: null,
      emailOutbox: null,
      sources: { drafts: 'healthy', emailOutbox: 'healthy' },
    };
    expect(status.sendPolicy.teamIdentities).toBe(0);
  });

  it('renders the unconfirmed, unallowlisted and confirmed states', () => {
    const cases: Array<[SendPolicyStatus, string]> = [
      [{ confirmed: false, teamIdentities: 0, channels: [] },
        'Team sends: no team identity is allowlisted in ~/.ashlr/agent-network.toml, so every send is refused.'],
      [{ confirmed: false, teamIdentities: 1, channels: ['slack'] },
        'Team sends: drafts only. You have not confirmed ~/.ashlr/comms.toml yet. Outside people are never sendable from here.'],
      [{ confirmed: true, teamIdentities: 2, channels: ['imessage', 'slack'] },
        'Team sends: confirmed by you · 2 team identities (imessage, slack)'],
    ];
    for (const [policy, line] of cases) expect(sendPolicyLine(policy)).toBe(line);
  });
});
