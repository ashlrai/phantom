import { describe, expect, it, vi } from 'vitest';
import { composeOwnerStatusReply, isOwnerStatusRequest, OWNER_STATUS_FALLBACK } from '../src/core/agents/owner-status-reply.js';

const now = new Date('2026-11-06T15:36:00Z'); // 10:36 ET (EST)

describe('isOwnerStatusRequest', () => {
  it.each([
    'status', 'Status', 'Phantom status', 'phantom status?', '  PHANTOM STATUS  ', 'fleet status.', '/status', 'status?',
    "what's the status?", 'whats the status', 'What’s the status!', 'status!?',
  ])('matches the short ask %j', text => { expect(isOwnerStatusRequest(text)).toBe(true); });

  it.each([
    '', '   ', 'status of the release pr #12', 'please fix the release', 'phantom', 'statuses', 'status report please',
    'what is the status', 'phantom status and also restart the daemon', `${'x'.repeat(30)} phantom status`,
    'phantom status?'.padEnd(41, '?') + ' now', 'no status',
  ])('ignores %j', text => { expect(isOwnerStatusRequest(text)).toBe(false); });

  it('rejects anything over 40 characters even if it would otherwise normalise to a match', () => {
    expect(isOwnerStatusRequest(`phantom status${'?'.repeat(27)}`)).toBe(false);
    expect(isOwnerStatusRequest(`phantom status${'?'.repeat(26)}`)).toBe(true);
  });
});

describe('composeOwnerStatusReply', () => {
  it('replaces the brief heading with an ET clock and keeps the sections', async () => {
    const brief = vi.fn(async () => 'Morning leader brief\nShipped (last 12h): none\nNeeds you: unavailable');
    const text = await composeOwnerStatusReply('/synthetic-runs', now, { brief });
    expect(text).toBe('Phantom status, 10:36 ET\nShipped (last 12h): none\nNeeds you: unavailable');
    expect(brief).toHaveBeenCalledWith('/synthetic-runs', now);
  });

  it('uses a 24-hour ET clock across daylight saving', async () => {
    const brief = async () => 'Morning leader brief';
    expect(await composeOwnerStatusReply('/r', new Date('2026-07-01T03:01:00Z'), { brief })).toBe('Phantom status, 23:01 ET');
    expect(await composeOwnerStatusReply('/r', new Date('2026-11-07T04:01:00Z'), { brief })).toBe('Phantom status, 23:01 ET');
  });

  it('caps the reply at 1500 characters', async () => {
    const text = await composeOwnerStatusReply('/r', now, { brief: async () => `Morning leader brief\n${'q'.repeat(5000)}` });
    expect(text).toHaveLength(1500);
    expect(text.startsWith('Phantom status, 10:36 ET\n')).toBe(true);
  });

  it('returns the fixed fallback when the brief throws, and never throws itself', async () => {
    await expect(composeOwnerStatusReply('/r', now, { brief: async () => { throw new Error('synthetic read failure'); } })).resolves.toBe(OWNER_STATUS_FALLBACK);
    expect(OWNER_STATUS_FALLBACK).toBe("Phantom status: the status read failed; your message is in the Leader's inbox and it will answer there.");
  });
});
