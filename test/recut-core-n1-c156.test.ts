import { expect, it } from 'vitest';
import { readUpdatePhase } from '../src/core/world/read.js';

it('keeps update status failures unknown through the world reader', () => {
  expect(readUpdatePhase(() => { throw new Error('status unavailable'); })).toBe('unknown');
});
