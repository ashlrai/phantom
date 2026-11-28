# Original #8063 reconciliation

Source head `7032de94c87c04ca89986f17452853c0d0f16d91`, parent
`c47d562d2994926c9ed79447e0a7987e732a93b1`; current baseline
`922deb58f16521928b21b9ad5c98e6ebcd111b72`. Comparison is the source
commit's four named paths, not a merge-base assumption.

| Original FAQ assertion | Current disposition and evidence |
| --- | --- |
| Open-source workbench, coding agents, API resources, local models | Current FAQ introduction, cost and agents answers; README quickstart. |
| RSI, agent-run factory, passive owner; mission and glossary links | Current mission answer; glossary link recovered here. |
| MIT/free; vendor billing, API billing, local hardware | Current cost answer retains the distinction. |
| Claude Code, Codex, Grok, Devin, tool-capable local models | Current lanes answer supersedes this older list; `docs/lanes.md` distinguishes job lanes. No expanded support claim carried. |
| Separate vendor sign-in and Resources readiness, quickstart | Current data answer describes vendor terms; recovered Resources guidance points to `QUICKSTART.md#complete-your-first-readiness-check`. `ReadinessLines.tsx` renders distinct Chat and Fleet verdicts from `/api/verse/budget/readiness`. |
| Everything stays local; cloud always requires `--allow-cloud` | Not carried: current FAQ distinguishes Phantom state from connected vendor traffic; `SECURITY.md` supplies the security boundary. The original blanket assertion is unsafe. |
| Contributing conventions, fork workflow, checks, Merge Gate and auto-merge | Current contributing answer links both contribution guides. |
| Private vulnerability reporting; MIT license; doctor, status, support, public issue | Current security, license and help answers retain these. |

| Other original paths (read-only) | Disposition |
| --- | --- |
| `docs/GLOSSARY.md` | Current Merge Gate entry has the corrected fast gate and scheduled suites, plus secret/generated checks; owner wording, pane link and FAQ link match the original intent. #8122 and successors own other glossary recovery. |
| `docs/README.md` | Original FAQ and glossary index rows and its appended categorized index are absent in this file. The appended links missing here are AGENT-CHAT, AGENT-PROFILES, AGENT-TO-AGENT, AMPLIFY, APP-DRIVE, APPS-CONTROL, AREA-OWNERS, AUTOMATIONS-WATCH, BETS-LANE, BRANCH-GARDENER, BRIEF-SEND, CAPABILITY-REGISTRY, CI-DAILY-PLAN, CLOUD-AGENT-ROUTES, COS-DESKTOP-API, COS, DESKTOP-OPERATOR, DESKTOPCTL, DRAFTS, ECOSYSTEM-ONBOARDING, FLEET-CONFIG, FLEET-VERBS, GRAPH-V1, INTENT, LANE-FIT, LANE-HEALTH, LANE-HOLDS, MCP-TOOLS, MERGE-IDENTITY, NEEDS-YOU, NOTIFICATIONS, OPERATOR-GLANCE, OUTPUT-EVAL, PANES, PROVIDER-CARDS, RADAR, RELEASE-AUTONOMY, REPO-RANK, RESOURCE-LEDGER, SELF-UPDATE, SHIPPED, SLACK-BUS-INGRESS, SLACK-CREDENTIAL-INJECTION, WORK-ORDERS, ZERO-WASTE and main-guardian (`docs/*.md`). Some are indexed elsewhere; this audit does not claim README parity. |
| `docs/llms.txt` | Original generated FAQ description reflected its then-new mission text; current dedicated FAQ and glossary entries and generated FAQ entry index both, with newer mission wording. |

#8312 lists #8063 as an inventory candidate but carries #7566; #8344 and
#8360 explicitly say inventory is not preservation. No FAQ owner was identified
in those reports. This is partial: leave #8063 open, especially for the README
index audit and any work owned by the glossary successors.
