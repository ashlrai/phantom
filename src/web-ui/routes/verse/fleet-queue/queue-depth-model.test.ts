import { describe, expect, it } from 'vitest';
import { queueDepth, ratioText } from './queue-depth-model.js';

const DAY_MS = 24 * 60 * 60_000;
const lane = (name: string, target: number, held = false) => ({ lane: name, running: 0, target, held });
const ages = (stale: number, rest = 0): (number | null)[] => [
  ...Array.from({ length: stale }, () => DAY_MS + 1),
  ...Array.from({ length: rest }, () => 60_000),
];

describe('queueDepth', () => {
  it('reports each verdict by the ready/live-cap ratio', () => {
    const cap = [lane('a', 30)];
    expect(queueDepth({ readyCount: 0, lanes: cap, lineAgesMs: [] })).toMatchObject({ verdict: 'empty', ratio: 0 });
    expect(queueDepth({ readyCount: 10, lanes: cap, lineAgesMs: [] }).verdict).toBe('thin');
    expect(queueDepth({ readyCount: 30, lanes: cap, lineAgesMs: [] }).verdict).toBe('ok');
    expect(queueDepth({ readyCount: 90, lanes: cap, lineAgesMs: [] }).verdict).toBe('ok');
    expect(queueDepth({ readyCount: 91, lanes: cap, lineAgesMs: [] }).verdict).toBe('deep');
  });

  it('excludes held lanes from the live cap', () => {
    const rows = [lane('a', 20, true), lane('b', 10), lane('c', 0, true)];
    const result = queueDepth({ readyCount: 40, lanes: rows, lineAgesMs: [] });
    expect(result).toMatchObject({ liveCap: 10, ratio: 4, verdict: 'deep' });
  });

  it('reads every lane held as no capacity, with a null ratio', () => {
    const result = queueDepth({ readyCount: 5, lanes: [lane('a', 4, true), lane('b', 6, true)], lineAgesMs: [] });
    expect(result).toMatchObject({ liveCap: 0, ratio: null, verdict: 'deep' });
    expect(result.text).toBe('No lane has capacity: every lane is held.');
  });

  it('says capacity unknown when lane data is missing, never zero slots', () => {
    const result = queueDepth({ readyCount: 812, lanes: [], lineAgesMs: [] });
    expect(result).toMatchObject({ liveCap: 0, ratio: null });
    expect(result.text).toBe('812 ready · live capacity unknown.');
    expect(result.text).not.toContain('0 live slots');
  });

  it('counts only lines older than 24 h; null and fresh ages are not stale', () => {
    const result = queueDepth({
      readyCount: 5,
      lanes: [lane('a', 10)],
      lineAgesMs: [null, DAY_MS + 1, DAY_MS - 1, DAY_MS * 2],
    });
    expect(result.staleCount).toBe(2);
    expect(result.text).toContain('2 lines older than 24 h.');
  });

  it('renders the deep-queue copy with the stale count', () => {
    const result = queueDepth({
      readyCount: 812,
      lanes: [lane('a', 30)],
      lineAgesMs: [...ages(640), ...Array.from({ length: 172 }, () => null)],
    });
    expect(result.text).toBe(
      '812 ready for 30 live slots (27x). Target is 2-3x: generators should hold. 640 lines older than 24 h.',
    );
  });

  it('uses singular forms for one slot and one stale line', () => {
    const result = queueDepth({ readyCount: 2, lanes: [lane('a', 1)], lineAgesMs: [DAY_MS * 2] });
    expect(result.text).toBe('2 ready for 1 live slot (2x). In bounds — target is 2-3x. 1 line older than 24 h.');
  });

  it('advises refill under the target and reports inside it', () => {
    expect(queueDepth({ readyCount: 10, lanes: [lane('a', 30)], lineAgesMs: [] }).text)
      .toBe('10 ready for 30 live slots (0.3x). Under the 2-3x target: generators may refill.');
    expect(queueDepth({ readyCount: 60, lanes: [lane('a', 30)], lineAgesMs: [] }).text)
      .toBe('60 ready for 30 live slots (2x). In bounds — target is 2-3x.');
    expect(queueDepth({ readyCount: 0, lanes: [lane('a', 30)], lineAgesMs: [] }).text)
      .toBe('Queue is empty — generators may refill.');
  });

  it('reports zero live slots honestly when unheld targets sum to 0', () => {
    const result = queueDepth({ readyCount: 3, lanes: [lane('a', 0)], lineAgesMs: [] });
    expect(result).toMatchObject({ liveCap: 0, ratio: null, verdict: 'deep' });
    expect(result.text).toBe("3 ready for 0 live slots — every lane's target is 0.");
  });
});

describe('ratioText', () => {
  it('keeps one decimal below 10 and rounds to an integer at or above it', () => {
    expect(ratioText(0.34)).toBe('0.3x');
    expect(ratioText(1)).toBe('1x');
    expect(ratioText(2.55)).toBe('2.6x');
    expect(ratioText(27.07)).toBe('27x');
  });
});
