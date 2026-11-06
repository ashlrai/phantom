import { Fragment } from 'react';
import { pullUrl, splitRefs } from '../fleet/job-refs.js';

export function BusRefs({ text, onOpenJob }: { text: string; onOpenJob: (job: string) => void }) {
  return <>{splitRefs(text).map((segment, index) => {
    if (segment.kind === 'job' && !['RQ-', 'LAND-', 'FIX-'].includes(segment.value)) return <button key={index} type="button" aria-label={`Open worker ${segment.value}`} onClick={() => onOpenJob(segment.value)} style={{ padding: 0, border: 0, background: 'none', color: 'var(--accent-600)', font: 'inherit', textDecoration: 'underline', cursor: 'pointer' }}>{segment.value}</button>;
    const href = segment.kind === 'pr' && segment.repo && segment.number ? pullUrl(segment.repo, segment.number) : null;
    if (href) return <a key={index} href={href} target="_blank" rel="noopener noreferrer">{segment.value}</a>;
    return <Fragment key={index}>{segment.value}</Fragment>;
  })}</>;
}
