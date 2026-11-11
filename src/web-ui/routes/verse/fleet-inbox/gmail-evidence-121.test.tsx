import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { GmailArchivePlanCard } from './GmailArchivePlanCard.js';
import { GmailTriageCard } from './GmailTriageCard.js';
import { readGmailEvidence } from './gmail-triage-model.js';

const evidence = { scope: 'saved-local-export-sample', liveInboxTargetState: 'unknown', archiveExecution: 'unverified' };
const sampleLine = 'From a saved export sample · live inbox not checked · archiving not run by Phantom';
const unknownLine = 'Source unknown · live inbox not checked · archiving not run by Phantom';

beforeEach(() => evictAll());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('accepts only the saved export scope and keeps live state unknown', () => {
  expect(readGmailEvidence({ evidence })).toEqual({ scope: 'saved-export-sample', liveInbox: 'unknown', archiveRun: 'unverified' });
  for (const data of [{ evidence: { scope: 'unknown' } }, {}, { evidence: { scope: 'live', liveInboxTargetState: 'checked', archiveExecution: 'done' } }, null]) {
    expect(readGmailEvidence(data)).toEqual({ scope: 'unknown', liveInbox: 'unknown', archiveRun: 'unverified' });
  }
});

const archivePayload = {
  schema: 'fleet.gmail-archive-plan-latest.v1',
  latest: { schema: 'fleet.gmail-archive-plan-latest.v1', plans: [{ inbox: 'inbox-a', at: new Date().toISOString(), unread: 140, target: 100, archiveCount: 40, topSenders: [] }] },
};

it('labels archive counts as a saved export sample', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...archivePayload, evidence })));
  const { container } = render(<GmailArchivePlanCard visible />);
  expect(await screen.findByText('140 unread in the saved export (target 100) · would archive 40')).toBeInTheDocument();
  expect(screen.getByText(sampleLine)).toBeInTheDocument();
  expect(container.textContent).not.toContain('unread now');
});

it('labels archive counts with unknown source for older servers', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(archivePayload)));
  render(<GmailArchivePlanCard visible />);
  expect(await screen.findByText('140 unread (source unknown) (target 100) · would archive 40')).toBeInTheDocument();
  expect(screen.getByText(unknownLine)).toBeInTheDocument();
});

it('shows the evidence on the triage card', async () => {
  const schema = 'fleet.gmail-triage-latest.v1';
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ schema, evidence, latest: {
    schema, at: new Date().toISOString(), scanned: 100, drafted: 4, review: 7, failed: 0,
    unreadInSample: 18, target: 100, archiveCandidateCount: 0,
  } })));
  render(<GmailTriageCard visible />);
  expect(await screen.findByText(sampleLine)).toBeInTheDocument();
});
