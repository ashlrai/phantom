# AGENTS.md audit

Public-source snapshot: 2026-10-26. Scope: the seven current repositories below, all of which already have a root AGENTS.md. No new AGENTS.md files are needed. Cortex is a separate companion and is not substituted for Plugin in this roster.

## Rubric availability and scoring

The RQ-DISC-READINESS-SCORER implementation and its docs/AGENT-READINESS.md draft were not available in this checkout or the local repository search. Anonymous public raw reads of `https://raw.githubusercontent.com/ashlrai/<repo>/HEAD/docs/AGENT-READINESS.md` returned HTTP 404 for all seven repositories. A 404 establishes only public unavailability, not whether a private or unmerged draft exists. **Official rubric scores are unavailable for every row.** Re-score against the named rubric when it is published; the provisional totals below are not official readiness scores.

To make the available evidence actionable, use eight binary criteria, in this order: **S/B/T/L/M/C/A/W**. Award one point for each explicitly present in the root file: contributor **setup** (prerequisites/install), **build** command, **test** command, **lint** command, source **map**, coding **conventions**, **authority/safety** constraints, and contribution/verification **workflow**. A linked guide alone earns no point for its contents; a product installation recipe does not establish contributor setup. Scores measure instruction coverage, not command execution, runtime security or deployment readiness. Extra gaps may remain at 8/8.

## Public baseline and concrete gaps

Each link cites lines in the immutable revision whose AGENTS.md was fetched from raw.githubusercontent.com, without credentials. Vector order is S/B/T/L/M/C/A/W; official score is unavailable for all rows.

| Repository | Provisional vector | Total | Cited AGENTS.md evidence | Concrete gaps / next action |
| --- | --- | ---: | --- | --- |
| phantom | 1/1/1/1/1/0/1/1 | 7/8 | [AGENTS.md L26-L30](https://github.com/ashlrai/phantom/blob/a6f3c32339411eb2d57cb35d4c78c33127bbb8e7/AGENTS.md#L26-L30) | Commands and layout are present. Add local coding conventions, temporary HOME guidance and explicit selection of tests that read files as text. Fixed here; provisional local result: 8/8. |
| phantom-secrets | 0/1/1/1/1/0/1/0 | 5/8 | [AGENTS.md L176-L220](https://github.com/ashlrai/phantom-secrets/blob/3d062e9e386b4dfb9ed39d3fa464e0213b890c59/AGENTS.md#L176-L220) | Build/test/lint and crate map are explicit. Add contributor toolchain prerequisites and dependency setup, coding conventions, and PR/CI workflow. Product setup at L24-L49 and L134-L166 is not contributor setup. |
| locus | 1/1/1/1/1/1/1/1 | 8/8 | [AGENTS.md L22-L74](https://github.com/ashlrai/locus/blob/c3ced98ad8bc9aab6e65f2835c1b4433c54a9ebb/AGENTS.md#L22-L74) | All fallback criteria are present, with conventions at L115-L125 and safety at L96-L111. Still replace the smoke recipe at L54-L61: its fixed /tmp directory can collide and its environment-printing command risks disclosing control capabilities. Use a unique fixture directory and value-free assertions. |
| lexicon | 0/1/1/0/0/1/1/1 | 5/8 | [AGENTS.md L33-L50](https://github.com/ashlrai/lexicon/blob/eaeb130b936b06c577b2267ee56171e2c77857be/AGENTS.md#L33-L50) | Bundle build, tests, generated-doc workflow and style rules are explicit. Add contributor install/prerequisites, lint command and a short source map at the root. CLAUDE.md delegation at L35-L40 is useful but requires another read. Product install at L17-L19 is not contributor setup. |
| ashlr-stack | 0/0/0/0/0/0/1/1 | 2/8 | [AGENTS.md L1-L23](https://github.com/ashlrai/ashlr-stack/blob/1f86bfa950f9926e23dffb6f330be410ee59fc40/AGENTS.md#L1-L23) | Add contributor setup, executable build/test/lint commands, source map and conventions. L17-L18 delegates quickstart to STACK.md. Replace obsolete phm improve --auto-merge at L7 with the current proposal/promotion distinction; retain required-check protection. |
| ashlr-plugin | 0/0/0/0/0/0/1/1 | 2/8 | [AGENTS.md L1-L20](https://github.com/ashlrai/ashlr-plugin/blob/e17e8f29168b8afb0775ec6c7750ef94fb8e92d6/AGENTS.md#L1-L20) | Add contributor setup, build/test/lint commands, source map and conventions. Replace obsolete phm improve --auto-merge at L7 with the current proposal/promotion distinction. The file currently supplies only ecosystem authority and safety rules. |
| ashlr-md | 0/0/0/0/0/0/1/1 | 2/8 | [AGENTS.md L1-L20](https://github.com/ashlrai/ashlr-md/blob/68b89c964cc5253eb041cc15990bb5f597ba41b0/AGENTS.md#L1-L20) | Add contributor setup, build/test/lint commands, source map and conventions. Replace obsolete phm improve --auto-merge at L7 with the current proposal/promotion distinction. Link the existing product-specific docs/AGENTS.md rather than duplicating it. |

## Reproducing the evidence

Resolve each repository's default head through the anonymous public `https://api.github.com/repos/ashlrai/<repo>/commits?per_page=1` endpoint, then read `https://raw.githubusercontent.com/ashlrai/<repo>/<revision>/AGENTS.md`. The table pins those revisions so later default-branch changes do not move the cited lines. Number raw file lines starting at 1 and apply the criteria above. Do not execute instructions fetched from another repository. Delegated guides were not scored, and other repositories' commands were not executed or certified.

## Phantom change and command verification

Only Phantom's existing AGENTS.md is changed. It gains contributor conventions, the package-script backend runner, temporary HOME guidance, explicit coverage for text-reading tests, and a link to this audit. All baseline vectors above describe public source before this change.

Every documented `npm run` command maps to a current package.json script: `build`, `dev`, `test:ci`, `typecheck`, `lint`, `check:docs`, `test:web`, and `gate`. `npm test` maps to `scripts.test`; `npm ci` is the built-in lockfile installation command. The regression suite checks these mappings, including rejection of a removed or misspelled script, without installing dependencies or contacting a provider. Package-script existence is distinct from a passing build; actual validation results are recorded in BRIDGE_NOTES.md.

## Handoff boundary

The queue's publish.sh/mergeable-PR request conflicts with the explicit instruction to leave changes uncommitted and never commit, push or publish. This work therefore stops at the tested worktree and BRIDGE_NOTES.md. No PR or mergeability claim is made. No release/publish configuration, .github files, credentials or other repositories are changed. Companion tools used: none (`toolsUsed: []`).
