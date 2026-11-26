import { useId, useState, type ReactNode } from 'react';
import type { FleetReplicaSource } from '../../../../core/fleet/fleet-replica.js';
import type { FleetLiveSnapshotV1 } from '../../../../core/fleet/fleet-types.js';
import type { FleetOrgTree } from '../../../../core/fleet/org-tree.js';
import { useQuery } from '../../../data/hooks.js';
import { runQuery } from '../../../data/cache.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { fleetOrgMapQuery } from './org-map-query.js';
import styles from './fleet-machine-scope.module.css';

export function FleetSourceBadge({ source, now, localMachine }: { source?: FleetReplicaSource; now: number; localMachine?: string }) {
  const machine = source?.machine ?? localMachine ?? 'Unknown machine';
  const asOf = Date.parse(source?.asOf ?? '');
  const age = Number.isFinite(asOf) ? Math.max(0, Math.floor((now - asOf) / 1000)) : source?.ageSeconds ?? null;
  const initials = machine.split(/[ ._-]+/).filter(Boolean).slice(0, 2).map(part => part[0]?.toUpperCase()).join('');
  return <span className={styles.badge} data-stale={source?.stale || undefined}>
    <span className={styles.initials} aria-hidden="true">{initials}</span>
    <span>{machine} · {source?.via === 'leader-replica' ? 'leader replica' : source?.via === 'local' || localMachine ? 'local' : 'source unknown'}
      {' · '}{age === null ? 'age unknown' : age < 60 ? `${age}s ago` : `${Math.floor(age / 60)}m ago`}
      {source?.stale ? ` · Stale: ${source.reason ?? 'no fresh observation'}` : null}</span>
  </span>;
}

export function FleetSourced({ children, ...badge }: Parameters<typeof FleetSourceBadge>[0] & { children: ReactNode }) {
  return <div className={styles.sourced}><FleetSourceBadge {...badge} />{children}</div>;
}

export function useFleetMachineScope(live: FleetLiveSnapshotV1 | null) {
  const org = useQuery(fleetOrgMapQuery);
  usePollWhileVisible(() => { void runQuery(fleetOrgMapQuery.key, () => fleetOrgMapQuery.fetch()); }, 5_000);
  const tree = org.data?.tree;
  const [selected, select] = useState('');
  const machine = selected || null;
  const origin = live?.source?.machine ?? tree?.source?.machine ?? null;
  const scopedLive = !live || !machine ? live : {
    ...live,
    lanes: live.lanes.filter(lane => (lane.machine ?? origin) === machine),
    runs: origin === machine ? live.runs : [],
  };
  return { machine, select, tree, scopedLive };
}

type Scope = ReturnType<typeof useFleetMachineScope>;
export function FleetMachineScope({ scope, live, now }: { scope: Scope; live: FleetLiveSnapshotV1 | null; now: number }) {
  const id = useId();
  const { machine, select, tree } = scope;
  const source = tree?.source ?? live?.source;
  const machines = new Set<string>();
  if (source?.machine) machines.add(source.machine);
  for (const peer of tree?.peerSources ?? []) if (peer.machine) machines.add(peer.machine);
  for (const lane of [...tree?.lanes ?? [], ...live?.lanes ?? []]) if (lane.machine) machines.add(lane.machine);
  if (machine) machines.add(machine);
  const lanes = tree?.lanes.filter(lane => !machine || (lane.machine ?? source?.machine) === machine) ?? [];
  if (!machine && machines.size === 0) return null;
  return <section aria-label="Fleet machines" className={styles.scope}>
    <label htmlFor={id}>Fleet machine</label>
    <select id={id} value={machine ?? ''} onChange={event => select(event.target.value)}>
      <option value="">All machines</option>
      {[...machines].sort().map(name => <option key={name}>{name}</option>)}
    </select>
    <FleetSourceBadge source={sourceForMachine(tree, source, machine)} now={now} />
    {source?.stale || lanes.length === 0
      ? <p role="status">{source?.reason ?? 'No lane observations reported for this selection.'}</p>
      : <ul aria-label="Machine lanes" className={styles.lanes}>{lanes.map(lane => <li key={`${lane.machine ?? source?.machine}:${lane.lane}`}>
        <strong>{lane.lane}</strong> <FleetSourceBadge source={lane.source ?? source} now={now} />
        <p>{lane.running === null ? 'Running count unknown' : `${lane.running} running`} · {lane.doing}</p>
        {lane.jobs.length > 0 ? <ul aria-label={`${lane.lane} agents`}>{lane.jobs.map(job => <li key={job.id}>{job.goal ?? job.id} · {job.doing}</li>)}</ul>
          : lane.source || !tree?.jobsKnown ? <p>Individual agents not reported.</p> : null}
      </li>)}</ul>}
  </section>;
}

function sourceForMachine(tree: FleetOrgTree | undefined, source: FleetReplicaSource | undefined, machine: string | null): FleetReplicaSource | undefined {
  if (!machine || machine === source?.machine) return source;
  return tree?.peerSources?.find(peer => peer.machine === machine) ??
    tree?.lanes.find(lane => lane.machine === machine && lane.source)?.source ??
    { machine, via: 'leader-replica', asOf: null, ageSeconds: null, stale: true, reason: source?.reason ?? 'no fresh machine observation' };
}
