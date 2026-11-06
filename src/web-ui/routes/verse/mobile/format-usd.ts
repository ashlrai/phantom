export function formatUsd(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return value >= 100 ? `$${Math.round(value)}` : `$${value.toFixed(2)}`;
}

