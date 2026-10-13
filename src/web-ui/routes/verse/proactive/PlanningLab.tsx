import { useRef, useState } from 'react';
import type { ProactiveResourceEvidenceResponse } from '../../../../core/proactive/resource-evidence-types.js';
import type { RoutingLabEvaluation, RoutingLabPreferenceProposal } from '../../../../core/proactive/routing-lab-types.js';
import type { ReleaseReadinessResponse, PlanningCommand } from './planning-queries.js';
import { MutationTokenDialog } from '../../../components/auth/MutationTokenDialog.js';
import { Input } from '../../../components/primitives/Input.js';
import { Select } from '../../../components/primitives/Select.js';
import { describeContextError, useTokenGate } from '../context/use-token-gate.js';
import { coordinationQuery } from './proactive-queries.js';
import { Button } from '../../../components/primitives/Button.js';
import { ApiError, readFailureReason } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { resourceEvidenceQuery, planningQuery, releaseReadinessQuery, recordPlanning } from './planning-queries.js';
import styles from './PlanningLab.module.css';

type LabAction = PlanningCommand extends infer Command ? Command extends PlanningCommand ? Omit<Command, 'requestId' | 'expectedRevision'> : never : never;
export function PlanningLab() {
  const [open, setOpen] = useState(false);
  const resources = useQuery(resourceEvidenceQuery, { enabled: open });
  const read = useQuery(planningQuery, { enabled: open });
  const releases = useQuery(releaseReadinessQuery, { enabled: open });
  const tasks = useQuery(coordinationQuery, { enabled: open });
  const refreshResources = useRefetch(resourceEvidenceQuery);
  const refreshPlanning = useRefetch(planningQuery);
  const refreshReleases = useRefetch(releaseReadinessQuery);
  const refreshTasks = useRefetch(coordinationQuery);
  const gate = useTokenGate();
  const flight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<{ command: PlanningCommand; done?: () => void } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [taskId, setTaskId] = useState('');
  const [conflict, setConflict] = useState(false);
  const [proposal, setProposal] = useState<{ evaluationId: string; resourceId: string; reason: string; revision: number } | null>(null);
  const unavailable = !read.data || read.status === 'error' || read.data.sourceState === 'degraded';
  const disabled = unavailable || busy || !!pending || conflict;
  const scopeUnavailable = !tasks.data || tasks.status === 'error' || tasks.data.sourceState === 'degraded';
  const selected = tasks.data?.tasks.find(task => task.id === taskId);
  const proposalStale = !!proposal && proposal.revision !== read.data?.revision;
  function refresh() { refreshPlanning(); refreshResources(); refreshReleases(); refreshTasks(); }
  async function submit(command: PlanningCommand, done?: () => void) {
    if (flight.current) return;
    flight.current = true; setBusy(true); setError(null); setNotice(null);
    try {
      const result = await gate.run('Save an offline planning receipt; no provider calls or release actions', () => recordPlanning(command));
      if (result === null) { setPending(null); return; }
      if (!result.ok) {
        setPending(null); setError(`Offline request ${result.reason}. Your selection and proposal draft are preserved.`);
        if (result.reason === 'conflict') setConflict(true);
        refreshPlanning(); return;
      }
      setPending(null); done?.(); refreshPlanning();
      setNotice(`Offline record ${result.disposition}. No live policy, account authority or release target was changed.`);
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 409) {
        setPending(null); setConflict(true); refreshPlanning();
        setError('Planning records changed elsewhere. Your selection and proposal draft are preserved. Refresh and review the latest revision before continuing.');
      } else if (failure instanceof ApiError && [400, 401, 403, 404, 413].includes(failure.status)) {
        setPending(null); setError(`${describeContextError(failure)} The offline request was rejected. Correct the input or restore access before submitting again.`);
      } else {
        setPending({ command, ...(done ? { done } : {}) });
        setError(`${describeContextError(failure)} The result is unconfirmed. Retry this exact request before starting another evaluation.`);
      }
    } finally { flight.current = false; setBusy(false); }
  }
  function record(action: LabAction, done?: () => void) {
    if (disabled || flight.current || !read.data) return;
    const command = { ...action, requestId: crypto.randomUUID(), expectedRevision: read.data.revision } as PlanningCommand;
    setPending({ command, ...(done ? { done } : {}) }); void submit(command, done);
  }
  return <section className={styles.section} aria-label="Planning lab">
    <header className={styles.header}><div><h2>Planning lab · offline only</h2><p>Inspect resource evidence, shadow routing and release gates. No evaluation calls a provider or grants execution authority.</p></div>
      <Button size="sm" variant="subtle" disabled={busy || !!pending} onClick={() => setOpen(value => !value)}>{open ? 'Close planning lab' : 'Open planning lab'}</Button></header>
    {open ? <><div className={styles.actions}><Button size="sm" variant="ghost" disabled={busy} onClick={refresh}>Refresh planning evidence</Button></div>
      {notice ? <p role="status">{notice}</p> : null}
      {error ? <p role="alert" className={styles.error}>{error}</p> : null}
      {pending && !busy ? <Button size="sm" variant="subtle" disabled={unavailable} onClick={() => void submit(pending.command, pending.done)}>Retry exact offline request</Button> : null}
      {conflict ? <p role="status">Review the refreshed planning records. <Button size="sm" variant="subtle" disabled={unavailable || busy || !!pending} onClick={() => { setConflict(false); setError(null); }}>Use latest planning revision</Button></p> : null}
      {resources.status === 'error' ? <p role="alert" className={styles.error}>Resource evidence is unavailable. {readFailureReason(resources.error)}</p>
        : resources.data ? <ResourceEvidence data={resources.data} /> : <p role="status" aria-busy="true">Reading cached resource evidence…</p>}
      <section className={styles.panel} aria-label="Offline routing evaluations"><h3>Shadow routing and offline demo</h3>
        <p className={styles.note}>Cached-task evaluations apply deterministic rules to local evidence. The offline demo uses synthetic providers, accounts and advice fixtures; pass/fail measures routing expectations, never provider quality, latency, quota or benefits.</p>
        {read.status === 'error' ? <p role="alert" className={styles.error}>Planning records are unavailable. {readFailureReason(read.error)}</p>
          : read.data?.sourceState === 'degraded' ? <p role="alert" className={styles.error}>The offline ledger is degraded. New evaluations and proposals are disabled.</p>
            : !read.data ? <p role="status" aria-busy="true">Reading offline evaluations…</p> : null}
        <form className={styles.form} onSubmit={event => { event.preventDefault(); if (selected && !scopeUnavailable) record({ kind: 'preview', taskId: selected.id }); }}>
          <label>Saved task<Select disabled={disabled || scopeUnavailable} value={taskId} onChange={event => setTaskId(event.target.value)}><option value="">Choose a scoped local task</option>
            {tasks.data?.tasks.map(task => <option key={task.id} value={task.id}>{task.goal} · {task.tenantId} / {task.projectBindingId}</option>)}</Select></label>
          {selected ? <p className={styles.note}>Scope: {selected.tenantId} / {selected.projectBindingId}. The server derives the saved packet and destination; browser text cannot expand its account scope.</p> : null}
          {scopeUnavailable ? <p className={styles.note}>Saved task scope is unavailable; cached-task evaluation is disabled.</p> : !tasks.data?.tasks.length ? <p className={styles.note}>Record a scoped local task above to evaluate current declarations.</p> : null}
          <div className={styles.actions}><Button type="submit" size="sm" variant="subtle" disabled={disabled || scopeUnavailable || !selected || resources.status === 'error' || !resources.data || resources.data.sourceState === 'invalid'}>Evaluate cached task</Button>
            <Button type="button" size="sm" variant="primary" disabled={disabled} onClick={() => record({ kind: 'benchmark' })}>Run offline demo</Button></div>
        </form>
        {read.data?.evaluations.length === 0 ? <p className={styles.note}>No offline evaluation receipts recorded.</p> : null}
        <ul className={styles.list}>{read.data?.evaluations.slice().reverse().map(evaluation => <li key={evaluation.id} className={styles.item}>
          <EvaluationEvidence evaluation={evaluation} disabled={disabled} propose={(evaluationId, resourceId) => { if (read.data) setProposal({ evaluationId, resourceId, reason: '', revision: read.data.revision }); }} />
        </li>)}</ul>
      </section>
      <section className={styles.panel} aria-label="Preference proposals"><h3>Preference review proposals</h3><p className={styles.note}>These recommendations are inspectable local records. They do not change routing policy, permissions or spending. Withdrawing reverses the proposal only.</p>
        {proposal ? <form className={styles.form} onSubmit={event => { event.preventDefault(); if (!proposalStale && proposal.reason.trim()) record({ kind: 'propose-preference', evaluationId: proposal.evaluationId, resourceId: proposal.resourceId, reason: proposal.reason.trim() }, () => setProposal(null)); }}>
          <p className={styles.note}>Evaluation {proposal.evaluationId} · resource {proposal.resourceId}</p>
          <label>Preference review reason<Input required maxLength={2000} disabled={disabled || proposalStale} value={proposal.reason} onChange={event => setProposal(current => current ? { ...current, reason: event.target.value } : null)} /></label>
          {proposalStale ? <p role="status">This proposal draft uses an older revision. Review the latest records. <Button size="sm" variant="subtle" type="button" disabled={disabled} onClick={() => { if (read.data) setProposal(current => current ? { ...current, revision: read.data!.revision } : null); }}>Use latest proposal revision</Button></p> : null}
          <div className={styles.actions}><Button size="sm" type="submit" variant="subtle" disabled={disabled || proposalStale || !proposal.reason.trim()}>Save review proposal</Button>
            <Button size="sm" type="button" variant="ghost" disabled={busy || !!pending} onClick={() => setProposal(null)}>Close proposal draft</Button></div>
        </form> : null}
        {!read.data?.proposals.length ? <p className={styles.note}>No preference proposals recorded.</p> : null}
        <ul className={styles.list}>{read.data?.proposals.map(item => <li key={item.id} className={styles.item}><ProposalEvidence proposal={item} />
          {item.state === 'proposed' ? <Button size="sm" variant="ghost" disabled={disabled} onClick={() => record({ kind: 'withdraw-preference', proposalId: item.id })}>Withdraw review proposal</Button> : null}</li>)}</ul>
      </section>
      {releases.status === 'error' ? <p role="alert" className={styles.error}>Release readiness is unavailable. {readFailureReason(releases.error)}</p>
        : releases.data ? <ReleaseEvidence data={releases.data} /> : <p role="status" aria-busy="true">Reading release readiness…</p>}
    </> : null}
    <MutationTokenDialog {...gate.dialog} tokenLabel="Mutation token" tokenHelp="the mutation token phm verse printed" />
  </section>;
}

function EvaluationEvidence({ evaluation, disabled, propose }: { evaluation: RoutingLabEvaluation; disabled: boolean; propose: (evaluationId: string, resourceId: string) => void }) {
  const simulated = evaluation.mode === 'fixture';
  return <div className={simulated ? styles.simulated : undefined}>
    <h4>{simulated ? 'Simulated offline demo' : 'Cached-evidence shadow evaluation'} · {evaluation.status}</h4>
    <p className={styles.note}>Evaluation {evaluation.id} · recorded {evaluation.createdAt}<br />Policy {evaluation.policyId} · model contract {evaluation.modelId} · adapter {evaluation.adapterMode}. No provider model ran.</p>
    <p>Routing expectations: {evaluation.summary.passed} pass · {evaluation.summary.failed} fail · {evaluation.summary.evaluated}/{evaluation.summary.total} evaluated · {evaluation.summary.expected} with expected outcomes.</p>
    <p className={styles.note}>Local evaluation duration: {evaluation.localDurationMs === null ? 'unknown' : `${evaluation.localDurationMs} ms`}. Provider latency and live performance are unknown.</p>
    {evaluation.status !== 'completed' ? <p className={styles.note}>This evaluation has no confirmed complete result. Interrupted or aborted evidence does not authorize another provider attempt.</p> : null}
    {evaluation.notes.map((note, index) => <p className={styles.note} key={index}>{note}</p>)}
    <details className={styles.evidence}><summary>Candidate and fallback evidence for {evaluation.id}</summary>
      <ul className={styles.list}>{evaluation.cases.map(test => <li key={test.caseId} className={styles.item}>
        <h4>{test.caseId} · {test.passed === null ? 'expectation unknown' : test.passed ? 'pass' : 'fail'}</h4>
        <p>Path {test.path} · selected {test.selectedResourceId ?? 'none'} · expected {test.expectedResourceId ?? 'unknown'}</p>
        <p>Fallback: {test.fallbackReason ?? 'none recorded'}</p>
        {test.notes.map((note, index) => <p className={styles.note} key={index}>{note}</p>)}
        <ul>{test.candidates.map(candidate => <li key={candidate.resourceId}><strong>{candidate.label}</strong> · {candidate.qualification} · {candidate.sourceMode}
          <p>Matched declared capabilities: {candidate.matchedCapabilityIds.join(', ') || 'none'} · execution not authorized.</p>
          <p>{candidate.holds.length ? `Held: ${candidate.holds.join(' ')}` : 'No local planning hold; live eligibility remains unverified.'}</p>
          {candidate.qualification === 'held' || candidate.holds.length > 0 ? <p className={styles.note}>Held candidates cannot support a preference proposal.</p> : evaluation.status === 'completed' ? <Button size="sm" variant="ghost" disabled={disabled} onClick={() => propose(evaluation.id, candidate.resourceId)}>Suggest preference review for {candidate.label}</Button> : null}
        </li>)}</ul>
      </li>)}</ul>
    </details>
  </div>;
}
function ProposalEvidence({ proposal }: { proposal: RoutingLabPreferenceProposal }) {
  return <><h4>Proposal only · {proposal.state}</h4><p>{proposal.reason}</p><p className={styles.note}>Resource {proposal.resourceId} · evaluation {proposal.evaluationId} · recorded {proposal.createdAt}. Execution not authorized.</p></>;
}
function ReleaseEvidence({ data }: { data: ReleaseReadinessResponse }) {
  const result = data.readiness;
  return <section className={styles.panel} aria-label="Release readiness"><h3>Release readiness · no release action</h3>
    {data.notes.map((note, index) => <p className={styles.note} key={index}>{note}</p>)}
    {!result ? <p className={styles.note}>Readiness unknown. Supply an exact release target, artifact, version, source revision and current evidence before a readiness review.</p> : <>
      <h4>{result.simulated || result.evidenceLayer === 'simulated' ? 'Simulated release evidence' : `${result.evidenceLayer} evidence`} · {result.readiness}</h4>
      <dl className={styles.facts}><div><dt>Channel / target</dt><dd>{result.binding.channel} / {result.binding.targetId}</dd></div>
        <div><dt>Version</dt><dd>{result.binding.version}</dd></div><div><dt>Source revision</dt><dd>{result.binding.sourceRevision}</dd></div>
        <div><dt>Artifact digest</dt><dd>{result.binding.artifactDigest}</dd></div><div><dt>Release attempt</dt><dd>{result.binding.attemptId}</dd></div>
        <div><dt>Evidence as of</dt><dd>{result.asOf}</dd></div></dl>
      <ul>{result.gates.map(gate => <li key={gate.id}><strong>{gate.id} · {gate.state}</strong><p>{gate.reason}</p><p className={styles.note}>Receipts: {gate.receiptIds.join(', ') || 'none'}</p></li>)}</ul>
      {result.gaps.length ? <ul>{result.gaps.map((gap, index) => <li key={index}>{gap}</li>)}</ul> : null}
    </>}
    <p className={styles.note}>Publishing, deployment, installation, service changes and permission changes are not authorized by this view. Post-release checks and channel-specific recovery remain separate gates.</p>
  </section>;
}

function ResourceEvidence({ data }: { data: ProactiveResourceEvidenceResponse }) {
  return <section className={styles.panel} aria-label="Resource evidence"><h3>Cached resource evidence</h3>
    <p className={styles.note}>Snapshot {data.sourceState} · sampled {data.sampledAt}. Account identity, connection, capabilities, entitlement and funding are separate observations. No collector or account login is started.</p>
    {data.notes.map((note, index) => <p key={index} className={styles.note}>{note}</p>)}
    {data.resources.length === 0 ? <p className={styles.note}>No cached resource evidence is available. Usage, funding and eligibility remain unknown.</p> : null}
    <ul className={styles.list}>{data.resources.map(resource => <li key={resource.resourceId} className={styles.item}>
      <div className={styles.header}><div><h4>{resource.label}</h4><p>{resource.identity.provider} / {resource.identity.accountId ?? 'account unknown'} / {resource.identity.agentId ?? 'agent unknown'}</p></div>
        <span className={styles.state}>Evidence: {resource.evidenceState}</span></div>
      <dl className={styles.facts}><div><dt>Resource</dt><dd>{resource.kind === 'funding-pool' ? 'Funding evidence · not execution capacity' : resource.kind} · {resource.resourceId}</dd></div>
        <div><dt>Identity</dt><dd>{resource.identityState}</dd></div><div><dt>Connection</dt><dd>{resource.connectionState}</dd></div>
        <div><dt>Capabilities</dt><dd>{resource.capabilityState} · {resource.capabilityIds.join(', ') || 'unknown'}</dd></div>
        <div><dt>Entitlement</dt><dd>{resource.entitlementState}</dd></div><div><dt>Readiness observation</dt><dd>{resource.readinessState} · execution not authorized</dd></div>
        <div><dt>Cost</dt><dd>{resource.cost.state === 'unknown' || resource.cost.value === null ? 'Unknown' : `${resource.cost.state} · ${resource.cost.value} ${resource.cost.currency ?? 'currency unknown'} ${resource.cost.units ?? ''}`} · evidence {resource.cost.evidenceState}</dd></div>
        <div><dt>Source freshness</dt><dd>{resource.source} · {resource.asOf ?? 'observation time unknown'}</dd></div>
      </dl>
      <details className={styles.evidence}><summary>Usage and funding evidence for {resource.label}</summary>
        {resource.usageWindows.length ? <ul>{resource.usageWindows.map(window => <li key={window.id}>{window.id}: {window.usedPercent === null ? 'usage unknown' : `${window.usedPercent}% used`} · {window.evidenceState} · observed {window.observedAt ?? 'unknown'} · reset {window.resetsAt ?? window.resetDescription ?? 'unknown'}{window.limitReached ? ' · limit reported reached' : ''}</li>)}</ul> : <p>Usage unknown; no cached windows.</p>}
        {resource.credits.length ? <ul>{resource.credits.map((credit, index) => <li key={`${credit.poolId}:${index}`}>{credit.kind} · {credit.recordKind === 'balance' ? `Balance ${credit.amount ?? 'unknown'}` : `${credit.recordKind} receipt ${credit.receiptAmount ?? 'amount unknown'}`} {credit.unit}{credit.recordKind !== 'balance' || credit.total === null ? '' : ` of ${credit.total}`} · {credit.surface}<br />
          Funding product {credit.fundingProductId ?? 'unknown'} · funding account {credit.fundingAccountId ?? 'unknown'} · eligibility {credit.eligibilityState}<br />
          Eligible surfaces: {credit.eligibleSurfaces.join(', ') || 'unknown'} · excluded surfaces: {credit.excludedSurfaces.join(', ') || 'none declared'}<br />
          Expiry {credit.expiryState} · {credit.expiresAt ?? credit.expiryDate ?? 'date unknown'} · evidence {credit.evidenceState} · source {credit.source} · observed {credit.asOf ?? 'unknown'}</li>)}</ul> : <p>Funding unknown; no cached credits. Subscription benefits and provider eligibility are not inferred.</p>}
        {resource.notes.map((note, index) => <p key={index}>{note}</p>)}
      </details>
    </li>)}</ul>
  </section>;
}
