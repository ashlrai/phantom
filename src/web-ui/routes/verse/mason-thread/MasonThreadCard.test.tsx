import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { renderMobile, stubFetch } from '../mobile/mobile.test-support.js';
import { MasonThreadCard } from './MasonThreadCard.js';

const PATH = 'GET /api/verse/comms/mason-thread';
const base = { schema: 'phantom.mason.thread.v1', as_of: '2026-11-19T12:00:00.000Z', since: '2026-11-18T12:00:00.000Z', gaps: [] };
afterEach(() => evictAll());

describe('MasonThreadCard', () => {
  it('says "Nothing yet." for an empty thread', async () => {
    stubFetch({ [PATH]: { ...base, items: [] } });
    renderMobile(<MasonThreadCard />);
    expect(await screen.findByText('Nothing yet.')).toBeInTheDocument();
  });

  it('shows one row per item with its state, jobs and the other channels', async () => {
    stubFetch({ [PATH]: { ...base, items: [
      { at: '2026-11-19T11:50:00.000Z', dir: 'in', channel: 'imessage', text: 'Ship the docs fix', state: 'RUNNING', job_ids: ['RQ-ONE'], also_on: ['slack'] },
      { at: '2026-11-19T11:55:00.000Z', dir: 'in', channel: 'slack', text: 'Any news?', state: 'UNKNOWN', job_ids: [], also_on: [] },
      { at: '2026-11-19T11:56:00.000Z', dir: 'out', channel: 'slack', text: 'On it.', state: null, job_ids: [], also_on: [] },
    ], gaps: ['The bus inbox could not be read.'] } });
    renderMobile(<MasonThreadCard />);
    expect(await screen.findByText('11:50 Operator via imessage (also slack): Ship the docs fix')).toBeInTheDocument();
    expect(screen.getByText('Running · RQ-ONE')).toBeInTheDocument();
    expect(screen.getByText('Unknown')).toBeInTheDocument();
    expect(screen.getByText('11:56 Leader to slack: On it.')).toBeInTheDocument();
    expect(screen.getByText('Unknown: The bus inbox could not be read.')).toBeInTheDocument();
  });
});
