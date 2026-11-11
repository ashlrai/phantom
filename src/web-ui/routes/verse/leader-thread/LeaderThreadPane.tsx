import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { OUTBOX_KIND_LABEL } from '../../../../core/fleet/outbox-kind.js';
import { computeLaneHealth, laneHealthLine, stuckBadge } from '../../../../core/fleet/lane-health.js';
import { VERSE_FLEET_RUNS_PATH } from '../../../../core/verse/fleet-runs-types.js';
import { MutationTokenDialog } from '../../../components/auth/MutationTokenDialog.js';
import { hasMutationHold } from '../../../data/auth-store.js';
import { refetchQuery, runQuery } from '../../../data/cache.js';
import { ApiError, apiGet, readFailureReason } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import type { QueryDef } from '../../../data/queries.js';
import { MessageMarkdown } from '../MessageMarkdown.js';
import { useNow } from '../autonomy/use-ticker.js';
import { formatRelative } from '../autonomy/format.js';
import { ActionStatus, useSurfaceActions } from '../command/actions.js';
import { fleetLiveQuery, leaderQuery } from '../command/surface-data.js';
import { openDockPane } from '../dock/dock-store.js';
import { requestWorkerLogJob } from '../fleet-job-log/worker-log-selection.js';
import { laneTargetsQuery } from '../ops/lane-targets-queries.js';
import { agentBusMissing, agentBusPageQuery, agentBusStatusQuery } from '../fleet-bus/agent-bus-queries.js';
import { ordersTraceQuery } from '../fleet-inbox/fleet-inbox-queries.js';
import { narrowOrderTrace, type OrderTraceV1 } from '../fleet-inbox/order-trace-model.js';
import { readMerges, type Merged, type Pending } from '../fleet-merges/fleet-merges-model.js';
import { JobRefs } from '../fleet/JobRefs.js';
import { narrowWorkers, validJob } from '../fleet/workers-card-model.js';
import { jobDetailQuery } from '../fleet/workers-card-queries.js';
import { DirectivesStrip } from '../leader/DirectivesStrip.js';
import { ChannelBadge } from '../leader/ThreadItems.js';
import { leaderDirectivesQuery, leaderThreadQuery } from '../leader/thread-data.js';
import { leaderJournalQuery } from '../leader-journal/leader-journal-queries.js';
import { clockTime, dayLabel } from '../leader/thread-model.js';
import type { LeaderThreadMessage } from '../leader/thread-types.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import leaderStyles from '../leader/leader.module.css';
import styles from './leader-thread.module.css';
import { busRepliesToMason, mergeByTime, type BusReply } from './thread-bus-replies.js';
import { appendLaneLog, laneEventItems, laneTransitions, loadLaneLog, type LaneEvent } from './thread-lane-events.js';
import { fleetInbox, fleetOutbox, lineChannel, lineSourceLabel, mergeThread } from './thread-merge-model.js';
import { canSend, scrollTargetIndex, trimReply } from './thread-reply-model.js';
import { stepMatch, threadMatches, type ThreadFindItem } from './thread-find-model.js';
import { mentionedRefs } from './thread-refs.js';
import { splitScreenshotMarkers } from './thread-screenshots.js';
import { ThreadScreenshot } from './ThreadScreenshot.js';
import { leaderCeoSummary } from './leader-ceo-model.js';
import { LeaderOfficeStrip } from './LeaderOfficeStrip.js';
import { OwnerChannelsStrip } from './OwnerChannelsStrip.js';
import { leaderOfficeQuery } from './leader-office-data.js';
import { mergeOwnerLines, ownerThreadLines, type LabeledLine } from './owner-thread-lines.js';
import { NO_OWNER_THREAD, ownerThreadQuery } from './owner-thread-queries.js';
import { fetchLeaderStatusNow } from './leader-status-now.js';
import { sendLeaderInboxMessage, sendLeaderThreadMessage } from './leader-inbox-data.js';
import { subscribeLeaderDraft, takeLeaderDraft } from './leader-draft-store.js';
import { COMMS_CONFIRM_LINE, COMMS_TOML_PATH, INBOX_HELD_SENTENCE, inboxHeld } from './inbox-held-model.js';
import { CopyPill } from '../apps/CopyPill.js';
import { commandHints, completeCommand, parseComposerDraft } from './composer-commands.js';
import { commandGate, liveComposerDeps, runComposerCommand, type ComposerCommand } from './composer-command-run.js';
import { steerTargetId, steerTargetOutcome, type SteerTargetJobFacts } from './steer-target-outcome.js';

/** Shared 'verse-fleet-runs' key so the pane rides the same cache and SSE invalidation as the other fleet panes. */
const fleetRunsQuery: QueryDef<unknown> = {
  key: 'verse-fleet-runs',
  fetch: signal => apiGet<unknown>(VERSE_FLEET_RUNS_PATH, signal),
};

const NO_MESSAGES: LeaderThreadMessage[] = [];
/** A thread scrolled within this of its end counts as "at the end" (new lines follow it down). */
const STICK_PX = 96;
/** Stand-in def for the disabled slot; `enabled: false` means it never fetches. */
const NO_JOB_DETAIL: QueryDef<null> = { key: 'steer-target:no-detail', fetch: () => Promise.resolve(null) };

/** localStorage can be denied (private mode); the lane-event log just stays session-only then. */
function laneEventStorage(): Storage | null {
  try { return window.localStorage; } catch { return null; }
}

/** One merged line: a system note stays the centered quiet line; the leaders' rows keep the conversation's look; Mason's get a left rule and a source chip. */
function LineView({ line, match, current }: { line: LabeledLine; match?: boolean; current?: boolean }) {
  const leader = line.who === 'leader';
  const iso = Number.isFinite(line.at) ? new Date(line.at).toISOString() : null;
  const clock = iso ? clockTime(iso) : '—';
  if (line.quiet === 'status-ask') {
    return <p className={styles.note} data-find-match={match || undefined} data-find-current={current || undefined}>You asked for status · <span className={leaderStyles.channel}>{lineSourceLabel(line.source)}</span> · <time dateTime={iso ?? undefined}>{clock}</time></p>;
  }
  if (line.source === 'system') {
    return <p className={leaderStyles.system} data-find-match={match || undefined} data-find-current={current || undefined}>{line.text}{iso ? <> <time dateTime={iso}>{clock}</time></> : null}</p>;
  }
  const channel = lineChannel(line.source);
  const label = lineSourceLabel(line.source);
  const refs = leader ? mentionedRefs(line.text) : [];
  return (
    <section data-find-match={match || undefined} data-find-current={current || undefined} className={leader ? leaderStyles.group : `${leaderStyles.group} ${styles.masonLine}`} data-from={line.who} data-source={line.source} aria-label={`${leader ? 'Leader' : 'You'}, ${clock}`}>
      <header className={leaderStyles.groupHead}>
        <span className={leaderStyles.avatar} data-from={line.who} aria-hidden="true">{leader ? 'L' : 'M'}</span>
        <span className={leaderStyles.who}>{line.label ?? (leader ? 'Leader' : 'You')}</span>
        {leader && channel ? <ChannelBadge channel={channel} /> : <span className={leaderStyles.channel} data-channel={channel ?? undefined} title={`Sent via ${label}`}>{label}</span>}
        {line.kind ? <span className={leaderStyles.channel}>{OUTBOX_KIND_LABEL[line.kind]}</span> : null}
        {!leader && line.ack ? <span className={leaderStyles.channel} data-ack={line.ack.state}>{line.ack.text}</span> : null}
        <time className={leaderStyles.time} dateTime={iso ?? undefined} title={iso ? new Date(line.at).toLocaleString('en-US') : 'Time unknown'}>{clock}</time>
      </header>
      <div className={leaderStyles.groupBody}>
        <div className={leaderStyles.entry}>
          {leader
            ? <div className={leaderStyles.leaderText}>
              <div className={leaderStyles.prose}><MessageMarkdown text={line.text} /></div>
              {refs.length ? <div className={styles.refs} aria-label="Mentioned">Mentioned: {refs.map((ref, index) => <span key={ref}>
                {index ? ' ' : null}<JobRefs text={ref.replace(/([^#])#/, '$1 #')} onOpenJob={job => { requestWorkerLogJob(job); openDockPane('worker-log'); }} />
              </span>)}</div> : null}
            </div>
            : <div className={leaderStyles.masonItem}>
              {splitScreenshotMarkers(line.text).map((segment, index) => segment.kind === 'shot'
                ? <ThreadScreenshot key={index} name={segment.name} raw={segment.raw} />
                : segment.text.trim() !== '' ? <p key={index} className={leaderStyles.bubble}>{segment.text}</p> : null)}
            </div>}
        </div>
      </div>
    </section>
  );
}

/** The quiet follow-up under a Mason entry that aimed a steer order at one job (@RQ-id). */
function SteerTargetLine({ id, text, trace, merges, liveByJob, now }: {
  id: string;
  text: string;
  trace: OrderTraceV1 | null;
  merges: { merged: readonly Merged[]; pending: readonly Pending[] };
  liveByJob: ReadonlyMap<string, number | null>;
  now: number;
}) {
  const detailDef = useMemo(() => (validJob(id) ? jobDetailQuery(id) : null), [id]);
  const detail = useQuery(detailDef ?? NO_JOB_DETAIL, { enabled: detailDef !== null });
  usePollWhileVisible(() => { if (detailDef) void runQuery(detailDef.key, () => detailDef.fetch()); }, 10_000, { enabled: detailDef !== null });
  const facts = useMemo<SteerTargetJobFacts>(() => {
    const traceJob = trace?.orders.flatMap(order => order.jobs).find(job => job.id === id) ?? null;
    const merged = merges.merged.find(item => item.job === id) ?? null;
    const pending = merges.pending.find(item => item.job === id) ?? null;
    const age = liveByJob.get(id);
    const data = detail.data;
    return {
      trace: traceJob ? { state: traceJob.state, url: traceJob.url } : null,
      merged: merged ? { number: merged.number, href: merged.href } : null,
      pending: pending ? { href: pending.href } : null,
      live: age === undefined ? null : { launchedAt: age === null ? null : new Date(now - age * 1_000).toISOString() },
      detail: data ? { state: data.state, prUrl: data.publish?.prUrl ?? null, launchedAt: data.launchedAt } : null,
    };
  }, [id, trace, merges, liveByJob, detail.data, now]);
  const outcome = steerTargetOutcome(text, facts);
  if (outcome === null) return null;
  return <p className={leaderStyles.system} data-steer-outcome={outcome.stage}>{outcome.href ? <a href={outcome.href} target="_blank" rel="noreferrer">{outcome.text}</a> : outcome.text}</p>;
}

function BusReplyView({ row, now, match, current }: { row: BusReply; now: number; match?: boolean; current?: boolean }) {
  return <section data-find-match={match || undefined} data-find-current={current || undefined} className={leaderStyles.group} aria-label="Bus reply">
    <header className={leaderStyles.groupHead}>
      <span className={leaderStyles.who}>{row.from}</span>
      <span className={leaderStyles.channel}>Via bus</span>
      <span className={leaderStyles.channel}>{row.kind}</span>
      {row.expired ? <span className={leaderStyles.channel}>expired</span> : null}
      <time className={leaderStyles.time} dateTime={row.at} title={new Date(row.at).toLocaleString()}>{formatRelative(row.at, now)}</time>
    </header>
    <div className={leaderStyles.groupBody}><div className={leaderStyles.entry}>{row.excerpt}</div></div>
  </section>;
}

export function LeaderThreadPane({ visible }: Pick<PaneProps, 'visible'>) {
  const thread = useQuery(leaderThreadQuery, { enabled: visible, freshMs: 5_000 });
  const runs = useQuery(fleetRunsQuery, { enabled: visible, freshMs: 5_000 });
  const laneTargets = useQuery(laneTargetsQuery, { enabled: visible, freshMs: 5_000 });
  const journal = useQuery(leaderJournalQuery, { enabled: visible, freshMs: 30_000 });
  const leader = useQuery(leaderQuery, { enabled: visible, freshMs: 30_000 });
  const fleet = useQuery(fleetLiveQuery, { enabled: visible, freshMs: 30_000 });
  const directives = useQuery(leaderDirectivesQuery, { enabled: visible, freshMs: 30_000 });
  const office = useQuery(leaderOfficeQuery, { enabled: visible, freshMs: 30_000 });
  const owner = useQuery(ownerThreadQuery, { enabled: visible, freshMs: 5_000 });
  const busStatus = useQuery(agentBusStatusQuery, { enabled: visible && !agentBusMissing(), freshMs: 10_000 });
  const after = Math.max(0, (busStatus.data?.retainedCount ?? 0) - 100);
  const busPageQuery = useMemo(() => agentBusPageQuery(after, 100), [after]);
  const busPage = useQuery(busPageQuery, { enabled: visible && busStatus.data?.source === 'available' && !agentBusMissing(), freshMs: 10_000 });
  const orders = useQuery(ordersTraceQuery, { enabled: visible, freshMs: 10_000 });
  const refetchThread = useRefetch(leaderThreadQuery);
  const refetchRuns = useRefetch(fleetRunsQuery);
  const refetchTargets = useRefetch(laneTargetsQuery);
  const refetchOwner = useRefetch(ownerThreadQuery);
  const refetchJournal = useRefetch(leaderJournalQuery);
  const refetchLeader = useRefetch(leaderQuery);
  const refetchFleet = useRefetch(fleetLiveQuery);
  const refetchDirectives = useRefetch(leaderDirectivesQuery);
  const refetchOffice = useRefetch(leaderOfficeQuery);
  const refetchBusStatus = useRefetch(agentBusStatusQuery);
  const refetchBusPage = useRefetch(busPageQuery);
  const refetchOrders = useRefetch(ordersTraceQuery);
  const actions = useSurfaceActions();
  const logRef = useRef<HTMLDivElement>(null);
  const atEnd = useRef(true);
  const inFlight = useRef(false);
  const [statusNow, setStatusNow] = useState<string | null>(null);
  const [checkingStatus, setCheckingStatus] = useState(false);
  const [needsYouOnly, setNeedsYouOnly] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [findIndex, setFindIndex] = useState(0);
  const findRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [held, setHeld] = useState(false);
  const [unlockOpen, setUnlockOpen] = useState(false);
  const [scrollVersion, setScrollVersion] = useState(0);
  const [addingDirective, setAddingDirective] = useState(false);
  /** Composer command results; local to this session, never sent as messages. */
  const [commandLines, setCommandLines] = useState<LabeledLine[]>([]);
  /** Lane held/resumed events, seeded from the persisted log so a reload keeps them. */
  const [laneEvents, setLaneEvents] = useState<LaneEvent[]>(() => loadLaneLog(laneEventStorage()).events);
  // Inbox wall times, the merge and the day labels want a coarse tick.
  const now = useNow(10_000);

  useEffect(() => {
    const take = () => {
      const text = takeLeaderDraft();
      if (!text) return;
      setDraft(prev => prev.trim() ? `${prev.trimEnd()}\n\n${text}` : text);
      inputRef.current?.focus();
    };
    take();
    return subscribeLeaderDraft(take);
  }, []);

  usePollWhileVisible(() => { refetchThread(); refetchRuns(); refetchTargets(); refetchOwner(); }, 5_000, { enabled: visible });
  usePollWhileVisible(refetchDirectives, 30_000, { enabled: visible });
  usePollWhileVisible(() => { refetchJournal(); refetchLeader(); refetchFleet(); refetchOffice(); }, 30_000, { enabled: visible });
  usePollWhileVisible(() => {
    if (!agentBusMissing()) { refetchBusStatus(); if (busStatus.data?.source === 'available') refetchBusPage(); }
  }, 10_000, { enabled: visible && !agentBusMissing() });
  usePollWhileVisible(refetchOrders, 15_000, { enabled: visible });

  // Each lane-targets read is diffed against the stored snapshot; the first
  // ever read records a baseline and emits nothing.
  useEffect(() => {
    const data = laneTargets.data;
    if (!data) return;
    const storage = laneEventStorage();
    const events = laneTransitions(loadLaneLog(storage).snapshot, data.lanes, Date.now());
    const next = appendLaneLog(storage, data.lanes, events);
    setLaneEvents(prev => {
      const last = next.events[next.events.length - 1];
      const prevLast = prev[prev.length - 1];
      return prev.length === next.events.length && prevLast?.lane === last?.lane && prevLast?.kind === last?.kind && prevLast?.atMs === last?.atMs ? prev : next.events;
    });
  }, [laneTargets.data]);

  const read = thread.data;
  const messages = read?.value?.messages ?? NO_MESSAGES;
  const inbox = useMemo(() => fleetInbox(runs.data), [runs.data]);
  const outbox = useMemo(() => fleetOutbox(runs.data), [runs.data]);
  const laneItems = useMemo(() => laneEventItems(laneEvents), [laneEvents]);
  const merged = useMemo(() => mergeThread(messages, inbox, now, runs.data, outbox, laneItems), [messages, inbox, outbox, laneItems, now, runs.data]);
  const busRows = useMemo(() => busRepliesToMason(busPage.data?.messages ?? [], now, outbox), [busPage.data, now, outbox]);
  const ownerRead = owner.data ?? NO_OWNER_THREAD;
  const ownerLines = useMemo(() => ownerRead.paused ? [] : ownerThreadLines(ownerRead.lines, merged.lines), [ownerRead, merged.lines]);
  const trace = useMemo(() => (orders.error ? null : narrowOrderTrace(orders.data)), [orders.data, orders.error]);
  const merges = useMemo(() => readMerges(runs.data), [runs.data]);
  const liveByJob = useMemo(() => new Map((narrowWorkers(runs.data)?.workers ?? []).map(worker => [worker.job, worker.ageSeconds] as const)), [runs.data]);
  const summary = leaderCeoSummary(journal.data);
  const bottleneck = summary.bottleneck ?? leader.data?.value?.latest?.bottleneck?.statement ?? null;
  const health = useMemo(() => fleet.data?.value ? computeLaneHealth(fleet.data.value) : null, [fleet.data]);

  // One row per line, keeping the conversation's day separators; undated lines go last.
  const items = useMemo(() => {
    const out: ThreadFindItem[] = [];
    let day = '';
    for (const item of mergeByTime([...mergeOwnerLines(merged.lines, ownerLines), ...merged.undated], busRows)) {
      if (needsYouOnly && (item.type !== 'line' || !((item.line.source === 'outbox' && (item.line.kind === 'decision' || item.line.kind === 'alert')) || (item.line.who === 'mason' && !item.line.quiet && item.line.ack?.state === 'waiting')))) continue;
      const at = item.type === 'line' ? item.line.at : Date.parse(item.row.at);
      if (Number.isFinite(at)) {
        const d = new Date(at);
        const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
        if (key !== day) {
          day = key;
          out.push({ type: 'day', key: `day-${key}`, label: dayLabel(d.toISOString(), now) });
        }
      }
      out.push(item.type === 'line' ? { ...item, key: item.line.id } : { ...item, key: item.row.key });
    }
    return out;
  }, [merged, ownerLines, busRows, now, needsYouOnly]);

  const matches = useMemo(() => threadMatches(items, findQuery), [items, findQuery]);
  const currentIndex = matches.length ? findIndex % matches.length : 0;
  const currentKey = matches[currentIndex];
  useEffect(() => { if (findOpen) findRef.current?.focus(); }, [findOpen]);
  useLayoutEffect(() => {
    if (findOpen && currentKey) logRef.current?.querySelector<HTMLElement>('[data-find-current="true"]')?.scrollIntoView?.({ block: 'center' });
  }, [findOpen, currentKey]);
  function closeFind() {
    setFindOpen(false);
    setFindQuery('');
    setFindIndex(0);
  }

  const lastKey = items.length ? items[items.length - 1]!.key : null;
  const forcedAt = useRef(scrollVersion);
  useLayoutEffect(() => {
    if (findOpen) return;
    const el = logRef.current;
    const entries = el?.firstElementChild?.children;
    if (!el || !entries || scrollTargetIndex(entries) === -1) return;
    const force = scrollVersion !== forcedAt.current;
    forcedAt.current = scrollVersion;
    if (!force && !atEnd.current) return;
    atEnd.current = true;
    el.scrollTop = el.scrollHeight;
  }, [lastKey, scrollVersion, findOpen]);

  async function checkStatus() {
    setCheckingStatus(true);
    setStatusNow(null);
    try {
      setStatusNow(await fetchLeaderStatusNow() ?? 'Status is unavailable right now.');
    } catch {
      setStatusNow('Status is unavailable right now.');
    } finally {
      setCheckingStatus(false);
    }
  }

  function runCommand(command: ComposerCommand) {
    if (actions.busy) return;
    const done = (text: string) => {
      const at = Date.now();
      setCommandLines(lines => [...lines, { id: `composer-${at}-${lines.length}`, at, who: 'mason', source: 'system', text, ack: null }]);
      setDraft('');
      setScrollVersion(version => version + 1);
    };
    const gate = commandGate(command);
    const run = () => runComposerCommand(command, liveComposerDeps);
    // Writes go through the pane's guarded actions: the button's confirm, then the mutation hold.
    if (gate) actions.act(run, gate.reason, { confirm: gate.confirm ?? undefined, onDone: done });
    else void run().then(done);
  }

  async function send() {
    if (inFlight.current || !canSend(draft, sending) || actions.readOnly) return;
    const parsed = parseComposerDraft(draft);
    if (parsed.kind === 'command') {
      runCommand(parsed);
      return;
    }
    if (!hasMutationHold()) {
      setUnlockOpen(true);
      return;
    }
    const text = trimReply(draft);
    inFlight.current = true;
    setSending(true);
    setFailure(null);
    setHeld(false);
    try {
      await sendLeaderInboxMessage(text);
      setDraft('');
      await refetchQuery(fleetRunsQuery.key, () => fleetRunsQuery.fetch(), true);
      setScrollVersion(version => version + 1);
    } catch (error) {
      if (inboxHeld(error)) setHeld(true);
      else setFailure(readFailureReason(error));
    } finally {
      inFlight.current = false;
      setSending(false);
    }
  }

  /** The thread route has no comms gate, so a held inbox message can still reach the Leader. */
  async function sendToThread() {
    if (inFlight.current || !canSend(draft, sending) || actions.readOnly) return;
    if (!hasMutationHold()) {
      setUnlockOpen(true);
      return;
    }
    inFlight.current = true;
    setSending(true);
    setFailure(null);
    try {
      await sendLeaderThreadMessage(trimReply(draft));
      setDraft('');
      setHeld(false);
      refetchThread();
      refetchRuns();
      setScrollVersion(version => version + 1);
    } catch (error) {
      setFailure(readFailureReason(error));
    } finally {
      inFlight.current = false;
      setSending(false);
    }
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void send();
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Tab' && !event.shiftKey) {
      const completed = completeCommand(draft);
      if (completed !== null) { event.preventDefault(); setDraft(completed); }
      return;
    }
    // A command runs on plain Enter; a message still needs Cmd/Ctrl+Enter.
    const command = !event.shiftKey && parseComposerDraft(draft).kind === 'command';
    if (event.key !== 'Enter' || (!command && !event.metaKey && !event.ctrlKey) || event.nativeEvent.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    event.stopPropagation();
    void send();
  }

  const hints = commandHints(draft);
  const threadMissing = read !== undefined && read.value === null;
  const empty = items.length === 0;
  const loading = empty && read === undefined && runs.data === undefined && runs.error === undefined;
  const busError = busStatus.error ?? busPage.error;
  const busUnavailable = agentBusMissing() || (busError instanceof ApiError && (busError.status === 404 || busError.status === 503))
    || busStatus.data?.source === 'missing' || busStatus.data?.source === 'unavailable';
  let note: string | null = null;
  if (!empty && threadMissing) note = read!.reason ?? 'The Leader conversation is not available on this server.';
  else if (!empty && !inbox.length && runs.error !== undefined) note = 'The fleet inbox could not be reached.';
  else if (!empty && !inbox.length && runs.data !== undefined) note = 'Nothing in Mason’s inbox yet — posts from any channel join this conversation.';

  let body: ReactNode;
  if (loading) {
    body = <p className={leaderStyles.placeholder} aria-busy="true">Reading the conversation…</p>;
  } else if (empty) {
    body = <p className={leaderStyles.placeholder} data-tone={threadMissing ? 'unknown' : undefined}>
      {needsYouOnly ? 'Nothing needs you right now.' : threadMissing ? (read!.reason ?? 'The Leader conversation did not answer.') : 'No conversation or interjections yet — reply below or post to the inbox from any channel.'}
    </p>;
  } else {
    body = items.map(item => {
      if (item.type === 'day') return <div key={item.key} className={leaderStyles.day} role="separator" aria-label={item.label}><span>{item.label}</span></div>;
      if (item.type !== 'line') return <BusReplyView key={item.key} row={item.row} now={now} match={findOpen && matches.includes(item.key)} current={findOpen && item.key === currentKey} />;
      const target = item.line.who === 'mason' ? steerTargetId(item.line.text) : null;
      return <Fragment key={item.key}>
        <LineView line={item.line} match={findOpen && matches.includes(item.key)} current={findOpen && item.key === currentKey} />
        {target !== null ? <SteerTargetLine id={target} text={item.line.text} trace={trace} merges={merges} liveByJob={liveByJob} now={now} /> : null}
      </Fragment>;
    });
  }

  return <div className={styles.root}>
    <ActionStatus actions={actions} />
    <section className={styles.overview} aria-label="Leader overview">
      <h2>Engineering leader</h2>
      {summary.lines.length ? <ul aria-label="CEO summary">{summary.lines.map((line, index) => <li key={index}>{line}</li>)}</ul>
        : <p>CEO summary unavailable.</p>}
      <p><strong>Current bottleneck:</strong> {bottleneck ?? 'Unknown'}</p>
      <LeaderOfficeStrip view={office.data?.value ?? null} />
      <details>
        <summary>Lane health</summary>
        {health?.lanes.length ? <ul>{health.lanes.map(lane => <li key={lane.lane}>
          <strong>{lane.lane}</strong>: {laneHealthLine(lane)}{stuckBadge(lane) ? ` · ${stuckBadge(lane)}` : ''}
        </li>)}</ul> : <p>Lane health unavailable.</p>}
      </details>
    </section>
    <DirectivesStrip read={directives.data} actions={actions} adding={addingDirective} onAddingChange={setAddingDirective} />
    <header><button type="button" disabled={checkingStatus} onClick={() => void checkStatus()}>{checkingStatus ? 'Checking…' : 'Status now'}</button> <button type="button" aria-pressed={needsYouOnly} onClick={() => setNeedsYouOnly(value => !value)}>Needs you only</button> <button type="button" onClick={() => setFindOpen(true)}>Find</button></header>
    {findOpen ? <div onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeFind(); }
    }}>
      <input ref={findRef} aria-label="Find in conversation" value={findQuery} onChange={event => { setFindQuery(event.target.value); setFindIndex(0); }} onKeyDown={event => {
        if (event.key === 'Enter') { event.preventDefault(); setFindIndex(stepMatch(currentIndex, matches.length, event.shiftKey ? -1 : 1)); }
      }} />
      <span role="status">{matches.length ? `${currentIndex + 1} of ${matches.length}` : 'No matches'}</span>
      <button type="button" onClick={() => setFindIndex(stepMatch(currentIndex, matches.length, -1))}>Prev</button>
      <button type="button" onClick={() => setFindIndex(stepMatch(currentIndex, matches.length, 1))}>Next</button>
      <button type="button" onClick={closeFind}>Close</button>
    </div> : null}
    {statusNow !== null ? <section aria-label="Status now" role="status"><p style={{ whiteSpace: 'pre-wrap' }}>{statusNow}</p><button type="button" onClick={() => setStatusNow(null)}>Dismiss</button></section> : null}
    <p className={styles.note}>{busRows.length} bus replies</p>
    {busUnavailable ? <p className={styles.note} role="status">Durable bus unavailable</p> : null}
    <OwnerChannelsStrip channels={ownerRead.channels} paused={ownerRead.paused} />
    <div ref={logRef} className={leaderStyles.log} role="log" aria-label="Conversation with the Leader" aria-live="polite" aria-relevant="additions" tabIndex={0}
      onScroll={() => {
        const el = logRef.current;
        if (el) atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_PX;
      }}>
      <div className={leaderStyles.logInner}>
        {ownerRead.paused ? <p className={leaderStyles.system}>Owner channels paused</p> : null}
        {body}
        {merged.hiddenNoise > 0 ? <p className={styles.note}>{merged.hiddenNoise} stray command {merged.hiddenNoise === 1 ? 'line' : 'lines'} hidden</p> : null}
        {commandLines.map(line => <LineView key={line.id} line={line} />)}
      </div>
    </div>
    {note ? <p className={styles.note} role="note">{note}</p> : null}
    <form className={styles.reply} onSubmit={onSubmit}>
      <div className={styles.replyRow}>
        <textarea ref={inputRef} aria-label="Reply to the Leader" placeholder="Reply to the Leader…" value={draft} maxLength={6000}
          disabled={sending || actions.readOnly} onChange={event => setDraft(event.target.value)} onKeyDown={onKeyDown} />
        <button type="submit" disabled={!canSend(draft, sending) || actions.readOnly}>Send</button>
      </div>
      {hints.length ? <ul className={styles.note} aria-label="Composer commands">
        {hints.map(hint => <li key={hint.name}><code>{hint.usage}</code> {hint.summary}</li>)}
      </ul> : null}
      {held ? <div className={styles.note} role="status">
        <p>{INBOX_HELD_SENTENCE} Only Mason edits this file.</p>
        <CopyPill text={COMMS_TOML_PATH} what="the comms.toml path" />
        <CopyPill text={COMMS_CONFIRM_LINE} what="the comms.toml confirmation line" />
        <button type="button" disabled={!canSend(draft, sending) || actions.readOnly} onClick={() => void sendToThread()}>Send to the Leader thread instead</button>
      </div> : null}
      {failure ? <p className={styles.replyFailure} role="alert">{failure}</p> : null}
    </form>
    <MutationTokenDialog open={unlockOpen} onClose={() => setUnlockOpen(false)} onUnlocked={() => void send()}
      reason="Messaging the Leader requires the dispatch token." tokenHelp="the mutation token ashlr verse printed" />
    {actions.dialogs}
  </div>;
}
