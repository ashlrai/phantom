export function gearUpdateTone(label: string | null): 'info' | 'warning' | null {
  if (label === null) return null;
  return /held|failed/i.test(label) ? 'warning' : 'info';
}

export function gearUpdateSpoken(label: string | null): string {
  return label === null ? '' : `, update: ${label}`;
}
