import type { UsageWindow } from '../../../../core/observe/types.js';

interface HeadroomRow {
  engine: string;
  name: string;
  leftPercent: number | null;
  level: string;
  value: string;
  summary: string;
}

function laneFor(row: HeadroomRow): string | null {
  if (row.engine === 'devin') return 'devin';
  if (row.engine === 'claude') return 'claude-max';
  if (row.engine === 'grok') return 'grok-ultra';
  if (row.engine === 'codex') return /personal/i.test(row.name) ? 'codex-personal' : 'codex-cmp';
  return null;
}

/** A null sensor headroom replaces a stale ledger percent. Fresh headroom is left on the existing row. */
export function applySensorHeadroom<T extends HeadroomRow>(rows: readonly T[], windows: readonly UsageWindow[] | null): T[] {
  if (!windows || windows.length === 0) return [...rows];
  return rows.map((row) => {
    const lane = laneFor(row);
    const sensor = lane ? windows.find((window) => window.lane === lane) : undefined;
    if (!sensor || sensor.headroom !== null) return row;
    return {
      ...row,
      leftPercent: null,
      level: 'unknown',
      value: 'unknown',
      summary: `${row.name}: headroom unknown`,
    };
  });
}
