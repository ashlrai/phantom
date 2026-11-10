/**
 * routes/verse/fleet-steer/SteerPane.tsx — the desktop steer surface:
 * the #945 roster for context, a steer note to the leaders' inbox, a
 * reprioritize picker for unclaimed queue lines, and a two-click job
 * stop. All three actions post through the one wb mutation door
 * (POST /api/wb/v1/action) with the held mutation token and a fresh
 * nonce each — never a second capability.
 */
import { useEffect, useMemo, useState } from 'react';
import { Button, SkeletonLine, Tag } from '../../../components/primitives/index.js';
import { ApiError } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { rosterSections } from '../../../data/agent-roster.js';
import { steerQuery } from './steer-queries.js';
import {
  reprioritizable, stoppable, STEER_PRIORITIES, type SteerQueueLine, type SteerSnapshot,
} from './steer-model.js';
import {
  actionFailureText, actionOutcomeText, isSteerPriority, noteProblem,
  postWbSteerAction, STOP_CONFIRM_MS, stopConfirmLabel, type WbActionBody,
} from './steer-action.js';
import styles from './fleet-steer.module.css';

type SendState = { busy: boolean; text: string };

function AgentRow({ agent }: { agent: { id: string; name: string; poolLabel: string | null; claims: readonly { task: string | null }[] } }) {
  const claim = agent.claims[0]?.task ?? null;
  return (
    <li className={styles.agent} aria-label={`Agent ${agent.name}`}>
      <span className={styles.agentName}>{agent.name}</span>
      {agent.poolLabel && <Tag size="sm">{agent.poolLabel}</Tag>}
      {agent.claims.length > 0 && <Tag size="sm">{agent.claims.length} claim{agent.claims.length === 1 ? '' : 's'}</Tag>}
      {claim && <span className={styles.agentTask}>{claim}</span>}
    </li>
  );
}

function QueueOption({ line }: { line: SteerQueueLine }) {
  return <option value={line.id}>{line.id} · {line.status} · {line.priority}</option>;
}

function NoteBox({ onSent }: { onSent: () => void }) {
  const [text, setText] = useState('');
  const [send, setSend] = useState<SendState>({ busy: false, text: '' });
  const problem = noteProblem(text);
  const press = async () => {
    if (send.busy || problem !== null) return;
    setSend({ busy: true, text: '' });
    const body: WbActionBody = { action: 'steer.note', text };
    try {
      const result = await postWbSteerAction(body);
      setSend({ busy: false, text: actionOutcomeText(body, result) });
      setText('');
      onSent();
    } catch (error) {
      setSend({ busy: false, text: actionFailureText(error) });
    }
  };
  return (
    <fieldset className={styles.block}>
      <legend>Steer note</legend>
      <textarea
        className={styles.note}
        aria-label="Steer note"
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder="Tell the leaders what to do next."
        rows={3}
      />
      <div className={styles.row}>
        <Button size="sm" disabled={send.busy || problem !== null} onClick={() => void press()}>Send note</Button>
        <span role="status" aria-live="polite" className={styles.status}>{send.text}</span>
      </div>
    </fieldset>
  );
}

function ReprioritizeBox({ queue, onSent }: { queue: readonly SteerQueueLine[]; onSent: () => void }) {
  const options = useMemo(() => reprioritizable(queue), [queue]);
  const [job, setJob] = useState('');
  const [priority, setPriority] = useState('');
  const [send, setSend] = useState<SendState>({ busy: false, text: '' });
  useEffect(() => { if (job !== '' && !options.some((line) => line.id === job)) setJob(''); }, [options, job]);
  const valid = job !== '' && isSteerPriority(priority);
  const press = async () => {
    if (send.busy || !valid) return;
    setSend({ busy: true, text: '' });
    const body: WbActionBody = { action: 'queue.reprioritize', job, priority };
    try {
      const result = await postWbSteerAction(body);
      setSend({ busy: false, text: actionOutcomeText(body, result) });
      onSent();
    } catch (error) {
      setSend({ busy: false, text: actionFailureText(error) });
    }
  };
  return (
    <fieldset className={styles.block}>
      <legend>Reprioritize a queue line</legend>
      <div className={styles.row}>
        <label className={styles.field}>Job
          <select aria-label="Queue line" value={job} onChange={(event) => setJob(event.target.value)}>
            <option value="">Select a line</option>
            {options.map((line) => <QueueOption key={line.id} line={line} />)}
          </select>
        </label>
        <label className={styles.field}>Priority
          <select aria-label="New priority" value={priority} onChange={(event) => setPriority(event.target.value)}>
            <option value="">Priority</option>
            {STEER_PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </label>
        <Button size="sm" disabled={send.busy || !valid} onClick={() => void press()}>Reprioritize</Button>
        <span role="status" aria-live="polite" className={styles.status}>{send.text}</span>
      </div>
      {options.length === 0 && <p className={styles.hint}>No unclaimed queue lines.</p>}
    </fieldset>
  );
}

function StopBox({ queue, onSent }: { queue: readonly SteerQueueLine[]; onSent: () => void }) {
  const options = useMemo(() => stoppable(queue), [queue]);
  const [job, setJob] = useState('');
  const [send, setSend] = useState<SendState>({ busy: false, text: '' });
  const [armedAt, setArmedAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1_000); return () => clearInterval(t); }, []);
  useEffect(() => { setArmedAt(null); }, [job]);
  useEffect(() => { if (job !== '' && !options.some((line) => line.id === job)) { setJob(''); setArmedAt(null); } }, [options, job]);
  const armed = armedAt !== null && now - armedAt < STOP_CONFIRM_MS;
  const press = async () => {
    if (send.busy || job === '') return;
    if (!armed) { setArmedAt(Date.now()); setSend((prev) => ({ ...prev, text: '' })); return; }
    setArmedAt(null);
    setSend({ busy: true, text: '' });
    const body: WbActionBody = { action: 'job.stop', job };
    try {
      const result = await postWbSteerAction(body);
      setSend({ busy: false, text: actionOutcomeText(body, result) });
      onSent();
    } catch (error) {
      setSend({ busy: false, text: actionFailureText(error) });
    }
  };
  return (
    <fieldset className={styles.block}>
      <legend>Stop a job</legend>
      <div className={styles.row}>
        <label className={styles.field}>Job
          <select aria-label="Job to stop" value={job} onChange={(event) => setJob(event.target.value)}>
            <option value="">Select a job</option>
            {options.map((line) => <QueueOption key={line.id} line={line} />)}
          </select>
        </label>
        <Button size="sm" variant="subtle" aria-label={job === '' ? 'Stop this job' : `Stop ${job}`} disabled={send.busy || job === ''} onClick={() => void press()}>
          {stopConfirmLabel(job, armed)}
        </Button>
        <span role="status" aria-live="polite" className={styles.status}>{send.text}</span>
      </div>
      {options.length === 0 && <p className={styles.hint}>No live jobs to stop.</p>}
    </fieldset>
  );
}

function sourceNote(snapshot: SteerSnapshot): string | null {
  if (snapshot.fleetState !== 'ok') return 'The fleet roster is unavailable; the queue and actions still work.';
  if (snapshot.queueState !== 'ok') return 'The queue is unavailable; reprioritize and stop pickers are read-only.';
  if (snapshot.seatsState !== 'ok') return 'Seat detail is unavailable; the roster shows fleet agents only.';
  return null;
}

export function SteerPane({ visible }: PaneProps) {
  const read = useQuery(steerQuery, { enabled: visible, freshMs: 0 });
  const refetch = useRefetch(steerQuery);
  usePollWhileVisible(refetch, 15_000, { enabled: visible });
  const snapshot = read.data;
  const sections = useMemo(() => (snapshot?.roster ? rosterSections(snapshot.roster.agents) : []), [snapshot]);
  const missing = read.data === null || (read.error instanceof ApiError && read.error.status === 404);
  if (missing) return <p className={styles.message}>Workbench steer is not in this build.</p>;
  if (snapshot === undefined) {
    return (
      <div className={styles.root} role="status">
        {read.status === 'error' ? 'The workbench steer read is unavailable.' : <><span>Reading the roster…</span><SkeletonLine /><SkeletonLine /></>}
      </div>
    );
  }
  const note = sourceNote(snapshot);
  return (
    <section className={styles.root} aria-label="Steer">
      {note && <p className={styles.notice} role="status">{note}</p>}
      {read.status === 'error' && <p className={styles.notice} role="status">The roster could not refresh. Showing the last reading.</p>}
      {sections.length === 0
        ? <p className={styles.message}>{snapshot.fleetState === 'ok' ? 'No agents on the roster.' : 'Roster unavailable.'}</p>
        : (
          <ul className={styles.roster} aria-label="Agent roster">
            {sections.map((section) => (
              <li key={section.title}>
                <h2 className={styles.sectionTitle}>{section.title}</h2>
                <ul>
                  {section.agents.map((agent) => <AgentRow key={agent.id} agent={agent} />)}
                </ul>
              </li>
            ))}
          </ul>
        )}
      <NoteBox onSent={refetch} />
      <ReprioritizeBox queue={snapshot.queue} onSent={refetch} />
      <StopBox queue={snapshot.queue} onSent={refetch} />
    </section>
  );
}
