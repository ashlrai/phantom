import type { Station } from './release-path-model.js';
import styles from './fleet-releases.module.css';

/**
 * A repo's way out, drawn left to right: unreleased commits, the release PR,
 * the release run, the published tag. Each mark's colour repeats what the
 * words under it say, and an unknown station is a hollow ring.
 */
export function ReleasePath({ repo, stations }: { repo: string; stations: readonly Station[] }) {
  return <div role="group" aria-label={`${repo} release path`}>
    <dl className={styles.path}>{stations.map(station => <div key={station.id} className={styles.station} data-tone={station.tone}>
      <dt>{station.label}</dt>
      <dd><span className={styles.stationValue}>{station.value}</span>{station.detail ? <span className={styles.stationDetail}>{station.detail}</span> : null}</dd>
    </div>)}</dl>
  </div>;
}
