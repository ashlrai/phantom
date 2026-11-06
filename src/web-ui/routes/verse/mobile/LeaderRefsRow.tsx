import { leaderRefs, prHref } from './leader-refs-model.js';
import { useMobile } from './mobile-context.js';
import { Button, cx } from './ui.js';
import { ui } from './ui-parts.js';

export function LeaderRefsRow({ text }: { text: string }) {
  const { navigate } = useMobile();
  const { jobs, prs } = leaderRefs(text);
  if (!jobs.length && !prs.length) return null;
  return (
    <div className={ui.chips} role="group" aria-label="Referenced jobs and PRs">
      {jobs.map((job) => (
        <Button key={job} className={ui.chip} onClick={() => navigate({ screen: 'worker', job })}>{job}</Button>
      ))}
      {prs.map((number) => {
        const href = prHref(number);
        return href ? <a key={number} className={cx(ui.btn, ui.secondary, ui.chip)} href={href} target="_blank" rel="noopener noreferrer">PR #{number}</a> : null;
      })}
    </div>
  );
}
