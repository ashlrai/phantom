import { expect, it } from 'vitest';
import { firstReadSession, markFirstReadAttempted, resetFirstReadSessionForTest } from '../src/web-ui/routes/verse/resources/first-read.js';

it('retains a first-read attempt for the app session', () => {
  resetFirstReadSessionForTest();
  try {
    markFirstReadAttempted('synthetic-seat');
    expect(firstReadSession().attempted.has('synthetic-seat')).toBe(true);
  } finally {
    resetFirstReadSessionForTest();
  }
});
