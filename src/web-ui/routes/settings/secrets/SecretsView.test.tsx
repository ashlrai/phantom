import { afterEach, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SecretsView } from './SecretsView.js';
import { evictAll } from '../../../data/cache.js';

afterEach(() => { evictAll(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it('renders only custody metadata and never renders or logs value-shaped input', async () => {
  const secret = ['sk', '-FAKE', '-custody', '0123456789abcdef0123456789'].join('');
  const log = vi.spyOn(console, 'log');
  const warn = vi.spyOn(console, 'warn');
  const error = vi.spyOn(console, 'error');
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ secrets: [{
    name: 'DEPLOY_KEY', scope: secret, ageMs: 86400000, value: secret, nested: { token: secret },
  }] }))));
  const { container } = render(<SecretsView />);
  expect(await screen.findByText('DEPLOY_KEY')).toBeInTheDocument();
  expect(screen.getByText('1 days')).toBeInTheDocument();
  expect(container.textContent).not.toContain(secret);
  expect(screen.getByText('[REDACTED]')).toBeInTheDocument();
  for (const spy of [log, warn, error]) expect(JSON.stringify(spy.mock.calls)).not.toContain(secret);
});
