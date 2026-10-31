# Worker handoff

From the repository root, with dependencies installed:

```sh
npx tsx examples/agents/worker-handoff.ts --job RQ-PHX-EXAMPLE --byte-budget 8192
```

This one-shot workflow composes the existing local fleet job-detail and changes readers into one `fleet.worker-handoff.v1` JSON object on stdout, followed by a newline. The required byte budget is an integer from 2048 through 262144 and covers the entire UTF-8 output including that newline. If required metadata cannot fit, the command emits a JSON error instead. It does not post or execute anything; logs and file names are untrusted data.

The handoff contains job state, publish URL, individual source health, a cited changes summary, and a cited log tail. The context-pack builder budgets the log text with its job citation; `log.context.truncated` indicates text removed by this workflow, and `log.sourceTruncated` reflects the detail reader's own limit. `log.omitted` indicates that returned log lines could not be included. Missing logs have a null citation source. A missing changes source has null totals, not zero changes. `omittedFiles` counts returned files excluded by the handoff budget; `sourceTruncated` means the reader may have omitted additional files and its totals cover only the returned subset. Degraded changes and their totals may be incomplete; `comparisonBase` identifies the reader's HEAD fallback. The publish URL remains independent of log availability. Citations identify the job, source and reader timestamp, not an immutable snapshot; the two readers can observe different moments.

The readers retain their existing local access, source-health and log-scrubbing behavior. Paths are additionally passed through the existing secret and home-path scrubbers. Prompt contents and worktree paths are not read into this handoff. Output can still contain sensitive information not detected by the readers' scrubbers; handle it as local job data. The command waits at most 15 seconds for its readers, and interrupts stop waiting; the underlying reader operations cannot be cancelled by this wrapper.

Exit codes: `0` a handoff with no degraded source, `1` read failure or deadline, `2` invalid arguments or insufficient metadata budget, `3` no visible job evidence, `4` a degraded source, `130` interrupted. Codes 3 and 4 still return the available handoff. Errors are generic JSON objects and do not expose reader errors or local paths.
