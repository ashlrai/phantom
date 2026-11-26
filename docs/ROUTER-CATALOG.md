# Router catalog refresh

## Model defaults by task tier

These defaults use the exact IDs in [the verified registry](model-registry.json).
The Gemini API and Antigravity CLI have different model identifiers; a verified
API ID is not evidence that the Gemini CLI accepts it.

| Surface | Frontier | Work | Mid | Fast |
| --- | --- | --- | --- | --- |
| Codex | `gpt-6.2-astra` | `gpt-6.2-sol` | `gpt-6.2-sol` | `gpt-6-luna` |
| Claude coding | `claude-opus-5-5` | `claude-opus-5-5` | `claude-sonnet-5-5` | `claude-haiku-5-5` |
| Gemini API | `gemini-4-carbon` | `gemini-4-neon` | `gemini-4-hydrogen` | `gemini-3.5-flash-lite` |
| Antigravity launcher candidate | `gemini-4-carbon-high` | `gemini-4-neon-xhigh` | `gemini-4-hydrogen-high` | `gemini-4-hydrogen-medium` |

`claude-fable-5-2` is an explicit subscription planning and orchestration
option, subject to its existing role and quota gates. It is not a coding
default. The Gemini API's untiered path still defaults to Neon.
The Mac Gemini CLI lane keeps its existing fallback: the [official Gemini CLI README](https://github.com/google-gemini/gemini-cli/) says Pro/Ultra moved to Antigravity CLI and Gemini CLI is “Not optimized for Gemini 4+.”
The Mac launcher candidate requires Security review and re-pin before install.

Devin's existing defaults are unchanged. `swe-2-1` and `swe-2-1-lightning`
are unverified fallback-catalog entries: their exact IDs are only in the
[secondary model listing](https://providers.dev/providers/devin/).
Devin Fusion is documented as a picker feature, not as a headless model ID.
Cursor Composer 2.5's exact CLI ID and GLM-5.4's API ID are unverified.

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
The scheduled command is `phm router catalog refresh --json`: it only writes
report and patch artifacts, never applies catalog changes. Installation does
not run discovery immediately.
