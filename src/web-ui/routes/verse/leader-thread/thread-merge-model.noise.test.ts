import { expect, it } from 'vitest';
import { mergeThread } from './thread-merge-model.js';

it('hides inbox flags, keeps status asks quiet and preserves thread posts', () => {
  const inbox = [
    { at: '2026-11-05T00:00:00Z', source: 'slack', text: 'Ship the fix' },
    { at: 'invalid', source: 'cli', text: '--help' },
    { at: '2026-11-05T00:02:00Z', source: 'slack', text: 'Phantom status' },
  ];
  const result = mergeThread([], inbox, Date.now(), undefined, [{ at: '2026-11-05T00:03:00Z', text: 'All clear' }]);
  expect(result.lines.map(line => line.text)).toEqual(['Ship the fix', 'Phantom status', 'All clear']);
  expect(result.lines[1]?.quiet).toBe('status-ask');
  expect(result.hiddenNoise).toBe(1);
  expect(result.undated).toHaveLength(0);
  const post = { id: 'post', at: '2026-11-05T00:04:00Z', from: 'mason' as const, channel: 'verse' as const, kind: 'message' as const, text: '--help' };
  expect(mergeThread([post], inbox, Date.now()).lines.some(line => line.id === 'post')).toBe(true);
});
