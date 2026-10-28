/**
 * routes/fleet-dashboard/QueueStationGraph.tsx: live station graph
 * (RQ-QUEUE-5). Plain SVG, one node per station (11, flow order) colored by
 * rho band (grey when rho is n/a), with queue length; the bottleneck gets a thick outline. Renders
 * nothing unless the `agentWorkspace` flag is on.
 */
import { useEffect, useState } from 'react';
import { isAgentWorkspaceEnabled } from '../../data/agent-workspace-flag.js';
import {
  QUEUE_STATIONS,
  RHO_COLORS,
  STATION_LABELS,
  rhoBand,
  selectBottleneck,
  type QueueStatsV1,
} from '../../data/queue-stats/schema.js';
import { fixtureQueueStatsSource, type QueueStatsSource } from '../../data/queue-stats/source.js';

const NODE_W = 96;
const NODE_H = 56;
const GAP = 24;

export interface QueueStationGraphProps {
  source?: QueueStatsSource;
  refreshMs?: number;
  /** Override for tests; defaults to the local agentWorkspace gate. */
  enabled?: boolean;
}

export function QueueStationGraph({ source, refreshMs = 15_000, enabled }: QueueStationGraphProps) {
  const on = enabled ?? isAgentWorkspaceEnabled();
  const [src] = useState(() => source ?? fixtureQueueStatsSource());
  const [stats, setStats] = useState<QueueStatsV1 | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!on) return;
    let alive = true;
    const tick = async () => {
      const r = await src.load();
      if (!alive) return;
      if (r.ok) {
        setStats(r.value);
        setError(null);
      } else {
        setError(r.error);
      }
    };
    void tick();
    const id = setInterval(() => void tick(), refreshMs);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [on, src, refreshMs]);

  if (!on) return null;
  if (error && !stats) {
    return (
      <section aria-label="Queue station graph" role="alert">
        Queue stats unavailable: {error}
      </section>
    );
  }
  if (!stats) return <section aria-label="Queue station graph">Loading queue stats</section>;
  const shown = QUEUE_STATIONS.filter((id) => stats.stations[id]);
  if (shown.length === 0) {
    return <section aria-label="Queue station graph">No queue activity in this window.</section>;
  }

  const bottleneck = selectBottleneck(stats.stations);
  const width = shown.length * (NODE_W + GAP);

  return (
    <section aria-label="Queue station graph">
      <h2>Queue stations</h2>
      <p>
        Bottleneck: <strong data-testid="queue-bottleneck">{bottleneck ? STATION_LABELS[bottleneck] : 'none'}</strong>
        {stats.little.drift ? <span data-testid="little-drift"> (Little's law drift)</span> : null}
      </p>
      <svg role="img" aria-label="Station graph" viewBox={`0 0 ${width} ${NODE_H + 20}`} width="100%">
        {shown.map((name, i) => {
          const s = stats.stations[name]!;
          const rhoText = s.rho === null ? 'n/a' : s.rho.toFixed(2);
          const qText = s.L === null ? '?' : String(Math.round(s.L * 10) / 10);
          const band = rhoBand(s.rho);
          const x = i * (NODE_W + GAP) + GAP / 2;
          const isB = name === bottleneck;
          return (
            <g key={name} data-testid={`station-${name}`} data-band={band} data-bottleneck={isB ? 'true' : 'false'}>
              {i > 0 ? <line x1={x - GAP} y1={10 + NODE_H / 2} x2={x} y2={10 + NODE_H / 2} stroke="#888" /> : null}
              <rect
                x={x}
                y={10}
                width={NODE_W}
                height={NODE_H}
                rx={8}
                fill={RHO_COLORS[band]}
                stroke={isB ? '#111' : 'none'}
                strokeWidth={isB ? 4 : 0}
              />
              <title>{`${STATION_LABELS[name]}: rho ${rhoText}, L ${qText}, W ${s.W_h === null ? '?' : `${Math.round(s.W_h * 60)}m`}, ${s.status}`}</title>
              <text x={x + NODE_W / 2} y={32} textAnchor="middle" fontSize={12} fill="#fff">
                {STATION_LABELS[name]}
              </text>
              <text x={x + NODE_W / 2} y={50} textAnchor="middle" fontSize={11} fill="#fff">
                {`rho ${rhoText} q ${qText}`}
              </text>
            </g>
          );
        })}
      </svg>
    </section>
  );
}
