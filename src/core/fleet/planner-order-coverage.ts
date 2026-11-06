import type { OrderTraceV1 } from './order-trace.js';

/** Summarize the newest orders chronologically without reading any sources. */
export function orderCoverageBriefLines(trace: OrderTraceV1, limit = 16): string[] {
  if (trace.orders.length === 0) return ['(no timestamped orders)'];
  const degraded = Object.entries(trace.sources).filter(([, state]) => state !== 'healthy')
    .map(([source, state]) => `${source} ${state}`);
  const count = Math.max(0, Math.floor(limit));
  return [
    ...(degraded.length ? [`(degraded sources: ${degraded.join(', ')})`] : []),
    ...trace.orders.slice(count === 0 ? trace.orders.length : -count).map(order => {
      // eslint-disable-next-line no-control-regex -- sources must remain a single printable line.
      const source = order.source.replace(/[\x00-\x1f\x7f-\x9f]/g, '').slice(0, 40);
      const states = new Map<string, number>();
      for (const job of order.jobs) states.set(job.state, (states.get(job.state) ?? 0) + 1);
      const coverage = order.jobs.length === 0 ? 'UNSERVED' :
        `${order.jobs.length} job(s) (${[...states.keys()].sort().map(state => `${state} ${states.get(state)}`).join(', ')})`;
      return `${order.key} ${source}: ${coverage}`;
    }),
  ];
}
