import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { COMMS_LIMITS_PATH, CommsLimitsRow } from './CommsLimitsRow.js';

const FAKE_PATH = '/Users/fake-owner/.ashlr/comms.toml';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function mount(response: () => Response) {
  const fetcher = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => response());
  vi.stubGlobal('fetch', fetcher);
  render(<CommsLimitsRow />);
  return fetcher;
}

/** Every request this row made was a GET to the read-only comms-limits route. */
function expectGetOnly(fetcher: ReturnType<typeof mount>) {
  expect(fetcher).toHaveBeenCalled();
  for (const [url, init] of fetcher.mock.calls) {
    expect(String(url)).toBe(COMMS_LIMITS_PATH);
    expect(init?.method ?? 'GET').toBe('GET');
    expect(init?.body).toBeUndefined();
  }
}

it('not confirmed: says drafts only, names the path and copies it', async () => {
  const fetcher = mount(() => Response.json({ schema: 'comms.limits.v1', confirmedByMason: false, path: FAKE_PATH }));
  expect(await screen.findByText('Not confirmed')).toBeInTheDocument();
  expect(screen.getByText(/Outside sends are drafts only/)).toBeInTheDocument();
  expect(screen.getByText(FAKE_PATH)).toBeInTheDocument();
  expect(screen.getByText('confirmedByMason = true')).toBeInTheDocument();
  const writeText = vi.fn(async () => undefined);
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  await userEvent.click(screen.getByRole('button', { name: 'Copy path' }));
  expect(writeText).toHaveBeenCalledWith(FAKE_PATH);
  expect(await screen.findByText(/Copied\./)).toBeInTheDocument();
  expectGetOnly(fetcher);
});

it('confirmed: says outside sends are allowed within limits and offers no control', async () => {
  const fetcher = mount(() => Response.json({ schema: 'comms.limits.v1', confirmedByMason: true, path: FAKE_PATH }));
  expect(await screen.findByText('Confirmed')).toBeInTheDocument();
  expect(screen.getByText('Outside sends allowed within comms.toml limits.')).toBeInTheDocument();
  expect(screen.queryByText(/drafts only/)).not.toBeInTheDocument();
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
  expect(screen.queryByRole('switch')).not.toBeInTheDocument();
  expectGetOnly(fetcher);
});

it('API error: says unknown instead of guessing', async () => {
  const fetcher = mount(() => Response.json({ error: 'boom' }, { status: 500 }));
  expect(await screen.findByText('Unknown')).toBeInTheDocument();
  expect(screen.getByText(/status is unknown/)).toBeInTheDocument();
  expect(screen.queryByText('Confirmed')).not.toBeInTheDocument();
  expect(screen.queryByText('Not confirmed')).not.toBeInTheDocument();
  expectGetOnly(fetcher);
});

it('unavailable or malformed answers are unknown, not "not confirmed"', async () => {
  const fetcher = mount(() => Response.json({ schema: 'comms.limits.v1', unavailable: true }));
  expect(await screen.findByText('Unknown')).toBeInTheDocument();
  await waitFor(() => expect(screen.queryByText('Not confirmed')).not.toBeInTheDocument());
  expectGetOnly(fetcher);
});
