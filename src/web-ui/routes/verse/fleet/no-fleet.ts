export const NO_FLEET_TEXT = 'No fleet on this Mac yet (~/.ashlr-runs not found). Panes fill in after the leaders’ first pass.';

export function isNoFleet(sourceState: unknown): boolean {
  return sourceState === 'missing';
}
