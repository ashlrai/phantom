# Router catalog refresh

`phm router catalog refresh --json` discovers models and writes a report and
unified patch under `~/.ashlr/router/catalog/`. This is a dry run by default.
Use `--out-dir DIR` to choose another artifact directory. `--apply` updates only
the generated `src/core/run/model-catalog-data.ts` in the installed package;
it does not update any routing logic or other source files.

Sources are Claude and Codex help, Devin's model listing, Cursor Agent's model
listing, Grok's model listing, and Ollama's loopback tags endpoint. Missing CLIs,
timeouts, nonzero exits, empty/unparseable responses and HTTP errors are unknown,
not evidence that a model disappeared. `--include-seats` also uses the existing
account-bound gateway discovery without introducing credentials.

The hand-maintained pattern table is first-match-wins. Only lite and normal can
be assigned automatically. Ultra, fusion and invalid tiers are rejected and
reported; those discoveries remain unassigned. Unassigned models are stored
separately, return null from modelModeTier, and route nowhere. Existing tiers
never change during refresh.

When all owning sources succeed but omit a catalog model, its first missed
timestamp is retained as unseen-since. Unknown owning sources (or no owning
pattern) do not create unseen marks. Reappearing models clear their marks.
After 30 days a missing entry is reported as deprecated; after 90 days its
removal is proposed. Refresh never removes models, including with --apply.

`phm router catalog schedule --hour 3` prints weekly Monday launchd or systemd
user units. Add `--install` to install them as a regular user with a built CLI.
The scheduled command is `phm router catalog refresh --json`: it only writes
report and patch artifacts, never applies catalog changes. Installation does
not run discovery immediately.
