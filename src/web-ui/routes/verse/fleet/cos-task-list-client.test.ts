import { afterEach, expect, it, vi } from 'vitest';
import { COS_LIST_PATH, readCosTaskList } from './cos-task-list-client.js';

const row = { id: `cos-${'0'.repeat(31)}1`, jobStatus: 'READY', channel: 'telegram', needsYou: true, delivery: null, hasDraft: true, request: 'Reply please' };
afterEach(() => vi.unstubAllGlobals());
function stub(body: unknown) {
  const fetcher = vi.fn(async () => Response.json(body));
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}
it('reads the list with a bounded limit and passes cancellation', async () => {
  const fetcher = stub({ v: 1, tasks: [row] });
  expect(await readCosTaskList(new AbortController().signal)).toEqual([row]);
  expect(fetcher.mock.calls[0]).toEqual([COS_LIST_PATH, expect.objectContaining({ method: 'GET', signal: expect.any(AbortSignal) })]);
});
it('drops malformed rows without losing good rows', async () => {
  stub({ tasks: [null, [], {}, ...Object.entries({ id: 'bad', jobStatus: 'ready', channel: 1, needsYou: 'true', delivery: 'failed', hasDraft: null, request: 'a'.repeat(141) }).map(([key, value]) => ({ ...row, [key]: value })), { ...row, request: 'two\nlines' }, row] });
  expect(await readCosTaskList()).toEqual([row]);
});
it.each([null, [], {}, { tasks: null }, { tasks: {} }])('rejects a malformed envelope: %j', async body => {
  stub(body);
  await expect(readCosTaskList()).rejects.toThrow('The task list is unavailable.');
});
it('accepts an empty list and an empty preview', async () => {
  stub({ tasks: [] });
  expect(await readCosTaskList()).toEqual([]);
  stub({ tasks: [{ ...row, request: '' }] });
  expect(await readCosTaskList()).toEqual([{ ...row, request: '' }]);
});
