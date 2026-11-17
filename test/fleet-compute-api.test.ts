import type { IncomingMessage, ServerResponse } from 'node:http';
import { expect, it, vi } from 'vitest';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
const send = vi.hoisted(() => vi.fn());
vi.mock('../src/core/web/api.js', () => ({ sendJson: send }));
import { createFleetComputeApi } from '../src/core/verse/fleet-compute-api.js';

it('routes only GET, rejects query input, and never invokes readers for refused requests', async () => {
  const read = vi.fn(), api = createFleetComputeApi(read);
  const path = '/api/verse/fleet/control/compute';
  const call = (url: string, method: string) => api({} as VerseApiContext, { url } as IncomingMessage, {} as ServerResponse, url.split('?')[0]!, method);
  expect(await call('/unrelated', 'GET')).toBe(false);
  expect(await call(path, 'POST')).toBe(true); expect(send.mock.lastCall?.[1]).toBe(405);
  await call(`${path}?home=/private`, 'GET'); expect(send.mock.lastCall?.[1]).toBe(400);
  expect(read).not.toHaveBeenCalled();
  read.mockResolvedValueOnce({ schema: 'fleet.compute.v1' });
  await call(path, 'GET'); expect(send.mock.lastCall?.[1]).toBe(200);
  read.mockRejectedValueOnce(new Error('private diagnostic'));
  await call(path, 'GET'); expect(send.mock.lastCall?.slice(1)).toEqual([503, { error: 'compute observation unavailable' }]);
});
