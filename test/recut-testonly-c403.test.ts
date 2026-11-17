import { afterEach, expect, it, vi } from 'vitest';
import { loopbackDeskCall } from '../src/core/drive/apps.js';

afterEach(() => vi.unstubAllGlobals());

it.each([
  { result: { content: null } },
  { result: { content: {} } },
  { error: { code: -32603, message: 'fake refusal' }, result: { content: [] } },
])('rejects malformed or refused DESK responses even with HTTP 200: %j', async (body) => {
  const fetcher = vi.fn(async () => ({ ok: true, status: 200, json: async () => body }));
  vi.stubGlobal('fetch', fetcher);
  const call = loopbackDeskCall('http://127.0.0.1:7777', `FakeDeskBearer${'0'.repeat(29)}`);

  await expect(call('computer_list_apps', {})).rejects.toThrow('DESK refused operation');
  expect(fetcher).toHaveBeenCalledTimes(1);
});
