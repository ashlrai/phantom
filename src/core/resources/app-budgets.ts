const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const number = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
const date = (v: unknown): string | null => typeof v === 'string' && /^\d{4}-\d\d-\d\dT/.test(v) && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null;
export function projectAppBudgets(input: unknown, now = Date.now()) {
  const source = object(input);
  return ['claude-org', 'claude-plan', 'codex', 'grok'].map(provider => {
    const row = object(source[provider]);
    const asOf = date(row['as_of']);
    const fresh = asOf !== null && now >= Date.parse(asOf) && now - Date.parse(asOf) <= 86_400_000;
    const numeric = (key: string) => fresh ? number(row[key]) : null;
    const pct = numeric('used_percent');
    return { provider, asOf, monthlyCreditsUsd: numeric('monthly_credits_usd'), usdRemaining: numeric('usd_remaining'),
      usedPercent: pct !== null && pct <= 100 ? pct : null, resetsAt: fresh ? date(row['resets_at']) : null,
      pacingPercentPerDay: numeric('pacing_percent_per_day') };
  });
}
export type AppBudgets = ReturnType<typeof projectAppBudgets>;
export function appBudgetLabel(row: AppBudgets[number]): string {
  if ([row.monthlyCreditsUsd, row.usdRemaining, row.usedPercent, row.resetsAt, row.pacingPercentPerDay].every(v => v === null)) return `${row.provider}: unknown`;
  const value = (n: number | null, unit: string) => n === null ? `unknown ${unit.trim()}` : `${n}${unit}`;
  return `${row.provider}: ${value(row.monthlyCreditsUsd, ' USD/mo credits')}, ${value(row.usdRemaining, ' USD left')}, ${value(row.usedPercent, '% used')}, reset ${row.resetsAt ?? 'unknown'}, pacing ${value(row.pacingPercentPerDay, '%/day')}`;
}
