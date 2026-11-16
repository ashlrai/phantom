import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { cosTaskLine, readCosTask } from './fleet/cos-task-client.js';
import { readCosTaskList } from './fleet/cos-task-list-client.js';
import { CosTaskList } from './fleet/CosTaskList.js';

/**
 * Recut check for PR #4053 (RQ-REBASE-PH-12): the desktop console understands
 * the chief-of-staff delivery state 'declined'. src/core/cos/intake.ts has
 * emitted it since the decline verb landed, but the console previously dropped
 * declined tasks from the list (isRow rejected them) and flattened the state
 * to a misleading job-status label. Synthetic payloads only; no real hosts.
 */

const ID = `cos-${'0'.repeat(31)}1`;
const baseRow = { id: ID, jobStatus: 'DONE', channel: 'telegram', needsYou: false, hasDraft: true, request: 'Reply to Mason' };

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function stub(body: unknown) {
  const fetcher = vi.fn(async (url: RequestInfo | URL) =>
    String(url).includes('/cos/list') ? Response.json(body) : Response.json({ v: 1, id: ID, jobStatus: 'DONE', channel: 'telegram', draft: { text: 't', digest: 'd' }, delivery: 'declined', needsYou: false }));
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}

describe('cos declined delivery (recut of #4053)', () => {
  it('keeps a declined task in the list instead of dropping it', async () => {
    stub({ v: 1, tasks: [{ ...baseRow, delivery: 'declined' }] });
    const rows = await readCosTaskList();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.delivery).toBe('declined');
  });

  it('still drops rows whose delivery is not a known state', async () => {
    stub({ v: 1, tasks: [{ ...baseRow, delivery: 'bogus' }, { ...baseRow, id: `cos-${'0'.repeat(31)}2`, delivery: 'sent' }] });
    const rows = await readCosTaskList();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.delivery).toBe('sent');
  });

  it('preserves delivery on the single-task status read', async () => {
    stub({ tasks: [] });
    const status = await readCosTask(ID);
    expect(status.delivery).toBe('declined');
  });

  it('words the declined state ahead of job status and drafts', () => {
    expect(cosTaskLine({ jobStatus: 'READY', draft: null, delivery: 'declined' })).toBe('Declined');
    expect(cosTaskLine({ jobStatus: 'DONE', draft: { text: 't', digest: 'd' }, delivery: 'declined' })).toBe('Declined');
    // Current behavior preserved: other delivery states keep their wording.
    expect(cosTaskLine({ jobStatus: 'READY', draft: null, delivery: 'sent' })).toBe('Sent');
    expect(cosTaskLine({ jobStatus: 'READY', draft: null, delivery: 'uncertain' })).toMatch(/^Delivery uncertain/);
    expect(cosTaskLine({ jobStatus: 'READY', draft: null, delivery: 'sending' })).toBe('Sending the approved reply…');
    expect(cosTaskLine({ jobStatus: 'READY', draft: null, delivery: null })).toBe('Queued · waiting for a worker');
  });

  it('renders Declined as the row label in the task list', async () => {
    stub({ v: 1, tasks: [{ ...baseRow, delivery: 'declined', request: 'Declined reply' }] });
    render(createElement(CosTaskList));
    await screen.findByRole('heading', { name: 'Tasks' });
    expect(screen.getByRole('button', { name: /Declined reply/ }).textContent).toBe('Declined replyTelegramDeclined');
  });
});
