import { useId, useMemo, useState } from 'react';
import { getMutationToken } from '../../../../data/auth-store.js';
import { ApiError, readFailureReason } from '../../../../data/client.js';
import { useQuery, useRefetch } from '../../../../data/hooks.js';
import { isRemoteMobileMode } from '../../../../data/remote-mode.js';
import { metaLine, pollMs, prLabel, safePrUrl, stateTone } from '../../fleet-job-log/worker-log-model.js';
import { jobDetailQuery } from '../../fleet-job-log/worker-log-queries.js';
import { VerseControlLockedError } from '../../autonomy/control-queries.js';
import { usePollWhileVisible } from '../../shell/section-visibility.js';
import { homeRunsQuery } from '../home-runs-query.js';
import { runMobileAction } from '../mobile-actions.js';
import { canShowActions, useMobile } from '../mobile-context.js';
import { postFleetRunsInbox } from '../runs-queries.js';
import { workerFromSnapshot } from '../worker-snapshot-model.js';
import { workerTellPrefill } from '../worker-tell-text.js';
import { Button, cx, Screen, SkeletonList } from '../ui.js';
import { Badge, EmptyState, ErrorState, Row, Section, ui } from '../ui-parts.js';
import styles from './WorkerScreen.module.css';

export function WorkerScreen({ job }: { job: string }) {
  const { navigate } = useMobile();
  const def = useMemo(() => jobDetailQuery(job), [job]);
  const query = useQuery(def);
  const refetch = useRefetch(def);
  const detail = query.data;
  const failed = query.status === 'error';
  const gatewayUnavailable = (query.error instanceof ApiError && [401, 403].includes(query.error.status))
    || (isRemoteMobileMode() && failed);
  const snapshotQuery = useQuery(homeRunsQuery, { enabled: gatewayUnavailable || detail === null });
  const refetchSnapshot = useRefetch(homeRunsQuery);
  usePollWhileVisible(refetchSnapshot, 15_000, { enabled: gatewayUnavailable || detail === null });
  usePollWhileVisible(refetch, pollMs(detail), { enabled: detail !== null && !gatewayUnavailable });

  const now = Date.now();
  const worker = gatewayUnavailable || detail === null ? workerFromSnapshot(snapshotQuery.data, job, now) : null;
  const launchedAt = detail?.launchedAt ? Date.parse(detail.launchedAt) : NaN;
  const snapshotAge = worker?.ageText?.match(/^(?:(\d+) hr)?(?: ?(\d+) min)?$/);
  const ageSeconds = worker?.ageText === '<1 min' ? 0 : snapshotAge
    ? (Number(snapshotAge[1] ?? 0) * 60 + Number(snapshotAge[2] ?? 0)) * 60 : null;
  const tell = detail && !gatewayUnavailable && !failed ? {
    job, lane: detail.lane ?? null, repo: null, ageSeconds: Number.isFinite(launchedAt) ? Math.max(0, (now - launchedAt) / 1000) : null,
    pr: safePrUrl(detail.publish?.prUrl),
  } : worker ? { job, lane: worker.lane, repo: worker.repo, ageSeconds, pr: worker.prUrl } : null;

  let body;
  if (gatewayUnavailable || detail === null) {
    body = <>
      {worker ? <Section title="Worker (from the fleet snapshot)">
        <Row title="Repo" trailing={worker.repo ?? '—'} />
        <Row title="Lane" trailing={worker.lane ?? '—'} />
        <Row title="Tier" trailing={worker.tier ?? '—'} />
        <Row title="State" trailing={worker.mergedAs ? `${worker.state} · ${worker.mergedAs}` : worker.state} />
        <Row title="Age" trailing={worker.ageText ?? '—'} />
        <Row title="Pull request" trailing={worker.prUrl ? <a href={worker.prUrl} target="_blank" rel="noopener noreferrer">{prLabel(worker.prUrl)}</a> : '—'} />
      </Section> : snapshotQuery.status === 'idle' || snapshotQuery.status === 'loading'
        ? <SkeletonList rows={4} label="Loading fleet snapshot" />
        : snapshotQuery.status === 'error' && !snapshotQuery.data
          ? <ErrorState title="Couldn’t load fleet snapshot" reason={readFailureReason(snapshotQuery.error)} onRetry={refetchSnapshot} />
          : <EmptyState title="This job is not in the current fleet snapshot." />}
      {detail === null && !gatewayUnavailable ? <p className={ui.muted}>Job detail is not in this build yet</p> : null}
      <p className={ui.muted}>Worker logs are not available through this gateway yet. Open Phantom on your Mac.</p>
    </>;
  } else if (failed) {
    body = <ErrorState title="Couldn’t load worker" reason={readFailureReason(query.error)} onRetry={refetch} />;
  } else if (detail === undefined) {
    body = <SkeletonList rows={4} label="Loading worker" />;
  } else {
    const pr = safePrUrl(detail.publish?.prUrl);
    const tone = stateTone(detail.state);
    body = <>
      <Section title="Worker">
        <Row title="Lane" trailing={detail.lane ?? '—'} />
        <Row title="Tier" trailing={detail.tier ?? '—'} />
        <Row title="Model" trailing={detail.model ?? '—'} />
        <Row title="State" trailing={<Badge tone={tone === 'unknown' ? 'neutral' : tone}>{detail.state ?? 'unknown'}</Badge>} />
        <Row title="Launched / age" subtitle={metaLine(detail, Date.now())} />
        <Row title="Pull request" trailing={pr ? <a href={pr} target="_blank" rel="noopener noreferrer">{prLabel(pr)}</a> : '—'} />
      </Section>
      <Section title="Log tail" flat>
        <pre className={styles.tail} aria-label="Worker log tail">{detail.log?.tail?.length ? detail.log.tail.join('\n') : 'No log lines available yet.'}</pre>
      </Section>
    </>;
  }
  return <Screen title={job} onBack={() => navigate({ screen: 'runs' })} onRefresh={gatewayUnavailable || detail === null ? refetchSnapshot : refetch}>{body}{tell ? <TellLeaders key={job} prefill={workerTellPrefill(tell)} /> : null}</Screen>;
}

function TellLeaders({ prefill }: { prefill: string }) {
  const { permissions, reachability } = useMobile();
  const [draft, setDraft] = useState(prefill);
  const [sending, setSending] = useState(false);
  const boxId = useId();
  const canAct = canShowActions(permissions);
  const offline = reachability === 'offline' || reachability === 'unreachable';
  const send = () => {
    const text = draft.trim();
    if (!text || sending) return;
    runMobileAction({
      title: 'Tell the leaders',
      consequences: 'Appends your words to the leaders’ inbox on your Mac — they read them newest first.',
      confirmLabel: 'Send', confirm: false,
      run: async () => {
        setSending(true);
        try {
          const token = getMutationToken();
          if (!token) throw new VerseControlLockedError();
          await postFleetRunsInbox(text, token);
        } finally { setSending(false); }
      },
      success: "Landed in the leaders' inbox",
      onDone: () => setDraft((current) => current.trim() === text ? '' : current),
    });
  };
  return <Section title="Tell the leaders" flat footer={canAct ? 'Lands in the leaders’ inbox on your Mac — they read it newest first.' : undefined}>
    {canAct ? <div className={ui.card}>
      <div className={ui.field}>
        <label className={ui.label} htmlFor={boxId}>Your message</label>
        <textarea id={boxId} className={ui.textarea} value={draft} maxLength={6000} onChange={(e) => setDraft(e.target.value)} />
      </div>
      <div className={ui.buttonRow}>
        <Button variant="primary" disabled={!draft.trim() || sending || offline} aria-busy={sending || undefined} onClick={send}>{sending ? '…' : 'Send'}</Button>
      </div>
      {offline ? <p className={ui.faint}>Your Mac isn’t answering. Sending is off until it does; your words stay here.</p> : null}
    </div> : <p className={cx(ui.card, ui.muted)}>{permissions.actReason ?? 'This device can read the fleet but not write to the leaders.'}</p>}
  </Section>;
}
