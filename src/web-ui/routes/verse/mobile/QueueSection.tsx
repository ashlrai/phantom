import { readFailureReason } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { JOB_ID_RE } from '../fleet-job-log/worker-log-model.js';
import { explainReason } from '../ops/ops-queue-model.js';
import { opsQueueQuery } from '../ops/ops-queue-queries.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { sinceText } from './connectivity.js';
import { useMobile } from './mobile-context.js';
import { groupRows, laneRows, queueHeadline, queueTone, skipRows } from './queue-model.js';
import { SkeletonList } from './ui.js';
import { Badge, Banner, ErrorState, Row, Section, ui, type Tone } from './ui-parts.js';

const BADGE_TONE: Record<ReturnType<typeof queueTone>, Tone> = {
  danger: 'danger', warn: 'warning', ok: 'success', neutral: 'neutral',
};

export function QueueSection() {
  const { navigate } = useMobile();
  const read = useQuery(opsQueueQuery, { freshMs: 0 });
  const refetch = useRefetch(opsQueueQuery);
  usePollWhileVisible(refetch, 15_000);
  const q = read.data;
  const badge = q ? <Badge tone={BADGE_TONE[queueTone(q)]}>{queueHeadline(q)}</Badge> : undefined;

  let body;
  if (q === null) body = <p className={ui.muted}>Queue not in this build</p>;
  else if (q === undefined && read.status === 'error') body = <ErrorState title="Couldn’t read the queue" reason={readFailureReason(read.error)} onRetry={refetch} />;
  else if (q === undefined) body = <SkeletonList rows={2} label="Loading the queue" />;
  else {
    body = (
      <div className={ui.stack}>
        {read.status === 'error' ? <Banner>Queue could not refresh. Showing the last reading.</Banner> : null}
        {Object.values(q.sources).some((source) => source !== 'healthy') ? <Banner>Queue data may be incomplete.</Banner> : null}
        {q.byLane.length > 0 ? <div className={ui.group} aria-label="Queue by lane">
          {laneRows(q).map((lane) => <Row key={lane.lane} title={lane.lane} trailing={`${lane.ready} ready · ${lane.parked} parked`} />)}
        </div> : null}
        {q.groups.length > 0 ? <div className={ui.group} aria-label="Parked groups">
          {groupRows(q).map((group, index) => <Row
            key={`${group.reason}:${group.lane}:${index}`}
            title={explainReason(group.reason).title}
            subtitle={<>{group.lane}{group.jobs.length > 0 ? <> · {group.jobs.map((job, jobIndex) => <span key={`${job}:${jobIndex}`}>
              {jobIndex > 0 ? ', ' : null}{JOB_ID_RE.test(job) ? <button type="button" className={`${ui.btn} ${ui.plain}`} aria-label={`Open worker ${job}`} onClick={(event) => { event.stopPropagation(); navigate({ screen: 'worker', job }); }}>{job}</button> : job}
            </span>)}</> : null}{group.more > 0 ? <> · +{group.more} more</> : null}</>}
            trailing={`${group.count} parked`}
          />)}
        </div> : null}
        {q.skips.length > 0 ? <div className={ui.group} aria-label="Latest precheck skips">
          {skipRows(q).map((skip, index) => {
            const at = Date.parse(skip.at);
            return <Row key={`${skip.at}:${skip.job}:${index}`} title={`${skip.job} · ${skip.code} · ${skip.reason}`} trailing={<time dateTime={skip.at}>{sinceText(Number.isFinite(at) ? at : null)}</time>} onClick={JOB_ID_RE.test(skip.job) ? () => navigate({ screen: 'worker', job: skip.job }) : undefined} />;
          })}
        </div> : null}
      </div>
    );
  }
  return <Section title="Queue" trailing={badge} flat>{body}</Section>;
}
