import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { getQuerySnapshot, refetchQuery } from '../../../data/cache.js';
import { ApiError, readFailureReason } from '../../../data/client.js';
import { useMutationHold, useQuery } from '../../../data/hooks.js';
import type { LaneTargetsV1 } from '../ops/lane-targets-model.js';
import { laneTargetsQuery, postLaneTarget } from '../ops/lane-targets-queries.js';
import { opsRunsQuery } from '../ops/ops-runs-queries.js';
import { nextTarget, stepperState } from './lane-target-stepper-model.js';
import styles from './fleet-lanes.module.css';

// All steppers in the pane share the write lock, including before React re-renders.
let writing = false;
const listeners = new Set<() => void>();
function subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
function setWriting(value: boolean) { writing = value; listeners.forEach(listener => listener()); }

export function LaneTargetStepper({ lane }: { lane: string }) {
  const read = useQuery(laneTargetsQuery);
  const hold = useMutationHold();
  const pending = useSyncExternalStore(subscribe, () => writing, () => false);
  const [posted, setPosted] = useState<LaneTargetsV1 | null>(null);
  const [confirm, setConfirm] = useState<{ lane: string; until: number } | null>(null);
  const [status, setStatus] = useState('');
  const active = useRef(true);
  const row = (posted ?? read.data)?.lanes.find(item => item.lane === lane);
  // The pane already observes runs; read its shared snapshot without another request.
  const fallback = getQuerySnapshot<Awaited<ReturnType<typeof opsRunsQuery.fetch>>>(opsRunsQuery.key).data?.lanes.find(item => item.lane === lane)?.target;
  const state = stepperState({ row, pending, confirm, hasHold: hold.hasHold, now: Date.now() });
  const title = read.data === null ? 'Lane targets are not in this build'
    : !hold.hasHold ? 'Unlock the mutation hold to change lane targets.'
      : pending ? 'A lane target change is in progress.' : !row ? 'Lane target is unavailable.' : undefined;

  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => {
    if (!confirm) return;
    const timer = setTimeout(() => setConfirm(null), Math.max(0, confirm.until - Date.now()));
    return () => clearTimeout(timer);
  }, [confirm]);

  async function change(delta: -1 | 1): Promise<void> {
    if (!row || writing || (delta === -1 ? state.lowerDisabled : state.raiseDisabled)) return;
    const target = nextTarget(row.target, delta);
    if (target === 0 && (!confirm || confirm.lane !== lane || Date.now() >= confirm.until)) {
      setConfirm({ lane, until: Date.now() + 5_000 });
      return;
    }
    setConfirm(null);
    setWriting(true);
    setStatus('');
    try {
      const response = await postLaneTarget(lane, target);
      if (active.current) { setPosted(response); setStatus('Saved'); }
      await Promise.all([
        refetchQuery(laneTargetsQuery.key, () => laneTargetsQuery.fetch(), true),
        refetchQuery(opsRunsQuery.key, () => opsRunsQuery.fetch(), true),
      ]);
      if (active.current && getQuerySnapshot(laneTargetsQuery.key).status === 'success') setPosted(null);
    } catch (reason) {
      const message = reason instanceof ApiError && reason.status === 409
        ? 'Another fleet control action is running, try again in a moment.' : readFailureReason(reason);
      if (active.current) setStatus(message);
    } finally { setWriting(false); }
  }

  return <span className={styles.stepper} title={title}>
    <button type="button" aria-label={`Lower ${lane} target`} title={title} disabled={state.lowerDisabled} onClick={() => void change(-1)}>−</button>
    <span>{row?.target ?? (read.data === null ? fallback : '—')}</span>
    <button type="button" aria-label={`Raise ${lane} target`} title={title} disabled={state.raiseDisabled} onClick={() => void change(1)}>+</button>
    {state.caption ? <span>{state.caption}</span> : null}
    {status ? <span role="status">{status}</span> : null}
  </span>;
}
