import { buildOutcomeMetrics, type OutcomeMetrics, type OutcomeMetricsInput } from './outcome-metrics.js';
import { suggestOutcomePolicy, type PolicySuggestion } from './policy-suggest.js';

const show = (value: number | null, percent = false): string => value === null ? 'unknown' : percent ? `${(value * 100).toFixed(1)}%` : value.toFixed(2);
/** Markdown for chief-of-staff attachment; callers control storage and delivery. */
export function renderOutcomeReport(metrics: OutcomeMetrics, suggestions: PolicySuggestion, title = 'Fleet outcome report'): string {
  const lines = [`# ${title}`, '', `${metrics.since} to ${metrics.until} (${metrics.hours} hours).`, '',
    `Evidence: ${metrics.sourceState}; ignored rows: ${metrics.ignoredRows}; merges with unknown times: ${metrics.unknownMergeTimes}.`,
    'Rates describe observed launch attempts; missing measurements are unknown. Durations and merge times are seconds; cost is recorded estimated USD.', '',
    '| Lane / model-tier | Jobs | Finish | PR | Empty | Median duration | Est. cost | PR / empty / duration / cost samples |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |'];
  for (const g of [...metrics.byLane, ...metrics.byModelTier]) lines.push(
    `| ${g.name} | ${g.jobs} | ${show(g.finishRate, true)} | ${show(g.prRate, true)} | ${show(g.emptyRate, true)} | ${show(g.medianDuration)} | ${show(g.estCost)} | ${g.samples.pr} / ${g.samples.empty} / ${g.samples.duration} / ${g.samples.cost} |`);
  if (!metrics.byLane.length) lines.push('', 'No measured launch attempts.');
  for (const r of metrics.byRepo) lines.push('',
    `${r.repo}: ${r.merged} merged; ${show(r.mergesPerDay)} merges/day; seven-day revert rate ${show(r.revertRate, true)} (${r.revertSamples}/${r.merged} observed).`,
    `Time to merge p50/p90/p95: ${show(r.timeToMerge.p50)}/${show(r.timeToMerge.p90)}/${show(r.timeToMerge.p95)} seconds (${r.timeToMerge.samples} samples).`);
  lines.push('', '## Suggestions (advisory)', '');
  const advice = [...suggestions.laneTargetDeltas.map(s => ({ ...s, subject: `${s.lane}: target delta ${s.delta > 0 ? '+' : ''}${s.delta}` })),
    ...suggestions.tierRoutingHints.map(s => ({ ...s, subject: `${s.tier}: consider ${s.preferModel} over ${s.overModel}` })),
    ...suggestions.promptTemplateFlags.map(s => ({ ...s, subject: `${s.lane}: ${s.flag}` }))];
  for (const s of advice) lines.push(`- ${s.subject}. ${s.reason} Evidence strength ${show(s.confidence)}; refs: ${s.evidenceRefs.slice(0, 5).join(', ')}${s.evidenceRefs.length > 5 ? ` (+${s.evidenceRefs.length - 5} more in JSON)` : ''}.`);
  if (!advice.length) lines.push('No suggestions meet the evidence thresholds.');
  lines.push('', 'Suggestions never apply changes. Rates do not establish causation or authorize spending.', '');
  return lines.join('\n');
}
export function generateWeeklySelfReport(input: Omit<OutcomeMetricsInput, 'hours'>): string {
  const metrics = buildOutcomeMetrics({ ...input, hours: 168 });
  return renderOutcomeReport(metrics, suggestOutcomePolicy(metrics), 'Weekly fleet self-report');
}
