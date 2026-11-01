import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { FleetGraphPane } from './FleetGraphPane.js';
import { openDockPane } from '../dock/dock-store.js';
import { openInterjectDialog } from '../fleet/interject-dialog-store.js';

vi.mock('../dock/dock-store.js', () => ({ openDockPane: vi.fn() }));
vi.mock('../fleet/interject-dialog-store.js', () => ({ openInterjectDialog: vi.fn() }));

const runs = { v: 1, generatedAt: '2026-10-31T12:00:00Z', sources: { runsDir: 'healthy', workers: 'healthy', inbox: 'healthy', codex: 'healthy', merges: 'healthy' },
  lastTick: null, paused: null, memFreePct: null, diskFreeGb: null, switches: [], claudeLane: null, lanes: [], workers: [], leaders: [],
  orchestratorAgents: null, publishesLastHour: [], mergesLastHour: { count: 0, items: [] }, events: [], codexPersonal: null, inbox: [], drop: null };
const node = (id: string, state: string) => ({ id, kind: 'seat', live: { state, usedPercent: 100, resetsAtMs: null, readingAgeMs: null, stale: false, reasons: ['quota'] } });
const live = { v: 1, live: { complete: true, issues: [], nodes: [node('seat-fake', 'exhausted'), node('ready-fake', 'ready')] } };

beforeEach(() => { evictAll(); vi.clearAllMocks(); });
afterEach(() => { vi.unstubAllGlobals(); });

it('opens a prepared interjection and preserves the usage row action', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url === '/api/verse/fleet/graph/live' ? live : runs)));
  render(<FleetGraphPane visible />);
  const steer = await screen.findByRole('button', { name: 'Steer seat-fake' });
  expect(screen.queryByRole('button', { name: 'Steer ready-fake' })).not.toBeInTheDocument();
  fireEvent.click(steer);
  expect(openInterjectDialog).toHaveBeenCalledWith({ prefill: 'Graph node seat-fake (seat) is exhausted: 100% used, reset unknown, no dated reading. Reasons: quota. Decide: route around it or wait for the reset.' });
  expect(openDockPane).not.toHaveBeenCalled();
  const row = steer.closest('li')!;
  fireEvent.click(within(row).getByRole('button', { name: /seat-fake exhausted/ }));
  expect(openDockPane).toHaveBeenCalledWith('fleet-usage');
});
