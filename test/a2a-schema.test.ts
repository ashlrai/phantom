import { describe, expect, it } from 'vitest';
import { a2aConfigSchema } from '../src/core/agents/a2a-schema.js';

const counterpart = {
  localOptIn: true,
  remoteOptInEvidence: 'consent-record-reference',
  channel: 'email',
  scope: ['project-updates'],
};

describe('agent-to-agent configuration', () => {
  it('defaults to disabled with no counterparts', () => {
    expect(a2aConfigSchema.parse({})).toEqual({ enabled: false, counterparts: [] });
  });

  it('requires both sides of consent even while disabled', () => {
    for (const invalid of [
      { ...counterpart, localOptIn: false },
      { ...counterpart, localOptIn: undefined },
      { ...counterpart, remoteOptInEvidence: undefined },
      { ...counterpart, remoteOptInEvidence: '  ' },
    ]) {
      expect(a2aConfigSchema.safeParse({ counterparts: [invalid] }).success).toBe(false);
    }
  });

  it('accepts each supported channel with bilateral consent and scope', () => {
    for (const channel of ['email', 'slack', 'imessage']) {
      expect(a2aConfigSchema.safeParse({ enabled: true, counterparts: [{ ...counterpart, channel }] }).success).toBe(true);
    }
  });

  it('rejects invalid scope, channels and unknown fields', () => {
    for (const invalid of [
      { ...counterpart, scope: [] },
      { ...counterpart, scope: ['  '] },
      { ...counterpart, channel: 'other' },
      { ...counterpart, unexpected: true },
    ]) {
      expect(a2aConfigSchema.safeParse({ counterparts: [invalid] }).success).toBe(false);
    }
    expect(a2aConfigSchema.safeParse({ unexpected: true }).success).toBe(false);
  });
});
