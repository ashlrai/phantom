import { useEffect, useMemo, useRef } from 'react';
import { jobControlAvailability } from '../../../../core/fleet/job-control-types.js';
import type { FleetJobTailV1 } from '../../../../core/fleet/runs-job-tail.js';
import { apiGet } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import type { QueryDef } from '../../../data/queries.js';
import { JobControls } from '../fleet-job-log/JobControls.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import styles from './compute.module.css';

export const SESSION_TAIL_LINES = 200;

/** fleet.job.tail.v1 for one session: the snapshot `phm sessions tail <id> --json` starts from. */
export function sessionTailQuery(job: string): QueryDef<FleetJobTailV1> {
  return {
    key: `fleet-session-tail:${job}`, fetch: async signal => {
      const value = await apiGet<FleetJobTailV1>(`/api/fleet/job/tail?id=${encodeURIComponent(job)}&lines=${SESSION_TAIL_LINES}`, signal);
      if (value?.schema !== 'fleet.job.tail.v1' || !Array.isArray(value.events)) throw new Error('Unsupported session tail');
      return value;
    },
  };
}

interface Props {
  job: string;
  /** False when the session runs on another computer: its log and controls are out of reach from here. */
  local: boolean;
  enabled: boolean;
  /** What the session list already knows, shown until the tail answers. */
  known: { lane: string | null; model: string | null; repo: string | null; startedAt: string | null; tokens: number | null };
}

/**
 * The live window into one session: what it is (lane, model, repo, start,
 * tokens), Pause, Resume, Stop and Move, and its last 200 log lines, re-read
 * every 2 seconds while it runs. The log stays pinned to the newest line until
 * the reader scrolls up. Every line is redacted by the server.
 */
export function SessionLive({ job, local, enabled, known }: Props) {
  const query = useMemo(() => sessionTailQuery(job), [job]);
  const tail = useQuery(query, { enabled: enabled && local, freshMs: 0 });
  const refresh = useRefetch(query);
  const data = local ? tail.data : undefined;
  usePollWhileVisible(refresh, 2_000, { enabled: enabled && local && data?.status !== 'finished' });
  const log = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const lines = data?.events ?? [];
  const newest = lines.at(-1)?.text;
  useEffect(() => { if (pinned.current && log.current) log.current.scrollTop = log.current.scrollHeight; }, [lines.length, newest]);
  const controls = !local ? jobControlAvailability('remote')
    : data ? data.controls ?? jobControlAvailability(undefined)
      : { available: false, reason: tail.status === 'error' ? 'Job control unknown: this session could not be read.' : 'Reading this session…' };
  const d = data?.detail;
  const tokens = d?.tokens ?? known.tokens;
  const facts: [string, string | null | undefined][] = [['Lane', d?.lane ?? known.lane], ['Model', d?.model ?? known.model], ['Repo', d?.repo ?? known.repo],
    ['Started', d?.launchedAt ?? known.startedAt], ['Tokens', tokens == null ? null : tokens.toLocaleString('en-US')]];
  return <>
    <dl className={styles.facts}>{facts.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value ?? 'unknown'}</dd></div>)}</dl>
    <div className={styles.steer} role="group" aria-label="Session controls">
      <JobControls job={job} lane={d?.lane ?? known.lane} disabledReason={controls.reason} onDone={refresh} />
    </div>
    <h4>Live log</h4>
    {!local ? <p>Live log unknown: this session runs on another computer.</p>
      : !data ? (tail.status === 'error' ? <p role="alert">The live log could not be read.</p> : <p role="status">Reading the live log…</p>)
        : <>
          {tail.status === 'error' && <p role="alert">The live log stopped refreshing; these lines may be old.</p>}
          {data.message && <p>{data.message}</p>}
          <div ref={log} className={styles.tail} role="log" aria-label={`Live log for ${job}`} tabIndex={0} onScroll={event => {
            const el = event.currentTarget;
            pinned.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 4;
          }}>
            {data.truncated && <div data-source="status">… earlier lines not shown</div>}
            {lines.map((line, index) => <div key={index} data-source={line.source}>{line.source === 'event' ? `[${line.ts ?? 'event'}] ` : ''}{line.text}</div>)}
            {lines.length === 0 && <div data-source="status">No lines yet.</div>}
          </div>
          <small>{data.status === 'finished' ? 'Finished. These are its last lines.' : `Newest lines, re-read every 2 seconds.`} Same stream for agents: <code>phm sessions tail {job} --follow</code></small>
        </>}
  </>;
}
