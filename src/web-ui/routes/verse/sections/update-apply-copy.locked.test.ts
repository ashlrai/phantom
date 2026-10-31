import { expect, it } from 'vitest';
import { applyOutcomeCopy } from './update-apply-copy.js';

it('directs a locked update to the mutation hold and retry action', () => {
  expect(applyOutcomeCopy({ kind: 'locked' })).toEqual({
    tone: 'warning',
    text: 'Unlock in Settings ▸ Connection ▸ Mutation hold, then press Update now again.',
  });
});
