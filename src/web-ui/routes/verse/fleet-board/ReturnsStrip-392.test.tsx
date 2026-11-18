import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { ReturnsStrip, ReturnsBody } from './ReturnsStrip.js';
import { parseReturns } from './returns-model.js';

const NOW = Date.parse('2026-11-14T18:00:00.000Z');
const ROW = {
  claimId: 'fake-392', repo: 'example/phantom', result: 'VERIFIED', evidenceKind: 'pr',
  pr: 42, head: 'abcdef1234567890', evidence: 'pr #42 head abcdef1234567890', from: 'fake-agent',
  at: '2026-11-14T18:00:00.000Z', expiresAt: '2026-11-15T18:00:00.000Z', temporal: 'current',
};
const BLOCKED = { ...ROW, claimId: 'fake-blocked', result: 'BLOCKED', evidenceKind: 'dependency', pr: null, head: null, evidence: 'dependency fake-api' };
const body = (over: Record<string, unknown> = {}) => ({
  v: 1, authority: 'none', generatedAt: ROW.at, source: 'coordination-ledger', asOf: new Date(NOW).toISOString(),
  state: 'known', returns: [ROW, BLOCKED], unparsed: 0, ...over,
});
const stub = (value: unknown, status = 200) => vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(value), { status })));
afterEach(() => { cleanup(); evictAll(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('renders agent receipts, short heads, age and the evidence caption', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  stub(body());
  render(<ReturnsStrip />);
  await waitFor(() => expect(screen.getByText('1 current verified, 1 current blocked · 0 background')).toBeInTheDocument());
  expect(screen.getByText('VERIFIED · current')).toBeInTheDocument();
  expect(screen.getByText('BLOCKED · current')).toBeInTheDocument();
  expect(screen.getByText('PR #42 · head abcdef1')).toBeInTheDocument();
  expect(screen.getByText('dependency')).toBeInTheDocument();
  expect(screen.getAllByText('fake-agent')).toHaveLength(2);
  expect(screen.getAllByText('example/phantom')).toHaveLength(2);
  expect(screen.getAllByText('0s ago')).toHaveLength(2);
  expect(screen.getByText("VERIFIED is the returning agent's evidence; Phantom has not checked the PR.")).toBeInTheDocument();
});

it('shows the fixed unknown reason', async () => {
  stub(body({ state: 'unknown', reason: 'untrusted server text' }));
  render(<ReturnsStrip />);
  await waitFor(() => expect(screen.getByText('Results unknown: coordination ledger: reader failed')).toBeInTheDocument());
  expect(screen.queryByText('untrusted server text')).toBeNull();
  expect(screen.queryAllByRole('listitem')).toHaveLength(0);
});

it('shows the not-landed message on 404', async () => {
  stub({}, 404);
  render(<ReturnsStrip />);
  await waitFor(() => expect(screen.getByText('The results API has not landed in this build yet.')).toBeInTheDocument());
});

it('drops malformed rows rather than rendering them', async () => {
  stub(body({ returns: [ROW, { ...BLOCKED, from: 'bad-agent', pr: 'oops' }] }));
  render(<ReturnsStrip />);
  await waitFor(() => expect(screen.getByText(/1 malformed rows dropped/)).toBeInTheDocument());
  expect(screen.queryByText('bad-agent')).toBeNull();
  expect(screen.getAllByRole('listitem')).toHaveLength(1);
});

it('limits the pure body to eight rows and uses the supplied clock', () => {
  render(<ReturnsBody parsed={parseReturns(body({ returns: Array.from({ length: 10 }, (_, i) => ({ ...ROW, claimId: `fake-${i}` })) }))} now={Date.parse(ROW.at) + 120_000} />);
  expect(screen.getAllByRole('listitem')).toHaveLength(8);
  expect(screen.getAllByText('2m ago')).toHaveLength(8);
});

it('does not fetch while hidden', () => {
  stub(body());
  render(<ReturnsStrip visible={false} />);
  expect(fetch).not.toHaveBeenCalled();
});

it('distinguishes request failure from an absent API', async () => {
  stub({}, 500);
  render(<ReturnsStrip />);
  await waitFor(() => expect(screen.getByText('Results unknown: request failed')).toBeInTheDocument());
  expect(screen.queryByText('The results API has not landed in this build yet.')).toBeNull();
});
