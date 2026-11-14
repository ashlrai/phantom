import { it, expect } from 'vitest';
import { validateAgentProfile } from '../src/core/agents/agent-profile.js';
import { checkSend } from '../src/core/agents/send-policy.js';
const profile = validateAgentProfile({ id: 'helper', displayName: 'Helper', doctrine: 'doctrine.md', channels: ['email'], policy: { send: 'allowlist-auto', perMessageApproval: false, recipients: { allow: ['<MASON_HANDLE>'], deny: ['<DENIED_HANDLE>'] } } });
it('limitsTodo forces drafts', () => {
  expect(checkSend(profile, 'email', '<MASON_HANDLE>', 0)).toEqual({ decision: 'draft', reason: 'limits-incomplete' });
});
it('deny beats allow', () => {
  const p = structuredClone(profile); p.policy.recipients.allow.push('<DENIED_HANDLE>');
  expect(checkSend(p, 'email', '<DENIED_HANDLE>', 0).decision).toBe('deny');
});
it('cap reached requires draft', () => {
  const p = structuredClone(profile); p.policy.limitsTodo = false; p.policy.dailyCap = 1;
  expect(checkSend(p, 'email', '<MASON_HANDLE>', 1).reason).toBe('daily-cap-reached');
});
it('unlisted channels deny', () => {
  expect(checkSend(profile, 'other', '<MASON_HANDLE>', 0).decision).toBe('deny');
});
it('portable allowlists never prove verified self identity', () => {
  const p = structuredClone(profile); p.policy.limitsTodo = false;
  expect(checkSend(p, 'email', '<MASON_HANDLE>', 0).decision).toBe('draft');
  expect(checkSend(p, 'email', '<MASON_HANDLE>', -1).decision).toBe('deny');
});
