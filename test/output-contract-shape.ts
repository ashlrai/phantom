// Keep field paths and array element shapes while removing volatile values such
// as timestamps, paths and counters from CLI contract snapshots.
export function outputContractShape(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(outputContractShape);
  if (value === null || typeof value !== 'object') return '<value>';
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, outputContractShape(child)]));
}
