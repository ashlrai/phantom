import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { runReleaseCommand } from './lane-release-command.js';

const row = { lane: 'devin', target: 2, floor: 0, ceiling: 10, held: false, heldReason: null, heldUntil: null, lastChange: null, changedBy: null };
const data = { v: 1, generatedAt: '2026-10-31T12:00:00Z', sourceState: 'healthy', lanes: [row] };
beforeEach(() => setMutationToken('fixture-token'));
afterEach(() => { clearMutationToken(); vi.unstubAllGlobals(); });

it('posts a release and confirms the returned lane', async () => {
  const fetcher = vi.fn(async () => Response.json(data));
  vi.stubGlobal('fetch', fetcher);
  expect(await runReleaseCommand('/release devin test reason')).toEqual({ ok: true, text: 'Released devin.' });
  expect(fetcher).toHaveBeenCalledOnce();
});
it('returns a refusal or connectivity message', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ code: 'manual-hold', error: 'Lane was held manually' }, { status: 422 })));
  expect(await runReleaseCommand('/release devin')).toEqual({ ok: false, text: 'Lane was held manually' });
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline'); }));
  expect(await runReleaseCommand('/release devin')).toEqual({ ok: false, text: 'The server did not answer.' });
});
it('does not claim success if the returned lane is still held', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...data, lanes: [{ ...row, held: true }] })));
  expect(await runReleaseCommand('/release devin')).toEqual({ ok: false, text: 'The server did not confirm the lane release.' });
});
