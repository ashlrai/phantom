import { useEffect, useMemo, useRef } from 'react';
import type { ComputeNode } from '../../../../core/fleet/compute-view.js';
import type { MapSession } from '../../../../core/fleet/sessions-view.js';
import { messageLineWidth } from '../../../../core/fleet/live-map.js';
import type { FleetOrgMap } from '../../../../core/fleet/org-map.js';
import { providerFor, type Provider } from '../../../../core/fleet/provider.js';
import { ProviderBadge } from '../../../components/primitives/ProviderBadge.js';
import { AGENT_COLORS, buildScene, makeFrame, pickAgent, project, UNKNOWN_COLOR } from './scene3d-model.js';
import styles from './compute.module.css';

interface Props {
  nodes: ComputeNode[]; jobs: MapSession[]; now: number; heat: boolean;
  orgMap?: FleetOrgMap | null;
  yaw: number; tilt: number; zoom: number; selection: string | null;
  onSelect: (job: string) => void; onOrbit: (yaw: number, tilt: number) => void;
}
const HEIGHT = 460;

/** Canvas twin of ProviderBadge: the provider's letter on a disc in its colour ("?" on gray when unknown). */
function drawBadge(ctx: CanvasRenderingContext2D, provider: Provider, x: number, y: number) {
  ctx.beginPath(); ctx.arc(x, y, 6, 0, 6.2832); ctx.fillStyle = provider.color; ctx.fill();
  ctx.font = 'bold 8px sans-serif'; ctx.fillStyle = '#fff'; ctx.fillText(provider.letter, x, y + 3); ctx.font = '11px sans-serif';
}

/** Message connections from the shared org map, each with its sender's provider badge. Shown under both the 2D and 3D maps. */
export function OrgMessages({ orgMap }: { orgMap: FleetOrgMap | null }) {
  const labels = new Map(orgMap?.nodes.map(n => [n.id, n.label]));
  const messages = orgMap?.edges.filter(edge => edge.kind === 'message') ?? [];
  return <section aria-label="Org map messages"><h3>Agent messages</h3>
    {orgMap?.sources.messages !== 'available' ? <p>Agent messages unknown.</p> : <>
      <p>Last {orgMap.messageWindowMinutes} minutes · retained live messages</p>
      {messages.length ? <ul>{messages.map(edge => <li key={edge.id}><ProviderBadge of={edge.provider} iconOnly /> {labels.get(edge.from) ?? 'unknown'} → {labels.get(edge.to) ?? 'unknown'} · {edge.count ?? 'unknown'} messages</li>)}</ul> : <p>No mapped messages in this window.</p>}
      {orgMap.unmappedMessages !== 0 && <p>Messages without a mapped endpoint: {orgMap.unmappedMessages ?? 'unknown'}</p>}
    </>}
  </section>;
}

/**
 * Canvas-2D projected 3D scene (no WebGL, no dependency). Draws on demand (data/camera change), reuses
 * preallocated buffers, and the text machine list stays the keyboard/assistive path to every agent.
 */
export function ComputeScene3D({ nodes, jobs, orgMap, now, heat, yaw, tilt, zoom, selection, onSelect, onOrbit }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const scene = useMemo(() => buildScene(nodes, jobs, now, heat), [nodes, jobs, now, heat]);
  const frame = useMemo(() => makeFrame(scene), [scene]);
  const orgJobs = useMemo(() => new Map(orgMap?.nodes.filter(n => n.kind === 'job' && n.jobId).map(n => [n.jobId, n])), [orgMap]);
  const selectedOrg = selection === null ? undefined : orgJobs.get(selection);
  // Only job-to-job messages have two placed ends to join; the rest stay in the list below the scene.
  const links = useMemo(() => (orgMap?.edges ?? []).filter(edge => edge.kind === 'message').map(edge => ({
    from: scene.agents.findIndex(a => a.job && `job:${a.job}` === edge.from), to: scene.agents.findIndex(a => a.job && `job:${a.job}` === edge.to), provider: providerFor(edge.provider), width: messageLineWidth(edge.count),
  })).filter(link => link.from >= 0 && link.to >= 0), [orgMap, scene]);
  const drag = useRef<{ x: number; y: number; yaw: number; tilt: number; moved: boolean } | null>(null);
  const state = useRef({ yaw, tilt, zoom, selection });
  state.current = { yaw, tilt, zoom, selection };

  useEffect(() => {
    const el = canvas.current;
    const ctx = el?.getContext?.('2d') ?? null;
    if (!el || !ctx) return;
    let raf = 0;
    const draw = () => {
      raf = 0;
      const w = el.clientWidth || 640, dpr = globalThis.devicePixelRatio || 1;
      if (el.width !== Math.round(w * dpr) || el.height !== Math.round(HEIGHT * dpr)) { el.width = Math.round(w * dpr); el.height = Math.round(HEIGHT * dpr); }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, HEIGHT);
      const s = state.current;
      project(scene, frame, w, HEIGHT, s.yaw, s.tilt, s.zoom);
      ctx.font = '11px sans-serif'; ctx.textAlign = 'center'; ctx.lineWidth = 1;
      for (const i of frame.order) {
        const n = scene.nodes[i]!, c = n.corners;
        ctx.globalAlpha = n.dim ? 0.45 : 1;
        ctx.beginPath(); ctx.moveTo(frame.sx[c]!, frame.sy[c]!);
        for (let k = 1; k < 4; k++) ctx.lineTo(frame.sx[c + k]!, frame.sy[c + k]!);
        ctx.closePath(); ctx.fillStyle = n.color; ctx.globalAlpha *= 0.55; ctx.fill();
        ctx.globalAlpha = n.dim ? 0.45 : 1; ctx.strokeStyle = n.color; ctx.stroke();
        ctx.fillStyle = '#c9d1d9'; ctx.fillText(n.label, frame.sx[n.center]!, frame.sy[n.corners + 2]! + 14);
        for (const a of scene.agents) {
          if (a.node !== i) continue;
          const bx = frame.sx[a.base]!, by = frame.sy[a.base]!, tx = frame.sx[a.top]!, ty = frame.sy[a.top]!;
          if (a.kind === 'more') { ctx.fillStyle = '#c9d1d9'; ctx.fillText(a.label, tx, ty); continue; }
          ctx.strokeStyle = AGENT_COLORS[a.kind] ?? UNKNOWN_COLOR;
          ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(tx, ty); ctx.stroke();
          ctx.beginPath(); ctx.arc(tx, ty, a.job === s.selection ? 7 : 5, 0, 6.2832); ctx.fillStyle = AGENT_COLORS[a.kind] ?? UNKNOWN_COLOR; ctx.fill();
          if (a.job === s.selection) { ctx.strokeStyle = '#fff'; ctx.stroke(); }
          drawBadge(ctx, a.provider, tx, ty - 13);
          if (a.job === s.selection) { ctx.fillStyle = '#c9d1d9'; ctx.fillText(`${orgJobs.get(a.job)?.label ?? a.job} · ${a.provider.name}`, tx, ty - 24); }
        }
      }
      ctx.globalAlpha = 1;
      for (const link of links) {
        const from = scene.agents[link.from]!, to = scene.agents[link.to]!;
        const x1 = frame.sx[from.top]!, y1 = frame.sy[from.top]!, x2 = frame.sx[to.top]!, y2 = frame.sy[to.top]!;
        ctx.strokeStyle = link.provider.color; ctx.lineWidth = link.width; ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); ctx.lineWidth = 1;
        drawBadge(ctx, link.provider, (x1 + x2) / 2, (y1 + y2) / 2);
      }
    };
    const schedule = () => { if (!raf) raf = requestAnimationFrame(draw); };
    schedule();
    el.addEventListener('redraw', schedule);
    window.addEventListener('resize', schedule);
    return () => { cancelAnimationFrame(raf); el.removeEventListener('redraw', schedule); window.removeEventListener('resize', schedule); };
  }, [scene, frame, orgJobs, links]);
  useEffect(() => { canvas.current?.dispatchEvent(new Event('redraw')); }, [yaw, tilt, zoom, selection]);

  const local = (e: { clientX: number; clientY: number }) => {
    const r = canvas.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  return <figure className={styles.scene3d}>
    <canvas ref={canvas} height={HEIGHT} role="img" data-testid="scene3d" style={{ height: HEIGHT }}
      aria-label={`3D fleet map: ${scene.nodes.length} nodes, ${scene.shown} agents shown${scene.overflow ? `, ${scene.overflow} more aggregated` : ''}. Use the machine list for details.`}
      onPointerDown={e => { drag.current = { x: e.clientX, y: e.clientY, yaw, tilt, moved: false }; }}
      onPointerMove={e => {
        const d = drag.current; if (!d) return;
        const dx = e.clientX - d.x, dy = e.clientY - d.y;
        if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
        if (d.moved) onOrbit(Math.max(-65, Math.min(65, d.yaw + dx * 0.4)), Math.max(-35, Math.min(35, d.tilt + dy * 0.2)));
      }}
      onPointerUp={e => {
        const d = drag.current; drag.current = null;
        if (d?.moved) return;
        const p = local(e), hit = pickAgent(scene, frame, p.x, p.y);
        if (hit) onSelect(hit.job);
      }}
      onPointerLeave={() => { drag.current = null; }} />
    <figcaption>
      {scene.nodes.length} nodes · {scene.shown} agents shown{scene.overflow ? ` · +${scene.overflow} more aggregated` : ''}
      {' '}· Heat = 1-min load ÷ 2×CPU ceiling; gray = unknown. Each agent and message line carries its provider's letter; “?” = provider unknown.
      {!orgMap && <p>Org map unknown.</p>}
      {selection && <p><ProviderBadge of={selectedOrg?.provider} iconOnly /> {selectedOrg?.label ?? selection} · Provider: {selectedOrg?.provider ?? 'unknown'} · Org status: {selectedOrg?.status ?? 'unknown'}</p>}
      <OrgMessages orgMap={orgMap ?? null} />
    </figcaption>
  </figure>;
}
