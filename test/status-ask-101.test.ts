import { expect, it } from 'vitest';
import { isOwnerStatusRequest } from '../src/core/agents/owner-status-reply.js';
import { isStatusAsk } from '../src/core/fleet/status-ask.js';
import { isOperatorStatusAsk } from '../src/core/fleet/operator-glance.js';

it('accepts the union of exact status requests and normalizes them', () => {
  const owner = ['status', 'phantom status', 'fleet status', '/status', "what's the status", 'whats the status'];
  const operator = ['/status@ashlrbot', 'glance', "what's up", 'what is up', 'whats up', "what's happening", 'what is happening', "what's running", 'what is running', "how's the fleet", 'how is the fleet', 'hows the fleet', "how's it going", 'how is it going', 'hows it going', 'how are we', 'how are things'];
  for (const phrase of [...owner, ...operator, 'Phantom status?', 'PHANTOM STATUS', ' WHAT’S THE STATUS?! ']) {
    expect(isStatusAsk(phrase), phrase).toBe(true);
    expect(isOperatorStatusAsk(phrase), phrase).toBe(true);
  }
  for (const phrase of owner) {
    expect(isOwnerStatusRequest(phrase)).toBe(true);
    expect(isStatusAsk(phrase)).toBe(true);
  }
  for (const phrase of ['status of the release pr #12', 'status: ship 3.30.9 now', 'x'.repeat(41), '']) expect(isStatusAsk(phrase)).toBe(false);
});
