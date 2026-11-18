import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { ReturnsStrip } from './ReturnsStrip.js';
import { parseVerify, verifyHeadline } from './returns-verify-model.js';

const AT = '2026-11-14T18:00:00.000Z';
const row = (pr: number, head: string) => ({
  claimId: `fake-${pr}`, repo: 'ashlrai/example', result: 'VERIFIED', evidenceKind: 'pr',
  pr, head, evidence: `pr #${pr} head ${head}`, from: 'fake-agent', at: AT, expiresAt: '2026-11-15T18:00:00.000Z',
});
const RETURNS = {
  v: 1, authority: 'none', generatedAt: AT, source: 'coordination-ledger', asOf: AT, state: 'known', unparsed: 0,
  returns: [row(11, 'aaaaaaa1111111'), row(12, 'bbbbbbb2222222'),
    { ...row(13, 'ccccccc'), result: 'BLOCKED', evidenceKind: 'dependency', pr: null, head: null, evidence: 'dependency fake-api' }],
};
const checked = (pr: number, head: string, verdict: string, reason?: string) =>
  ({ claimId: `fake-${pr}`, repo: 'AshlrAI/Example', pr, head, verdict, observedHead: null, mergedAt: null, ...(reason ? { reason } : {}) });
const verifyBody = (over: Record<string, unknown> = {}) => ({
  v: 1, authority: 'none', generatedAt: AT, asOf: AT, returnsState: 'known',
  coverage: { parsedTotal: 3, omitted: 0, unparsed: 0 }, unparsed: 0, skipped: 1, truncated: false, nonCurrentReceipts: 0,
  checked: [checked(11, 'AAAAAAA1111111', 'merged-at-head'), checked(12, 'bbbbbbb2222222', 'merged-at-head')],
  complete: true, ...over,
});
const NOT_CHECKED = "VERIFIED is the returning agent's evidence; Phantom has not checked the PR.";
const verifyCalls = () => vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith('/returns/verify'));

/** Serves the strip's own read and, separately, the verify route. */
function stub(verify: unknown, status = 200) {
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => String(url).endsWith('/returns/verify')
    ? new Response(JSON.stringify(verify), { status }) : new Response(JSON.stringify(RETURNS))));
}
async function renderAndClick() {
  render(<ReturnsStrip />);
  const button = await screen.findByRole('button', { name: 'Check on GitHub' });
  expect(verifyCalls()).toHaveLength(0);
  expect(screen.getByText(NOT_CHECKED)).toBeInTheDocument();
  fireEvent.click(button);
}
afterEach(() => { cleanup(); evictAll(); vi.unstubAllGlobals(); });

it('renders verdict chips and the agreeing headline after one click', async () => {
  stub(verifyBody());
  await renderAndClick();
  await waitFor(() => expect(screen.getByText(/GitHub agrees with all 2 receipts/)).toBeInTheDocument());
  expect(screen.getAllByText('merged-at-head')).toHaveLength(2);
  expect(screen.getByText(/as of/)).toHaveAttribute('title', AT);
  expect(screen.queryByText(NOT_CHECKED)).toBeNull();
  expect(verifyCalls()).toHaveLength(1);
});

it('never shows the agrees text for an incomplete check', async () => {
  stub(verifyBody({
    complete: false,
    checked: [checked(11, 'aaaaaaa1111111', 'open'), checked(12, 'bbbbbbb2222222', 'unknown', 'read-failed')],
  }));
  await renderAndClick();
  await waitFor(() => expect(screen.getByText(/GitHub check incomplete: 0 merged at head, 1 other, 1 unknown/)).toBeInTheDocument());
  expect(screen.getByText('open')).toBeInTheDocument();
  expect(screen.getByText('unknown (read-failed)')).toBeInTheDocument();
  expect(screen.queryByText(/agrees/)).toBeNull();
});

it('marks a receipt GitHub was not asked about and explains the incomplete coverage', async () => {
  stub(verifyBody({ complete: false, truncated: true, checked: [checked(11, 'aaaaaaa1111111', 'merged-at-head')] }));
  await renderAndClick();
  await waitFor(() => expect(screen.getByText(/1 merged at head, 0 other, 0 unknown \(more receipts than the check limit\)/)).toBeInTheDocument());
  expect(screen.getByText('not checked')).toBeInTheDocument();
  expect(screen.queryByText(/agrees/)).toBeNull();
});

it.each([
  ['a failed request', {}, 500],
  ['a malformed answer', { ...verifyBody(), checked: [{ verdict: 'merged-at-head' }] }, 200],
])('shows unavailable, never success, on %s', async (_name, body, status) => {
  stub(body, status);
  await renderAndClick();
  await waitFor(() => expect(screen.getByText('GitHub check unavailable')).toBeInTheDocument());
  expect(screen.queryByText(/agrees/)).toBeNull();
  expect(screen.queryByText('merged-at-head')).toBeNull();
  expect(screen.getByText(NOT_CHECKED)).toBeInTheDocument();
});

it('does not trust a complete flag the rows contradict, nor unlisted reason text', () => {
  const parsed = parseVerify(verifyBody({ checked: [checked(11, 'aaaaaaa1111111', 'unknown', 'gh: fake leak')] }));
  expect(parsed?.complete).toBe(false);
  expect(parsed?.checked[0]?.reason).toBeNull();
  expect(verifyHeadline(parsed!).text).not.toMatch(/agrees/);
  expect(parseVerify(verifyBody({ authority: 'merge' }))).toBeNull();
  expect(verifyHeadline(parseVerify(verifyBody({ checked: [] }))!).tone).toBe('neutral');
});
