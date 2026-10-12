import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { ResidentAwakePanel } from './ResidentAwakePanel.js';

const TOKEN = 'a'.repeat(64);

function answer(configured: boolean, installed: boolean, serviceRunning: boolean | null = true) {
  return { schema: 'ashlr.resident-awake.v1', supported: true, configured, installed,
    serviceInstalled: true, serviceRunning, restartRequired: configured !== installed, saved: false };
}

describe('ResidentAwakePanel', () => {
  beforeEach(() => {
    clearMutationToken();
    delete (window as unknown as Record<string, unknown>)['__ASHLR_DESKTOP__'];
  });
  afterEach(() => {
    clearMutationToken();
    delete (window as unknown as Record<string, unknown>)['__ASHLR_DESKTOP__'];
    vi.unstubAllGlobals();
  });

  it('saves a service-only preference and requires an independent native-confirmed restart', async () => {
    setMutationToken(TOKEN);
    let configured = false;
    let installed = false;
    const sent: string[] = [];
    (window as unknown as Record<string, unknown>)['__ASHLR_DESKTOP__'] = {
      fleet: { version: 1, ops: ['resident-start', 'resident-restart'], send: (request: { id: string; op: string }) => {
        sent.push(request.op);
        installed = configured;
        queueMicrotask(() => window.dispatchEvent(new CustomEvent('ashlr:fleet', {
          detail: { id: request.id, op: request.op, phase: 'done', message: 'Confirmed native restart complete.' },
        })));
        return true;
      } },
    };
    const fetcher = vi.fn(async (_path: string, opts: RequestInit) => {
      if (opts.method === 'POST') configured = JSON.parse(String(opts.body)).keepAwake as boolean;
      return new Response(JSON.stringify({ ...answer(configured, installed), saved: opts.method === 'POST' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetcher);

    render(<ResidentAwakePanel />);
    const toggle = await screen.findByRole('switch', { name: 'Keep Mac awake while resident runs' });
    await waitFor(() => expect(toggle).toBeEnabled());
    expect(toggle).not.toBeChecked();
    expect(document.querySelector('svg[data-pouring="true"]')).toBeNull();
    await userEvent.click(toggle);
    await waitFor(() => expect(toggle).toBeChecked());
    expect(screen.getByText(/Restart the resident service to apply it/)).toBeInTheDocument();
    expect(sent).toEqual([]);
    expect(document.querySelector('svg[data-pouring="true"]')).toBeNull();
    expect(fetcher.mock.calls.some(([, opts]) => opts.method === 'POST' &&
      JSON.stringify(JSON.parse(String(opts.body))) === '{"keepAwake":true}')).toBe(true);

    await userEvent.click(screen.getByRole('button', { name: 'Review restart' }));
    await waitFor(() => expect(sent).toEqual(['resident-restart']));
    await waitFor(() => expect(screen.getByText(/running service requests idle sleep prevention/i)).toBeInTheDocument());
    expect(document.querySelector('svg[data-pouring="true"]')).not.toBeNull();
    expect(screen.getByText(/Closing the lid or choosing Sleep can still sleep the Mac/)).toBeInTheDocument();
  });

  it('does not expose a writable switch without the mutation hold', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(answer(false, false)), { status: 200 })));
    render(<ResidentAwakePanel />);
    const toggle = await screen.findByRole('switch', { name: 'Keep Mac awake while resident runs' });
    await waitFor(() => expect(screen.getByText(/Unlock the mutation hold/)).toBeInTheDocument());
    expect(toggle).toBeDisabled();
  });

  it('offers native Start when the installed preference matches but the service is stopped', async () => {
    const sent: string[] = [];
    (window as unknown as Record<string, unknown>)['__ASHLR_DESKTOP__'] = {
      fleet: { version: 1, ops: ['resident-start', 'resident-restart'], send: (request: { id: string; op: string }) => {
        sent.push(request.op);
        queueMicrotask(() => window.dispatchEvent(new CustomEvent('ashlr:fleet', {
          detail: { id: request.id, op: request.op, phase: 'done', message: 'Confirmed native start complete.' },
        })));
        return true;
      } },
    };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(answer(true, true, false)), { status: 200 })));
    render(<ResidentAwakePanel />);
    await userEvent.click(await screen.findByRole('button', { name: 'Review start' }));
    await waitFor(() => expect(sent).toEqual(['resident-start']));
  });

  it('uses native Restart for an installed service whose runtime state is unknown', async () => {
    const sent: string[] = [];
    (window as unknown as Record<string, unknown>)['__ASHLR_DESKTOP__'] = {
      fleet: { version: 1, ops: ['resident-start', 'resident-restart'], send: (request: { id: string; op: string }) => {
        sent.push(request.op);
        queueMicrotask(() => window.dispatchEvent(new CustomEvent('ashlr:fleet', {
          detail: { id: request.id, op: request.op, phase: 'done', message: 'Confirmed native restart complete.' },
        })));
        return true;
      } },
    };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(answer(true, false, null)), { status: 200 })));
    render(<ResidentAwakePanel />);
    await userEvent.click(await screen.findByRole('button', { name: 'Review service update' }));
    await waitFor(() => expect(sent).toEqual(['resident-restart']));
    expect(screen.getByText('Service state unverified')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Replay coffee pour' })).toBeNull();
    expect(document.querySelector('svg[data-pouring="true"]')).toBeNull();
  });

  it('keeps initial verified installation static with a focusable expandable explanation', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(answer(true, true)), { status: 200 })));
    render(<ResidentAwakePanel />);
    await screen.findByText('Sleep prevention installed');
    expect(document.querySelector('svg[data-pouring="true"]')).toBeNull();
    const explanation = screen.getByText('How sleep prevention works');
    explanation.focus();
    expect(explanation).toHaveFocus();
    // jsdom does not implement summary's native Enter default action.
    await userEvent.click(explanation);
    expect(explanation.closest('details')).toHaveAttribute('open');
    expect(screen.getByText(/This panel does not read your power source/)).toBeVisible();
    expect(screen.getByAltText('Ash holding a cup of coffee')).toHaveAttribute('loading', 'lazy');
    expect(screen.getByAltText('Ash holding a cup of coffee')).toHaveAttribute('width', '112');
    await userEvent.click(screen.getByRole('button', { name: 'Replay coffee pour' }));
    expect(document.querySelector('svg[data-pouring="true"]')).not.toBeNull();
    // The timer also ends the decoration when reduced-motion prevents CSS events.
    await waitFor(() => expect(document.querySelector('svg[data-pouring="true"]')).toBeNull(), { timeout: 2000 });
    expect(screen.getByRole('button', { name: 'Replay coffee pour' })).toBeEnabled();
  });

  it('does not celebrate an unsuccessful native operation even if readback is active', async () => {
    let calls = 0;
    (window as unknown as Record<string, unknown>)['__ASHLR_DESKTOP__'] = {
      fleet: { version: 1, ops: ['resident-start', 'resident-restart'], send: (request: { id: string; op: string }) => {
        queueMicrotask(() => window.dispatchEvent(new CustomEvent('ashlr:fleet', {
          detail: { id: request.id, op: request.op, phase: 'cancelled', message: 'Restart was not confirmed.' },
        })));
        return true;
      } },
    };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(
      ++calls === 1 ? answer(true, false) : answer(true, true)), { status: 200 })));
    render(<ResidentAwakePanel />);
    await userEvent.click(await screen.findByRole('button', { name: 'Review restart' }));
    await screen.findByText('Restart was not confirmed.');
    expect(document.querySelector('svg[data-pouring="true"]')).toBeNull();
  });
});
