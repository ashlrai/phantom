import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { HarnessVersion, LearningStateV1 } from '../../../../core/learn/harness-types.js';
import { apiPost } from '../../../data/client.js';
import { HarnessActions } from './HarnessActions.js';

vi.mock('../../../data/hooks.js', () => ({ useMutationHold: () => ({ token: 'test-token', touch: vi.fn() }) }));
vi.mock('../../../data/client.js', () => ({ apiPost: vi.fn(), ApiError: class extends Error {} }));
afterEach(cleanup);

it('lets the owner keep the adopted harness without posting a rollback', () => {
  const active = { id: 'h-1', status: 'adopted' } as HarnessVersion;
  const state: LearningStateV1 = { v: 1, generatedAt: '2026-01-01T00:00:00Z', active, canary: null, versions: [active], experiments: [], hypotheses: [] };
  render(<HarnessActions state={state} onChanged={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Roll back to Baseline' }));
  fireEvent.click(screen.getByRole('button', { name: 'Keep current' }));
  expect(screen.queryByRole('button', { name: 'Confirm rollback' })).toBeNull();
  expect(apiPost).not.toHaveBeenCalled();
});
