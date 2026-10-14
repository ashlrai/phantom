import type { CompanionCandidate } from '../../../../core/proactive/planning.js';
import type { CompanionTask, CompanionCommand, CompanionTaskInput } from '../../../../core/proactive/coordination-types.js';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import type { ProactiveAvatar, ProactiveProfile, ProactiveProfileInput, ProactiveProvider, ProactiveService } from '../../../../core/proactive/types.js';
import { MutationTokenDialog } from '../../../components/auth/MutationTokenDialog.js';
import { Button } from '../../../components/primitives/Button.js';
import { Dialog } from '../../../components/primitives/Dialog.js';
import { Input } from '../../../components/primitives/Input.js';
import { Select } from '../../../components/primitives/Select.js';
import { Switch } from '../../../components/primitives/Switch.js';
import { ApiError, readFailureReason } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { describeContextError, useTokenGate } from '../context/use-token-gate.js';
import { VerseMark } from '../rail-icons.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { createProactiveProfile, deleteProactiveProfile, editProactiveProfile, proactiveProfilesQuery, coordinationQuery, recordCoordination, prepareCoordinationPacket } from './proactive-queries.js';
import styles from './ProactiveAgents.module.css';
import { PlanningLab } from './PlanningLab.js';

const GrokBotHandoff = lazy(() => import('./GrokBotHandoff.js').then(module => ({ default: module.GrokBotHandoff })));

const PROVIDERS: Record<ProactiveProvider, string> = { 'openai-dot': 'OpenAI Dot', 'grok-bot': 'Grok Bot', 'meta-muse': 'Meta Muse', other: 'Other agent' };
const OPERATION_LABEL = { dispatch: 'Send work', status: 'Read status', cancel: 'Cancel work', result: 'Read results' };
function SetupHelp({ provider }: { provider: ProactiveProvider }) {
  const link = provider === 'openai-dot' ? { href: 'https://developers.openai.com/plugins/build/mcp-events', label: 'OpenAI plugin events setup' }
    : provider === 'grok-bot' ? { href: 'https://cursor.com/help/grok-bot/routines', label: 'Grok Bot routine setup' }
      : provider === 'meta-muse' ? { href: 'https://ai.meta.com/muse/', label: 'Meta Muse product guide' } : null;
  const guidance = provider === 'openai-dot' ? 'A supported connection needs an authenticated HTTPS plugin and event subscription. Phantom has not commissioned that connection yet.'
    : provider === 'grok-bot' ? 'An existing routine needs an account-bound connection and independent result evidence. Phantom has not commissioned that connection yet.'
      : provider === 'meta-muse' ? 'A supported personal-Muse connection has not been verified. Meta Model API funding does not connect your personal Muse.'
        : 'Record your existing agent identity. A supported account connection and result path are needed before Phantom can send work.';
  return <div className={styles.setup}><p>{guidance}</p>{link ? <a href={link.href} target="_blank" rel="noopener noreferrer">{link.label} ↗</a> : null}
    {provider === 'grok-bot' ? <p>Legacy plans may have a separate Bot meter; unified X subscriptions share their allowance across Grok chat, Build and Bot. Verify the actual billing account, balance, reset and on-demand setting. A Bot meter alone does not establish Build capacity or API access. <a href="https://cursor.com/help/grok-bot/plans" target="_blank" rel="noopener noreferrer">Legacy Bot billing ↗</a> · <a href="https://docs.x.ai/x-subscription/grok-bot" target="_blank" rel="noopener noreferrer">Unified X billing ↗</a></p> : null}
  </div>;
}
type Draft = Required<Pick<ProactiveProfileInput, 'identity' | 'displayName' | 'avatar' | 'responsibility' | 'computer' | 'services' | 'enabled'>> & { capabilityIds: string; priority: number; maxConcurrent: number; projectBindingIds: string; fundingKind: 'unknown' | 'subscription' | 'promotional-api'; poolId: string };
type Editor = { saved: ProactiveProfile | null; draft: Draft; conflict: boolean };
function draftOf(profile?: ProactiveProfile): Draft {
  return {
    identity: profile ? { ...profile.identity } : { provider: 'openai-dot', accountId: '', agentId: '' },
    displayName: profile?.displayName ?? '', avatar: { ...(profile?.avatar ?? { color: '#5a59ef', variant: 'classic' }) },
    responsibility: profile?.responsibility ?? '', computer: { ...(profile?.computer ?? { kind: 'unknown', label: '', providerComputerId: null }) },
    services: profile?.services.map(service => ({ ...service })) ?? [], enabled: profile?.enabled ?? false,
    capabilityIds: profile?.capabilityIds.join(', ') ?? '', priority: profile?.preferences.priority ?? 50, maxConcurrent: profile?.preferences.maxConcurrent ?? 1, projectBindingIds: profile?.preferences.projectBindingIds.join(', ') ?? '',
    fundingKind: profile?.fundingReference?.kind ?? 'unknown', poolId: profile?.fundingReference?.poolId ?? '',
  };
}
function profileInput(draft: Draft): ProactiveProfileInput {
  const identity = { ...draft.identity, provider: draft.identity.provider.trim(), accountId: draft.identity.accountId.trim(), agentId: draft.identity.agentId.trim() };
  return { identity, displayName: draft.displayName.trim(), avatar: draft.avatar,
    responsibility: draft.responsibility.trim(), computer: { ...draft.computer, label: draft.computer.label.trim(), providerComputerId: draft.computer.providerComputerId?.trim() || null },
    capabilityIds: entries(draft.capabilityIds), preferences: { priority: draft.priority, maxConcurrent: draft.maxConcurrent, projectBindingIds: entries(draft.projectBindingIds) },
    services: draft.services.map(service => ({ id: service.id.trim(), label: service.label.trim() })), enabled: draft.enabled,
    fundingReference: draft.fundingKind === 'unknown' && !draft.poolId.trim() ? null : { kind: draft.fundingKind, accountId: identity.accountId, poolId: draft.poolId.trim() || null } };
}
function localIdentity(value: string): boolean { return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/.test(value.trim()); }
function entries(text: string): string[] { return [...new Set(text.split(',').map(value => value.trim()).filter(Boolean))]; }
function validDraft(draft: Draft): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(draft.identity.provider.trim()) && draft.identity.provider.trim().length <= 64
    && entries(draft.capabilityIds).length <= 32 && entries(draft.capabilityIds).every(id => id.length <= 64 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id))
    && entries(draft.projectBindingIds).length <= 32 && entries(draft.projectBindingIds).every(id => id.length <= 256)
    && Number.isInteger(draft.priority) && draft.priority >= 0 && draft.priority <= 100
    && Number.isInteger(draft.maxConcurrent) && draft.maxConcurrent >= 1 && draft.maxConcurrent <= 32
    && !!draft.displayName.trim() && !!draft.identity.accountId.trim() && !!draft.identity.agentId.trim()
    && draft.services.every(service => !!service.id.trim() && !!service.label.trim())
    && new Set(draft.services.map(service => service.id.trim())).size === draft.services.length;
}
function Avatar({ avatar }: { avatar: ProactiveAvatar }) {
  return <span className={styles.avatar} style={{ color: avatar.color }} data-variant={avatar.variant} aria-hidden="true">
    {avatar.variant === 'classic' ? <VerseMark size={36} /> : <svg viewBox="0 0 32 32" width="36" height="36" focusable="false">
      <path fill="currentColor" d={avatar.variant === 'round' ? 'M16 3a12 12 0 0 0-12 12v13l6-3 6 3 6-3 6 3V15A12 12 0 0 0 16 3Z' : 'M8 4h16v4h4v20h-4v-4h-4v4h-8v-4H8v4H4V8h4Z'} />
      <ellipse fill="#f7faff" cx="11" cy="15" rx="3" ry="4" /><ellipse fill="#f7faff" cx="21" cy="15" rx="3" ry="4" />
      <circle fill="#172442" cx="12" cy="16" r="1.5" /><circle fill="#172442" cx="22" cy="16" r="1.5" />
    </svg>}
  </span>;
}

export function ProactiveAgents() {
  const read = useQuery(proactiveProfilesQuery);
  const refetch = useRefetch(proactiveProfilesQuery);
  usePollWhileVisible(refetch, 30_000);
  const gate = useTokenGate();
  const [editor, setEditor] = useState<Editor | null>(null);
  const [busy, setBusy] = useState(false);
  const flight = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<ProactiveProfile | null>(null);
  const profiles = read.data?.profiles ?? [];
  const unavailable = read.status === 'error' || !read.data;
  const latest = editor?.saved ? profiles.find(profile => profile.id === editor.saved!.id) : undefined;
  const stale = !!editor?.saved && (editor.conflict || !latest || latest.version !== editor.saved.version);

  function open(profile?: ProactiveProfile) { setError(null); setNotice(null); setEditor({ saved: profile ?? null, draft: draftOf(profile), conflict: false }); }
  function openGrokReviewer() {
    const draft = draftOf();
    draft.identity.provider = 'grok-bot'; draft.displayName = 'Phantom improvement reviewer';
    draft.capabilityIds = 'research, code-review';
    draft.responsibility = 'Independently research Phantom improvements and review exact PR evidence. Recommend high-leverage fixes with source links and explicit unknowns. Do not post, merge, deploy, change permissions or treat a proposal as verified.';
    setError(null); setNotice(null); setEditor({ saved: null, draft, conflict: false });
  }
  function patch(patch: Partial<Draft>) { setEditor(current => current ? { ...current, draft: { ...current.draft, ...patch } } : null); }
  async function mutate(reason: string, action: () => Promise<unknown>, done: () => void) {
    if (flight.current) return;
    flight.current = true; setBusy(true); setError(null); setNotice(null);
    try {
      const result = await gate.run(reason, action);
      if (result !== null) { done(); refetch(); }
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 409) {
        setEditor(current => current ? { ...current, conflict: true } : null);
        setDeleting(null);
        setError('This profile changed elsewhere. Your draft is preserved. Refresh, then load the latest profile before saving.');
        refetch();
      } else setError(describeContextError(failure));
    } finally { flight.current = false; setBusy(false); }
  }
  function save() {
    if (!editor || busy || stale || unavailable || !validDraft(editor.draft)) return;
    const input = profileInput(editor.draft);
    const saved = editor.saved;
    void mutate(saved ? 'Save this proactive agent profile' : 'Add this proactive agent profile', () => {
      if (!saved) return createProactiveProfile(input);
      const { identity: _identity, ...editable } = input;
      return editProactiveProfile(saved.id, { ...editable, expectedVersion: saved.version });
    }, () => { setEditor(null); setNotice('Profile saved. You can organize it here; sending work and reading results are not available yet.'); });
  }

  return <section className={styles.section} aria-label="Proactive agents">
    <header className={styles.header}>
      <div><h2>Proactive agents</h2><p>Your persistent agents, their responsibilities and their recorded apps.</p></div>
      <div className={styles.actions}><Button size="sm" variant="ghost" onClick={refetch} disabled={busy}>Refresh agents</Button>
        <Button size="sm" variant="subtle" disabled={unavailable || busy} onClick={openGrokReviewer}>Add Grok reviewer profile</Button>
        <Button size="sm" variant="primary" disabled={unavailable || busy} onClick={() => open()}>Add agent</Button></div>
    </header>
    <p className={styles.note}>Save your agents and planning preferences for local coordination; connections, execution and funding are verified separately.</p>
    {notice ? <p role="status">{notice}</p> : null}
    {error && !editor && !deleting ? <p role="alert" className={styles.error}>{error}</p> : null}
    {read.status === 'error' ? <p role="alert" className={styles.error}>Agent profiles are unavailable. {readFailureReason(read.error)} Refresh to retry.</p>
      : !read.data ? <p role="status" aria-busy="true">Reading agent profiles…</p>
        : profiles.length === 0 ? <div className={styles.empty}><Avatar avatar={{ color: '#5a59ef', variant: 'classic' }} />
          <div><h3>Bring your persistent agents together</h3><p>Add Dot, Grok Bot, Muse or another agent. Keep its identity, responsibilities and connection evidence in one place.</p>
            <Button size="sm" variant="primary" onClick={() => open()}>Add your first agent</Button></div></div> : null}
    {read.status !== 'error' ? <ul className={styles.list}>{profiles.map(profile => <li key={profile.id} className={styles.row}>
      <div className={styles.identity}><Avatar avatar={profile.avatar} /><div><h3>{profile.displayName}</h3><p>{PROVIDERS[profile.identity.provider] ?? profile.identity.provider}</p></div></div>
      <p className={styles.responsibility}>{profile.responsibility || 'No responsibility added yet.'}</p>
      {profile.identity.provider === 'grok-bot' ? <p className={styles.note}>Bot allowance and reset unknown · verify the billing account and product.</p> : null}
      <div className={styles.rowActions}><span className={styles.state}>{profile.enabled ? 'Planning preference on' : 'Planning preference off'}</span>
        <Button size="sm" variant="subtle" onClick={() => open(profile)} disabled={busy}>Edit {profile.displayName}</Button></div>
      <details className={styles.evidence}><summary>Connection and capabilities</summary>
        <dl><div><dt>Connection</dt><dd>Configured profile; transport unverified</dd></div>
          <div><dt>Account</dt><dd>{profile.identity.accountId}</dd></div><div><dt>Agent identity</dt><dd>{profile.identity.agentId}</dd></div>
          <div><dt>Declared capabilities</dt><dd>{profile.capabilityIds.join(', ') || 'None recorded'} · unverified</dd></div>
          <div><dt>Planning preferences</dt><dd>Priority {profile.preferences.priority} · concurrency {profile.preferences.maxConcurrent} · project bindings {profile.preferences.projectBindingIds.join(', ') || 'no preference restriction'}. These do not grant access.</dd></div>
          <div><dt>Usage and pricing</dt><dd>Unknown; entitlement and spending eligibility unverified.</dd></div>
          <div><dt>Computer</dt><dd>{profile.computer.label || 'Unknown'} · control unverified ({profile.computer.kind === 'hosted' ? 'hosted' : profile.computer.kind === 'connected-local' ? 'connected local computer' : 'not verified'})</dd></div>
          <div><dt>Recorded apps</dt><dd>{profile.services.length ? profile.services.map(service => service.label).join(', ') : 'None recorded'}; access unverified</dd></div>
          <div><dt>Funding reference</dt><dd>{profile.fundingReference ? `${profile.fundingReference.kind === 'subscription' ? 'Subscription' : profile.fundingReference.kind === 'promotional-api' ? 'Promotional API pool' : 'Unknown'} · ${profile.fundingReference.accountId}${profile.fundingReference.poolId ? ` · ${profile.fundingReference.poolId}` : ''}` : 'None recorded'}. Spending eligibility unknown.</dd></div>
          {Object.entries(OPERATION_LABEL).map(([operation, label]) => { const readiness = profile.operations[operation as keyof typeof OPERATION_LABEL]; return <div key={operation}><dt>{label}</dt><dd>{readiness.state === 'unverified' ? 'Unverified' : 'Unsupported'}{readiness.note ? ` — ${readiness.note}` : ''}</dd></div>; })}
          <div><dt>Latest run</dt><dd>No qualified run evidence</dd></div>
        </dl><SetupHelp provider={profile.identity.provider} />
      </details>
    </li>)}</ul> : null}

    <CoordinationBoard profiles={profiles} profilesAvailable={!unavailable} />
    <PlanningLab />

    <Dialog open={editor !== null} onClose={() => { if (!busy) setEditor(null); }} titleId="proactive-profile-editor" title={editor?.saved ? `Edit ${editor.saved.displayName}` : 'Add a proactive agent'}
      description="Save a profile and planning preference for local assignments. This does not connect a transport, send work or enable spending.">
      {editor ? <form className={styles.editor} onSubmit={event => { event.preventDefault(); save(); }}>
        <fieldset disabled={busy}><legend className={styles.visuallyHidden}>Agent profile</legend>
          <label>Name<Input required maxLength={120} value={editor.draft.displayName} onChange={event => patch({ displayName: event.target.value })} /></label>
          <div className={styles.twoColumn}><label>Provider<Input aria-label="Provider" required list="proactive-provider-presets" maxLength={64} pattern="[a-z0-9]+(-[a-z0-9]+)*" value={editor.draft.identity.provider} disabled={!!editor.saved} onChange={event => patch({ identity: { ...editor.draft.identity, provider: event.target.value } })} />
            <datalist id="proactive-provider-presets">{Object.entries(PROVIDERS).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</datalist></label>
            <label>Avatar<Select value={editor.draft.avatar.variant} onChange={event => patch({ avatar: { ...editor.draft.avatar, variant: event.target.value as ProactiveAvatar['variant'] } })}>
              <option value="classic">Classic ghost</option><option value="round">Round ghost</option><option value="pixel">Pixel ghost</option></Select></label></div>
          <label>Ghost color<input type="color" value={editor.draft.avatar.color} onChange={event => patch({ avatar: { ...editor.draft.avatar, color: event.target.value } })} /></label>
          <div className={styles.twoColumn}><label>Account identity<Input required maxLength={256} disabled={!!editor.saved} value={editor.draft.identity.accountId} onChange={event => patch({ identity: { ...editor.draft.identity, accountId: event.target.value } })} /></label>
            <label>Agent identity<Input required maxLength={256} disabled={!!editor.saved} value={editor.draft.identity.agentId} onChange={event => patch({ identity: { ...editor.draft.identity, agentId: event.target.value } })} /></label></div>
          <SetupHelp provider={editor.draft.identity.provider} />
          <p className={styles.note}>Use the provider’s existing account and agent IDs. These identities stay fixed after saving.</p>
          <label>Responsibility<textarea rows={3} maxLength={4000} value={editor.draft.responsibility} placeholder="What should this agent help with?" onChange={event => patch({ responsibility: event.target.value })} /></label>
          <label>Declared capabilities<Input maxLength={4000} placeholder="research, code-review, outreach" value={editor.draft.capabilityIds} onChange={event => patch({ capabilityIds: event.target.value })} /></label>
          <p className={styles.note}>Comma-separated capability IDs describe preferences; connection, entitlement and executable capability remain unverified.</p>
          <div className={styles.twoColumn}><label>Planning priority<Input type="number" min={0} max={100} value={editor.draft.priority} onChange={event => patch({ priority: Number(event.target.value) })} /></label>
            <label>Preferred concurrency<Input type="number" min={1} max={32} value={editor.draft.maxConcurrent} onChange={event => patch({ maxConcurrent: Number(event.target.value) })} /></label></div>
          <label>Preferred project bindings<Input maxLength={4000} value={editor.draft.projectBindingIds} onChange={event => patch({ projectBindingIds: event.target.value })} /></label>
          <div className={styles.toggle}><div><strong>Save planning preference</strong><p>Allows local planning; provider execution remains unavailable.</p></div>
            <Switch checked={editor.draft.enabled} aria-label="Save planning preference" onChange={enabled => patch({ enabled })} /></div>
          <details><summary>Computer, apps and funding</summary><div className={styles.advanced}>
            <label>Computer type<Select value={editor.draft.computer.kind} onChange={event => patch({ computer: { ...editor.draft.computer, kind: event.target.value as Draft['computer']['kind'] } })}>
              <option value="unknown">Unknown</option><option value="hosted">Provider hosted</option><option value="connected-local">Local computer (recorded)</option></Select></label>
            <label>Computer label<Input maxLength={120} value={editor.draft.computer.label} onChange={event => patch({ computer: { ...editor.draft.computer, label: event.target.value } })} /></label>
            <label>Provider computer ID<Input maxLength={256} value={editor.draft.computer.providerComputerId ?? ''} onChange={event => patch({ computer: { ...editor.draft.computer, providerComputerId: event.target.value || null } })} /></label>
            <fieldset><legend>Apps</legend>{editor.draft.services.map((service, index) => <div className={styles.service} key={index}>
              <label>App ID<Input aria-label={`App ${index + 1} ID`} maxLength={128} required value={service.id} onChange={event => {
                const services: ProactiveService[] = editor.draft.services.map((item, position) => position === index ? { ...item, id: event.target.value } : item); patch({ services });
              }} /></label><label>App name<Input aria-label={`App ${index + 1} name`} maxLength={120} required value={service.label} onChange={event => patch({ services: editor.draft.services.map((item, position) => position === index ? { ...item, label: event.target.value } : item) })} /></label>
              <Button size="sm" type="button" variant="ghost" onClick={() => patch({ services: editor.draft.services.filter((_, position) => position !== index) })}>Remove app {index + 1}</Button>
            </div>)}<Button size="sm" type="button" variant="subtle" disabled={editor.draft.services.length >= 100} onClick={() => patch({ services: [...editor.draft.services, { id: '', label: '' }] })}>Add app</Button></fieldset>
            <label>Funding kind<Select value={editor.draft.fundingKind} onChange={event => patch({ fundingKind: event.target.value as Draft['fundingKind'] })}>
              <option value="unknown">Unknown</option><option value="subscription">Subscription</option><option value="promotional-api">Promotional API pool</option></Select></label>
            <label>Pool identity<Input maxLength={256} value={editor.draft.poolId} onChange={event => patch({ poolId: event.target.value })} /></label>
            <p className={styles.note}>A reference to this account only. Balance, expiry and spending permission are not inferred.</p>
          </div></details>
        </fieldset>
        {error ? <p role="alert" className={styles.error}>{error}</p> : null}
        {stale ? <p role="status">This profile changed or was removed. Your draft is preserved.
          <Button size="sm" type="button" variant="ghost" onClick={refetch} disabled={busy}>Refresh latest profile</Button>
          {latest ? <Button size="sm" type="button" variant="subtle" disabled={busy} onClick={() => { setEditor({ saved: latest, draft: draftOf(latest), conflict: false }); setError(null); }}>Load latest profile</Button> : null}</p> : null}
        <div className={styles.actions}>
          {editor.saved ? <Button type="button" size="sm" variant="danger" disabled={busy || stale} onClick={() => { setDeleting(editor.saved); setError(null); }}>Delete profile</Button> : null}
          <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setEditor(null)}>Cancel</Button>
          <Button type="submit" size="sm" variant="primary" busy={busy} disabled={unavailable || stale || !validDraft(editor.draft)}>Save profile</Button>
        </div>
      </form> : null}
    </Dialog>
    <Dialog open={deleting !== null} titleId="proactive-profile-delete" title="Delete this profile?" description="This removes the profile from Phantom. It does not stop or delete the provider’s agent." onClose={() => { if (!busy) setDeleting(null); }}>
      {error ? <p role="alert" className={styles.error}>{error}</p> : null}
      <div className={styles.actions}><Button size="sm" variant="ghost" disabled={busy} onClick={() => setDeleting(null)}>Keep profile</Button>
        <Button size="sm" variant="danger" busy={busy} onClick={() => { if (!deleting) return; const saved = deleting;
          void mutate('Delete this proactive agent profile', () => deleteProactiveProfile(saved.id, saved.version), () => { setDeleting(null); setEditor(null); setNotice('Agent profile deleted.'); }); }}>Delete agent profile</Button></div>
    </Dialog>
    <MutationTokenDialog {...gate.dialog} tokenLabel="Mutation token" tokenHelp="the mutation token phm verse printed" />
  </section>;
}

type LocalAction = CompanionCommand extends infer Command ? Command extends CompanionCommand ? Omit<Command, 'commandId' | 'expectedRevision'> : never : never;
function CoordinationBoard({ profiles, profilesAvailable }: { profiles: ProactiveProfile[]; profilesAvailable: boolean }) {
  const read = useQuery(coordinationQuery);
  const refresh = useRefetch(coordinationQuery);
  usePollWhileVisible(refresh, 30_000);
  const gate = useTokenGate();
  const [busy, setBusy] = useState(false);
  const flight = useRef(false);
  const [pending, setPending] = useState<{ command: CompanionCommand; done?: () => void } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [draft, setDraft] = useState({ tenantId: '', projectBindingId: '', taskKey: '', goal: '', acceptance: '', profileId: '', capabilityIds: '', deadline: '', maxCostUsd: '', maxAttempts: '1' });
  const [draftRevision, setDraftRevision] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const revision = read.data?.revision;
  const unavailable = !read.data || read.status === 'error' || read.data.sourceState === 'degraded' || revision === null;
  const disabled = unavailable || busy || !!pending;
  const stale = creating && draftRevision !== revision;
  function patch(value: Partial<typeof draft>) { setDraft(current => ({ ...current, ...value })); }
  async function submit(command: CompanionCommand, done?: () => void) {
    if (flight.current) return;
    flight.current = true; setBusy(true); setError(null); setNotice(null);
    try {
      const result = await gate.run('Record local coordination evidence; no provider will be contacted', () => recordCoordination(command));
      if (result === null) { setPending(null); return; }
      if (!result.ok) {
        setPending(null);
        setError(`Local command ${result.reason}. Your draft is preserved. Refresh the ledger before continuing.`);
        refresh(); return;
      }
      setPending(null); done?.(); refresh();
      setNotice(`Local record ${result.disposition}. Provider transport remains unavailable.`);
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 409) {
        setPending(null); setError('The ledger changed elsewhere. Your draft is preserved. Refresh and review the latest state before recording another command.'); refresh();
      } else if (failure instanceof ApiError && [400, 401, 403, 404, 413].includes(failure.status)) {
        // These route/gate/input rejections happen before a local write. Unlike
        // a lost response, they are safe to correct and submit as a new command.
        setPending(null);
        setError(`${describeContextError(failure)} The local command was rejected. Your draft is preserved; correct the input or restore access before submitting again.`);
      } else {
        setPending({ command, ...(done ? { done } : {}) });
        setError(`${describeContextError(failure)} The result is unconfirmed. Retry the exact command below; do not recreate it.`);
      }
    } finally { flight.current = false; setBusy(false); }
  }
  function record(action: LocalAction, done?: () => void) {
    if (disabled || revision === undefined || revision === null) return;
    const command = { ...action, commandId: crypto.randomUUID(), expectedRevision: revision } as CompanionCommand;
    setPending({ command, ...(done ? { done } : {}) }); void submit(command, done);
  }
  const availableRecipients = profiles.filter(profile => profile.enabled && entries(draft.capabilityIds).every(id => profile.capabilityIds.includes(id))
    && (!profile.preferences.projectBindingIds.length || profile.preferences.projectBindingIds.includes(draft.projectBindingId.trim())));
  const criteria = draft.acceptance.split('\n').map(line => line.trim()).filter(Boolean);
  const valid = localIdentity(draft.tenantId) && localIdentity(draft.projectBindingId) && localIdentity(draft.taskKey) && !!draft.goal.trim()
    && criteria.length > 0 && criteria.length <= 32 && new Set(criteria).size === criteria.length && criteria.every(line => new TextEncoder().encode(line).length <= 2000) && availableRecipients.some(profile => profile.id === draft.profileId)
    && entries(draft.capabilityIds).length <= 32 && entries(draft.capabilityIds).every(id => id.length <= 64 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id))
    && (!draft.deadline || Number.isFinite(Date.parse(draft.deadline)))
    && (!draft.maxCostUsd || Number.isFinite(Number(draft.maxCostUsd)) && Number(draft.maxCostUsd) >= 0 && Number(draft.maxCostUsd) <= 1_000_000)
    && Number.isInteger(Number(draft.maxAttempts)) && Number(draft.maxAttempts) >= 1 && Number(draft.maxAttempts) <= 32;
  async function create() {
    if (!valid || stale || disabled || !profilesAvailable || flight.current || revision === undefined || revision === null) return;
    flight.current = true; setBusy(true); setError(null);
    const input = { tenantId: draft.tenantId.trim(), projectBindingId: draft.projectBindingId.trim(), taskKey: draft.taskKey.trim(),
      goal: draft.goal.trim(), acceptance: draft.acceptance.split('\n').map(line => line.trim()).filter(Boolean), capabilityIds: entries(draft.capabilityIds), profileId: draft.profileId,
      deadline: draft.deadline ? new Date(draft.deadline).toISOString() : null, maxCostUsd: draft.maxCostUsd ? Number(draft.maxCostUsd) : null, maxAttempts: Number(draft.maxAttempts) };
    let digest: string | null = null;
    try { digest = await gate.run('Prepare a local evidence packet without importing account data or contacting a provider', () => prepareCoordinationPacket(input)); }
    catch (failure) { setError(describeContextError(failure)); }
    finally { flight.current = false; setBusy(false); }
    if (!digest) return;
    const { profileId: _profile, ...taskInput } = input;
    const task: CompanionTaskInput = { ...taskInput, packetDigest: digest };
    const command: CompanionCommand = { kind: 'create', task, commandId: crypto.randomUUID(), expectedRevision: revision };
    const done = () => setCreating(false);
    setPending({ command, done }); await submit(command, done);
  }
  return <section className={styles.board} aria-label="Local coordination">
    <header className={styles.header}><div><h2>Local coordination · provider transport unavailable</h2>
      <p>Record scoped assignments, handoff intent and manual evidence. No action here contacts an agent or grants account access.</p></div>
      <div className={styles.actions}><Button size="sm" variant="ghost" disabled={busy} onClick={refresh}>Refresh coordination</Button>
        <Button size="sm" variant="primary" disabled={disabled || !profilesAvailable} onClick={() => { setDraftRevision(revision ?? null); setCreating(true); }}>Record task</Button></div></header>
    <p className={styles.note}>Planning only. Usage and actual cost are unknown. Budget, deadline and attempts are recorded constraints; no autonomous routing or spending occurs.</p>
    {notice ? <p role="status">{notice}</p> : null}
    {error ? <p role="alert" className={styles.error}>{error}</p> : null}
    {pending && !busy ? <Button size="sm" variant="subtle" disabled={unavailable} onClick={() => void submit(pending.command, pending.done)}>Retry exact local command</Button> : null}
    {read.status === 'error' ? <p role="alert" className={styles.error}>Local coordination is unavailable. {readFailureReason(read.error)}</p>
      : !read.data ? <p role="status" aria-busy="true">Reading local coordination…</p>
        : read.data.sourceState === 'degraded' ? <p role="alert" className={styles.error}>The coordination ledger is degraded. Recording is disabled; repair or restore its evidence before continuing.</p>
          : read.data.tasks.length === 0 ? <p className={styles.note}>No local tasks recorded.</p> : null}
    <ul className={styles.taskList}>{read.data?.tasks.map(task => <li key={task.id} className={styles.task}>
      <div className={styles.header}><div><h3>{task.goal}</h3><p>{task.tenantId} / {task.projectBindingId} · {task.taskKey}</p></div><span className={styles.state}>{task.state === 'verified' ? 'verified · recorded review' : task.state}</span></div>
      <TaskControls task={task} revision={revision} destination={read.data?.packetDestinations.find(item => item.taskId === task.id)?.identity} candidates={read.data?.routing?.find(row => row.taskId === task.id)?.candidates} profiles={profiles} disabled={disabled} profilesAvailable={profilesAvailable} record={record} />
      <details className={styles.taskEvidence}><summary>Scope and recorded evidence</summary>
        <dl><div><dt>Task</dt><dd>{task.id}</dd></div><div><dt>Packet digest</dt><dd>{task.packetDigest}</dd></div>
          <div><dt>Acceptance criteria</dt><dd><ul>{task.acceptance.map((criterion, index) => <li key={index}>{criterion}</li>)}</ul></dd></div>
          <div><dt>Required capabilities</dt><dd>{task.capabilityIds.join(', ') || 'None declared'} · eligibility unverified</dd></div>
          <div><dt>Planning limits</dt><dd>Deadline {task.deadline ?? 'unset'} · maximum cost {task.maxCostUsd === null ? 'unset' : `$${task.maxCostUsd}`} · maximum attempts {task.maxAttempts}</dd></div>
          <div><dt>Reports</dt><dd>{task.reports.length ? task.reports.map(report => <div key={report.id} className={styles.report}><strong>Manually recorded · unverified{report.stale ? ' · stale' : ''}</strong><p>{report.report}</p><pre>{report.result}</pre><p>Source: {report.sourceReference}</p><p>Result digest: {report.resultDigest}</p></div>) : 'No results recorded'}</dd></div>
          <div><dt>Reviews</dt><dd>{task.verifications.length ? task.verifications.map(review => <p key={review.id}>Manually recorded {review.reviewer.kind} review · acceptance {review.acceptanceMet ? 'met' : 'not met'} · {review.applied ? 'applied' : 'not applied'}</p>) : 'No verification recorded'}</dd></div>
          <div><dt>Recent events</dt><dd>{task.events.slice(-6).map(event => <p key={event.seq}>{event.type} · {event.source} · {event.at}</p>)}</dd></div>
        </dl>
      </details>
      {task.notification ? <div className={styles.notification}><span>Local notification: {task.notification.reason} · {task.notification.state}</span>
        {task.notification.state === 'pending' ? <Button size="sm" variant="ghost" disabled={disabled} onClick={() => record({ kind: 'notification-ack', taskId: task.id, eventId: task.notification!.eventId })}>Acknowledge notification</Button> : null}</div> : null}
    </li>)}</ul>
    <Dialog open={creating} titleId="coordination-create" title="Record a local task" description="Choose a configured recipient and an approved tenant/project binding. Phantom prepares a local packet with your goal and criteria only; imported account evidence is missing and provider access remains unverified." onClose={() => { if (!busy && !pending) setCreating(false); }}>
      <form className={styles.editor} onSubmit={event => { event.preventDefault(); create(); }}><fieldset disabled={disabled || stale || !profilesAvailable}>
        <div className={styles.twoColumn}><label>Tenant identity<Input required maxLength={240} pattern="[A-Za-z0-9][A-Za-z0-9._:-]{0,239}" value={draft.tenantId} onChange={event => patch({ tenantId: event.target.value })} /></label>
          <label>Project binding<Input required maxLength={240} pattern="[A-Za-z0-9][A-Za-z0-9._:-]{0,239}" value={draft.projectBindingId} onChange={event => patch({ projectBindingId: event.target.value })} /></label></div>
        <label>Task key<Input required maxLength={240} pattern="[A-Za-z0-9][A-Za-z0-9._:-]{0,239}" value={draft.taskKey} onChange={event => patch({ taskKey: event.target.value })} /></label>
        <label>Goal<textarea required rows={3} maxLength={8000} value={draft.goal} onChange={event => patch({ goal: event.target.value })} /></label>
        <label>Acceptance criteria<textarea required rows={3} maxLength={8000} placeholder="One criterion per line" value={draft.acceptance} onChange={event => patch({ acceptance: event.target.value })} /></label>
        <label>Packet recipient<Select required value={draft.profileId} onChange={event => patch({ profileId: event.target.value })}><option value="">Choose a configured profile</option>
          {availableRecipients.map(profile => <option key={profile.id} value={profile.id}>{profile.displayName} · {profile.identity.provider} / {profile.identity.accountId} / {profile.identity.agentId}</option>)}</Select></label>
        <p className={styles.note}>Enable a profile’s planning preference and declare matching capabilities/project preferences to select it. This packet contains local planning metadata. Account-source evidence and access approval are missing; no live handoff is available.</p>
        <label>Required capability IDs<Input maxLength={4000} value={draft.capabilityIds} onChange={event => patch({ capabilityIds: event.target.value })} /></label>
        <details><summary>Planning limits</summary><div className={styles.advanced}>
          <label>Deadline (ISO date and time)<Input value={draft.deadline} onChange={event => patch({ deadline: event.target.value })} /></label>
          <label>Maximum estimated cost (USD)<Input type="number" min={0} max={1_000_000} step="any" value={draft.maxCostUsd} onChange={event => patch({ maxCostUsd: event.target.value })} /></label>
          <label>Maximum attempts<Input type="number" min={1} max={32} value={draft.maxAttempts} onChange={event => patch({ maxAttempts: event.target.value })} /></label>
        </div></details>
      </fieldset>
        {stale ? <p role="status">The ledger revision changed. Your task draft is preserved. <Button size="sm" type="button" variant="subtle" disabled={disabled} onClick={() => setDraftRevision(revision ?? null)}>Use latest ledger revision</Button></p> : null}
        {error ? <p role="alert" className={styles.error}>{error}</p> : null}
        <div className={styles.actions}><Button size="sm" type="button" variant="ghost" disabled={busy || !!pending} onClick={() => setCreating(false)}>Close task draft</Button>
          <Button size="sm" type="submit" variant="primary" disabled={disabled || stale || !profilesAvailable || !valid}>Save local task</Button></div>
      </form>
    </Dialog>
    <MutationTokenDialog {...gate.dialog} tokenLabel="Mutation token" tokenHelp="the mutation token phm verse printed" />
  </section>;
}

function TaskControls({ task, revision, destination, candidates, profiles, profilesAvailable, disabled, record }: { task: CompanionTask; revision: number | null | undefined; destination?: ProactiveProfile['identity']; candidates?: CompanionCandidate[]; profiles: ProactiveProfile[]; profilesAvailable: boolean; disabled: boolean; record: (action: LocalAction, done?: () => void) => void }) {
  const [profileId, setProfileId] = useState('');
  const [ownerId, setOwnerId] = useState('local-operator');
  const [leaseMinutes, setLeaseMinutes] = useState('30');
  const [result, setResult] = useState('');
  const [report, setReport] = useState('');
  const [sourceReference, setSourceReference] = useState('');
  const [reviewerId, setReviewerId] = useState('');
  const [reviewedReportId, setReviewedReportId] = useState<string | null>(null);
  const [acceptanceMet, setAcceptanceMet] = useState('no');
  const [reviewingKey, setReviewingKey] = useState<string | null>(null);
  const attempt = task.attempts.at(-1);
  const latestReport = task.reports.at(-1);
  const reviewed = !!latestReport && reviewedReportId === latestReport.id;
  const matching = profiles.filter(profile => profile.enabled && (candidates === undefined || candidates.some(candidate => candidate.profileId === profile.id && candidate.localAssignmentEligible)) && !!destination && profile.identity.provider === destination.provider && profile.identity.accountId === destination.accountId && profile.identity.agentId === destination.agentId && task.capabilityIds.every(id => profile.capabilityIds.includes(id))
    && (!profile.preferences.projectBindingIds.length || profile.preferences.projectBindingIds.includes(task.projectBindingId)));
  const selected = matching.find(profile => profile.id === profileId);
  const handoffProfile = profiles.find(profile => attempt && profile.identity.provider === 'grok-bot'
    && profile.identity.provider === attempt.assignee.provider && profile.identity.accountId === attempt.assignee.accountId
    && profile.identity.agentId === attempt.assignee.agentId && profile.enabled
    && task.capabilityIds.every(id => profile.capabilityIds.includes(id))
    && (!profile.preferences.projectBindingIds.length || profile.preferences.projectBindingIds.includes(task.projectBindingId)));
  const handoffKey = JSON.stringify([task.id, task.packetDigest, task.state, attempt, revision,
    handoffProfile?.id, handoffProfile?.version, disabled, profilesAvailable]);
  const now = Date.now();
  const profileDates = handoffProfile ? [Date.parse(handoffProfile.createdAt), Date.parse(handoffProfile.updatedAt)] : [];
  const canReview = !disabled && profilesAvailable && !!attempt && !!handoffProfile && revision !== undefined && revision !== null
    && task.state === 'handoff-intent' && attempt.contact === 'intent' && attempt.cancelRequestedAt === null
    && attempt.packetDigest === task.packetDigest && Number.isSafeInteger(attempt.epoch) && attempt.epoch > 0
    && Number.isFinite(Date.parse(attempt.leaseExpiresAt)) && Date.parse(attempt.leaseExpiresAt) > now
    && (task.deadline === null || Number.isFinite(Date.parse(task.deadline)) && Date.parse(task.deadline) > now)
    && profileDates.every(value => Number.isFinite(value) && value <= now) && profileDates[1]! >= profileDates[0]!;
  // Discard an old review on any independent ledger/profile/availability change.
  // The render guard below also hides it before effect cleanup can run.
  useEffect(() => { setReviewingKey(null); }, [handoffKey]);
  return <div className={styles.taskControls}>
    {attempt ? <p className={styles.note}>Assigned to {attempt.assignee.provider} / {attempt.assignee.accountId} / {attempt.assignee.agentId} · owner {attempt.ownerId} · epoch {attempt.epoch}<br />
      Contact observation: {attempt.contact}. Lease expires {attempt.leaseExpiresAt}. Expiry does not prove remote work stopped.</p> : null}
    {(task.state === 'draft' || task.state === 'needs-attention') && task.attempts.length < task.maxAttempts ? <details><summary>Record an assignment</summary>
      <form className={styles.editor} onSubmit={event => { event.preventDefault(); if (selected && localIdentity(ownerId)) record({ kind: 'assign', taskId: task.id, assignee: selected.identity, ownerId: ownerId.trim(), leaseMs: Number(leaseMinutes) * 60_000 }); }}>
        <p className={styles.note}>Assignment must match the packet recipient and declared capability/project preferences. Access, entitlement and transport remain unverified.</p>
        <fieldset disabled={disabled || !profilesAvailable}><label>Agent profile<Select value={profileId} onChange={event => setProfileId(event.target.value)}><option value="">Choose a configured profile</option>
          {matching.map(profile => <option key={profile.id} value={profile.id}>{profile.displayName} · {profile.identity.provider} / {profile.identity.accountId} / {profile.identity.agentId}</option>)}</Select></label>
          {!matching.length ? <p className={styles.note}>Local assignment unavailable. {candidates?.filter(candidate => profiles.some(profile => profile.id === candidate.profileId && destination && profile.identity.provider === destination.provider && profile.identity.accountId === destination.accountId && profile.identity.agentId === destination.agentId)).flatMap(candidate => candidate.reasons).join(' ') || 'Enable a matching recipient profile and review its packet destination and declared preferences.'}</p> : null}
          <div className={styles.twoColumn}><label>Local owner identity<Input required maxLength={240} pattern="[A-Za-z0-9][A-Za-z0-9._:-]{0,239}" value={ownerId} onChange={event => setOwnerId(event.target.value)} /></label>
            <label>Lease minutes<Input required type="number" min={1} max={1440} value={leaseMinutes} onChange={event => setLeaseMinutes(event.target.value)} /></label></div>
          <Button size="sm" type="submit" variant="subtle" disabled={!selected || !localIdentity(ownerId) || !Number.isInteger(Number(leaseMinutes)) || Number(leaseMinutes) < 1 || Number(leaseMinutes) > 1440}>Save local assignment</Button>
        </fieldset>
      </form></details> : null}
    {attempt ? <div className={styles.actions}>
      {task.state === 'assigned' ? <Button size="sm" variant="subtle" disabled={disabled} onClick={() => record({ kind: 'handoff', taskId: task.id, attemptId: attempt.id, epoch: attempt.epoch, ownerId: attempt.ownerId })}>Prepare handoff intent</Button> : null}
      {task.state !== 'verified' && task.state !== 'cancel-requested' ? <Button size="sm" variant="ghost" disabled={disabled} onClick={() => record({ kind: 'cancel', taskId: task.id, attemptId: attempt.id })}>Record cancellation intent</Button> : null}
    </div> : null}
    {task.state === 'handoff-intent' ? <p className={styles.note}>Handoff intent recorded locally. Transport unavailable; no provider acceptance or completion is proven.</p> : null}
    {attempt?.assignee.provider === 'grok-bot' && task.state === 'handoff-intent' ? <Button size="sm" variant="subtle" disabled={!canReview}
      onClick={() => setReviewingKey(handoffKey)}>Review Grok Bot brief</Button> : null}
    {reviewingKey === handoffKey && canReview && attempt && handoffProfile && revision !== undefined && revision !== null ?
      <Suspense fallback={<p role="status">Loading Grok Bot brief controls…</p>}><GrokBotHandoff
        request={{ taskId: task.id, attemptId: attempt.id, epoch: attempt.epoch, expectedRevision: revision,
          profileId: handoffProfile.id, expectedProfileVersion: handoffProfile.version }} packetDigest={task.packetDigest}
        leaseExpiresAt={attempt.leaseExpiresAt} deadline={task.deadline} disabled={disabled || !profilesAvailable}
        onClose={() => setReviewingKey(null)} /></Suspense> : null}
    {task.state === 'cancel-requested' ? <p className={styles.note}>Cancellation requested locally. Provider cancellation is unconfirmed.</p> : null}
    {attempt && task.state !== 'verified' ? <details><summary>Record a manual report</summary><form className={styles.editor} onSubmit={event => { event.preventDefault();
      if (result.trim() && report.trim() && sourceReference.trim()) record({ kind: 'report', taskId: task.id, attemptId: attempt.id, epoch: attempt.epoch, packetDigest: attempt.packetDigest, result, report, sourceReference: sourceReference.trim() }, () => { setResult(''); setReport(''); setSourceReference(''); }); }}>
      <p className={styles.note}>Manual evidence does not prove provider acceptance, execution or an independently verified outcome. The ledger hashes the exact result text.</p>
      <fieldset disabled={disabled}><label>Result text<textarea required rows={4} maxLength={16000} value={result} onChange={event => setResult(event.target.value)} /></label>
        <label>Report summary<textarea required rows={2} maxLength={8000} value={report} onChange={event => setReport(event.target.value)} /></label>
        <label>Source reference<Input required maxLength={1024} value={sourceReference} onChange={event => setSourceReference(event.target.value)} /></label>
        <Button type="submit" size="sm" variant="subtle" disabled={!result.trim() || !report.trim() || !sourceReference.trim()}>Save manual report</Button>
      </fieldset></form></details> : null}
    {latestReport && task.state !== 'verified' ? <details><summary>Record operator verification</summary><form className={styles.editor} onSubmit={event => { event.preventDefault(); if (localIdentity(reviewerId) && reviewed) record({ kind: 'operator-review', taskId: task.id, reportId: latestReport.id, checkedResultDigest: latestReport.resultDigest, reviewer: { kind: 'operator', operatorId: reviewerId.trim() }, acceptanceMet: acceptanceMet === 'yes' }); }}>
      <p className={styles.note}>Review the exact result and criteria above. This review binds the displayed result digest. This is a manual operator review; no independent provider verifier ran.</p>
      <fieldset disabled={disabled}><label>Reviewer identity<Input required maxLength={240} pattern="[A-Za-z0-9][A-Za-z0-9._:-]{0,239}" value={reviewerId} onChange={event => setReviewerId(event.target.value)} /></label>
        <label className={styles.reviewCheck}><input type="checkbox" checked={reviewed} onChange={event => setReviewedReportId(event.target.checked ? latestReport.id : null)} />I reviewed this exact result and its acceptance criteria</label>
        <label>Acceptance met<Select value={acceptanceMet} onChange={event => setAcceptanceMet(event.target.value)}><option value="no">No</option><option value="yes">Yes, criteria reviewed</option></Select></label>
        <Button size="sm" type="submit" variant="subtle" disabled={!localIdentity(reviewerId) || !reviewed}>Save operator review</Button>
      </fieldset></form></details> : null}
  </div>;
}
