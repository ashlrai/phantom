/**
 * DOM tests for the SSE-driven half of live run streaming: RunStreamPanel
 * consuming useRunStream -> useRunStreamEvents against a mocked
 * `EventSource` (jsdom has none). Complements RunStreamPanel.test.tsx, which
 * covers the polling fallback (exercised there for free, since jsdom's lack
 * of a real EventSource already forces that path).
 *
 * Covers:
 *   - append: a pushed step-done frame (plus the refetch it triggers)
 *     renders new step text without a poll tick.
 *   - pin/follow: scrolling away from the bottom shows a "Follow" button;
 *     clicking it re-pins and hides the button again.
 *   - stall banner: a server-pushed `stall` event flips the phase banner to
 *     the stalled state, driven by the server's own age, not a client guess.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act, renderHook } from '@testing-library/react';
import { RunStreamPanel } from './RunStreamPanel.js';
import { useRunStreamEvents, RUN_STREAM_RECONNECT_TIMEOUT_MS } from './useRunStreamEvents.js';
import { evictAll } from '../../data/cache.js';

// ---------------------------------------------------------------------------
// Minimal EventSource mock — jsdom ships none.
// ---------------------------------------------------------------------------

type Listener = (evt: { data: string; lastEventId: string }) => void;

class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private listeners = new Map<string, Set<Listener>>();
  closed = false;
  readyState = 0;

  constructor(url: string, _init?: unknown) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, cb: Listener): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(cb);
  }

  removeEventListener(type: string, cb: Listener): void {
    this.listeners.get(type)?.delete(cb);
  }

  close(): void {
    this.closed = true;
    this.readyState = 2;
  }

  emitOpen(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  emit(type: string, data: unknown, lastEventId = ''): void {
    if (this.closed) return;
    const evt = { data: JSON.stringify(data), lastEventId };
    for (const cb of this.listeners.get(type) ?? []) cb(evt);
  }

  static latest(): MockEventSource {
    const inst = MockEventSource.instances.at(-1);
    if (!inst) throw new Error('no MockEventSource constructed yet');
    return inst;
  }
}

function runAt(stepCount: number, status: 'running' | 'done' = 'running') {
  return {
    id: 'r1',
    goal: 'ship the thing',
    engine: 'claude',
    provider: 'anthropic',
    createdAt: new Date(Date.now() - 30_000).toISOString(),
    updatedAt: new Date().toISOString(),
    budget: { maxTokens: 100_000, maxSteps: 50, allowCloud: true },
    usage: { tokensIn: 100 * stepCount, tokensOut: 50 * stepCount, steps: stepCount, estCostUsd: 0.01 * stepCount },
    tasks: [{ id: 't1', goal: 'do it', deps: [], status: status === 'done' ? 'done' : 'running' }],
    steps: Array.from({ length: stepCount }, (_, i) => ({
      ts: new Date().toISOString(),
      taskId: 't1',
      kind: 'tool' as const,
      summary: `step ${i + 1}`,
    })),
    status,
  };
}

describe('RunStreamPanel (SSE transport)', () => {
  beforeEach(() => {
    evictAll();
    MockEventSource.instances = [];
    vi.stubGlobal('EventSource', MockEventSource);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('appends a new step to the transcript when a push frame arrives, without a poll tick', async () => {
    let stepCount = 1;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(runAt(stepCount)), { status: 200 })),
    );

    render(<RunStreamPanel runId="r1" />);
    await waitFor(() => expect(screen.getByText('step 1')).toBeInTheDocument());

    const source = MockEventSource.latest();
    act(() => source.emitOpen());
    await waitFor(() => expect(screen.getByText(/streaming/i)).toBeInTheDocument());

    // Server-side state advances; the push frame is what should trigger the
    // refetch that picks it up (not the 2s poll timer, which this test
    // never waits long enough for).
    stepCount = 2;
    act(() => source.emit('step-done', { taskId: 't1', kind: 'tool', index: 1, ts: new Date().toISOString(), usage: null }));

    await waitFor(() => expect(screen.getByText('step 2')).toBeInTheDocument(), { timeout: 1000 });
  });

  it('shows a Follow button after scrolling away from the bottom, and re-pins on click', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(runAt(5)), { status: 200 })),
    );

    render(<RunStreamPanel runId="r1" />);
    await waitFor(() => expect(screen.getByText('step 5')).toBeInTheDocument());

    const log = screen.getByRole('log', { name: /run step transcript/i });
    // jsdom has no real layout — force the scroll geometry a "scrolled up"
    // reader would have, then fire the scroll handler the component wires up.
    Object.defineProperty(log, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(log, 'clientHeight', { value: 200, configurable: true });
    Object.defineProperty(log, 'scrollTop', { value: 0, configurable: true, writable: true });
    fireEvent.scroll(log);

    const followButton = await screen.findByRole('button', { name: /follow/i });
    expect(followButton).toBeInTheDocument();

    fireEvent.click(followButton);
    await waitFor(() => expect(screen.queryByRole('button', { name: /follow/i })).not.toBeInTheDocument());
  });

  it('flips to the stalled banner on a server-pushed stall event, showing the server age', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(runAt(1)), { status: 200 })),
    );

    render(<RunStreamPanel runId="r1" />);
    await waitFor(() => expect(screen.getByText('step 1')).toBeInTheDocument());

    const source = MockEventSource.latest();
    act(() => source.emitOpen());
    await waitFor(() => expect(screen.getByText(/streaming/i)).toBeInTheDocument());

    act(() => source.emit('stall', { ageMs: 9_000 }));

    await waitFor(() => expect(screen.getByText(/may be stalled/)).toBeInTheDocument());
    expect(screen.getByText(/in 9s/)).toBeInTheDocument();
    expect(screen.getByText(/still watching/i)).toBeInTheDocument();
  });

  it('keeps draining after a terminal refetch and retains all output after run-done', async () => {
    let terminal = false;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(runAt(1, terminal ? 'done' : 'running')), { status: 200 })));
    render(<RunStreamPanel runId="r1" />);
    await screen.findByText('step 1');
    const source = MockEventSource.latest();
    act(() => source.emitOpen());
    terminal = true;
    act(() => source.emit('output-chunk', { kind: 'log', text: 'first captured burst', ts: '2026-10-12T20:00:00Z', taskId: null }, 'v1:-1:-1:10000000'));
    await waitFor(() => expect(screen.getByText(/loading captured output/i)).toBeInTheDocument());
    expect(source.closed).toBe(false);
    act(() => source.emit('output-chunk', { kind: 'log', text: 'final captured burst', ts: '2026-10-12T20:00:01Z', taskId: null }, 'v1:-1:-1:10000001'));
    act(() => source.emit('run-done', { status: 'done', result: null, terminationReason: null }, 'v1:0:1000002:10000001'));
    await waitFor(() => expect(source.closed).toBe(true));
    expect(screen.getByText('first captured burst')).toBeInTheDocument();
    expect(screen.getByText('final captured burst')).toBeInTheDocument();
  });

  it('loads captured output when mounted on a run already known to be terminal', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(runAt(1, 'done')), { status: 200 })));
    render(<RunStreamPanel runId="r1" />);
    await screen.findByText('step 1');
    const source = MockEventSource.latest();
    expect(source.closed).toBe(false);
    act(() => source.emitOpen());
    act(() => source.emit('output-chunk', { kind: 'log', text: 'saved older output', ts: '2026-10-12T20:00:00Z', taskId: null }, 'v1:-1:-1:10000000'));
    act(() => source.emit('run-done', { status: 'done', result: null, terminationReason: null }));
    await screen.findByText('saved older output');
  });

  it('shows capture gaps separately from the persisted run outcome', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(runAt(1, 'done')), { status: 200 })));
    render(<RunStreamPanel runId="r1" />);
    const source = MockEventSource.latest();
    act(() => source.emitOpen());
    act(() => source.emit('stream-gap', { reason: 'invalid-output-record' }));
    act(() => source.emit('run-done', { status: 'done', result: null, terminationReason: null }));
    await screen.findByText(/captured output is incomplete/i);
    expect(screen.getByText('done')).toBeInTheDocument();
  });

  it('deduplicates replayed output and out-of-order task starts without payload seq fields', async () => {
    const { result } = renderHook(() => useRunStreamEvents('r1', true));
    const source = MockEventSource.latest();
    const output = { kind: 'log', text: 'once', ts: '2026-10-12T20:00:00Z', taskId: null };
    const start = { taskId: 't2', index: 1, goal: 'second' };
    act(() => {
      source.emitOpen();
      source.emit('output-chunk', output, 'v1:-1:-1:10000000');
      source.emit('step-started', start, 'v1:-1:-1:10000000');
      source.emit('step-output-chunk', { taskId: 't2', kind: 'tool', index: 0, ts: output.ts, text: 'step' }, 'v1:-1:1000000:10000000');
      source.emit('output-chunk', output, 'v1:-1:1000000:10000000');
      source.emit('step-started', start, 'v1:-1:1000000:10000000');
      source.emit('step-output-chunk', { taskId: 't2', kind: 'tool', index: 0, ts: output.ts, text: 'step' }, 'v1:-1:1000000:10000000');
    });
    expect(result.current.outputChunks).toHaveLength(1);
    expect(result.current.starts).toHaveLength(1);
    expect(result.current.chunks).toHaveLength(1);
  });

  it('rejects a malformed run-done frame without fabricating a successful result', async () => {
    const { result } = renderHook(() => useRunStreamEvents('r1', true));
    const source = MockEventSource.latest();
    act(() => { source.emitOpen(); source.emit('run-done', { surprise: 'not a status' }); });
    expect(result.current.runDone).toBeNull();
    expect(result.current.status).toBe('unavailable');
    expect(source.closed).toBe(true);
  });


  it('preserves valid chunks and bounds native reconnecting after an interrupted response', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useRunStreamEvents('r1', true));
    const source = MockEventSource.latest();
    act(() => {
      source.emitOpen();
      source.emit('output-chunk', { kind: 'log', text: 'kept', ts: '2026-10-12T20:00:00Z', taskId: null }, 'v1:-1:-1:10000000');
      source.readyState = 0;
      source.onerror?.();
    });
    expect(result.current.status).toBe('reconnecting');
    act(() => vi.advanceTimersByTime(RUN_STREAM_RECONNECT_TIMEOUT_MS));
    expect(result.current.status).toBe('unavailable');
    expect(result.current.runDone).toBeNull();
    expect(result.current.outputChunks.map((chunk) => chunk.text)).toEqual(['kept']);
    expect(source.closed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears reconnect timers on reopening and unmount', () => {
    vi.useFakeTimers();
    const { result, unmount } = renderHook(() => useRunStreamEvents('r1', true));
    const source = MockEventSource.latest();
    act(() => { source.emitOpen(); source.readyState = 0; source.onerror?.(); });
    expect(vi.getTimerCount()).toBe(1);
    act(() => source.emitOpen());
    expect(result.current.status).toBe('open');
    expect(vi.getTimerCount()).toBe(0);
    act(() => { source.readyState = 0; source.onerror?.(); });
    unmount();
    expect(vi.getTimerCount()).toBe(0);
    expect(source.onopen).toBeNull();
    expect(source.onerror).toBeNull();
  });

  it('stops on fatal session failure while keeping already received output', () => {
    const { result } = renderHook(() => useRunStreamEvents('r1', true));
    const source = MockEventSource.latest();
    act(() => {
      source.emitOpen();
      source.emit('output-chunk', { kind: 'log', text: 'kept', ts: '2026-10-12T20:00:00Z', taskId: null }, '10000000');
      source.readyState = 2;
      source.onerror?.();
    });
    expect(result.current.status).toBe('unavailable');
    expect(result.current.runDone).toBeNull();
    expect(result.current.outputChunks).toHaveLength(1);
    expect(source.closed).toBe(true);
  });

  it('accepts failed outcome as terminal transport completion without changing its outcome', () => {
    const { result } = renderHook(() => useRunStreamEvents('r1', true));
    const source = MockEventSource.latest();
    act(() => { source.emitOpen(); source.emit('run-done', { status: 'failed', result: 'tool failed', terminationReason: 'task-failed' }); });
    expect(result.current.status).toBe('complete');
    expect(result.current.runDone?.status).toBe('failed');
    expect(source.closed).toBe(true);
  });

  it('never invents a done result from an unparseable terminal payload', () => {
    const { result } = renderHook(() => useRunStreamEvents('r1', true));
    const source = MockEventSource.latest();
    act(() => { source.emitOpen(); source.emit('run-done', null); });
    expect(result.current.runDone).toBeNull();
    expect(result.current.gap?.reason).toBe('invalid-run-done');
    expect(result.current.status).toBe('unavailable');
  });

  it('keeps capture on disable and clears it when the run id changes', () => {
    const { result, rerender } = renderHook(({ runId, enabled }) => useRunStreamEvents(runId, enabled),
      { initialProps: { runId: 'r1', enabled: true } });
    const source = MockEventSource.latest();
    act(() => { source.emitOpen(); source.emit('output-chunk', { kind: 'log', text: 'kept', ts: '2026-10-12T20:00:00Z', taskId: null }, '10000000'); });
    rerender({ runId: 'r1', enabled: false });
    expect(result.current.outputChunks).toHaveLength(1);
    rerender({ runId: 'missing', enabled: false });
    expect(result.current.outputChunks).toHaveLength(0);
  });


  it('shows the validated failed outcome while the structured query still has older running data', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(runAt(1)), { status: 200 })));
    render(<RunStreamPanel runId="r1" />);
    await screen.findByText('step 1');
    const source = MockEventSource.latest();
    act(() => { source.emitOpen(); source.emit('run-done', { status: 'failed', result: null, terminationReason: 'task-failed' }); });
    await screen.findByText('failed');
    expect(screen.getByText(/Run finished/i)).toBeInTheDocument();
    expect(screen.queryByText(/Live · streaming/i)).not.toBeInTheDocument();
  });

});
