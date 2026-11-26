# Ecosystem autonomy audit

## Owner grant update

Run this block on the Mac that holds the current grant. It expects the reviewed
private selection in `~/Downloads/phantom-ecosystem-grant-targets.json` and
existing cleanly identified checkouts for the new enrollments in
`~/Projects/ashlrai`. The selection has `enroll` (short GitHub repo names) and
`promote` (`ashlrai/name` strings) arrays. Review the printed scope and complete
one Touch ID signature. Keep the current Stop and switch posture.

```sh
(
  set -eu
  umask 077
  selection="$HOME/Downloads/phantom-ecosystem-grant-targets.json"
  root="$HOME/Projects/ashlrai"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  jq -e '
    (.enroll | type == "array" and all(.[]; test("^[a-z0-9-]+$"))) and
    (.promote | type == "array" and all(.[]; test("^ashlrai/[a-z0-9-]+$")))
  ' "$selection" >/dev/null
  phm authority draft --reapprove --json > "$tmp/current.json"
  jq -r '.enroll[]' "$selection" > "$tmp/enroll"
  while IFS= read -r repo; do
    checkout="$root/$repo"
    origin="$(git -C "$checkout" remote get-url origin)"
    case "$origin" in
      "https://github.com/ashlrai/$repo"|"https://github.com/ashlrai/$repo.git"|"git@github.com:ashlrai/$repo"|"git@github.com:ashlrai/$repo.git") ;;
      *) printf 'Unexpected origin for %s\n' "$repo" >&2; exit 1 ;;
    esac
    phm enroll add "$checkout" --no-secrets-offer --json
  done < "$tmp/enroll"
  phm authority draft --new --json > "$tmp/candidates.json"
  jq -e --slurpfile candidates "$tmp/candidates.json" --slurpfile selection "$selection" '
    $selection[0] as $want
    | .payload
    | reduce ($want.enroll | unique[] | "ashlrai/" + .) as $name (.;
        if any(.repos[]; .nameWithOwner == $name) then .
        else
          ($candidates[0].payload.repos | map(select(.nameWithOwner == $name))) as $matches
          | if ($matches | length) != 1 then error("Missing enrollment candidate: " + $name)
            else .repos += [$matches[0] | .stage = "propose"]
            | .rollout.stages[-1].repos += [{nameWithOwner: $name, stage: "propose"}]
            end
        end)
    | reduce ($want.promote | unique[]) as $name (.;
        if any(.repos[]; .nameWithOwner == $name) then
          (.repos[] | select(.nameWithOwner == $name) | .stage) = "merge"
          | if any(.rollout.stages[-1].repos[]; .nameWithOwner == $name) then
              (.rollout.stages[-1].repos[] | select(.nameWithOwner == $name) | .stage) = "merge"
            else .rollout.stages[-1].repos += [{nameWithOwner: $name, stage: "merge"}]
            end
        else error("Promotion target is outside the draft: " + $name)
        end)
    | if (.repos | length) > 32 then error("Grant exceeds the 32-repository ceiling") else . end
  ' "$tmp/current.json" > "$tmp/payload.json"
  phm authority grant --payload "$tmp/payload.json"
  phm authority status --json
)
```

The sequence uses the continuation draft for the current scope and the new
draft for enforcement metadata on new enrollments. It adds the requested stage
changes to the last remaining rung and keeps the continuation draft's earlier
rungs, spend, and Phantom self-repository mode. Check the scope printed before
the signature. A raised signed ceiling still depends on rollout, verification,
enforcement and GitHub settings. See [Standing authority](STANDING-AUTHORITY.md).
The local repo enrollment command is separate from
[MCP ecosystem onboarding](ECOSYSTEM-ONBOARDING.md).

## Public repositories

Snapshot audited on 2026-11-26. Grant stages come from the operator-supplied
grant #26 status. GitHub columns come from repository metadata, active branch
rules, protected branch checks where readable, default branch source, Actions
workflow state, Pages configuration, and recent deployment records.

- **GitHub auto-merge** is the repository setting. A live merge also needs the
  signed scope and its independently enforced gates.
- **Checks** lists required names reported by branch rules. Classic protection
  detail was unavailable to the audit credential. **None reported** means the
  readable rules returned no required check. CI source is noted separately.
- **Release** describes the active triggers or the distribution mechanism.
  **Dispatch** means an active workflow declares `workflow_dispatch`.
  Credential and environment permissions were not exercised.
- **Fleet** is checked-in evidence. **Queuegen** means the static queuegen and
  Mac restock lists include the repo. **Owner** means a participant is declared
  in [the repo owner registry](../fleet/repo-owners.json). Live queue rows and
  lane readiness on the Mac were unavailable for this snapshot.

| Repo | Grant #26 | GitHub auto-merge | Required checks / CI | AGENTS.md / Article 1 | Release | Docs and website | Fleet |
| --- | --- | --- | --- | --- | --- | --- | --- |
| [phantom](https://github.com/ashlrai/phantom) | Propose, self-repo merge-non-authority | Yes | Merge Gate and merge queue | Synced | Release Please, train and canonical publishers support dispatch | Docs in repo. Production phm.dev uses the Phantom Secrets host profile | Queuegen, Owner |
| [phantom-secrets](https://github.com/ashlrai/phantom-secrets) | Merge | Yes | CI Gate | Synced | Tag-triggered release, dispatchable rehearsal and registry | phm.dev and /secrets use the signed host profile, deployment unverified here | Queuegen, Owner |
| [ashlr-plugin](https://github.com/ashlrai/ashlr-plugin) | Merge | Yes | CI Gate | Synced | Tag and dispatch | Main-to-Vercel workflow, GitHub Pages from main /docs | Queuegen, Owner |
| [binshield](https://github.com/ashlrai/binshield) | Merge | No | ashlr/verify, verify | Absent | Dispatch | Vercel source and preview records, production trigger unverified | Owner |
| [ashlrcode](https://github.com/ashlrai/ashlrcode) | Merge | No | ashlr/verify, test | Absent | GitHub release event publishes | Company site product route, docs in repo | Owner |
| [ashlr-pulse](https://github.com/ashlrai/ashlr-pulse) | Merge | No | ashlr/verify, build agent, verify | Present, Article 1 missing | Tag-triggered release | Railway main deployment documented as broken | Owner |
| [locus](https://github.com/ashlrai/locus) | Merge | Yes | CI Gate | Present, Article 1 missing | Tag and dispatch | Docs in repo, separate production deployment unverified | Queuegen, Owner |
| [fleet-canary](https://github.com/ashlrai/fleet-canary) | Merge | No | test | Absent | PR/revert canary | No site evidenced | — |
| [ashlr-core-efficiency](https://github.com/ashlrai/ashlr-core-efficiency) | Propose | No | None reported, CI present | Absent | No release workflow in source | Plugin site is owned by ashlr-plugin | — |
| [lexicon](https://github.com/ashlrai/lexicon) | Outside #26 | Yes | CI Gate | Synced | Tag and dispatch | GitHub Pages from main and Vercel previews | Queuegen, Owner |
| [ashlr-stack](https://github.com/ashlrai/ashlr-stack) | Outside #26 | Yes | CI Gate | Synced | Tag and dispatch | Main-to-Vercel workflow | Queuegen, Owner |
| [ashlr-md](https://github.com/ashlrai/ashlr-md) | Outside #26 | Yes | Check (Linux) | Synced | Tag, assembly and publication dispatch | Vercel production deployments recorded from main SHAs | Queuegen, Owner |
| [.github](https://github.com/ashlrai/.github) | Outside #26 | No | None reported, reusable workflows | Absent | Org profile and reusable workflows | GitHub renders the org profile from source | Owner |
| [ashlr-ao](https://github.com/ashlrai/ashlr-ao) | Outside #26 | No | None reported, CI present | Absent | Tag-triggered publish | Main-to-website workflow, supports dispatch | Owner |
| [ashlr-mux](https://github.com/ashlrai/ashlr-mux) | Outside #26 | No | None reported, CI present | Present, Article 1 missing | Tag and dispatch | Vercel config, production trigger unverified | Owner |
| [ashlr-workbench](https://github.com/ashlrai/ashlr-workbench) | Outside #26 | No | None reported, SLA validation workflow | Present, Article 1 missing | No release workflow in source | Docs in repo | — |
| [codedreamer](https://github.com/ashlrai/codedreamer) | Outside #26 | No | None reported, no CI workflow | Absent | No release workflow in source | Docs in repo | — |
| [creatures](https://github.com/ashlrai/creatures) | Outside #26 | No | None reported, CI present | Absent | No release workflow in source | Pages configured from gh-pages, production deployments recorded | Owner |
| [homebrew-idle](https://github.com/ashlrai/homebrew-idle) | Outside #26 | No | None reported, no CI workflow | Absent | Distribution via formulas in Git | Formula docs in repo | — |
| [homebrew-phantom](https://github.com/ashlrai/homebrew-phantom) | Outside #26 | No | None reported, formula verification workflow | Absent | Distribution via formulas in Git | Formula docs in repo | — |
| [homebrew-tap](https://github.com/ashlrai/homebrew-tap) | Outside #26 | No | None reported, no CI workflow | Absent | Distribution via formulas in Git | Formula docs in repo | — |
| [homebrew-webfetch](https://github.com/ashlrai/homebrew-webfetch) | Outside #26 | No | None reported, no CI workflow | Absent | Upstream release updates tap | Formula docs in repo | Owner |
| [idle](https://github.com/ashlrai/idle) | Outside #26 | No | None reported, no CI workflow | Absent | No release workflow in source | Vercel config, production trigger unverified | — |
| [mechanistic-interpretability](https://github.com/ashlrai/mechanistic-interpretability) | Outside #26 | No | None reported, CI present | Absent | No package release workflow in source | MkDocs workflow on main and dispatch, Pages deploys recorded | Owner |
| [morphkit](https://github.com/ashlrai/morphkit) | Outside #26 | Yes | None reported, CI present | Absent | GitHub release event publishes | Vercel production deployments recorded from main SHAs | Owner |
| [perch](https://github.com/ashlrai/perch) | Outside #26 | No | None reported, build workflow | Absent | No release workflow in source | Docs in repo | — |
| [reelint](https://github.com/ashlrai/reelint) | Outside #26 | No | None reported, CI present | Absent | No release workflow in source | No site evidenced | — |
| [runbook-control-plane](https://github.com/ashlrai/runbook-control-plane) | Outside #26 | No | None reported, CI present | Absent | No release workflow in source | Vercel config, production trigger unverified | Owner |
| [solar](https://github.com/ashlrai/solar) | Outside #26 | No | None reported, CI present | Absent | Tag-triggered release | GitHub Pages deployment workflow on main and dispatch | Owner |
| [webfetch](https://github.com/ashlrai/webfetch) | Outside #26 | Yes | None reported, CI present | Absent | Tag publishes npm and updates tap | Vercel previews and Cloudflare config, production trigger unverified | Owner |
| [wrkpad](https://github.com/ashlrai/wrkpad) | Outside #26 | Yes | None reported, CI present | Absent | Agent Board package build supports dispatch, publication unverified | Company site homepage metadata, docs in repo | Owner |

Private repositories and the company site producer are covered in the owner
handoff. The website address is [ashlr.ai](https://ashlr.ai).

## Gaps to close

1. Use the signed repo scope to target fleet queue generation and admission.
   The current seven-repo list includes three repos outside #26 and omits
   multiple signed repos. The checked-in lists predict eligibility at those two
   entry points only. See [queuegen and restock](QUEUE.md#queuegen-dedupe-and-empty-outcome-suppression).
2. Use each repo's sanctioned release path, required check names and
   publication environment. Repos with tag or GitHub-release event triggers
   need a documented way for an authorized agent to produce the trigger.
   Workflow YAML can add a named check or dispatch entry point. GitHub settings
   determine whether the check is required and whether auto-merge is available.
3. Refresh README/install instructions, package metadata and configured public
   site links as scoped jobs. Only change a recorded version or publication
   status after observing its corresponding release or deployment.
