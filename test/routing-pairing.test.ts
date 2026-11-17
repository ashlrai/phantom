import { expect, it } from 'vitest';
import { decidePairing, type PairingLane } from '../src/core/routing/pairing.js';

const now = Date.parse('2026-11-15T12:00:00Z');
const lane = (id: string, laneClass: PairingLane['laneClass'] = 'frontier', hours = 1): PairingLane => ({
  lane: id, laneClass, available: true,
  pool: { pool: id, resetAt: new Date(now + hours * 3600000).toISOString(), remainingPercent: 80 },
});

it('pairs reset-pressured judgment with cheap free capacity, skipping unavailable lanes', () => {
  const result = decidePairing([lane('distant', 'frontier', 100), lane('near'), lane('free', 'cheap'),
    { ...lane('unavailable', 'frontier', 0.1), available: false }], now);
  expect(result).toMatchObject({ schema: 'route.pairing.v1', advisory: true,
    lead: { lane: 'near', stages: ['plan', 'verify'], reason_codes: ['reset-pressure'] },
    sidekick: { lane: 'free', stages: ['implement'] } });
  expect(result.lead!.pacePerHour).toBeGreaterThan(0);
  expect(result.reason_codes).toContain('paired');
});

it('never gives judgment to cheap lanes and leaves missing classes unknown', () => {
  expect(decidePairing([lane('cheap', 'cheap')], now)).toMatchObject({ lead: null, reason_codes: ['no-frontier-lane', 'reset-pressure'] });
  expect(decidePairing([lane('lead')], now)).toMatchObject({ sidekick: null, reason_codes: ['no-cheap-lane', 'reset-pressure'] });
  expect(decidePairing([], now)).toMatchObject({ lead: null, sidekick: null, reason_codes: ['no-frontier-lane', 'no-cheap-lane'] });
});

it('escalates only bottleneck implementation onto a different frontier lane', () => {
  const lanes = [lane('lead'), lane('second', 'frontier', 2)];
  expect(decidePairing(lanes, now, { bottleneck: 'verify' }).sidekick).toBeNull();
  const result = decidePairing(lanes, now, { bottleneck: 'implement' });
  expect(result.sidekick).toMatchObject({ lane: 'second', stages: ['implement'] });
  expect(result.reason_codes).toContain('implement-escalated');
  expect(decidePairing([lanes[0]], now, { bottleneck: 'implement' }).sidekick).toBeNull();
});

it('excludes exhausted lanes unless positive credits remain and spends margin-only allowance before reset', () => {
  const exhausted = { ...lane('empty'), pool: { ...lane('empty').pool, remainingPercent: 0 } };
  for (const creditBalance of [undefined, null, 0]) {
    expect(decidePairing([{ ...exhausted, pool: { ...exhausted.pool, creditBalance } }], now).lead).toBeNull();
  }
  expect(decidePairing([{ ...exhausted, pool: { ...exhausted.pool, creditBalance: 1 } }], now).lead)
    .toMatchObject({ lane: 'empty', reason_codes: ['credits-only'] });
  expect(decidePairing([{ ...lane('margin'), pool: { ...lane('margin').pool, remainingPercent: 2 } }], now).lead)
    .toMatchObject({ pacePerHour: 0, reason_codes: ['reset-pressure'] });
});

it('ranks weekly before credits, then unknown evidence by lane id; drops invalid pools', () => {
  const credits = { ...lane('credits'), pool: { pool: 'credits', resetAt: null, remainingPercent: null, creditBalance: 100 } };
  const unknown = (id: string) => ({ ...lane(id), pool: { pool: id, resetAt: null, remainingPercent: null } });
  expect(decidePairing([credits, lane('weekly')], now).lead!.lane).toBe('weekly');
  expect(decidePairing([unknown('a'), credits], now).lead!.reason_codes).toEqual(['credits-only']);
  expect(decidePairing([unknown('z'), unknown('a')], now).lead).toMatchObject({ lane: 'a', reason_codes: ['no-capacity-evidence'] });
  expect(decidePairing([{ ...lane('bad'), pool: { pool: 'bad', resetAt: 'invalid', remainingPercent: 80 } }], now).lead).toBeNull();
});
