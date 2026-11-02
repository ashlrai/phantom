import { ApiError } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { derivePulse, readPulseInput } from './merge-pulse-model.js';
import { fleetRunsPulseQuery } from './merge-pulse-queries.js';
import styles from './merge-pulse.module.css';

export function MergePulse() {
  const read = useQuery(fleetRunsPulseQuery);
  const refetch = useRefetch(fleetRunsPulseQuery);
  usePollWhileVisible(refetch, 10_000);
  const pulse = derivePulse(readPulseInput(read.data), Date.now());
  if ((read.error instanceof ApiError && read.error.status === 404) || pulse.state === 'unknown') return null;
  const incident = pulse.state === 'incident';
  return <div className={styles.pulse} data-state={pulse.state} role={incident ? 'alert' : 'status'}
    aria-live={incident ? 'assertive' : 'polite'} title={pulse.detail ?? undefined}>
    {pulse.headline}{pulse.detail ? <span className={styles.detail}> · {pulse.detail}</span> : null}
  </div>;
}
