import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { StatusEvidenceButton } from './StatusEvidenceButton.js';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

it('copies the formatted status and shows a confirmation', async () => {
  const now = new Date().toISOString();
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('runtime-identity')) return json({ v: 1, generatedAt: now, identity: { host: 'fake-host', installedVersion: '1.2.3', asOf: now } });
    if (url.includes('coordination-claims')) return json({ state: 'known', generatedAt: now, claims: [{ agent: 'a', repo: 'r', task: 't' }] });
    return json({ items: [{ id: 'wi-1', channel: 'slack', channelRef: 'T/C/1.2', receivedAt: now, state: 'ASSIGNED', owner: 'fake-owner', claimReceipt: 'bus-claim:wi-1:1' }], inbox: 'ok', truncated: false, asOf: now });
  }));
  const writeText = vi.fn(async () => undefined);
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  render(<StatusEvidenceButton />);
  fireEvent.click(screen.getByRole('button', { name: 'Copy status for Dot' }));
  await waitFor(() => expect(screen.getByRole('button').textContent).toBe('Copied'));
  const body = String((writeText.mock.calls[0] as unknown[])[0]);
  expect(body).toContain('Status: ASSIGNED');
  expect(body).toContain('host fake-host');
  expect(body).toContain('Claims: 1 live');
  expect(body).toContain('Bridge owner: fake-owner');
});
