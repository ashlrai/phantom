import type { FleetGraphSeed } from '../../src/core/graph/types.js';
import { fleetFixture, fixtureStatuses } from './fixture.js';
import type { FleetStatus } from './fixture.js';

export interface FleetMapNode { id: string; label: string; type: 'agent' | 'mcp'; status: FleetStatus }
const typeColors = { agent: '#8ab4ff', mcp: '#d9a5ff' };
const statusColors = { active: '#5de4ad', idle: '#ffd580', offline: '#ff8095', unknown: '#a0a8b8' };
const svgNS = 'http://www.w3.org/2000/svg';

/** Standalone, local-only fleet.v1 viewer. select.detail is the selected FleetMapNode. */
export class FleetNodeMap extends HTMLElement {
  private seed = fleetFixture;
  private telemetry = fixtureStatuses;
  private yaw = 25;
  private selected: string | undefined;
  private root = this.attachShadow({ mode: 'open' });

  set graph(value: FleetGraphSeed) { this.seed = value; this.selected = undefined; this.render(); }
  set statuses(value: Record<string, FleetStatus>) { this.telemetry = value; this.render(); }
  connectedCallback(): void { this.render(); }

  private render(): void {
    if (!this.root.childElementCount) this.root.innerHTML = `<style>
      :host{display:block;color:#e8edf7;background:#101725;border-radius:16px;padding:20px;font:14px system-ui}
      .scene{position:relative;height:360px;overflow:hidden;background:radial-gradient(ellipse,#243651,transparent 70%)}
      svg{position:absolute;width:100%;height:100%;pointer-events:none}
      button{position:absolute;translate:-50% -50%;border:3px solid;border-radius:50%;width:80px;height:80px;
        color:#101725;cursor:pointer;font:600 12px system-ui;box-shadow:inset -10px -12px 20px #0005;overflow-wrap:anywhere}
      button[aria-pressed=true],button:focus-visible{outline:3px solid white;outline-offset:5px}
      label{display:flex;align-items:center;gap:12px} input{flex:1} p{color:#bec9dc}
    </style><strong>Fleet node map · fixture</strong><p>Fill: agent (blue), MCP (purple). Ring: active (green), idle (amber), offline (red), unknown (gray).</p>
      <div class="scene" role="group" aria-label="Fleet nodes"><svg viewBox="0 0 600 360" preserveAspectRatio="none" aria-hidden="true"></svg></div>
      <label>Rotate view <input aria-label="Rotate view" type="range" min="-180" max="180"></label>`;
    const scene = this.root.querySelector<HTMLElement>('.scene')!;
    const svg = this.root.querySelector('svg')!;
    scene.replaceChildren(svg);
    svg.replaceChildren();
    const nodes: FleetMapNode[] = [
      ...this.seed.agents.map(a => ({ id: `agent:${a.id}`, label: a.id, type: 'agent' as const })),
      ...this.seed.mcp.map(m => ({ id: `mcp:${m.id}`, label: m.id, type: 'mcp' as const })),
    ].map(n => ({ ...n, status: this.telemetry[n.id] ?? 'unknown' }));
    const angle = this.yaw * Math.PI / 180;
    const positions = new Map(nodes.map((node, index) => {
      const theta = index * Math.PI * 2 / nodes.length;
      const x = Math.cos(theta) * 180, z = Math.sin(theta) * 180;
      const depth = x * Math.sin(angle) + z * Math.cos(angle);
      const scale = 650 / (650 + depth);
      return [node.id, { x: 300 + (x * Math.cos(angle) - z * Math.sin(angle)) * scale,
        y: 180 + (node.type === 'agent' ? -55 : 80) * scale, scale, depth }];
    }));
    const edges = [
      ...this.seed.edges.map(e => ({ from: `agent:${e.from}`, to: `agent:${e.to}` })),
      ...this.seed.agents.flatMap(a => (a.mcpIds ?? []).map(id => ({ from: `agent:${a.id}`, to: `mcp:${id}` }))),
    ];
    for (const edge of edges) {
      const from = positions.get(edge.from), to = positions.get(edge.to);
      if (!from || !to) continue;
      const line = document.createElementNS(svgNS, 'line');
      for (const [key, value] of Object.entries({ x1: from.x, y1: from.y, x2: to.x, y2: to.y, stroke: '#647899', 'stroke-width': 2 })) {
        line.setAttribute(key, String(value));
      }
      svg.append(line);
    }
    for (const node of nodes) {
      const point = positions.get(node.id)!;
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = node.label;
      button.setAttribute('aria-label', `${node.label}, ${node.type}, ${node.status}`);
      button.setAttribute('aria-pressed', String(this.selected === node.id));
      Object.assign(button.style, { left: `${point.x / 6}%`, top: `${point.y / 3.6}%`,
        transform: `scale(${point.scale})`, zIndex: String(Math.round(500 - point.depth)),
        backgroundColor: typeColors[node.type], borderColor: statusColors[node.status] });
      button.addEventListener('click', () => {
        this.selected = node.id;
        scene.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b === button)));
        this.dispatchEvent(new CustomEvent<FleetMapNode>('select', { detail: node, bubbles: true, composed: true }));
      });
      scene.append(button);
    }
    if (!nodes.length) scene.append('No fleet nodes in this snapshot.');
    const rotation = this.root.querySelector('input')!;
    rotation.value = String(this.yaw);
    rotation.oninput = () => {
      this.yaw = Number(rotation.value);
      this.render();
    };
  }
}

if (!customElements.get('fleet-node-map')) customElements.define('fleet-node-map', FleetNodeMap);
