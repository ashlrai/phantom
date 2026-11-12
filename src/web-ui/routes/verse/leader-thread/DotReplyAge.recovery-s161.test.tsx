import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DotReplyAge, DOT_REPLY_AGE_PATH } from './DotReplyAge.js';

const payload = { schema: 'comms.teammate-reply-age.v1', source: 'healthy', lastInboundAt: new Date(Date.now() - 60_000).toISOString(), lastOutboundAt: new Date(Date.now() - 600_000).toISOString(), answered: false };
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('Dot reply recovery', () => {
  it('keeps the newest inbound pending despite an older reply', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } })));
    render(<DotReplyAge />);
    expect(await screen.findByRole('status')).toHaveTextContent('NOT answered');
    expect(fetch).toHaveBeenCalledWith(DOT_REPLY_AGE_PATH, expect.anything());
  });

  it.each([null, {}, { ...payload, source: 'degraded' }, { ...payload, lastInboundAt: 'bad' }, { ...payload, lastOutboundAt: 'bad' }])('does not invent a success or time for %j', async body => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })));
    render(<DotReplyAge />);
    const status = await screen.findByRole('status');
    expect(status).toHaveAttribute('data-dot-reply', 'unknown');
    expect(status).not.toHaveTextContent(/ago|answered/);
  });

  it('reports a failed request as unknown', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    render(<DotReplyAge />);
    expect(await screen.findByRole('status')).toHaveTextContent('reply status unknown');
  });

  it('aborts on unmount and ignores a late response', async () => {
    let resolve!: (value: Response) => void;
    const fetcher = vi.fn().mockImplementation(() => new Promise<Response>(r => { resolve = r; }));
    vi.stubGlobal('fetch', fetcher);
    const mounted = render(<DotReplyAge />);
    await waitFor(() => expect(fetcher).toHaveBeenCalled());
    const signal = (fetcher.mock.calls[0]![1] as RequestInit).signal!;
    mounted.unmount();
    expect(signal.aborted).toBe(true);
    resolve(new Response(JSON.stringify(payload), { status: 200 }));
    await Promise.resolve();
    expect(screen.queryByRole('status')).toBeNull();
  });
});
