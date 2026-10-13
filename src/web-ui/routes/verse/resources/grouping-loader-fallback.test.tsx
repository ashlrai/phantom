import { expect, vi } from 'vitest';
import { groupingFallbackRegression } from './grouping-fallback.test-support.js';

const chunk = vi.hoisted(() => ({ reject: null as ((error: Error) => void) | null }));
// Hold, then reject the actual lazy import; do not replace its fallback component.
vi.mock('./ProviderResourceGroups.js', () => new Promise<Record<string, unknown>>((_, reject) => { chunk.reject = reject; }));
groupingFallbackRegression('Synthetic account', /Provider grouping unavailable/, async () => {
  await vi.waitFor(() => expect(chunk.reject).toBeTypeOf('function'));
  chunk.reject!(new Error('Synthetic chunk unavailable'));
});
