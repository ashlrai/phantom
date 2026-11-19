import { describe, expect, it } from 'vitest';
import { leaderPresence, newestPassMs, spanText } from './leader-presence-model.js';

const MIN = 60_000;
const NOW = Date.parse('2026-11-18T18:00:00Z');
const etWall = (ms: number) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
}).format(ms).replace(',', '');
/** A fleet runs read whose newest leader pass ran `passAgoMin` minutes before NOW. */
const runs = (passAgoMin: number, inbox: Array<{ agoMin: number; text: string; source?: string }> = []) => ({
  generatedAt: new Date(NOW).toISOString(),
  leaders: [{ label: 'plan', ageSeconds: passAgoMin * 60 }, { label: 'older', ageSeconds: passAgoMin * 60 + 900 }],
  inbox: inbox.map(entry => ({ at: etWall(NOW - entry.agoMin * MIN), source: entry.source ?? 'Chat', text: entry.text })),
});

describe('spanText', () => {
  it('says spans the way a person does', () => {
    expect(spanText(20_000)).toBe('under a minute');
    expect(spanText(6 * MIN + 59_000)).toBe('6 min');
    expect(spanText(89 * MIN)).toBe('89 min');
    expect(spanText(120 * MIN)).toBe('2 h');
    expect(spanText(132 * MIN)).toBe('2 h 12 min');
  });
});

describe('newestPassMs', () => {
  it('takes the youngest pass age against the read time', () => {
    expect(newestPassMs(runs(6))).toBe(NOW - 6 * MIN);
  });
  it('is null when the read holds no usable pass age', () => {
    expect(newestPassMs({ generatedAt: new Date(NOW).toISOString(), leaders: [{ label: 'plan', ageSeconds: null }] })).toBeNull();
    expect(newestPassMs({ generatedAt: 'not a time', leaders: [{ ageSeconds: 60 }] })).toBeNull();
    expect(newestPassMs({ inbox: [] })).toBeNull();
    expect(newestPassMs(null)).toBeNull();
  });
});

describe('leaderPresence', () => {
  it('is reading before the first answer and unknown when the read failed or is absent', () => {
    expect(leaderPresence(undefined, false, NOW)).toMatchObject({ state: 'reading', progress: null, waiting: null });
    expect(leaderPresence(undefined, true, NOW)).toMatchObject({ state: 'unknown', headline: 'Leader pass time unknown', waiting: null });
    expect(leaderPresence(null, false, NOW).state).toBe('unknown');
  });

  it('stays unknown, never "all read", when no pass is recorded', () => {
    const view = leaderPresence({ generatedAt: new Date(NOW).toISOString(), leaders: [], inbox: [{ at: etWall(NOW - MIN), source: 'Chat', text: 'hello' }] }, false, NOW);
    expect(view).toMatchObject({ state: 'unknown', waiting: null, progress: null, detail: 'No leader pass is recorded in the fleet read.' });
  });

  it('says when the last pass ran and when the next is due', () => {
    const view = leaderPresence(runs(6), false, NOW);
    expect(view).toMatchObject({ state: 'due', headline: 'Last leader pass 6 min ago · next in about 9 min', detail: null, waiting: 0 });
    expect(view.progress).toBeCloseTo(0.4);
    expect(view.lastPassIso).toBe(new Date(NOW - 6 * MIN).toISOString());
  });

  it('counts the messages no pass has read yet', () => {
    const view = leaderPresence(runs(6, [{ agoMin: 20, text: 'read already' }, { agoMin: 3, text: 'first' }, { agoMin: 1, text: 'second' }]), false, NOW);
    expect(view).toMatchObject({ state: 'due', waiting: 2, detail: '2 of your messages wait for the next pass.' });
    expect(leaderPresence(runs(6, [{ agoMin: 2, text: 'only one' }]), false, NOW).detail).toBe('1 message of yours waits for the next pass.');
  });

  it('says everything was read only when something was sent', () => {
    expect(leaderPresence(runs(6, [{ agoMin: 20, text: 'read already' }]), false, NOW).detail).toBe('Everything you sent has been read.');
    expect(leaderPresence(runs(6), false, NOW).detail).toBeNull();
  });

  it('leaves out system lines, stray flags and status asks, as the conversation does', () => {
    const view = leaderPresence(runs(6, [{ agoMin: 2, text: 'lane held', source: 'system' }, { agoMin: 2, text: '--json' }, { agoMin: 2, text: 'status' }]), false, NOW);
    expect(view).toMatchObject({ waiting: 0, detail: null });
  });

  it('says due now inside the grace window, then late, then stalled', () => {
    expect(leaderPresence(runs(16), false, NOW)).toMatchObject({ state: 'due', headline: 'Last leader pass 16 min ago · next one due now', progress: 1 });
    expect(leaderPresence(runs(24, [{ agoMin: 5, text: 'waiting' }]), false, NOW)).toMatchObject({
      state: 'late', headline: 'Leader pass is 9 min late · last one 24 min ago', detail: '1 message of yours waits for the next pass.', progress: 1,
    });
    expect(leaderPresence(runs(52, [{ agoMin: 5, text: 'a' }, { agoMin: 4, text: 'b' }]), false, NOW)).toMatchObject({
      state: 'stalled', headline: 'No leader pass for 52 min', detail: '2 of your messages are unread until a pass runs.',
    });
  });
});
