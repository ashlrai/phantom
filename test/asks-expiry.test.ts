import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { answerAsk, askOfLine, listAsks, raiseAsk, type AsksOptions } from '../src/core/fleet/asks.js';
import { answerOwnerAsk, listAskBatch } from '../src/core/fleet/asks-batch.js';
import { emptyOwnerSettings } from '../src/core/comms/owner-channel.js';

const NOW = Date.parse('2026-11-19T12:00:00.000Z');
let home = '';
let opts: Required<Pick<AsksOptions, 'runsDir' | 'bus' | 'now'>>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'example-asks-expiry-'));
  mkdirSync(join(home, 'runs'));
  opts = { runsDir: join(home, 'runs'), bus: { root: join(home, 'fleet'), now: () => NOW }, now: () => NOW };
  writeFileSync(join(home, 'runs', 'NEEDS-MASON.md'), [
    '# Needs Mason',
    '- [ ] ask:device Sign in once on the example-ask laptop (asked 2026-11-19T10:00:00.000Z)',
    '- [ ] ask:payment May I spend the leftover example credit? => The fleet may spend it (asked 2026-11-18T10:00:00.000Z) (expires 2026-11-24T00:00:00.000Z)',
    '- [ ] ask:payment Renew the example-ask plan (asked 2026-11-19T09:00:00.000Z) (expires 2026-11-20T00:00:00.000Z)',
    '- [ ] ask:payment Old example-ask invoice (asked 2026-11-10T09:00:00.000Z) (expires 2026-11-18T00:00:00.000Z)',
    '',
  ].join('\n'));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('ask expiry', () => {
  it('sorts by expiry, soonest first, unknown last', () => {
    const list = listAsks(opts);
    expect(list.asks.map(a => a.request)).toEqual([
      'Renew the example-ask plan', 'May I spend the leftover example credit?', 'Sign in once on the example-ask laptop']);
    expect(list.asks.map(a => a.expires)).toEqual(['2026-11-20T00:00:00.000Z', '2026-11-24T00:00:00.000Z', null]);
  });

  it('hides an expired ask and counts it, in the list and the phone batch', () => {
    const list = listAsks(opts);
    expect(list.expiredHidden).toBe(1);
    expect(list.asks.some(a => a.request.startsWith('Old'))).toBe(false);
    expect(listAskBatch(opts).asks.map(a => a.number)).toEqual([1, 2, 3]);
    expect(listAskBatch(opts).asks.map(a => a.expires)).toEqual(['2026-11-20T00:00:00.000Z', '2026-11-24T00:00:00.000Z', null]);
  });

  it('shows unknown expiry as null, and keeps the question free of the tag', () => {
    expect(askOfLine('ask:payment Buy it (expires not-a-time)')?.expires).toBeNull();
    expect(askOfLine('ask:payment Buy it (expires 2026-11-24T00:00:00Z) (asked 2026-11-19T00:00:00Z)')).toMatchObject({ request: 'Buy it', expires: '2026-11-24T00:00:00.000Z' });
  });

  it('records an answer for an open ask and gives each ask its allowed words', async () => {
    const [renew] = listAsks(opts).asks;
    expect(renew!.replies).toEqual(['yes', 'no']);
    const out = await answerAsk(renew!.id, 'yes', 'cli', opts);
    expect(out).toMatchObject({ status: 'answered', answer: 'yes' });
    expect(listAsks(opts).count).toBe(2);
  });

  it('will not record an answer to an expired ask', async () => {
    const out = await answerAsk('nm-0000', 'yes', 'cli', opts);
    expect(out.status).toBe('unknown');
    const expired = listAsks({ ...opts, now: () => NOW });
    expect(expired.count).toBe(3);
    const later = { ...opts, now: () => Date.parse('2026-11-30T00:00:00.000Z') };
    const [soon] = expired.asks;
    expect(await answerAsk(soon!.id, 'yes', 'cli', later)).toMatchObject({ status: 'unknown', reason: 'That ask has expired.' });
    expect(listAsks(later).count).toBe(1);
  });

  it('refuses an unverified source and records nothing', async () => {
    const [soon] = listAsks(opts).asks;
    const out = await answerOwnerAsk({ askId: soon!.id, answer: 'yes', sender: { channel: 'desktop', senderId: 'stranger' } },
      { settings: { ...emptyOwnerSettings(), owners: { desktop: 'owner-one' } }, options: opts });
    expect(out.status).toBe('refused');
    expect(listAsks(opts).count).toBe(3);
  });

  it('raises an ask with an expiry, and refuses a past or malformed one', () => {
    const ok = raiseAsk('payment', 'Pay the example-ask fee', opts, { expires: '2026-11-25T00:00:00Z' });
    expect(ok).toMatchObject({ ok: true });
    expect(listAsks(opts).asks.find(a => a.request === 'Pay the example-ask fee')?.expires).toBe('2026-11-25T00:00:00.000Z');
    expect(raiseAsk('payment', 'Pay again', opts, { expires: '2026-11-01T00:00:00Z' })).toMatchObject({ ok: false });
    expect(raiseAsk('payment', 'Pay again', opts, { expires: 'tomorrow' })).toMatchObject({ ok: false });
  });
});
