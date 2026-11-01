import { useId, useRef, useState, type ChangeEvent } from 'react';
import { Button } from '../../../components/primitives/Button.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { useAgentWorkspace } from './agent-workspace.js';
import { MAX_RECORDING_BYTES, parseReplayJson, replayFromEvents, seekReplay, type ReplayResult } from './replay-model.js';
import styles from './ReplayPane.module.css';

export function ReplayPane(props: PaneProps) {
  const enabled = useAgentWorkspace();
  // The boundary also protects tabs restored from a saved layout.
  return enabled ? <ReplaySession key={props.sessionId ?? 'local'} {...props} /> : null;
}

function ReplaySession({ events }: PaneProps) {
  const [result, setResult] = useState<ReplayResult>(() => replayFromEvents(events));
  const [position, setPosition] = useState(0);
  const [loading, setLoading] = useState(false);
  const request = useRef(0);
  const fileId = useId();
  const sliderId = useId();
  const recording = result.ok ? result.recording : null;
  const revealed = recording ? seekReplay(recording, position) : [];
  const step = revealed.at(-1);
  const count = recording?.steps.length ?? 0;

  const replace = (next: ReplayResult) => { setResult(next); setPosition(0); };
  const openFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file) return;
    const current = ++request.current;
    setLoading(true);
    // Remove the old run immediately: failed imports cannot leave stale success visible.
    replace({ ok: false, error: 'Opening recording…' });
    try {
      const next = file.size > MAX_RECORDING_BYTES
        ? { ok: false as const, error: 'Choose a complete, valid run recording (up to 2 MB).' }
        : parseReplayJson(await file.text());
      if (current === request.current) replace(next);
    } catch {
      if (current === request.current) replace({ ok: false, error: 'Could not read this recording. Choose a local JSON file.' });
    } finally {
      if (current === request.current) setLoading(false);
    }
  };

  return <section className={styles.pane} aria-label="Run replay">
    <header className={styles.header}>
      <h2>Run replay</h2>
      <p>Review a finished run, one recorded step at a time.</p>
      <div className={styles.sources}>
        <Button size="sm" disabled={loading} onClick={() => { ++request.current; replace(replayFromEvents(events)); }}>Use latest finished run</Button>
        <label className={styles.fileLabel} htmlFor={fileId}>Open recording</label>
        <input className={styles.fileInput} id={fileId} type="file" accept=".json,application/json" aria-label="Open recording" disabled={loading} onChange={(e) => { void openFile(e); }} />
      </div>
    </header>
    {recording ? <>
      <div className={styles.transport}>
        <strong className={styles.title}>{recording.title}</strong>
        <div className={styles.buttons}>
          <Button size="sm" onClick={() => setPosition(0)} disabled={position === 0}>Restart</Button>
          <Button size="sm" onClick={() => setPosition((p) => Math.max(0, p - 1))} disabled={position === 0}>Previous</Button>
          <Button size="sm" variant="primary" onClick={() => setPosition((p) => Math.min(count, p + 1))} disabled={position >= count}>Next step</Button>
        </div>
        <label htmlFor={sliderId}>Step {position} of {count}</label>
        <input id={sliderId} type="range" min={0} max={count} step={1} value={position} onChange={(e) => setPosition(Number(e.target.value))} aria-label="Replay position" aria-valuetext={`Step ${position} of ${count}`} />
      </div>
      <div className={styles.stage}>
        <p role="status" className={styles.status}>{step ? `${step.label} · ${step.at}` : 'Ready. Choose Next step to begin.'}</p>
        {step ? <article className={styles.entry} aria-label={step.label} data-kind={step.kind}>
          <h3>{step.label}</h3>
          {step.text ? <pre>{step.text}</pre> : <p>{step.label === 'Run completed' ? 'End of recording.' : 'No additional text was recorded.'}</p>}
        </article> : null}
        {revealed.length > 0 ? <ol className={styles.timeline} aria-label="Revealed steps">
          {revealed.map((entry, index) => <li key={entry.seq}>
            <button type="button" aria-current={index === position - 1 ? 'step' : undefined} onClick={() => setPosition(index + 1)}>
              <span>{index + 1}</span>{entry.label}
            </button>
          </li>)}
        </ol> : null}
      </div>
    </> : <p className={styles.empty} role="status">{result.ok ? '' : result.error}</p>}
    <footer className={styles.footer}>Recorded data only. Commands and changes are never executed.</footer>
  </section>;
}
