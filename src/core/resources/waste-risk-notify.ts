import type { AshlrConfig } from '../types.js';
import { desktopNotify } from '../integrations/desktop-notify.js';
import type { WasteRiskProjection } from './waste-risk.js';

/** Caller retains the previous snapshot. Repeated reads of the same high state are silent. */
export async function notifyWasteRiskTransition(
  previous: WasteRiskProjection | undefined,
  current: WasteRiskProjection,
  cfg: AshlrConfig,
): Promise<boolean> {
  if (current.waste_risk !== 'high' || current.hours_to_reset === null ||
      current.hours_to_reset <= 0 || current.hours_to_reset >= 24 ||
      (previous?.lane === current.lane && previous.reset_at === current.reset_at &&
        previous.waste_risk === 'high' && previous.hours_to_reset !== null &&
        previous.hours_to_reset < 24)) return false;
  return desktopNotify('Phantom: unused included capacity',
    `${current.lane}: ${current.projected_unused_at_reset} usage units projected unused; reset in ${current.hours_to_reset.toFixed(1)}h.`, cfg);
}
