import type { ComputeNode } from '../../../../core/fleet/compute-view.js';
import type { FleetSessionMap } from '../../../../core/fleet/sessions-view.js';
import { fresh } from './compute-model.js';
import styles from './compute.module.css';

type Group = { y: number; label: string; count: number };
type Link = { from: Group; to: Group; count: number; uncertain: boolean };

function group(groups: Map<string | null, Group>, key: string | null, label: string): Group {
  const existing = groups.get(key);
  if (existing) return existing;
  const entry = { y: 46 + groups.size * 32, label, count: 0 };
  groups.set(key, entry);
  return entry;
}

const WIDTH = 800;
const BOX = 190;
const plural = (count: number) => `${count} running agent${count === 1 ? '' : 's'}`;

function DrawLink({ link, x, end }: { link: Link; x: number; end: number }) {
  const middle = (x + end) / 2;
  return <path className={styles.flowLink}
    d={`M ${x} ${link.from.y} C ${middle} ${link.from.y}, ${middle} ${link.to.y}, ${end} ${link.to.y}`}
    strokeWidth={2 + Math.log2(link.count) * 2} strokeDasharray={link.uncertain ? '5 4' : undefined}
    data-running-count={link.count}>
    <title>{link.from.label} → {link.to.label}: {plural(link.count)}{link.uncertain ? ' (stale or unknown)' : ''}</title>
  </path>;
}

function DrawNode({ entry, x, label }: { entry: Group; x: number; label: string }) {
  return <g className={styles.flowNode}>
    <title>{entry.label} · {plural(entry.count)}</title>
    <rect x={x} y={entry.y - 12} width={BOX} height={24} rx={5} />
    <text x={x + 9} y={entry.y} dominantBaseline="central">{label.length > 25 ? `${label.slice(0, 24)}…` : label}</text>
  </g>;
}

export function ComputeFlow({ nodes, snapshot, now }: { nodes: ComputeNode[]; snapshot?: FleetSessionMap; now: number }) {
  const machines = new Map<string | null, Group>(), lanes = new Map<string | null, Group>();
  const machineLinks = new Map<Group, Map<Group, Link>>();
  const agentLinks: Link[] = [];
  const inventory = new Map(nodes.map(node => [node.id, node]));
  const sessionsFresh = snapshot?.sourceState === 'healthy' && fresh(Date.parse(snapshot.generatedAt), now);
  const placementsFresh = sessionsFresh && fresh(Date.parse(snapshot.computeAt), now);
  for (const session of snapshot?.mapSessions ?? []) {
    if (session.mapState !== 'running') continue;
    const node = session.nodeId === null ? undefined : inventory.get(session.nodeId);
    const machine = group(machines, session.nodeId, node?.id ?? session.nodeId ?? 'Machine unknown');
    const lane = group(lanes, session.lane, session.lane ?? 'Lane unknown');
    machine.count += 1;
    lane.count += 1;
    const laneUncertain = !sessionsFresh || session.lane === null;
    const placementUncertain = !placementsFresh || !node || node.state === 'offline'
      || (!fresh(node.heartbeatAt, now) && !fresh(node.stats?.sampledAtMs, now))
      || session.placement === 'unknown' || session.placement === 'conflict';
    const from = machineLinks.get(machine) ?? new Map<Group, Link>();
    machineLinks.set(machine, from);
    const link = from.get(lane) ?? { from: machine, to: lane, count: 0, uncertain: false };
    link.count += 1;
    link.uncertain ||= placementUncertain || laneUncertain;
    from.set(lane, link);
    agentLinks.push({ from: lane, to: { label: session.job, count: 1, y: 46 + agentLinks.length * 32 },
      count: 1, uncertain: laneUncertain });
  }
  const x = [12, (WIDTH - BOX) / 2, WIDTH - BOX - 12] as const;
  return <figure className={styles.flow}>
    <figcaption><strong>Compute → lanes → running agents</strong></figcaption>
    {!agentLinks.length ? <p>{sessionsFresh && !snapshot.truncated ? 'No running agents recorded.' : 'Running agent placement is unavailable.'}</p> : <>
      <div className={styles.flowViewport}>
        <svg viewBox={`0 0 ${WIDTH} ${44 + agentLinks.length * 32}`} role="img" aria-label="Running agent flow">
          <desc>Machines supply lanes, which connect to running agents. Wider links carry more agents. Dashed links have stale or unknown evidence.</desc>
          {['Machines', 'Lanes', 'Agents'].map((label, index) => <text key={label} x={x[index]} y={19} className={styles.flowHeading}>{label}</text>)}
          {[...machineLinks.values()].flatMap((byLane, i) => [...byLane.values()].map((link, j) =>
            <DrawLink key={`${i}:${j}`} link={link} x={x[0] + BOX} end={x[1]} />))}
          {agentLinks.map(link => <DrawLink key={link.to.label} link={link} x={x[1] + BOX} end={x[2]} />)}
          {[...machines.values()].map(entry => <DrawNode key={entry.y} entry={entry} x={x[0]} label={`${entry.label} · ${entry.count}`} />)}
          {[...lanes.values()].map(entry => <DrawNode key={entry.y} entry={entry} x={x[1]} label={`${entry.label} · ${entry.count}`} />)}
          {agentLinks.map(({ to }) => <DrawNode key={to.label} entry={to} x={x[2]} label={`Job · ${to.label}`} />)}
        </svg>
      </div>
      <small>Link width shows running count. Dashed links are stale or unknown.</small>
    </>}
  </figure>;
}
