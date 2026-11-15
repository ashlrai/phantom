import { usagePace, type UsagePaceInput } from './usage-pace.js';

export function UsagePaceChip(input: UsagePaceInput) {
  const pace = usagePace(input);
  const text = pace.kind === 'on-pace' ? 'On pace'
    : pace.kind === 'waste' ? `Will waste ~${Math.round(pace.wastePct)}%`
    : pace.kind === 'runs-out' ? `Runs out ~${new Date(pace.runsOutAt).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false })}`
    : 'unknown';
  const title = `Used: ${input.usedFrac === null ? 'unknown' : `${input.usedFrac * 100}%`}; rate per hour: ${input.ratePerHour === null ? 'unknown' : `${input.ratePerHour * 100}%`}; reset: ${input.resetAt ?? 'unknown'}; now: ${Number.isFinite(input.now) ? new Date(input.now).toISOString() : 'unknown'}`;
  return <span data-usage-pace={pace.kind} title={title} style={{ borderRadius: '999px', padding: '2px 6px', background: pace.kind === 'waste' ? '#fef3c7' : 'var(--surface-raised, #eee)', color: pace.kind === 'waste' ? '#78350f' : 'inherit' }}>{text}</span>;
}
