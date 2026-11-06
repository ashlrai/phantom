# Sandbox mailbox engine adapters

`runMailboxEngine` in `src/core/run/mailbox-engine.ts` provides a one-shot
transport for `codex exec` and `claude -p`. Its caller owns sandbox creation,
confinement, admission, cancellation, diff capture and proposal filing. It does
not dispatch work or grant authority on its own.

The request specifies `engine`, `sandboxDir`, `inbox`, `outbox` and a required
`launcher` from the sandbox owner. Optional `model`, `timeoutMs` and `signal`
are forwarded to the central engine runner. Inbox and outbox paths resolve
relative to the sandbox; absolute paths are accepted only inside it. The inbox
must be a regular UTF-8 file, and the outbox must not exist. Parent directories
must already exist and use canonical paths. Symlink inboxes are refused.

The adapter copies the inbox into a private `.phantom-mailbox-*/prompt.txt`
inside the sandbox, then feeds that file's contents on stdin. Codex receives
`exec --cd <sandbox> --json [--model <model>] -`; Claude receives
`-p --output-format json [--model <model>]`. Prompt contents never become shell
syntax or command arguments. No permission-bypass flags are added.

The central `spawnEngine` path preserves credential filtering, local-only
policy, custody checks, timeout supervision and cancellation. A missing
confinement launcher is terminal; there is no raw-spawn fallback. Callers must
supply a genuine OS launcher whose policy permits the private exchange directory
and worktree. This transport does not verify the launcher's policy or replace
the sandbox owner's authority checks.

Only a successful Claude `result` or a Codex agent message followed by
`turn.completed` becomes a reply. Tool output, partial responses, malformed
protocols, failure events and cancellation never produce a delivery. Input and
captured output are limited to 1 MiB. The reply is UTF-8 text, published by an
atomic exclusive hard link; an existing file or symlink cannot be overwritten.
The filesystem must support hard links within the sandbox. Prompt and reply
files have mode `0600`; the exchange directory is removed after the attempt.
The inbox remains intact on success and failure so the caller controls
acknowledgement/retry. Use a distinct outbox filename for each inbox delivery.

Fake-engine coverage lives in `test/mailbox-engine.test.ts`. It replaces only
the central runner, exercising real prompt staging, file permissions, exact
argv/stdin, protocol decoding, publication and cleanup without contacting a
provider or invoking an installed vendor CLI.
