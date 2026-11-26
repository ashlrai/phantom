# Router catalog refresh

`phm router catalog refresh --json` discovers models and writes a report and
unified patch under `~/.ashlr/router/catalog/`. This is a dry run by default.
Use `--out-dir DIR` to choose another artifact directory. `--apply` updates only
the generated `src/core/run/model-catalog-data.ts` in the installed package;
it does not update any routing logic or other source files.

Sources are Claude and Codex help, Devin's model listing, Cursor Agent's model
listing, Grok's model listing, Antigravity's `agy models`, and Ollama's loopback
tags endpoint. The Antigravity probe does not inherit metered API credentials
and reflects only the IDs the CLI lists, not API or desktop availability.
Missing CLIs,
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

For official provider documentation (rather than installed CLI discovery),
`phm models radar --fetch --propose --json` reports fresh model candidates and
configured lane retirements, and files unapplied registry patches as pending
inbox notes. `phm models radar schedule` previews the daily job; it runs only
after explicit installation. See [official-source model radar](RADAR.md#official-source-model-radar).
The scheduled command is `phm router catalog refresh --json`: it only writes
report and patch artifacts, never applies catalog changes. Installation does
not run discovery immediately.

## Resident lane auto

Set a per-lane model to `auto` in the resident daemon's isolated
`$ASHLR_RUNS_DIR/models.json`, for example `{"codex.work":"auto"}`. The
lookup order is lane+tier, lane, family+tier, family. An explicit pin still
takes precedence if it matches first. This setting is separate from gateway
`auto`, which selects a seat, and does not enable new seats or spending.

The resident daemon resolves the model before reserving a slot. It uses
the lane's provider, registry/catalog evidence, the seat's native model
list when available, and current subscription-only or local admission.
Deprecated, retired, historical and explicit-only entries are excluded.
Without native model-list evidence, only the existing tier default is
considered. Local execution is limited to its bound runtime default;
Devin's separate native admission is unchanged and its CLI auto is held.
If the default cannot be admitted and no ranked candidate qualifies,
the lane is held rather than switching providers or using metered capacity.

Ranking requires five resolved jobs per model in the same lane, tier and
recorded work class. Without a class recorded for the exact job, the
daemon uses the default instead of guessing a class. Ranking uses held
merges (reverts do not count), first-pass CI,
then lower observed USD per held merge when all tied costs are known.
Unknown evidence stays unknown. The resident dispatch journal
(`~/.ashlr/fleet/runtime/runs.jsonl`) records an `autoModel` receipt with
the candidates, scores, sample counts, and `scored`, `threshold-fallback`,
or `held` reason. `phm route explain` does not read this journal.

Do not enable this in the Mac dispatcher's runs directory until Security
reviews and re-pins the launcher candidate. The re-pinned launcher uses
its existing lane/tier defaults, not the resident scorer, and holds
lanes with no non-metered concrete fallback. `phm models check` warns
when `auto` is present beside an installed Mac dispatcher.
