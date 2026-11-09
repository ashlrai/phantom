/**
 * A fleet job id as the server accepts it. Its own module so the phone app's
 * first paint (mobile-router, QueueSection) can validate an id without
 * pulling the whole worker-log model into its critical JS.
 */
export const JOB_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{2,79}$/;
