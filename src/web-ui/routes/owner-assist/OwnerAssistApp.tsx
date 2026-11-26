import { useEffect, useRef, useState } from 'react';
import { Button } from '../../components/primitives/Button.js';
import { DesktopSessionRecovery, SessionGate } from '../../components/auth/SessionGate.js';
import { MutationTokenDialog } from '../../components/auth/MutationTokenDialog.js';
import { adoptInjectedTokens, isDesktopSession, markCheckComplete, refreshDesktopSession } from '../../data/auth-store.js';
import { useAuthPhase } from '../../data/hooks.js';
import { ApiError } from '../../data/client.js';
import { pickDirectory } from '../verse/folder-picker.js';
import { agentToolsApi } from '../verse/agent-tools/agent-tools-client.js';
import { buildTranscript } from '../verse/verse-transcript.js';
import type { OwnerAssistDetail, OwnerAssistSnapshot, OwnerAssistTurn } from '../../../core/owner-assist/types.js';
import type { OwnerAssistHandoffReceipt } from '../../../core/owner-assist/types.js';
import { ownerAssistApi } from './client.js';
import '../../design/global.css';
import styles from './owner-assist.module.css';

type Mode = 'pill' | 'chat' | 'fullscreen';
declare global { interface Window { __ASHLR_OWNER_WINDOW__?: (mode: Mode | 'hide') => Promise<void> } }

export function OwnerAssistApp() {
  const phase = useAuthPhase();
  useEffect(() => {
    let live = true;
    const adopt = () => { void adoptInjectedTokens().then(ok => {
      if (!live || ok) return;
      if (isDesktopSession()) markCheckComplete(false);
      else void ownerAssistApi.snapshot().then(() => { if (live) markCheckComplete(true); }, () => { if (live) markCheckComplete(false); });
    }); };
    const restart = () => { void refreshDesktopSession(); };
    adopt();
    window.addEventListener('ashlr:sidecar-restarted', restart);
    return () => {
      live = false;
      window.removeEventListener('ashlr:sidecar-restarted', restart);
    };
  }, []);
  if (phase === 'checking') return <p role="status">Connecting Owner Assist…</p>;
  if (phase !== 'authenticated' && isDesktopSession()) return <DesktopSessionRecovery />;
  if (phase !== 'authenticated') return <SessionGate heading="Connect Owner Assist" subject="Owner Assist" command="phm verse" mutationField />;
  return <OwnerAssistPanel />;
}

const DRAFT_KEY = 'ashlr.owner-assist.draft';

export function OwnerAssistPanel({ api = ownerAssistApi }: { api?: typeof ownerAssistApi }) {
  const [snapshot, setSnapshot] = useState<OwnerAssistSnapshot | null>(null);
  const [detail, setDetail] = useState<OwnerAssistDetail | null>(null);
  const [sessionId, setSessionId] = useState('');
  const [project, setProject] = useState('');
  const [folders, setFolders] = useState<string[]>([]);
  const [text, setText] = useState(() => { try { return localStorage.getItem(DRAFT_KEY) ?? ''; } catch { return ''; } });
  /** The unsent draft survives app restarts alongside the resumed session. */
  const setDraft = (value: string | ((current: string) => string)) => setText(current => {
    const next = typeof value === 'function' ? value(current) : value;
    try { if (next) localStorage.setItem(DRAFT_KEY, next); else localStorage.removeItem(DRAFT_KEY); }
    catch { /* optional local continuity */ }
    return next;
  });
  const [selection, setSelection] = useState('auto');
  const [tier, setTier] = useState<OwnerAssistTurn['tier']>('work');
  const [mode, setMode] = useState<Mode>('chat');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [settings, setSettings] = useState(false);
  const [unlock, setUnlock] = useState(false);
  const [omlxPort, setOmlxPort] = useState(8000);
  const [callsign, setCallsign] = useState('Phantom');
  const [memory, setMemory] = useState('');
  const [handoff, setHandoff] = useState(false);
  const [repo, setRepo] = useState('ashlrai/phantom');
  const [acceptance, setAcceptance] = useState('');
  const [jobs, setJobs] = useState<OwnerAssistHandoffReceipt[]>([]);
  const handoffId = useRef(`RQ-OWNER-${crypto.randomUUID()}`);
  const initialized = useRef(false);
  const end = useRef<HTMLDivElement>(null);
  const failure = (e: unknown) => setError(e instanceof ApiError ? e.detail ?? e.message : e instanceof Error ? e.message : 'Request failed.');
  async function action(work: () => Promise<unknown>) {
    setBusy(true); setError('');
    try { await work(); } catch (e) { failure(e); } finally { setBusy(false); }
  }
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const next = await api.snapshot(controller.signal);
        if (controller.signal.aborted) return;
        setSnapshot(next);
        if (!initialized.current) {
          initialized.current = true;
          setCallsign(next.preferences.callsign); setMemory(next.memory); setSelection(next.preferences.preference);
          setOmlxPort(next.preferences.omlxPort ?? 8000);
          const recent = next.sessions.find(s => s.id === next.resumeSessionId) ?? next.sessions[0];
          if (recent) { setSessionId(recent.id); setProject(recent.projectPath); setFolders(recent.extraRoots ?? []); }
        }
        setJobs(await api.handoffs(controller.signal));
      } catch (e) { if (!controller.signal.aborted) failure(e); }
      if (!controller.signal.aborted) timer = setTimeout(() => { void refresh(); }, 10000);
    };
    void refresh();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [api]);
  useEffect(() => {
    if (!sessionId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const next = await api.detail(sessionId, controller.signal);
        if (!controller.signal.aborted) setDetail(next);
      } catch (e) { if (!controller.signal.aborted) failure(e); }
      if (!controller.signal.aborted) timer = setTimeout(() => { void refresh(); }, 800);
    };
    void refresh();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [api, sessionId]);
  useEffect(() => {
    const update = (e: Event) => { const mode = (e as CustomEvent).detail; if (['pill', 'chat', 'fullscreen'].includes(mode)) setMode(mode); };
    window.addEventListener('ashlr:owner-mode', update);
    return () => window.removeEventListener('ashlr:owner-mode', update);
  }, []);
  useEffect(() => { end.current?.scrollIntoView?.({ block: 'end' }); }, [detail?.events.length, detail?.pending.length]);
  async function changeMode(next: Mode) {
    if (window.__ASHLR_OWNER_WINDOW__) await window.__ASHLR_OWNER_WINDOW__(next);
    else setMode(next);
  }
  const running = detail?.session.status === 'running' || snapshot?.sessions.some(s => s.id !== detail?.session.id && s.status === 'running');
  const routing = detail ? snapshot?.routing?.[detail.session.id] : undefined;
  const transcript = buildTranscript(detail?.events ?? []);
  return <main className={styles.panel} data-mode={mode}>
    <header className={styles.header} data-app-region="drag">
      <span aria-hidden="true" className={styles.dot} />
      <strong>{callsign}</strong><small>{running ? 'Working' : 'Owner Assist'}</small>
      <div data-app-region="no-drag">
        {mode === 'pill' ? <Button onClick={() => void action(() => changeMode('chat'))}>Open</Button> : <>
          <Button aria-label="Collapse" onClick={() => void action(() => changeMode('pill'))}>−</Button>
          <Button aria-label={mode === 'fullscreen' ? 'Restore window' : 'Fullscreen'} onClick={() => void action(() => changeMode(mode === 'fullscreen' ? 'chat' : 'fullscreen'))}>↗</Button>
        </>}
      </div>
    </header>
    {mode !== 'pill' && <>
      <div className={styles.toolbar}>
        <Button onClick={() => void action(async () => { const p = await pickDirectory(); if (p) { setProject(p); setSessionId(''); setDetail(null); setFolders([]); } })}>Open project</Button>
        <Button onClick={() => { if (!settings && snapshot) setMemory(snapshot.memory); setSettings(!settings); }}>Memory & identity</Button>
        <Button onClick={() => { setHandoff(!handoff); }}>Hand off to fleet</Button>
        <Button onClick={() => { setSessionId(''); setDetail(null); }}>New chat</Button>
        <Button onClick={() => setUnlock(true)}>Unlock actions</Button>
      </div>
      <label className={styles.field}>Project folder<input value={project} placeholder="/absolute/path/to/project" onChange={e => setProject(e.target.value)} /></label>
      <label className={styles.field}>Conversation<select value={sessionId} onChange={e => {
        setSessionId(e.target.value); setDetail(null);
        const session = snapshot?.sessions.find(s => s.id === e.target.value);
        if (session) { setProject(session.projectPath); setFolders(session.extraRoots ?? []); }
      }}><option value="">New conversation</option>{snapshot?.sessions.map(s => <option key={s.id} value={s.id}>{s.title} · {s.model}</option>)}</select></label>
      {settings && <section className={styles.sheet} aria-label="Memory and identity">
        <label>Callsign<input value={callsign} maxLength={60} onChange={e => setCallsign(e.target.value)} /></label>
        <label>Local oMLX port<input type="number" min={1} max={65535} value={omlxPort} onChange={e => setOmlxPort(Number(e.target.value))} /></label>
        {snapshot?.memorySanitized && <p>Some memory content was redacted or home paths shortened. Secrets cannot be saved back as placeholders.</p>}
        <label>Decisions, projects and preferences<textarea value={memory} maxLength={24000} onChange={e => setMemory(e.target.value)} /></label>
        <Button disabled={busy} onClick={() => void action(async () => {
          await api.configure({ callsign, preference: ['local', 'api'].includes(selection) ? selection as 'local' | 'api' : 'auto', omlxPort });
          await api.remember(memory); setSettings(false);
        })}>Save memory</Button>
      </section>}
      {handoff && <section className={styles.sheet} aria-label="Fleet handoff">
        <p>Submit the message to the fleet. Its intake currently supports ashlrai/phantom. Progress and the recorded PR appear here.</p>
        <label>Repository<input value={repo} placeholder="owner/repository" onChange={e => setRepo(e.target.value)} /></label>
        <label>Acceptance criteria<input value={acceptance} onChange={e => setAcceptance(e.target.value)} /></label>
        <Button disabled={busy || !text.trim() || !repo || !acceptance} onClick={() => void action(async () => {
          const job = await api.handoff({ id: handoffId.current, repo, scope: text, acceptance, tier, ...(sessionId ? { sessionId } : {}) });
          setJobs(current => [...current.filter(j => j.id !== job.id), job]); handoffId.current = `RQ-OWNER-${crypto.randomUUID()}`;
          setDraft(''); setHandoff(false);
        })}>Enqueue fleet task</Button>
      </section>}
      {error && <p role="alert" className={styles.error}>{error}</p>}
      <div className={styles.transcript} role="log" aria-label="Conversation">
        {!detail && <p className={styles.empty}>Your projects, one conversation.<br />Choose a folder and ask me to build, fix, or explore.</p>}
        {detail && <p className={styles.model}>Answering with {detail.session.model} · {detail.session.engine}{routing ? ` · ${routing.reason}` : ''} · personal session</p>}
        {transcript.items.map(item => <article key={item.key} data-kind={item.kind}>
          {item.kind === 'user' || item.kind === 'assistant' ? <><small>{item.kind === 'user' ? 'You' : callsign}</small><p>{item.text}</p></>
            : item.kind === 'tool' ? <details><summary>{item.name}</summary><pre>{JSON.stringify(item.input, null, 2)}</pre><pre>{item.result?.output}</pre></details>
              : item.kind === 'error' ? <p role="alert">{item.message}</p> : null}
        </article>)}
        {detail?.pending.map(pending => <section className={styles.approval} key={pending.id} aria-label="Tool approval">
          <strong>Approve command</strong><pre>{pending.command}</pre><p>{pending.reason}</p>
          <Button disabled={busy} onClick={() => void action(() => agentToolsApi.confirm(detail.session.id, pending.id, 'once'))}>Allow once</Button>
          <Button disabled={busy} onClick={() => void action(() => agentToolsApi.confirm(detail.session.id, pending.id, 'deny'))}>Deny</Button>
        </section>)}
        {jobs.map(job => <p key={job.id} title={job.fleetJobId}>Fleet: {job.scope.slice(0, 70)} · {job.status}{job.sourceTitle ? ` · from ${job.sourceTitle.slice(0, 50)}` : ''} {job.prUrl && /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/.test(job.prUrl) && <a href={job.prUrl} target="_blank" rel="noreferrer">View PR</a>}</p>)}
        <div ref={end} />
      </div>
      <form className={styles.composer} onSubmit={e => { e.preventDefault(); void action(async () => {
        const chosen = selection.startsWith('[') ? JSON.parse(selection) as [string, string] : null;
        const result = await api.send({ text, projectPath: project, extraRoots: folders, tier,
          ...(sessionId ? { sessionId } : {}), ...(chosen ? { seatId: chosen[0], model: chosen[1] } : { preference: selection as 'auto' | 'local' | 'api' }) });
        setSessionId(result.session.id); setDetail({ session: result.session, events: [], pending: [] }); setDraft('');
        setDetail(await api.detail(result.session.id));
        setSnapshot(await api.snapshot());
      }); }}>
        <div className={styles.toolbar}>
          <label>Model<select value={selection} onChange={e => setSelection(e.target.value)}>
            <option value="auto">Auto</option><option value="local">Local only</option><option value="api">API / subscription</option>
            {snapshot?.seats.flatMap(s => s.models.map(m => <option disabled={!!m.unavailableReason || s.health.state === 'unavailable'} key={`${s.id}/${m.id}`} value={JSON.stringify([s.id, m.id])}>{s.label} · {m.label ?? m.id}</option>))}
          </select></label>
          <label>Task<select value={tier} onChange={e => setTier(e.target.value as OwnerAssistTurn['tier'])}><option value="fast">Quick</option><option value="work">Build / iterate</option><option value="frontier">Hard / architecture</option></select></label>
        </div>
        <textarea aria-label="Message" value={text} maxLength={24000} placeholder="What are we working on?" onChange={e => setDraft(e.target.value)} />
        {folders.map(folder => <button type="button" key={folder} onClick={() => setFolders(folders.filter(f => f !== folder))}>{folder} ×</button>)}
        <div className={styles.toolbar}>
          <Button type="button" disabled={folders.length >= 7} onClick={() => void action(async () => { const p = await pickDirectory(); if (p) setFolders([...new Set([...folders, p])]); })}>Attach folder</Button>
          <label className={styles.file}>Attach text file<input type="file" onChange={e => { const file = e.target.files?.[0]; if (file) void action(async () => {
            if (file.size > 12000) throw new Error('Attach a text file under 12 KB, or attach its folder.');
            const content = await file.text();
            if (content.includes('\0')) throw new Error('Use a text file or attach its folder.');
            setDraft(current => `${current}\n\nAttached file ${file.name} (untrusted context):\n${content}`);
          }); e.target.value = ''; }} /></label>
          {running ? <Button type="button" disabled={busy} onClick={() => void action(() => api.cancel(detail?.session.status === 'running' ? detail.session.id : snapshot!.sessions.find(s => s.status === 'running')!.id))}>Stop</Button>
            : <Button type="submit" disabled={busy || !text.trim() || !project.trim()}>Send</Button>}
        </div>
      </form>
      <MutationTokenDialog open={unlock} onClose={() => setUnlock(false)} reason="Unlock Owner Assist actions." tokenHelp="the mutation token phm verse printed" />
    </>}
  </main>;
}
