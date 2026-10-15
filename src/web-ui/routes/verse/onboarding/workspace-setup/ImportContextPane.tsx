import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Button } from '../../../../components/primitives/Button.js';
import { MutationTokenDialog } from '../../../../components/auth/MutationTokenDialog.js';
import { MemoryPanel, type ReviewedMemoryDraft } from '../../context/MemoryPanel.js';
import { secretLike } from '../../context/context-model.js';
import { useTokenGate } from '../../context/use-token-gate.js';
import { insertIntoComposer } from '../../chat/composer-bridge.js';
import { previewContextImport } from '../../../../../core/verse/context-import-preview.js';
import { CONTEXT_IMPORT_FILE_BYTES, CONTEXT_IMPORT_PASTE_BYTES, CONTEXT_IMPORT_MAX_SELECTED, CONTEXT_IMPORT_SELECTED_BYTES,
  contextImportBytes, validContextImportItems, validContextImportRecord, type ContextImportPreview, type ContextImportProvider, type ContextImportRecord } from '../../../../../core/verse/context-import-types.js';
import { contextReferenceApi, referenceDraft, referenceSaveError, type ContextReferenceApi } from './context-client.js';
import { reviewedMemoryDraft } from './setup-model.js';
import styles from './workspace-setup.module.css';

const TRANSFORM_LABELS = { 'line-endings-normalized': 'Line endings normalized', 'credentials-redacted': 'Credential-like text removed',
  'private-home-paths-redacted': 'Private home paths removed', 'text-split': 'Long text split into bounded items', 'operator-edited': 'Selected text edited by the operator' } as const;
const LABELS = { chatgpt: 'ChatGPT', claude: 'Claude', grok: 'Grok', other: 'Other' } as const;
export async function readContextFile(file: File): Promise<string> {
  if (file.size > CONTEXT_IMPORT_FILE_BYTES) throw new Error('Choose a file smaller than 8 MiB. Nothing was read or truncated.');
  if (!/\.(txt|md|json)$/i.test(file.name)) throw new Error('Choose UTF-8 TXT, Markdown or a Phantom context capsule JSON. Extract ZIP archives yourself; archives are not opened here.');
  const bytes = typeof file.arrayBuffer === 'function' ? await file.arrayBuffer() : await new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader(); reader.onload = () => reader.result !== null && typeof reader.result !== 'string'
      ? resolve(reader.result) : reject(new Error('The file could not be read.'));
    reader.onerror = () => reject(new Error('The file could not be read.')); reader.readAsArrayBuffer(file);
  });
  if (bytes.byteLength !== file.size || bytes.byteLength > CONTEXT_IMPORT_FILE_BYTES) throw new Error('The file size could not be verified. Choose the file again.');
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new Error('This file is not valid UTF-8 text. Export a UTF-8 TXT, Markdown or JSON file; nothing was replaced or truncated.'); }

}
interface Props { sessionId: string | null; projectPath: string | null; api?: ContextReferenceApi }
export function ImportContextPane({ sessionId, projectPath: initialProject, api = contextReferenceApi }: Props) {
  const id = useId(); const gate = useTokenGate();
  const [provider, setProvider] = useState<ContextImportProvider>('chatgpt');
  const [text, setText] = useState(''); const [kind, setKind] = useState<'paste' | 'file'>('paste');
  const [sourceLabel, setSourceLabel] = useState('Pasted context'); const [project, setProject] = useState(initialProject ?? '');
  const [preview, setPreview] = useState<ContextImportPreview | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set()); const [edits, setEdits] = useState<Record<string, string>>({});
  const [confirmed, setConfirmed] = useState(false); const [record, setRecord] = useState<ContextImportRecord | null>(null);
  const [facts, setFacts] = useState(''); const [reviewedFacts, setReviewedFacts] = useState(''); const memoryNonce = useRef(0); const [proposal, setProposal] = useState<ReviewedMemoryDraft | null>(null);
  const [error, setError] = useState<string | null>(null); const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<'reading' | 'previewing' | 'saving' | null>(null);
  const generation = useRef(0); const alive = useRef(true); const saveAbort = useRef<AbortController | null>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; generation.current++; saveAbort.current?.abort(); }; }, []);
  const items = useMemo(() => preview?.items.filter(item => selected.has(item.id)).map(item => ({ ...item, text: edits[item.id] ?? item.text })) ?? [], [preview, selected, edits]);
  const selectedBytes = useMemo(() => items.reduce((sum, item) => sum + contextImportBytes(item.text), 0), [items]);
  const selectionValid = useMemo(() => validContextImportItems(items), [items]);
  const locked = busy !== null || proposal !== null;
  const pasteOver = kind === 'paste' && contextImportBytes(text) > CONTEXT_IMPORT_PASTE_BYTES;
  const invalidate = () => { generation.current++; setPreview(null); setSelected(new Set()); setEdits({}); setRecord(null);
    setFacts(''); setReviewedFacts(''); setProposal(null); setConfirmed(false); setError(null); setNotice(null); };
  const editSelection = () => { generation.current++; setRecord(null); setFacts(''); setReviewedFacts(''); setProposal(null); setConfirmed(false); setNotice(null); setError(null); };
  async function loadFile(file: File) {
    invalidate(); const revision = generation.current; setText(''); setBusy('reading');
    try {
      const content = await readContextFile(file);
      if (!alive.current || revision !== generation.current) return;
      setText(content); setKind('file'); setSourceLabel(file.name);
      setNotice('File read locally. Preview and select what to keep; the whole file is not uploaded.');
    } catch (failure) { if (alive.current && revision === generation.current) setError(failure instanceof Error ? failure.message : 'The file could not be read.'); }
    finally { if (alive.current && revision === generation.current) setBusy(null); }
  }
  async function makePreview() {
    invalidate(); const revision = generation.current; setBusy('previewing');
    try {
      const value = await previewContextImport({ text, kind, claimedProvider: provider, sourceLabel });
      if (alive.current && revision === generation.current) { setPreview(value); setNotice('Choose the reference items you want to keep. Nothing has been saved.'); }
    } catch (failure) { if (alive.current && revision === generation.current) setError(failure instanceof Error ? failure.message : 'This input could not be previewed.'); }
    finally { if (alive.current && revision === generation.current) setBusy(null); }
  }
  async function save() {
    if (!preview || !selectionValid || !confirmed || !project.trim() || busy) return;
    const revision = generation.current; const abort = new AbortController(); saveAbort.current = abort;
    setBusy('saving'); setError(null); setNotice(null);
    try {
      const value = await gate.run(`Save only ${items.length} selected reference items for ${project}. Imported references remain untrusted and are not automatically injected.`,
        () => api.save(project, preview, items, abort.signal));
      if (value && !validContextImportRecord(value)) throw new Error('Invalid saved reference');
      if (alive.current && revision === generation.current && !abort.signal.aborted && value) { setRecord(value); setNotice('Reference saved and verified. Nothing was added to memory or sent to an agent.'); }
    } catch (failure) { if (alive.current && revision === generation.current && !abort.signal.aborted) setError(referenceSaveError(failure)); }
    finally { if (alive.current && revision === generation.current) setBusy(null); }
  }
  function addReference() {
    if (!record || !sessionId || project !== initialProject) return;
    const draft = referenceDraft(record);
    if (contextImportBytes(draft) > 48 * 1024) { setError('This reference is larger than a chat draft. Keep fewer items in a new selection, or copy the reference for use in smaller parts. Nothing was truncated.'); return; }
    setNotice(insertIntoComposer(sessionId, draft) ? 'Reference added to the message draft. Review it before sending.' : 'Open the selected chat to add a reference to its message draft.');
  }
  async function copyReference() {
    if (!record) return; const revision = generation.current;
    try { await navigator.clipboard.writeText(referenceDraft(record)); if (alive.current && revision === generation.current) setNotice('Reference copied.'); }
    catch { if (alive.current && revision === generation.current) setError('The clipboard is unavailable. Select reference text and copy it manually.'); }
  }
  const factsBytes = contextImportBytes(facts); const factsUnsafe = secretLike(facts);
  return <div className={styles.body}>
    <p className={styles.intro}>Bring the useful parts of your history.</p>
    <p className={styles.quiet}>Choose reference documents from ChatGPT, Claude, Grok or elsewhere. Your source label is not provider verification. No provider account is contacted.</p>
    <label className={styles.field} htmlFor={`${id}-source`}>Source
      <select id={`${id}-source`} value={provider} disabled={locked} onChange={event => { invalidate(); setProvider(event.target.value as ContextImportProvider); }}>
        {Object.entries(LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select>
    </label>
    <label className={styles.field} htmlFor={`${id}-file`}>Choose a local file
      <input id={`${id}-file`} type="file" accept=".txt,.md,.json,text/plain,text/markdown,application/json" disabled={locked} onChange={event => { const file = event.target.files?.[0]; if (file) void loadFile(file); event.target.value = ''; }} />
    </label>
    <p className={styles.quiet}>Up to 8 MiB per file; TXT, Markdown or a Phantom context capsule JSON. ZIP and HTML are not opened here. JSON provides bounded text fields for review; it does not recreate native conversations, memories or account settings.</p>
    <label className={styles.field} htmlFor={`${id}-paste`}>{kind === 'file' ? `Local file: ${sourceLabel}` : 'Paste context'}
      <textarea id={`${id}-paste`} rows={6} value={text} readOnly={kind === 'file'} disabled={locked} onChange={event => { invalidate(); setKind('paste'); setSourceLabel('Pasted context'); setText(event.target.value); }} />
    </label>
    {pasteOver ? <p className={styles.error} role="alert">Pasted context exceeds 256 KiB. Choose a smaller selection or use a local file; nothing is truncated.</p> : null}
    <div className={styles.actions}><Button variant={preview ? 'subtle' : 'primary'} busy={busy === 'previewing' || busy === 'reading'} disabled={locked || !text.trim() || pasteOver} onClick={() => void makePreview()}>Preview context</Button>
      <Button disabled={locked} onClick={() => { invalidate(); setText(''); setKind('paste'); setSourceLabel('Pasted context'); }}>Clear input</Button></div>
    {preview ? <section className={styles.stage} aria-labelledby={`${id}-preview`}>
      <h3 className={styles.heading} id={`${id}-preview`}>Choose what to keep</h3>
      <p className={styles.quiet}>{preview.items.length} preview items · {items.length} selected · {selectedBytes.toLocaleString()} bytes selected</p>
      <p className={styles.quiet}>Up to {CONTEXT_IMPORT_MAX_SELECTED} items and {CONTEXT_IMPORT_SELECTED_BYTES / 1024} KiB total. Each item is limited to 4 KiB. This is selected reference material, not a complete account migration.</p>
      {preview.sanitized ? <p className={styles.quiet} role="status">The preview was transformed. Review the displayed text before selecting it.</p> : null}
      {preview.transformations.length ? <ul className={styles.quiet}>{preview.transformations.map(flag => <li key={flag}>{TRANSFORM_LABELS[flag]}</li>)}</ul> : null}
      <div className={styles.entries}>
        {preview.items.map(item => <div key={item.id} className={styles.entry}>
          <label className={styles.check}><input type="checkbox" checked={selected.has(item.id)} disabled={locked} onChange={event => { editSelection(); setSelected(current => { const next = new Set(current); if (event.target.checked) next.add(item.id); else next.delete(item.id); return next; }); }} />
            <span>{item.title}</span></label>
          <p className={styles.quiet}>{item.sourceLocator}{item.sourceRole ? ` · source role: ${item.sourceRole}` : ''}</p>
          {selected.has(item.id) ? <label className={styles.field}>Edit selected reference
            <textarea rows={4} value={edits[item.id] ?? item.text} disabled={locked} onChange={event => { editSelection(); setEdits(current => ({ ...current, [item.id]: event.target.value })); }} />
          </label> : <details><summary>Read reference</summary><pre>{item.text}</pre></details>}
        </div>)}
      </div>
      {items.length > 0 && !selectionValid ? <p className={styles.error} role="alert">The selection exceeds its count or byte limits, contains empty or unsafe text, or includes a credential-like value. Edit it or select fewer items; nothing is truncated.</p> : null}
      <label className={styles.field} htmlFor={`${id}-project`}>Project folder
        <input id={`${id}-project`} value={project} placeholder="/absolute/path/to/project" disabled={locked} onChange={event => { editSelection(); setProject(event.target.value); }} />
      </label>
      <label className={styles.check}><input type="checkbox" checked={confirmed} disabled={locked} onChange={event => setConfirmed(event.target.checked)} />
        <span>I reviewed the selected items and want to save them as untrusted references for this project.</span></label>
      <Button variant="primary" busy={busy === 'saving'} disabled={locked || !selectionValid || !confirmed || !project.trim() || record !== null} onClick={() => void save()}>Save selected reference</Button>
    </section> : null}
    {record ? <section className={styles.stage} aria-labelledby={`${id}-saved`}>
      <h3 className={styles.heading} id={`${id}-saved`}>Reference ready</h3>
      <p className={styles.quiet}>Saved separately from project memory. It grants no authority and is not automatically used by an agent.</p>
      <div className={styles.actions}><Button disabled={!sessionId || project !== initialProject} onClick={addReference}>Add reference to message</Button><Button onClick={() => void copyReference()}>Copy reference</Button></div>
      {project !== initialProject ? <p className={styles.quiet}>Open a chat in the saved project to add this reference to its draft. Copying it is a separate, explicit action.</p> : null}
      <details><summary>Saved reference text</summary><pre className={styles.quiet} style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{referenceDraft(record)}</pre></details>
      <h3 className={styles.heading}>Keep a few durable facts</h3>
      <p className={styles.quiet}>Write useful facts in your own words. Raw imported messages are never copied into project memory. This opens an editable draft; Save in the memory editor is a separate action.</p>
      <label className={styles.field} htmlFor={`${id}-facts`}>Facts I have rewritten and reviewed
        <textarea id={`${id}-facts`} rows={4} value={facts} onChange={event => setFacts(event.target.value)} />
      </label>
      {factsBytes > 16 * 1024 || factsUnsafe ? <p className={styles.error} role="alert">Use up to 16 KiB of facts and remove credential-like text before reviewing the memory draft.</p> : null}
      <Button disabled={!facts.trim() || factsBytes > 16 * 1024 || factsUnsafe !== null || proposal !== null && facts === reviewedFacts} onClick={() => { setReviewedFacts(facts); setProposal({ projectPath: project, nonce: ++memoryNonce.current, text: reviewedMemoryDraft(`${LABELS[provider]} · ${record.id}`, facts) }); }}>Review memory draft</Button>
      {proposal ? <><p className={styles.quiet}>Input and project scope stay fixed while this editor is open. Save or cancel your edit before closing the editor.</p><MemoryPanel projectPath={project} reviewedDraft={proposal} /><Button onClick={() => setProposal(null)}>Close memory editor</Button></> : null}
    </section> : null}
    {busy === 'reading' ? <p className={styles.status} role="status">Reading the local file…</p> : null}
    {notice ? <p className={styles.status} role="status">{notice}</p> : null}
    {error ? <p className={styles.error} role="alert">{error}</p> : null}
    <MutationTokenDialog {...gate.dialog} />
  </div>;
}
