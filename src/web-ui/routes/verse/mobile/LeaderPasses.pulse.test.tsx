import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { LeaderPasses } from './LeaderPasses.js';

vi.mock('./ui-parts.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./ui-parts.js')>();
  return { ...original, Badge: ({ tone, children }: Parameters<typeof original.Badge>[0]) => <span data-tone={tone}>{children}</span> };
});

beforeEach(() => evictAll());
afterEach(() => { cleanup(); evictAll(); vi.unstubAllGlobals(); });

it('shows a stalled fleet in the danger tone', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({
    workers: [{ ageSeconds: 2520 }], events: [], mergesLastHour: { count: 0 },
  })));
  render(<LeaderPasses />);
  const badge = await screen.findByText('Stalled: nothing launched in 42 min, nothing merged');
  expect(badge).toHaveAttribute('data-tone', 'danger');
  expect(badge.parentElement?.parentElement).toHaveTextContent('Fleet pulse');
});

it('shows a launching fleet', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({
    workers: [{ ageSeconds: 180 }], events: [], mergesLastHour: { count: 0 },
  })));
  render(<LeaderPasses />);
  expect(await screen.findByText('Launching · newest worker 3 min old')).toHaveAttribute('data-tone', 'success');
});
