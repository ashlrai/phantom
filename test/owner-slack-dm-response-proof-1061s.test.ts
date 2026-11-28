import { describe, expect, it } from 'vitest';
import { proveOwnerDirectMessage } from '../src/core/comms/owner-live-transport.js';

const ref = 'slack:T123:D123:1700000000.000100';
const owner = 'U0123456789';
const methods = ['conversations.info', 'conversations.members', 'auth.test'] as const;

function probe(failure?: { method: string; flag?: unknown; throws?: boolean }) {
  const calls: string[] = [];
  const responses: Record<string, Record<string, unknown>> = {
    'conversations.info': { ok: true, channel: { id: 'D123', is_im: true } },
    'conversations.members': { ok: true, members: [owner, 'U0BOTUSER1'] },
    'auth.test': { ok: true, user_id: 'U0BOTUSER1' },
  };
  return {
    calls,
    call: async (method: string): Promise<Record<string, unknown>> => {
      calls.push(method);
      if (failure?.method === method) {
        if (failure.throws) throw new Error('fake probe failure');
        if ('flag' in failure) responses[method].ok = failure.flag;
        else delete responses[method].ok;
      }
      return responses[method];
    },
  };
}

describe('owner Slack DM response proof', () => {
  it('accepts successful evidence for the exact owner and bot DM', async () => {
    const fake = probe();
    expect(await proveOwnerDirectMessage(fake.call, ref, owner)).toBe(true);
    expect(fake.calls).toEqual(methods);
  });

  for (const [index, method] of methods.entries()) {
    for (const [label, flag] of [['false', false], ['null', null], ['string', 'true'], ['number', 1]] as const) {
      it(`rejects ${label} success from ${method} without further probes`, async () => {
        const fake = probe({ method, flag });
        expect(await proveOwnerDirectMessage(fake.call, ref, owner)).toBe(false);
        expect(fake.calls).toEqual(methods.slice(0, index + 1));
      });
    }
    it(`rejects missing success from ${method} without further probes`, async () => {
      const fake = probe({ method });
      expect(await proveOwnerDirectMessage(fake.call, ref, owner)).toBe(false);
      expect(fake.calls).toEqual(methods.slice(0, index + 1));
    });
    it(`handles a thrown ${method} probe without further probes`, async () => {
      const fake = probe({ method, throws: true });
      expect(await proveOwnerDirectMessage(fake.call, ref, owner)).toBe(false);
      expect(fake.calls).toEqual(methods.slice(0, index + 1));
    });
  }
});
