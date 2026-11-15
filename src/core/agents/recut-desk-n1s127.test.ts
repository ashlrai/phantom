import { describe, expect, it } from 'vitest';
import { validateAgentProfile } from './agent-profile.js';
import { checkSend } from './send-policy.js';

describe('portable agent profile send policy', () => {
  it('defaults to a draft and denies channels absent from the profile', () => {
    const profile = validateAgentProfile({ id: 'helper', displayName: 'Helper', doctrine: 'helper.md', channels: ['email'] });
    expect(checkSend(profile, 'email', 'person@example.test', 0).decision).toBe('draft');
    expect(checkSend(profile, 'sms', 'person@example.test', 0).decision).toBe('deny');
  });
});
