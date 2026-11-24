# Apps request completion from #5897

At original head `8abebe7868938ca9151ae94b88ebb81cbd5c61f8`,
`src/cli/completions.ts` includes `request` in the `apps` subcommand array
alongside `list`, `open`, `quit`, `focus`, and `status`. The inherited hunk
addressed a doc-facts omission. At current upstream
`b108103bfba6d488bb1022ac291454cae009e6e7`, the same array retains those
verbs and adds `log`, `restart`, and `suggest`.

`test/apps-request-completion-original-5897-857s.test.ts` calls the real
completion generator for Bash and Zsh, isolates each shell's second-word case
and its `apps` branch, and asserts all nine verbs. It proves preservation in
generated suggestions without executing a shell or an app action. No missing
behavior was found in this slice, so no production edit is needed.

All other #5897/#4742 hunks remain unaudited; this slice does not establish
that either broader body of work is reconciled.
