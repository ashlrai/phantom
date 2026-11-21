import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { MapEdge } from '../../../../core/fleet/map-edges.js';
import type { FleetLiveMap, LiveMapEdge, LiveMapNode } from '../../../../core/fleet/live-map.js';
import { mockViewport, type ViewportMock } from '../shell/viewport.test-support.js';
import { MapView } from './MapPane.js';
import { layoutByOrg, MAP_LAYOUT_KEY } from './org-layout-model.js';

const node = (kind: LiveMapNode['kind'], id: string, label: string, status: string, provider: LiveMapNode['provider'] = 'unknown'): LiveMapNode =>
  ({ id, kind, level: { leader: 0, lane: 1, job: 2, computer: 3, resource: 4 }[kind], label, provider, status, detail: `${label} detail`, live: null });
const edge = (kind: LiveMapEdge['kind'], from: string, to: string, messages: number | null = null): LiveMapEdge =>
  ({ id: `${kind}:${from}->${to}`, kind, from, to, messages, lastMessageAt: messages ? '2026-11-18T00:00:00Z' : null, pulse: false });
const fleet = (): FleetLiveMap => ({ schema: 'fleet.live-map.v1', generatedAt: '2026-11-18T00:00:00Z', windowMinutes: 15, pulseSeconds: 60,
  nodes: [node('leader', 'leader', 'Leader', 'unknown'), node('lane', 'lane:claude', 'claude', 'running', 'anthropic' as never), node('lane', 'lane:grok', 'grok', 'idle'),
    node('job', 'job:one', 'RQ-ONE', 'running'), node('job', 'job:two', 'RQ-TWO', 'running'), node('job', 'job:lost', 'RQ-LOST', 'unknown'), node('computer', 'computer:a', 'node-a', 'ready')],
  edges: [edge('reports-to', 'lane:claude', 'leader'), edge('reports-to', 'lane:grok', 'leader'), edge('reports-to', 'job:one', 'lane:claude'),
    edge('reports-to', 'job:two', 'lane:claude'), edge('runs-on', 'job:one', 'computer:a'), edge('messaged-in-last-15-min', 'leader', 'lane:claude', 3)],
  counts: { lanes: 2, jobs: 3, computers: 1, resources: 0, messages: 3 },
  sources: { org: 'available', jobs: 'available', computers: 'available', resources: 'unknown', messages: 'available' }, unmappedMessages: 0, gaps: [] });

let viewport: ViewportMock | null = null;
afterEach(() => { cleanup(); viewport?.restore(); viewport = null; localStorage.clear(); });

describe('layoutByOrg', () => {
  it('places each lane with its jobs in one box, anything without a parent in "Other", and every node once', () => {
    const layout = layoutByOrg(fleet());
    expect(layout.nodes.map(n => n.id).sort()).toEqual(fleet().nodes.map(n => n.id).sort());
    expect(layout.boxes.map(box => box.label)).toEqual(['claude', 'grok', 'Other']);
    const box = (label: string) => layout.boxes.find(b => b.label === label)!;
    const inside = (id: string, b: { x: number; width: number; y: number; height: number }) => { const n = layout.at.get(id)!; return n.x > b.x && n.x < b.x + b.width && n.y > b.y && n.y < b.y + b.height; };
    expect(['lane:claude', 'job:one', 'job:two'].every(id => inside(id, box('claude')))).toBe(true);
    expect(inside('job:lost', box('Other'))).toBe(true);
    expect(layout.at.get('leader')!.y).toBeLessThan(layout.at.get('lane:claude')!.y);
    expect(layout.at.get('computer:a')!.y).toBeGreaterThan(layout.at.get('job:two')!.y);
  });
});

const agent = (name: string, node: string | null) => ({ name, role: 'unknown' as const, lane: null, node });
const said = (from: string, to: string, summary: string): MapEdge => ({ id: `${from}->${to}`, from: agent(from, from), to: agent(to, to), count: 1, lastAt: '2026-11-18T00:00:00Z', lastSummary: summary });

describe('guardian and loops in "By org"', () => {
  it('shows each planner as a line in its own box, and the latest message on a parent link only in org mode', () => {
    viewport = mockViewport(1440);
    const map = { ...fleet(), planners: [{ id: 'guardian', label: 'Main guardian', state: 'idle', doing: 'Quiet' }, { id: 'executor', label: 'Executor', state: 'running', doing: 'Active' }] };
    const { container } = render(<MapView map={map} now={Date.parse('2026-11-18T00:00:30Z')} onOpen={() => {}} edges={[said('lane:claude', 'job:one', 'ship it'), said('leader', 'lane:claude', 'go')]} />);
    expect(container.querySelector('[data-org-group]')).toBeNull();
    expect(container.querySelector('[data-link-note]')).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: 'By org' }));
    expect([...container.querySelectorAll('[data-org-group]')].map(el => el.querySelector('span')!.textContent)).toEqual(
      ['claude: 2 running', 'grok: 0 running', 'Guardian: 0 running', 'Loops: 1 running', 'Other: 0 running, 1 unknown']);
    expect([...container.querySelectorAll('[data-planner]')].map(el => el.textContent)).toEqual(['Main guardian: idle', 'Executor: running']);
    // Parent links carry the newest message either way round; a link with no message has no note.
    expect([...container.querySelectorAll('[data-link-note]')].map(el => [el.getAttribute('data-link-note'), el.textContent])).toEqual([
      ['reports-to:lane:claude->leader', '“go”'], ['reports-to:job:one->lane:claude', '“ship it”']]);
    // Messages off hides the notes.
    fireEvent.click(screen.getByRole('button', { name: 'Messages' }));
    expect(container.querySelector('[data-link-note]')).toBeNull();
  });
});

describe('the "By org" toggle', () => {
  it('starts on rows, switches to boxes with a running count, keeps lines and logos, and is remembered', () => {
    viewport = mockViewport(1440);
    const first = render(<MapView map={fleet()} now={Date.parse('2026-11-18T00:00:30Z')} onOpen={() => {}} />);
    const toggle = screen.getByRole('radiogroup', { name: 'Group' });
    expect(within(toggle).getByRole('radio', { name: 'By lane' }).getAttribute('aria-checked')).toBe('true');
    expect(first.container.querySelector('[data-org-group]')).toBeNull();
    fireEvent.click(within(toggle).getByRole('radio', { name: 'By org' }));
    const boxes = [...first.container.querySelectorAll('[data-org-group]')].map(el => el.textContent);
    expect(boxes).toEqual(['claude: 2 running', 'grok: 0 running', 'Other: 0 running, 1 unknown']);
    // Same nodes, the message line and the provider logo are still there, and the choice was stored.
    expect(screen.getAllByRole('button', { name: /^Open / })).toHaveLength(7);
    expect(first.container.querySelectorAll('path[data-kind="messaged-in-last-15-min"]')).toHaveLength(1);
    expect(screen.getByRole('button', { name: /^Open lane claude:/ }).querySelector('[data-provider-badge]')).toBeTruthy();
    expect(localStorage.getItem(MAP_LAYOUT_KEY)).toBe('org');
    first.unmount();
    const again = render(<MapView map={fleet()} now={0} onOpen={() => {}} />);
    expect(screen.getByRole('radio', { name: 'By org' }).getAttribute('aria-checked')).toBe('true');
    expect(again.container.querySelectorAll('[data-org-group]')).toHaveLength(3);
    fireEvent.click(screen.getByRole('radio', { name: 'By lane' }));
    expect(again.container.querySelector('[data-org-group]')).toBeNull();
  });
});
