import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { VerseMutationLockedError } from '../verse-queries.js';
import { postInterjection, postInterjectionDetailed } from './interject-queries.js';

beforeEach(() => setMutationToken('a'.repeat(64)));
afterEach(() => { clearMutationToken(); vi.unstubAllGlobals(); });

it.each([
  [{ at: 'now', duplicate: true, accepted: false }, true, false],
  [{ at: 'now', duplicate: false, accepted: true }, false, true],
  [{ at: 'now' }, false, false],
  [{ at: 'now', duplicate: 'true' }, false, false],
])('returns the detailed response for %j', async (body, duplicate, accepted) => {
  const fetcher = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => Response.json(body));
  vi.stubGlobal('fetch', fetcher);
  expect(await postInterjectionDetailed('Hello')).toEqual({ at: 'now', duplicate, accepted });
  expect(await postInterjection('Hello')).toEqual({ at: 'now' });
  expect(JSON.parse(String(fetcher.mock.calls[0]![1]!.body))).toEqual({ text: 'Hello', source: 'Phantom desktop' });
});

it('refuses a locked send without posting', async () => {
  clearMutationToken();
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  await expect(postInterjectionDetailed('Hello')).rejects.toBeInstanceOf(VerseMutationLockedError);
  expect(fetcher).not.toHaveBeenCalled();
});
