import type { IncomingMessage, ServerResponse } from 'node:http';
import { expect, it, vi } from 'vitest';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
const send = vi.hoisted(() => vi.fn());
vi.mock('../src/core/web/api.js', () => ({ sendJson: send }));
import { createCompanyOrgApi } from '../src/core/verse/company-org-api.js';
import { handleFleetControlApi } from '../src/core/verse/fleet-control-api.js';

it('serves only GET with no caller-selected paths and suppresses private reader errors', async () => {
  const read = vi.fn(), api = createCompanyOrgApi(read);
  const path = '/api/verse/fleet/control/org';
  const call = (url: string, method: string) => api({} as VerseApiContext, { url } as IncomingMessage, {} as ServerResponse, url.split('?')[0]!, method);
  expect(await call('/unrelated', 'GET')).toBe(false);
  await call(path, 'POST'); expect(send.mock.lastCall?.[1]).toBe(405);
  await call(`${path}?file=/private`, 'GET'); expect(send.mock.lastCall?.[1]).toBe(400);
  expect(read).not.toHaveBeenCalled();
  read.mockResolvedValueOnce({ schema: 'company.org.v1', members: 3 });
  await call(path, 'GET'); expect(send.mock.lastCall?.slice(1)).toEqual([200, { schema: 'company.org.v1', members: 3 }]);
  read.mockRejectedValueOnce(new Error('PRIVATE-READER-DETAIL'));
  await call(path, 'GET'); expect(send.mock.lastCall?.slice(1)).toEqual([503, { error: 'organization observation unavailable' }]);
});

it('mounts the org read through the existing fleet control family', async () => {
  const path = '/api/verse/fleet/control/org';
  expect(await handleFleetControlApi({} as VerseApiContext, { url: path } as IncomingMessage, {} as ServerResponse, path, 'GET')).toBe(true);
  expect(send.mock.lastCall?.[1]).toBe(200);
  expect(send.mock.lastCall?.[2]).toMatchObject({ schema: 'company.org.v1', members: null, contributingMembers: null, contributingLanes: null });
});
