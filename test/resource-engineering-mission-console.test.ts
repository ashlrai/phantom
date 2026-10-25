import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_TRANSIENT_READ_FAILURES, requestEngineeringMissionConsole } from '../src/core/resources/engineering-mission-console.js';
import type { ResourceConsoleServerHandle } from '../src/core/web/resource-console-server.js';

afterEach(() => vi.unstubAllGlobals());
function fixture() {
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  const abort = new AbortController();
  const options = { handle: { url: 'http://127.0.0.1:12345', readToken: 'fixture-read', controlToken: 'fixture-control' } as ResourceConsoleServerHandle,
    path: '/api/resources/engineering-supervision', signal: abort.signal, remainingMs: vi.fn(() => 1000),
    assertActive: vi.fn(() => { if (abort.signal.aborted) throw Error('Stopped'); }), wait: vi.fn(async () => {}) };
  return { fetch, abort, options };
}
describe('mission console bounded observation recovery', () => {
  it('retries temporary snapshot unavailability without renewing the clock or changing origin', async () => {
    const { fetch, options } = fixture();
    fetch.mockResolvedValueOnce(new Response('busy', { status: 503 })).mockResolvedValueOnce(Response.json({ state: 'ready' }));
    options.remainingMs.mockReturnValueOnce(1000).mockReturnValueOnce(500);
    expect(await requestEngineeringMissionConsole(options)).toEqual({ state: 'ready' });
    expect(options.wait).toHaveBeenCalledOnce(); expect(options.remainingMs).toHaveBeenCalledTimes(2);
    for (const [url, input] of fetch.mock.calls) {
      expect(url).toBe('http://127.0.0.1:12345/api/resources/engineering-supervision');
      expect(input).toMatchObject({ method: 'GET', redirect: 'error', headers: { 'x-ashlr-token': 'fixture-read' } });
    }
  });
  it('retries a transient transport failure on a read, then succeeds', async () => {
    const { fetch, options } = fixture();
    fetch.mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(Response.json({ state: 'ready' }));
    expect(await requestEngineeringMissionConsole(options)).toEqual({ state: 'ready' });
    expect(fetch).toHaveBeenCalledTimes(2); expect(options.wait).toHaveBeenCalledOnce();
  });
  it('bounds consecutive transport failures on a read', async () => {
    const { fetch, options } = fixture(); fetch.mockRejectedValue(new TypeError('fetch failed'));
    await expect(requestEngineeringMissionConsole(options)).rejects.toThrow('fetch failed');
    expect(MAX_TRANSIENT_READ_FAILURES).toBe(3);
    expect(fetch).toHaveBeenCalledTimes(MAX_TRANSIENT_READ_FAILURES + 1);
    expect(options.wait).toHaveBeenCalledTimes(MAX_TRANSIENT_READ_FAILURES);
  });
  it('stops transport retries at the original deadline', async () => {
    const { fetch, options } = fixture(); fetch.mockRejectedValue(new TypeError('fetch failed'));
    options.remainingMs.mockReturnValueOnce(1000).mockReturnValueOnce(0);
    await expect(requestEngineeringMissionConsole(options)).rejects.toThrow('Mission execution stopped');
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('never retries a mutation after a transport failure', async () => {
    const { fetch, options } = fixture(); fetch.mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(requestEngineeringMissionConsole({ ...options, body: { id: 'stable-task' } })).rejects.toThrow('fetch failed');
    expect(fetch).toHaveBeenCalledOnce(); expect(options.wait).not.toHaveBeenCalled();
  });
  it.each([['abort', new DOMException('aborted', 'AbortError')], ['timeout', new DOMException('timed out', 'TimeoutError')], ['other', new Error('boom')]])(
    'does not retry a non-transient %s error', async (_label, error) => {
      const { fetch, options } = fixture(); fetch.mockRejectedValueOnce(error);
      await expect(requestEngineeringMissionConsole(options)).rejects.toBe(error);
      expect(fetch).toHaveBeenCalledOnce(); expect(options.wait).not.toHaveBeenCalled();
    });
  it('stops unavailable reads when the original deadline expires', async () => {
    const { fetch, options } = fixture(); fetch.mockResolvedValueOnce(new Response('busy', { status: 503 }));
    options.remainingMs.mockReturnValueOnce(1000).mockReturnValueOnce(0);
    await expect(requestEngineeringMissionConsole(options)).rejects.toThrow('Mission execution stopped');
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('stops retries on cancellation', async () => {
    const { fetch, options, abort } = fixture(); fetch.mockResolvedValueOnce(new Response('busy', { status: 503 }));
    options.wait.mockImplementation(async () => abort.abort());
    await expect(requestEngineeringMissionConsole(options)).rejects.toThrow('Stopped'); expect(fetch).toHaveBeenCalledOnce();
  });
  it.each([400, 401, 403, 404, 409, 429, 500])('does not retry HTTP %s', async status => {
    const { fetch, options } = fixture(); fetch.mockResolvedValueOnce(new Response('refused', { status }));
    await expect(requestEngineeringMissionConsole(options)).rejects.toThrow('Mission console request refused');
    expect(fetch).toHaveBeenCalledOnce(); expect(options.wait).not.toHaveBeenCalled();
  });
  it('never retries a mutation even on HTTP 503', async () => {
    const { fetch, options } = fixture(); fetch.mockResolvedValueOnce(new Response('busy', { status: 503 }));
    await expect(requestEngineeringMissionConsole({ ...options, body: { id: 'stable-task' } })).rejects.toThrow('refused');
    expect(fetch).toHaveBeenCalledOnce(); expect(fetch.mock.calls[0]![1]).toMatchObject({ method: 'POST', headers: { 'x-ashlr-token': 'fixture-control' } });
  });
  it.each([['malformed', '{invalid'], ['oversized', 'x'.repeat(2 * 1024 * 1024 + 1)]])('does not retry %s successful output', async (_label, body) => {
    const { fetch, options } = fixture(); fetch.mockResolvedValueOnce(new Response(body));
    await expect(requestEngineeringMissionConsole(options)).rejects.toThrow(); expect(fetch).toHaveBeenCalledOnce();
  });
  it.each(['https://remote.example', 'http://127.0.0.1:12345/other', 'http://localhost:12345'])('refuses an unowned origin %s before transport', async url => {
    const { fetch, options } = fixture(); options.handle.url = url;
    await expect(requestEngineeringMissionConsole(options)).rejects.toThrow('unavailable'); expect(fetch).not.toHaveBeenCalled();
  });
});
