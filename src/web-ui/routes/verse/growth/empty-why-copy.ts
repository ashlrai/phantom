import type { FleetEmptyWhyReason } from '../../../../core/fleet/empty-why-classify.js';

/** What each empty-job reason means and what to do about it. */
export const EMPTY_WHY_COPY: Record<FleetEmptyWhyReason, string> = {
  limit: 'The lane hit its usage limit, so the work is lost. Pause the lane sooner.',
  'lint-env': 'Lint or the local toolchain failed before any change landed. Fix the environment, then requeue.',
  interrupted: 'The run was stopped (exit 130) before it finished. Requeue it.',
  blocked: 'The job reported it was blocked or incomplete. Open its log and unblock it.',
  other: 'No known cause in the log tail. Open the log to see what happened.',
};
