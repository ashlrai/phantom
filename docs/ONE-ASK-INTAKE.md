# One-ask intake boundary

`intakeOneAsk` in `src/core/one-ask/intake.ts` checks a proposed one-repository
scope before a caller accepts an ask. It returns either an accepted copy or a
refusal with a code and reason. This is an intake primitive; it does not launch
work and is not wired into existing cloud, chat, or fleet entry points.

A trusted caller supplies exactly one `owner/name` repository and a complete
list of concrete repo-relative files. Expand directories before calling. For
files under `test/`, provide the trusted base content, or `null` for a new
file, so the existing Tier-1 test classifier can examine imports. Never derive
that evidence from the ask or from a model. The guard applies Phantom's
protected-path rules conservatively to all repositories, rejects `.github`, and
checks the active repository hold store. An unreadable hold store refuses.
Literal references to protected paths and some other repository identities in
the ask also cause refusal; these checks can only restrict admission. The ask
is carried as opaque data, not interpreted as instructions to this guard.

Natural language and literal matching cannot establish a complete scope. A
caller must independently establish the file and repository targets, prevent
execution from expanding them, recheck holds and targets at execution time,
and apply the existing diff and authority gates before delivery. Intake is not
a sandbox, a grant, or a substitute for those checks. A new test's later
contents, for example, need review in the resulting diff.
