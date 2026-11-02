/**
 * routes/verse/mobile/fleet-actions.ts — pressing a fleet button on the phone
 * (Home's one button, the Fleet screen's controls): the guarded path
 * (mobile-actions.ts), the swappable client (fleet-client.ts), then a refresh
 * of every read that shows the fleet — the control aggregate, the live view
 * and activity's autonomy badge — so the new state shows at once.
 */
import { getMutationToken, touchMutationHold } from '../../../data/auth-store.js';
import { invalidate } from '../../../data/cache.js';
import { ApiError, apiPost } from '../../../data/client.js';
import { VerseControlLockedError } from '../autonomy/control-queries.js';
import { SURFACE_KEYS } from '../command/surface-data.js';
import { LANE_HOLDS_PATH } from '../fleet-lanes/lane-hold-release.js';
import { refreshActivity } from '../shell/useActivity.js';
import { getMobileFleetClient } from './fleet-client.js';
import type { DaemonVerb, FleetPrimaryAction } from './fleet-state.js';
import { runMobileAction } from './mobile-actions.js';
import { showMobileToast } from './mobile-toast.js';

/** The workbench's control aggregate key (autonomy/control-queries.ts VERSE_CONTROL_KEY). */
export const CONTROL_KEY = 'verse-control';

const DONE_TEXT: Readonly<Record<DaemonVerb, string>> = {
  start: 'Fleet starting',
  stop: 'Fleet stopped',
  pause: 'Fleet paused',
  resume: 'Fleet resumed',
};

export function refreshFleetReads(): void {
  invalidate(CONTROL_KEY);
  invalidate(SURFACE_KEYS.fleetLive);
  void refreshActivity();
}

/**
 * Release a lane hold the fleet placed on itself. Same step-up path as a lane
 * target change: held mutation token, then apiPost — which the remote session
 * turns into a begin/finish step-up when this phone drives the gateway. The
 * Hub releases only autobackoff holds; `reason` lands in its unheld_by audit.
 */
export async function releaseLaneHold(lane: string, reason?: string): Promise<unknown> {
  const token = getMutationToken();
  if (!token) throw new VerseControlLockedError();
  const body: Record<string, unknown> = { lane, action: 'release' };
  if (reason !== undefined) body.reason = reason;
  try {
    const result = await apiPost<unknown>(LANE_HOLDS_PATH, body, token);
    touchMutationHold();
    return result;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      const message = 'This Phantom server cannot release holds yet; update the app.';
      throw new ApiError(message, 404, LANE_HOLDS_PATH, message);
    }
    throw error;
  }
}

export function runFleetAction(action: Extract<FleetPrimaryAction, { kind: 'daemon' }>): boolean {
  let note: string | null = null;
  return runMobileAction({
    title: action.confirm?.title ?? `${action.label} the fleet`,
    consequences: action.confirm?.body ?? '',
    confirmLabel: action.confirm?.confirmLabel ?? action.label,
    destructive: action.destructive,
    confirm: action.confirm !== null,
    run: async () => {
      note = (await getMobileFleetClient().daemon(action.verb)).note;
    },
    onDone: () => {
      refreshFleetReads();
      showMobileToast(note ?? DONE_TEXT[action.verb], 'success');
    },
  });
}
