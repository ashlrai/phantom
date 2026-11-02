import { Fragment } from 'react';
import { pullUrl, splitRefs } from './job-refs.js';
import styles from './fleet.module.css';

export function JobRefs({ text, onOpenJob }: { text: string; onOpenJob: (id: string) => void }) {
  return <>{splitRefs(text).map((segment, index) => {
    if (segment.kind === 'job') return <button key={index} type="button" className={styles.refButton} aria-label={`Open log for ${segment.value}`} onClick={() => onOpenJob(segment.value)}>{segment.value}</button>;
    const href = segment.kind === 'pr' && segment.repo && segment.number ? pullUrl(segment.repo, segment.number) : null;
    if (href) return <a key={index} href={href} target="_blank" rel="noopener noreferrer">{segment.value}</a>;
    return <Fragment key={index}>{segment.value}</Fragment>;
  })}</>;
}
