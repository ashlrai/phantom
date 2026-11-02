import { describe, expect, it } from 'vitest';
import { dialogDescription, landedText } from './interject-dialog-eta.js';

const now = new Date(2026, 9, 31, 9, 5).getTime();
const minute = 60_000;

describe('interjection dialog ETA', () => {
  it('explains when no pass has reported', () => {
    expect(dialogDescription(null, now)).toBe("Lands in the leaders' inbox. Leader passes run about every 15 min; no pass has reported yet.");
  });

  it('shows the next pass and the age of the last pass', () => {
    expect(dialogDescription(now - 5 * minute, now)).toBe("Lands in the leaders' inbox. Next leader pass in ~10 min, last pass 5 min ago.");
    expect(dialogDescription(now - 40 * minute, now)).toBe("Lands in the leaders' inbox. Next leader pass is overdue by 25 min (last pass 40 min ago)");
  });

  it('formats the local landing time and known or unknown ETA', () => {
    expect(landedText(now, now - 5 * minute, now)).toBe('Landed at 09:05 · expected to be read next pass in ~10 min');
    expect(landedText(now, null, now)).toBe('Landed at 09:05 · read on the next leader pass');
  });
});
