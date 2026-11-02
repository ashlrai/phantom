import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, within } from '@testing-library/dom';
import { FleetNodeMap } from './fleet-node-map.js';
import { fleetFixture } from './fixture.js';
import { parseFleetGraphSeed } from '../../src/core/graph/registry.js';

afterEach(() => document.body.replaceChildren());
function mount() {
  const map = new FleetNodeMap();
  map.graph = fleetFixture;
  document.body.append(map);
  return { map, ui: within(map.shadowRoot! as unknown as HTMLElement) };
}
describe('fleet node map', () => {
  it('renders the fleet.v1 fixture, bindings and distinct type/status colors', () => {
    expect(parseFleetGraphSeed(fleetFixture)).toEqual(fleetFixture);
    const { map, ui } = mount();
    const producer = ui.getByRole('button', { name: 'producer, agent, active' });
    const reviewer = ui.getByRole('button', { name: 'reviewer, agent, idle' });
    const mcp = ui.getByRole('button', { name: 'locus, mcp, offline' });
    expect(ui.getAllByRole('button')).toHaveLength(3);
    expect(map.shadowRoot!.querySelectorAll('line')).toHaveLength(2);
    expect(producer.style.backgroundColor).toBe(reviewer.style.backgroundColor);
    expect(producer.style.backgroundColor).not.toBe(mcp.style.backgroundColor);
    expect(new Set([producer, reviewer, mcp].map(b => b.style.borderColor)).size).toBe(3);
  });
  it('emits a bubbling select event with node identity and updates selection', () => {
    const { map, ui } = mount();
    const select = vi.fn();
    document.body.addEventListener('select', select, { once: true });
    const node = ui.getByRole('button', { name: 'producer, agent, active' });
    fireEvent.click(node);
    expect(select).toHaveBeenCalledTimes(1);
    expect(select.mock.calls[0][0].detail).toEqual({ id: 'agent:producer', label: 'producer', type: 'agent', status: 'active' });
    expect(node.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(ui.getByRole('button', { name: 'locus, mcp, offline' }));
    expect(node.getAttribute('aria-pressed')).toBe('false');
    expect(map.shadowRoot!.querySelectorAll('[aria-pressed=true]')).toHaveLength(1);
  });
  it('rotates projected geometry and handles unknown status and empty snapshots', () => {
    const { map, ui } = mount();
    const before = ui.getAllByRole('button')[0].style.left;
    const slider = ui.getByRole('slider');
    fireEvent.input(slider, { target: { value: '90' } });
    expect(ui.getByRole('slider')).toBe(slider);
    expect(ui.getAllByRole('button')[0].style.left).not.toBe(before);
    map.statuses = {};
    expect(ui.getByRole('button', { name: 'producer, agent, unknown' })).toBeTruthy();
    map.graph = { schema: 'fleet.v1', agents: [], mcp: [], edges: [] };
    expect(ui.queryAllByRole('button')).toHaveLength(0);
    expect(ui.getByText('No fleet nodes in this snapshot.')).toBeTruthy();
  });
});
