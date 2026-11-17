import type { IncomingMessage, ServerResponse } from 'node:http';
import { expect, it, vi } from 'vitest';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
const send = vi.hoisted(() => vi.fn());
vi.mock('../src/core/web/api.js', () => ({ sendJson: send }));
import { createFleetClaimNoticesApi } from '../src/core/verse/fleet-claim-notices-api.js';

it('serves claim notices for GET only, rejects queries and sanitizes reader failures', async () => {
  const read = vi.fn(), api = createFleetClaimNoticesApi(read);
  const path = '/api/verse/fleet/control/claim-notices';
  const call = (url: string, method: string) => api({} as VerseApiContext, { url } as IncomingMessage, {} as ServerResponse, url.split('?')[0]!, method);
  expect(await call('/unrelated', 'GET')).toBe(false);
  expect(await call(path, 'POST')).toBe(true); expect(send.mock.lastCall?.[1]).toBe(405);
  await call(`${path}?home=/private`, 'GET'); expect(send.mock.lastCall?.[1]).toBe(400);
  expect(read).not.toHaveBeenCalled();
  const view = { v: 1, source: 'ok', bindings: 1, sent: { total: 0, recent: [] }, pending: [], slackConfigured: true };
  read.mockResolvedValueOnce(view);
  await call(path, 'GET'); expect(send.mock.lastCall?.slice(1)).toEqual([200, view]);
  read.mockRejectedValueOnce(new Error('private diagnostic'));
  await call(path, 'GET'); expect(send.mock.lastCall?.slice(1)).toEqual([503, { error: 'claim notices unavailable' }]);
});
