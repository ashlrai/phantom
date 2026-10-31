# Job release evidence

From the repository root, with dependencies installed:

```sh
npx tsx examples/agents/job-release-evidence.ts --job RQ-EXAMPLE --repo /path/to/repo --tag v1.2.3 --merge-sha 0123456789abcdef0123456789abcdef01234567
```

The command reads the local job snapshot and resolves the named local tag to a commit. `--merge-sha` is optional and must be a full 40- or 64-character hexadecimal commit ID. Supply it only after independently verifying that it is the job's merge commit: this command cannot establish that relationship, verify a PR merged, or verify that a tag was published. It checks only whether that asserted commit is an ancestor of the tag. A base SHA, PR URL, or auto-merge setting alone is insufficient evidence. No network access or tagging is performed.

The JSON result contains `status` (`included`, `not-included`, or `unknown`), a reason, `tagSha` (or null if unavailable), job state, and the base and publish source health. Missing or degraded evidence, a running job, unavailable objects, Git errors, and a negative ancestry check in a shallow repository yield `unknown`. The supplied repository and tag must correspond to the intended release; local tags and objects are trusted inputs. The reader's logs, messages, paths, and PR URL are not emitted or executed.

Exit codes are 0 for included or help, 3 for not included, 4 for unknown, 2 for invalid arguments, and 1 for an unexpected error. Errors are JSON except for help. Git calls have a five-second timeout and bounded output; no polling or waiting workflow is used.
