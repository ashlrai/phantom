import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { CosTaskCard } from './CosTaskCard.js';
import { isCosRouteAbsent } from './cos-task-client.js';
import { readCosTaskList, type CosTaskListRow } from './cos-task-list-client.js';
import styles from './cos-task-list.module.css';

const CHANNELS: Record<string, string> = { telegram: 'Telegram', email: 'Email', desktop: 'Desktop', cli: 'CLI', phone: 'Phone', page: 'Page' };
function stateLabel(task: CosTaskListRow): string {
  if (task.needsYou) return 'Needs your approval';
  if (task.delivery === 'sent') return 'Sent';
  if (task.delivery === 'uncertain') return 'Delivery uncertain';
  if (task.delivery === 'sending') return 'Sending';
  switch (task.jobStatus) {
    case 'BLOCKED': return 'Blocked';
    case 'CLAIMED': case 'RUNNING': return 'Working';
    case 'READY': case 'QUEUED': return 'Queued';
    case 'DONE': return 'Done';
    default: return task.jobStatus;
  }
}

export function CosTaskList() {
  const [tasks, setTasks] = useState<CosTaskListRow[]>([]);
  const [result, setResult] = useState<'ready' | 'absent' | 'error'>('ready');
  const [selected, setSelected] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const id = useId();
  const refetch = useCallback(async () => {
    if (controller.current) return;
    const request = new AbortController();
    controller.current = request;
    try {
      const rows = await readCosTaskList(request.signal);
      if (!request.signal.aborted) { setTasks(rows); setResult('ready'); }
    } catch (error) {
      if (!request.signal.aborted) setResult(isCosRouteAbsent(error) ? 'absent' : 'error');
    } finally {
      if (controller.current === request) controller.current = null;
    }
  }, []);
  useEffect(() => {
    void refetch();
    return () => { controller.current?.abort(); controller.current = null; };
  }, [refetch]);
  usePollWhileVisible(() => { void refetch(); }, 30_000);
  if (result === 'absent') return null;
  if (result === 'error') return <p className={styles.muted}>Tasks are unavailable right now</p>;
  if (!tasks.length) return null;
  // The server supplies newest first; stable sorting preserves recency within each group.
  const ordered = [...tasks].sort((a, b) => Number(b.needsYou) - Number(a.needsYou));
  const count = tasks.filter(task => task.needsYou).length;
  return <section className={styles.panel} aria-labelledby={`${id}-title`}>
    <h2 id={`${id}-title`}>Tasks{count ? ` · ${count} need you` : ''}</h2>
    <ul className={styles.list}>{ordered.map(task => <li key={task.id}>
      <button type="button" className={styles.row} aria-expanded={selected === task.id} aria-controls={`${id}-card`}
        onClick={() => setSelected(current => current === task.id ? null : task.id)}>
        <span className={styles.preview}>{task.request || '(no preview)'}</span>
        <span className={styles.muted}>{CHANNELS[task.channel.toLowerCase()] ?? task.channel}</span>
        <span className={styles.muted}>{stateLabel(task)}</span>
      </button>
    </li>)}</ul>
    <div id={`${id}-card`}>{selected ? <CosTaskCard key={selected} id={selected} /> : null}</div>
  </section>;
}
