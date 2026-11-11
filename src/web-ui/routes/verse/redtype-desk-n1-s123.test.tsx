import { expect, it } from 'vitest';
import { mergeOwnerThread } from './mobile/screens/leader-owner-model.js';

it('accepts an owner thread without reply-gap data', () => {
  expect(mergeOwnerThread([], { paused: false, channels: [], lines: [] }).entries).toEqual([]);
});
