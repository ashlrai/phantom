import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { confirmNeeded, runLaneCommand } from './lane-target-command.js';

const path = '/api/verse/fleet/control/lanes';
const row = { lane: 'devin', target: 10, floor: 0, ceiling: 20, held: false, heldReason: null, heldUntil: null, lastChange: null, changedBy: null };
const data = { v: 1, generatedAt: '2026-10-31T12:00:00Z', sourceState: 'healthy', lanes: [row] };
beforeEach(() => setMutationToken('fixture-token'));
afterEach(() => { clearMutationToken(); vi.unstubAllGlobals(); });

describe('runLaneCommand', () => {
  it('reads the current target and posts the new one', async () => {
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => Response.json(init?.method === 'POST' ? { ...data, lanes: [{ ...row, target: 12 }] } : data));
    vi.stubGlobal('fetch', fetcher);
    await expect(runLaneCommand({ lane: 'devin', target: 12 })).resolves.toEqual({ ok: true, lane: 'devin', from: 10, to: 12 });
    expect(fetcher.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([[path, 'GET'], [path, 'POST']]);
    expect(JSON.parse(String(fetcher.mock.calls[1]![1]!.body))).toEqual({ lane: 'devin', target: 12 });
  });
  it.each([
    [409, { code: 'busy' }, 'Another fleet control action is still running, try again in a moment'],
    [404, { error: 'not found' }, 'Lane targets are not in this build'],
    [422, { error: 'Outside the permitted range.' }, 'Outside the permitted range.'],
  ])('shows the reason for a %i post refusal', async (status, body, reason) => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => init?.method === 'POST' ? Response.json(body, { status }) : Response.json(data)));
    await expect(runLaneCommand({ lane: 'devin', target: 12 })).resolves.toEqual({ ok: false, reason });
  });
  it('handles an unavailable read and a lane absent from the snapshot without posting', async () => {
    const fetcher = vi.fn(async () => Response.json({}, { status: 404 }));
    vi.stubGlobal('fetch', fetcher);
    await expect(runLaneCommand({ lane: 'devin', target: 12 })).resolves.toEqual({ ok: false, reason: 'Lane targets are not in this build' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    fetcher.mockImplementation(async () => Response.json({ ...data, lanes: [] }));
    await expect(runLaneCommand({ lane: 'devin', target: 12 })).resolves.toEqual({ ok: false, reason: 'Lane devin was not found.' });
  });
  it('explains a missing mutation hold', async () => {
    clearMutationToken();
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(data)));
    expect((await runLaneCommand({ lane: 'devin', target: 12 }))).toEqual({ ok: false, reason: expect.stringContaining('Unlock actions') });
  });
});

it('confirms only zero targets for the same lane within five seconds', () => {
  const zero = { lane: 'devin', target: 0 };
  expect(confirmNeeded(null, zero, 1000)).toBe(true);
  expect(confirmNeeded(null, { ...zero, target: 1 }, 1000)).toBe(false);
  expect(confirmNeeded({ lane: 'devin', until: 6000 }, zero, 5999)).toBe(false);
  expect(confirmNeeded({ lane: 'devin', until: 6000 }, zero, 6000)).toBe(true);
  expect(confirmNeeded({ lane: 'other', until: 6000 }, zero, 2000)).toBe(true);
  expect(confirmNeeded({ lane: 'devin', until: 6000 }, zero, 999)).toBe(true);
});
