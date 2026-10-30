# Version audit findings

The seven companions are listed in docs/AGENT-TOOLCHAIN.md: phantom,
phantom-secrets, locus, lexicon, ashlr-stack, ashlr-cortex and ashlr-md.
Locus tools are not exposed in this session. No account access is needed for
anonymous fetch. No companion tools called (toolsUsed: []).
The final user instruction prohibits commits and publication, overriding the
queue text requesting publish.sh. Prepare a tested uncommitted handoff.

Live checks found Cargo virtual workspaces and npm wrapper distribution paths.
Stack's private root version is bookkeeping, so its CLI is the comparison anchor.
Registry repository identity is required to prevent unrelated crate name collisions.
The final anonymous dry run found 4 confirmed mismatches and 7 incomplete repos;
website badge evidence is absent and later GitHub requests became unavailable.
The full response is preserved in version-drift.json, including source URLs.

Initial typecheck and lint failed because preinstalled node_modules was incomplete.
Repaired with npm ci --ignore-scripts --no-audit --no-fund, without lockfile edits.
An optional process-status diagnostic was denied by the host; no access was added.
