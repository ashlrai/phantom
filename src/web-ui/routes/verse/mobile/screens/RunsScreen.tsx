/**
 * routes/verse/mobile/screens/RunsScreen.tsx — the fleet on your Mac, live,
 * on a phone: who is building, what merged in the last hour, the lane table,
 * personal Codex headroom, the inbox tail — and a line to the leaders
 * through the same guard every phone write uses.
 *
 *   Reads   GET /api/verse/fleet/runs  (runs-queries.ts, polled 10 s while
 *           visible — the route the desktop's Live runs tile reads)
 *   Writes  POST /api/verse/fleet/runs/inbox — runMobileAction, confirmless
 *           like a Leader send: token sheet if the hold lapsed, then POST,
 *           then a toast; a refused send keeps the words in the box.
 *
 * The route family is still landing, so a 404 is its own state ("not in
 * this build yet"), never an error and never a zero. Nulls are honest
 * unknowns and print as —.
 */
import { useId, useState } from 'react';
import { getMutationToken } from '../../../../data/auth-store.js';
import { refetchQuery } from '../../../../data/cache.js';
import { ApiError, readFailureReason } from '../../../../data/client.js';
import { useQuery, useRefetch } from '../../../../data/hooks.js';
import { VerseControlLockedError } from '../../autonomy/control-queries.js';
import { ago } from '../../command/ladder-model.js';
import { usePollWhileVisible } from '../../shell/section-visibility.js';
import { BusSection } from '../BusSection.js';
import { busLiteQuery } from '../bus-query.js';
import { runMobileAction } from '../mobile-actions.js';
import { canShowActions, useMobile } from '../mobile-context.js';
import { fleetRunsQuery, postFleetRunsInbox } from '../runs-queries.js';
import { Button, cx, Screen, SkeletonList } from '../ui.js';
import { Badge, EmptyState, ErrorState, Meter, Row, Section, ui } from '../ui-parts.js';
import styles from './RunsScreen.module.css';

export const RUNS_POLL_MS = 10_000;
/** Worker rows before the list truncates (the Mac's Live runs has the rest). */
export const WORKER_CAP = 40;
export const INBOX_MAX_CHARS = 6_000;
/** The counter shows once the limit is close, not from the first keystroke. */
export const INBOX_COUNT_FROM = 5_000;

/** A count is a real number or an honest dash — never an invented zero. */
const count = (n: number | null | undefined): string => (typeof n === 'number' && Number.isFinite(n) ? String(n) : '—');

/** "300" → "5m": a worker's or leader pass's age, in the tightest form that still reads. */
const ageText = (s: number | null): string => (s === null || !Number.isFinite(s) ? '—'
  : s < 60 ? `${Math.max(0, Math.floor(s))}s` : s < 3_600 ? `${Math.floor(s / 60)}m` : s < 86_400 ? `${Math.floor(s / 3_600)}h` : `${Math.floor(s / 86_400)}d`);

/** "in 2 h" for the Codex window's reset; a passed reset reads "soon". */
function untilText(iso: string, now: number): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 'at an unknown time';
  const ms = t - now;
  if (ms <= 60_000) return 'soon';
  if (ms < 3_600_000) return `in ${Math.round(ms / 60_000)} m`;
  if (ms < 86_400_000) return `in ${Math.round(ms / 3_600_000)} h`;
  return `in ${Math.round(ms / 86_400_000)} d`;
}

/** Pull-to-refresh: force both reads fresh. */
export function refreshRunsScreen(): Promise<unknown> {
  return Promise.all([
    refetchQuery(fleetRunsQuery.key, () => fleetRunsQuery.fetch(), true),
    refetchQuery(busLiteQuery.key, () => busLiteQuery.fetch(), true),
  ]);
}

export function RunsScreen() {
  const { permissions, reachability, navigate } = useMobile();
  const runs = useQuery(fleetRunsQuery);
  const refetch = useRefetch(fleetRunsQuery);
  const notInBuild = runs.error instanceof ApiError && runs.error.status === 404;
  // A missing route is not retried (the query memoizes it), so stop the clock too.
  usePollWhileVisible(refetch, RUNS_POLL_MS, { enabled: !notInBuild });
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const boxId = useId();

  const canAct = canShowActions(permissions);
  const offline = reachability === 'offline' || reachability === 'unreachable';
  const data = runs.data ?? null;

  const send = () => {
    const text = draft.trim();
    if (!text || sending) return;
    runMobileAction({
      title: 'Tell the leaders',
      consequences: 'Appends your words to the leaders’ inbox on your Mac — they read them newest first.',
      confirmLabel: 'Send',
      confirm: false,
      run: async () => {
        setSending(true);
        try {
          const token = getMutationToken();
          if (!token) throw new VerseControlLockedError();
          await postFleetRunsInbox(text, token);
        } finally {
          setSending(false);
        }
      },
      success: "Landed in the leaders' inbox",
      onDone: () => {
        // Only what was sent is cleared: words typed meanwhile stay.
        setDraft((d) => (d.trim() === text ? '' : d));
        refetch();
      },
    });
  };

  let body;
  if (data === null) {
    if (notInBuild) {
      body = <EmptyState title="Live runs is not in this build yet" body="Update Phantom on your Mac to see the fleet here." />;
    } else if (runs.status === 'error') {
      body = <ErrorState title="Couldn’t load live runs" reason={readFailureReason(runs.error)} onRetry={refetch} />;
    } else {
      body = <SkeletonList rows={4} label="Loading live runs" />;
    }
  } else {
    const now = Date.now();
    const laneDown = data.claudeLane !== null && data.claudeLane.toLowerCase().includes('down');
    const leaderAge = data.leaders.reduce<number | null>((best, l) => (l.ageSeconds !== null && (best === null || l.ageSeconds < best) ? l.ageSeconds : best), null);
    const workers = data.workers.slice(0, WORKER_CAP);
    body = (
      <>
        <div className={ui.group}>
          <Row
            title={`${data.workers.length} running · ${count(data.mergesLastHour.count)} merged in the last hour`}
            subtitle={`Last tick ${data.lastTick ? ago(data.lastTick, now) : '—'}${leaderAge !== null ? ` · leaders ${ageText(leaderAge)}` : ''}`}
            trailing={(data.paused === true || laneDown) ? (
              <>
                {data.paused === true ? <Badge tone="danger">Paused</Badge> : null}
                {laneDown ? <Badge tone="warning">Claude lane down</Badge> : null}
              </>
            ) : undefined}
          />
        </div>
        <Section title="Lanes" flat>
          {data.lanes.length === 0 ? <p className={cx(ui.card, ui.muted)}>No lanes reported.</p> : (
            <div className={ui.group}>
              {data.lanes.map((lane) => (
                <Row
                  key={lane.lane}
                  title={lane.lane}
                  subtitle={`${count(lane.running)}/${count(lane.target)} · queued ${count(lane.queued)}${lane.held && lane.heldReason ? ` · ${lane.heldReason}` : ''}`}
                  trailing={lane.held ? <Badge tone="warning">held</Badge> : undefined}
                />
              ))}
            </div>
          )}
        </Section>
        <Section title="Workers" flat>
          {data.workers.length === 0 ? <EmptyState title="Nothing running" body="No worker processes on your Mac right now." /> : (
            <>
              <div className={ui.group}>
                {workers.map((w, i) => (
                  <Row key={`${w.job}-${i}`} title={w.job} subtitle={`${w.repo} · ${w.lane} · ${w.tier}`} trailing={ageText(w.ageSeconds)} />
                ))}
              </div>
              {data.workers.length > WORKER_CAP ? <p className={ui.faint}>+{data.workers.length - WORKER_CAP} more</p> : null}
            </>
          )}
        </Section>
        {data.codexPersonal ? (
          <Section title="Personal Codex" flat>
            <div className={ui.card}>
              <Meter label="Codex (personal)" percent={data.codexPersonal.usedPct} note={data.codexPersonal.resetsAt ? `Resets ${untilText(data.codexPersonal.resetsAt, now)}` : 'Reset time unknown'} />
            </div>
          </Section>
        ) : null}
        <Section title="Tell the leaders" flat footer={canAct ? 'Lands in the leaders’ inbox on your Mac — they read it newest first.' : undefined}>
          {canAct ? (
            <div className={ui.card}>
              <div className={ui.field}>
                <label className={ui.label} htmlFor={boxId}>Your message</label>
                <textarea
                  id={boxId}
                  className={ui.textarea}
                  value={draft}
                  maxLength={INBOX_MAX_CHARS}
                  aria-describedby={draft.length > INBOX_COUNT_FROM ? `${boxId}-count` : undefined}
                  onChange={(e) => setDraft(e.target.value.slice(0, INBOX_MAX_CHARS))}
                />
                {draft.length > INBOX_COUNT_FROM ? <span id={`${boxId}-count`} className={ui.faint}>{draft.length}/{INBOX_MAX_CHARS}</span> : null}
              </div>
              <div className={ui.buttonRow}>
                <Button variant="primary" disabled={!draft.trim() || sending || offline} aria-busy={sending || undefined} onClick={send}>
                  {sending ? '…' : 'Send'}
                </Button>
              </div>
              {offline ? <p className={ui.faint}>Your Mac isn’t answering. Sending is off until it does; your words stay here.</p> : null}
            </div>
          ) : (
            <p className={cx(ui.card, ui.muted)}>{permissions.actReason ?? 'This device can read the fleet but not write to the leaders.'}</p>
          )}
        </Section>
        <Section title="Recent inbox" flat>
          {data.inbox.length === 0 ? <p className={cx(ui.card, ui.muted)}>Nothing sent to the leaders yet.</p> : (
            <div className={ui.group}>
              {data.inbox.map((m, i) => (
                <Row key={`${m.at}-${i}`} leading={<Badge>{m.source}</Badge>} title={<span className={styles.clamp3}>{m.text}</span>} trailing={ago(m.at, now)} />
              ))}
            </div>
          )}
        </Section>
        <BusSection />
      </>
    );
  }

  return (
    <Screen title="Live runs" onBack={() => navigate({ screen: 'more' })} backLabel="More" onRefresh={refreshRunsScreen} label="Live runs">
      {body}
    </Screen>
  );
}
