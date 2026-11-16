import { describe, expect, it } from 'vitest';
import { validateAgentProfile } from '../src/core/agents/agent-profile.js';
import { checkSend } from '../src/core/agents/send-policy.js';

const outside = 'outside@example.test';
const metadata = {
  id: 'recut-helper',
  displayName: 'Recut helper',
  doctrine: 'doctrine.md',
  channels: ['email'],
};

describe('send-policy recut outside-send regression', () => {
  it('blocks an outside send with the default incomplete limits', () => {
    const profile = validateAgentProfile(metadata);

    expect(checkSend(profile, 'email', outside, 0)).toEqual({
      decision: 'draft', reason: 'limits-incomplete',
    });
  });

  it.each(['self-only', 'allowlist-auto'])('keeps outside mail in drafts even with %s configured', (send) => {
    const profile = validateAgentProfile({
      ...metadata,
      policy: {
        send,
        limitsTodo: false,
        perMessageApproval: false,
        recipients: { allow: [outside], deny: [] },
      },
    });

    // A portable allowlist is metadata, never evidence of verified self identity.
    expect(checkSend(profile, 'email', outside, 0)).toEqual({
      decision: 'draft', reason: 'verified-self-evidence-required',
    });
  });

  it('denies an outside recipient even when also allowlisted', () => {
    const profile = validateAgentProfile({
      ...metadata,
      policy: {
        recipients: { allow: [outside], deny: [outside] },
      },
    });

    expect(checkSend(profile, 'email', outside, 0)).toEqual({
      decision: 'deny', reason: 'recipient-denied',
    });
  });
});
