# Wait for publication

From the repository root, with dependencies installed:

```sh
npx tsx examples/agents/wait-publish.ts --job RQ-PHX-EXAMPLE --timeout-ms 300000 --interval-ms 5000
```

All three options are required. The timeout is an integer from 1 to 3,600,000 milliseconds; the interval is an integer from 1 to 60,000 milliseconds. Polling starts immediately and never waits beyond the deadline. The workflow reads the current user's fleet job detail through the desktop's existing reader; it does not retry jobs or start workers. The reader's bounded, scrubbed projection and source-health rules apply. Logs and messages are data, never commands.

A successful read requires state `published`, a healthy publish source, and a nonempty `publish.prUrl`. A running job with an older publish record, an archived log, a missing worker, or unknown state alone is not publication. The result is a single JSON line containing `job` and `prUrl`. Other source degradation does not establish or invalidate the publish record; a degraded publish source is a read failure. The PR URL is the reader's scrubbed value and is not independently verified against a remote service.

Errors are a single JSON line with a generic `error` and, for valid arguments, `job`. Exit codes are `0` for publication, `1` for a reader or publish-source failure, `2` for invalid arguments, `3` for timeout, and `130` for cancellation (including SIGINT or SIGTERM). An embedding caller can pass an AbortSignal to the exported runner. Cancellation stops waiting but cannot cancel a read already in progress because the underlying reader does not accept a signal.
