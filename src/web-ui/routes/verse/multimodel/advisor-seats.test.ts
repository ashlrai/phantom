import { describe, expect, it } from 'vitest';
import type { VersePreferences, VerseSeat } from '../../../../core/verse/types.js';
import { adviseSeat } from '../../../../core/verse/multimodel/advisor.js';
import { classifyPrompt } from '../../../../core/verse/multimodel/classify.js';
import { CLAUDE_SEAT, LOCAL_SEAT, session } from '../fixtures.test-support.js';
import { toAdvisorSeats } from './advisor-seats.js';

const MODELS = [
  { id: 'small', label: 'Configured', contextWindow: 16_000 },
  { id: 'large', label: 'Later option', contextWindow: 128_000,
    expansive: { contextWindow: 256_000, autoCompactAt: null } },
];
const seat: VerseSeat = { ...CLAUDE_SEAT, contextWindow: 1_000_000, models: MODELS };
const prefs: VersePreferences = { version: 1, seats: { [seat.id]: { contextMode: 'expansive' } }, memory: { enabled: false, disabledProjects: [] } };
const NOW = Date.parse('2026-10-14T12:00:00.000Z');
const choose = (seats: ReturnType<typeof toAdvisorSeats>, contextTokens = 20_000) => adviseSeat({
  classification: { ...classifyPrompt('explain this'), estTokens: 1 }, seats,
  policy: { mode: 'balanced', seats: {}, updatedAt: new Date(0).toISOString() }, mode: 'auto', nowMs: NOW, contextTokens,
});

describe('pure exact-model advisor projection', () => {
  it('projects one account with every runnable option and never borrows the seat default window', () => {
    const projected = toAdvisorSeats([seat]);
    expect(projected).toHaveLength(1);
    expect(projected[0]?.capacity.contextWindow).toBe(16_000);
    expect(projected[0]?.modelVariants?.map((v) => [v.model, v.contextWindow])).toEqual([['small', 16_000], ['large', 128_000]]);
    expect(choose(projected).choice).toMatchObject({ seatId: seat.id, model: 'large', contextMode: 'standard', contextWindow: 128_000 });
    expect(projected[0]?.cheaper).toBeUndefined();
    expect(projected[0]?.capacity.free).toBe(false);
    expect(projected[0]?.capacity.costBasis).toBe('subscription');
  });

  it('uses explicit standard when preferences are unread and resolves each actual preferred option', () => {
    expect(toAdvisorSeats([seat])[0]?.modelVariants?.map((v) => v.contextMode)).toEqual(['standard', 'standard']);
    const projected = toAdvisorSeats([seat], [], { preferences: prefs });
    expect(projected[0]?.modelVariants?.map((v) => [v.model, v.contextMode, v.contextWindow])).toEqual([
      ['small', 'standard', 16_000], ['large', 'expansive', 256_000],
    ]);
    expect(choose(projected, 150_000).choice).toMatchObject({ model: 'large', contextMode: 'expansive', contextWindow: 256_000 });
    expect(choose(toAdvisorSeats([seat]), 150_000).choice).toBeNull();
  });

  it('does not use an unavailable large model or an unknown window as a fit rescue', () => {
    const unavailable = { ...seat, models: [MODELS[0]!, { ...MODELS[1]!, unavailableReason: 'Pinned CLI too old' }] };
    expect(choose(toAdvisorSeats([unavailable])).choice).toBeNull();
    const unknown = { ...seat, models: [MODELS[0]!, { id: 'unknown', label: 'Unknown', contextWindow: null }] };
    expect(choose(toAdvisorSeats([unknown])).choice).toBeNull();
  });

  it('retains null instead of borrowing a large seat-default window', () => {
    const unknown = { ...seat, models: [{ id: 'unknown', label: 'Unknown', contextWindow: null }] };
    expect(toAdvisorSeats([unknown])[0]?.capacity.contextWindow).toBeNull();
  });

  it('preserves a current runtime clamp and never supplies an unclamped duplicate model', () => {
    const current = session({ seatId: seat.id, model: 'large', contextMode: 'standard', usage: {
      ...session().usage, contextWindow: 12_000, contextWindowSource: 'runtime', contextTokens: 20_000,
    } });
    const projected = toAdvisorSeats([seat], [], { session: current, preferences: prefs });
    expect(projected[0]).toMatchObject({ model: 'large', contextMode: 'standard', capacity: { contextWindow: 12_000 } });
    expect(projected[0]?.modelVariants?.filter((v) => v.model === 'large')).toEqual([
      expect.objectContaining({ contextWindow: 12_000, contextMode: 'standard' }),
    ]);
    expect(choose(projected).choice).toBeNull();
  });

  it('current local window is the window recorded for that native session', () => {
    const current = session({ seatId: LOCAL_SEAT.id, engine: 'local', model: LOCAL_SEAT.models[0]!.id,
      usage: { ...session().usage, contextWindow: 8_000, contextWindowSource: 'fallback' } });
    const projected = toAdvisorSeats([LOCAL_SEAT], [], { session: current });
    expect(projected[0]?.capacity.contextWindow).toBe(8_000);
    expect(choose(projected).choice).toBeNull();
  });

  it('keeps an actual recorded expansive current mode even when no current catalog expansive budget exists', () => {
    const current = session({ seatId: seat.id, model: 'small', contextMode: 'expansive', usage: {
      ...session().usage, contextWindow: 80_000, contextWindowSource: 'runtime',
    } });
    expect(toAdvisorSeats([seat], [], { session: current })[0]).toMatchObject({
      model: 'small', contextMode: 'expansive', capacity: { contextWindow: 80_000 },
    });
  });

  it('does not borrow session data for a different real account', () => {
    const current = session({ seatId: 'other-account', model: 'large', usage: { ...session().usage, contextWindow: 1_000_000, contextWindowSource: 'runtime' } });
    expect(toAdvisorSeats([seat], [], { session: current })[0]?.capacity.contextWindow).toBe(16_000);
  });

  it('matches only existing canonical aliases for recorded session context', () => {
    const aliasSeat = { ...seat, models: [{ id: 'claude-opus-5-5', label: 'Existing alias', contextWindow: 128_000 }] };
    const current = session({ seatId: seat.id, model: 'claude-opus-5.5', usage: { ...session().usage, contextWindow: 10_000, contextWindowSource: 'runtime' } });
    expect(toAdvisorSeats([aliasSeat], [], { session: current })[0]?.capacity.contextWindow).toBe(10_000);
  });

  it('filters down/model-less seats and only server badges establish private/tool evidence', () => {
    const down = { ...seat, id: 'down', health: { ...seat.health, state: 'unavailable' as const } };
    expect(toAdvisorSeats([down, { ...seat, models: [] }])).toEqual([]);
    expect(toAdvisorSeats([LOCAL_SEAT])[0]).toMatchObject({ local: true, private: false, supportsTools: null });
    expect(toAdvisorSeats([LOCAL_SEAT], [{ seatId: LOCAL_SEAT.id, model: LOCAL_SEAT.models[0]!.id,
      state: 'available', contextWindow: 65_536, tokPerSec: null, tokPerSecSource: null,
      private: true, supportsTools: false }])[0]).toMatchObject({ private: true, supportsTools: false });
  });
});
