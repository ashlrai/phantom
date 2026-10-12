import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
// @ts-expect-error jsdom is provided by the web test runner without its optional type package.
import { JSDOM } from 'jsdom';
import { DevinDashboardReader } from './DevinDashboardReader.js';
import { DEVIN_READER_EVENT, readDevinReaderEvent } from './native-devin-reader.js';

const source = readFileSync(resolve(process.cwd(), 'desktop/src-tauri/src/devin_reader_extract.js'), 'utf8');
const nonce = 'a'.repeat(32);

function extract(html: string, page: 'general' | 'usage', origin = 'https://app.devin.ai') {
  const dom = new JSDOM(html, { url: `${origin}/org/team/settings/${page}`, runScripts: 'outside-only' });
  Object.defineProperty(dom.window.HTMLElement.prototype, 'getClientRects', { value: () => [1] });
  Object.defineProperty(dom.window, '__ashlrDevinReaderNonce', { value: nonce });
  const result = JSON.parse(dom.window.eval(source) as string);
  dom.window.close();
  return result as Record<string, unknown>;
}

function usage(weekly: string, monthly: string) {
  return `<h2>Usage &amp; limits</h2><div role="tabpanel">
    <div><span>Weekly allowance</span><span>${weekly}</span><span>Resets in 6 days</span></div>
    <div><span>Remaining balance</span><span>$0.00</span></div>
    <div><h3>Max</h3>${monthly}<span>Renews on October 27, 2026</span></div>
  </div>`;
}

afterEach(() => { cleanup(); delete (window as unknown as Record<string, unknown>).__ASHLR_DESKTOP__; });

describe('Devin dashboard observation', () => {
  it('reads only a weekly-labelled allowance and associated Max monthly price', () => {
    const valid = extract(usage('0% used', '<span>$200/month</span>'), 'usage');
    expect(valid).toMatchObject({ page: 'usage', weeklyUsedPercent: 0, monthlyPriceUsd: 200, onDemandBalanceUsd: 0 });
    expect(extract(usage('0% used', '<span>$200/month</span>') + '<div>90% used</div>', 'usage')).toMatchObject({ page: 'usage' });
    expect(extract(usage('Weekly allowance', '<span>$200/month</span>') + '<span>0% used</span>', 'usage')).toMatchObject({ error: 'usage-fields' });
    expect(extract(usage('0,5% used', '<span>$200/month</span>'), 'usage')).toMatchObject({ error: 'usage-fields' });
    expect(extract(usage('0% used', '') + '<span>$200/month</span>', 'usage')).toMatchObject({ error: 'usage-fields' });
    expect(extract(usage('0% used', '<span>$200/month</span>'), 'usage', 'https://example.test')).toMatchObject({ error: 'origin' });
  });

  it('refuses ambiguous or unrelated organization and currency labels', () => {
    expect(extract('<div><div><div><h4>Organization ID</h4></div><p>org-team</p></div></div>', 'general')).toMatchObject({ page: 'general', orgId: 'org-team' });
    expect(extract('<div><div><div><h4>Organization ID</h4></div><p>org-team org-other</p></div></div>', 'general')).toMatchObject({ error: 'org-value' });
    expect(extract(usage('0% used', '<span>$200/month</span><span>$300/month</span>'), 'usage')).toMatchObject({ error: 'usage-fields' });
  });

  it('clears an org A observation when the connected API organization changes to B', () => {
    (window as unknown as Record<string, unknown>).__ASHLR_DESKTOP__ = { devinReader: { version: 1, send: vi.fn(() => true) } };
    const view = render(<DevinDashboardReader orgId="org-a" />);
    const oldObservation = {
      kind: 'snapshot', source: 'devin-dashboard-organization', accountVerified: false, orgId: 'org-a',
      observedAtMs: Date.now(), expiresAtMs: Date.now() + 90_000,
      usage: { weeklyUsedPercent: 12, onDemandBalanceUsd: 0, plan: 'Max', monthlyPriceUsd: 200,
        resetProse: 'Resets in 6 days', renewalProse: null, autoReload: false },
    };
    act(() => window.dispatchEvent(new CustomEvent(DEVIN_READER_EVENT, { detail: oldObservation })));
    expect(screen.getByText(/weekly 12% used/)).toBeInTheDocument();
    view.rerender(<DevinDashboardReader orgId="org-b" />);
    expect(screen.queryByText(/weekly 12% used/)).not.toBeInTheDocument();
    act(() => window.dispatchEvent(new CustomEvent(DEVIN_READER_EVENT, { detail: oldObservation })));
    expect(screen.queryByText(/weekly 12% used/)).not.toBeInTheDocument();
    expect(screen.getByText('No current dashboard observation is available.')).toBeInTheDocument();
  });

  it('rejects expired, mismatched and malformed native display events', () => {
    const now = Date.now();
    const row = { kind: 'snapshot', source: 'devin-dashboard-organization', accountVerified: false,
      orgId: 'org-a', observedAtMs: now, expiresAtMs: now + 60_000,
      usage: { weeklyUsedPercent: 0, onDemandBalanceUsd: 0, plan: 'Max', monthlyPriceUsd: 200,
        resetProse: 'Resets in 6 days', renewalProse: null, autoReload: false } };
    const read = (data: object) => readDevinReaderEvent(new CustomEvent(DEVIN_READER_EVENT, { detail: data }), now);
    expect(read(row)).toMatchObject({ kind: 'snapshot', orgId: 'org-a' });
    expect(read({ ...row, orgId: 'team-a' })).toBeNull();
    expect(read({ ...row, expiresAtMs: now - 1 })).toBeNull();
    expect(read({ ...row, usage: { ...row.usage, weeklyUsedPercent: 101 } })).toBeNull();
  });
});
