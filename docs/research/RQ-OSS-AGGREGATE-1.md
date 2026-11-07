# RQ-OSS-AGGREGATE-1 — ranked OSS adoption and build handoff

Checked 2026-11-06. **Dot/Core: please relay the executive summary below to Mason.** This file is the handoff; no message was sent and no queue was edited.

## A. Executive summary

There are open-source desktop agent examples: [OpenCode](https://github.com/anomalyco/opencode) is a coding-agent desktop, [Hope Agent](https://github.com/shiwenwen/hope-agent) presents persistent agent workflows, and [Jan](https://github.com/janhq/jan) is a local-model desktop. They demonstrate pieces of a Grok-Bot-like experience, not verified feature or security equivalence. Phantom already has a Tauri shell, MCP gateway, local inference integration, and multi-node lease/fencing. Extend these rather than replace the product.

Top five bets: (1) MCP gateway lifecycle and conformance; (2) local inference measurement against existing llama-server and oMLX; (3) safe Agent Skills compatibility; (4) desktop streaming and tool-state clarity; (5) restart-safe fleet handoff and status. They are proposed product outcomes, not claims of installed or production acceptance.

License bottom line: bounded adoption of the five explicitly marked candidates below has a re-opened upstream LICENSE; MCP's current root license is a MIT-to-Apache transition, not simply Apache. Licenses of pinned versions, packages, assets, dependencies, model weights, datasets and converted artifacts require separate checks. Preserve applicable notices. Proprietary products are inspiration only. No fork is recommended here.

**Coverage:** Only the local-speed worker report was available on the required recheck, as an uncommitted sibling-worktree file. Desktop, A2A, MCP and multinode reports were not accessible; the queue parent returned EPERM, exact-ID GitHub searches found no PRs, issues or branches, and unrelated PR comments were not exhaustively searchable. The ranking below combines that one table with independent primary-source research, **not a completed five-worker synthesis**. Reconcile the four missing reports before treating the ranking as final. Candidate READY build rows are bounded, independently actionable proposals, not evidence that all research dependencies finished. Check Core's queue for duplicates under lock before appending.

Scoring: impact and strategic fit each 1–5, composite = 0.6 × impact + 0.4 × fit; estimated effort S/M/L and license clarity break ties. Scores are judgments, not measurements. `adopt` means scoped use of a specific candidate, not deployment; `inspire` means independent implementation with no code copied; `evaluate` is deferred.

## B. Master ranked table

| rank | project | url | license | effort | impact | primary slice | recommend | why Phantom (fit; score) |
|---:|---|---|---|---|---:|---|---|---|
| 1 | MCP TypeScript SDK | https://github.com/modelcontextprotocol/typescript-sdk | MIT / Apache-2.0 transition | S | 5 | MCP | adopt | Existing gateway SDK; improve lifecycle (5; 5.0) |
| 2 | llama.cpp | https://github.com/ggml-org/llama.cpp | MIT | M | 5 | local | adopt | Existing llama-server path; measure honest concurrency (5; 5.0) |
| 3 | oMLX | https://github.com/jundot/omlx | Apache-2.0 | M | 5 | local | adopt | Existing loopback path; measure batching/cache (5; 5.0) |
| 4 | Agent Skills | https://github.com/agentskills/agentskills | Apache-2.0 | M | 5 | skills | adopt | Interoperable metadata, preserve trust boundaries (5; 5.0) |
| 5 | mlx-lm | https://github.com/ml-explore/mlx-lm | MIT | M | 5 | local | adopt | Apple Silicon baseline; cache behavior needs measurement (4; 4.6) |
| 6 | assistant-ui | https://github.com/assistant-ui/assistant-ui | MIT | M | 4 | desktop | adopt | Scoped UI components if package compatibility holds (5; 4.4) |
| 7 | OpenCode | https://github.com/anomalyco/opencode | MIT | M | 4 | desktop | inspire | Session/workspace ergonomics (4; 4.0) |
| 8 | LangGraph | https://github.com/langchain-ai/langgraph | MIT | M | 4 | orchestration | inspire | Durable checkpoint and resume concepts (4; 4.0) |
| 9 | A2A | https://github.com/a2aproject/A2A | Apache-2.0 | M | 4 | orchestration | inspire | Interoperable handoff model; preserve local authority (4; 4.0) |
| 10 | Qwen3-4B MLX 4-bit | https://huggingface.co/Qwen/Qwen3-4B-MLX-4bit | Apache-2.0, worker reported | S | 4 | local | evaluate | Worker candidate; exact weight revision and fit unverified (4; 4.0) |
| 11 | Ollama | https://github.com/ollama/ollama | MIT | S | 3 | local | inspire | Existing provider; readiness and baseline metrics (4; 3.4) |
| 12 | Hope Agent | https://github.com/shiwenwen/hope-agent | MIT | M | 3 | desktop | inspire | Persistent workflow presentation (4; 3.4) |
| 13 | AutoGen | https://github.com/microsoft/autogen | MIT code; docs separate | M | 3 | orchestration | inspire | Bounded agent handoffs (4; 3.4) |
| 14 | Aider repo map | https://github.com/Aider-AI/aider | Apache-2.0, worker reported | M | 3 | local | inspire | Compact context, validate task outcomes (4; 3.4) |
| 15 | NATS Server | https://github.com/nats-io/nats-server | Apache-2.0 | L | 3 | multinode | evaluate | Event transport only; current SSH witness remains authority (3; 3.0) |
| 16 | lm-evaluation-harness | https://github.com/EleutherAI/lm-evaluation-harness | MIT; corrected LICENSE.md rechecked | M | 3 | local | evaluate | Useful evaluation design; integration fit unproven (3; 3.0) |
| 17 | etcd | https://github.com/etcd-io/etcd | Apache-2.0 | L | 3 | multinode | evaluate | Consensus is costly for two Macs (3; 3.0) |
| 18 | memberlist | https://github.com/hashicorp/memberlist | MPL-2.0 | L | 2 | multinode | inspire | Gossip is not fencing or admission (3; 2.4) |
| 19 | Jan | https://github.com/janhq/jan | Apache-2.0, worker reported | L | 2 | desktop | inspire | Local-model desktop reference (3; 2.4) |
| 20 | vLLM-Metal | https://github.com/vllm-project/vllm-metal | Apache-2.0, worker reported | L | 2 | local | evaluate | Mac hardware tradeoffs remain unmeasured (2; 2.0) |

Ties use effort, then license clarity. Project-root license re-opened for each `adopt`: [MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/LICENSE), [llama.cpp](https://github.com/ggml-org/llama.cpp/blob/master/LICENSE), [oMLX](https://github.com/jundot/omlx/blob/main/LICENSE), [Agent Skills](https://github.com/agentskills/agentskills/blob/main/LICENSE), [assistant-ui](https://github.com/assistant-ui/assistant-ui/blob/main/LICENSE), [mlx-lm](https://github.com/ml-explore/mlx-lm/blob/main/LICENSE). These root checks are not transitive clearance. Recheck the exact pinned revision before copying, packaging, or distribution.

## C. Proposed READY implementation rows

Core: inspect existing queue for duplicate or overlapping jobs before materializing prompts and appending under lock. These rows are proposed; no prompt files or queue entries were created. The source tree's constitution has Articles 1 and 9, **no Article 2**; stubs explicitly require verifying the applicable Article 2 text rather than inventing it. Never turn a source proposal into an installed-runtime or production claim.

```tsv
job_id	repo	lane	tier	prompt_path
RQ-OSS-ADOPT-MCP-LIFECYCLE-1	phantom	devin	work	/Users/masonwyatt/.ashlr-runs/queue/prompts/RQ-OSS-ADOPT-MCP-LIFECYCLE-1.md
RQ-OSS-ADOPT-SKILLS-COMPAT-1	phantom	devin	work	/Users/masonwyatt/.ashlr-runs/queue/prompts/RQ-OSS-ADOPT-SKILLS-COMPAT-1.md
RQ-OSS-ADOPT-DESKTOP-STREAM-1	phantom	devin	work	/Users/masonwyatt/.ashlr-runs/queue/prompts/RQ-OSS-ADOPT-DESKTOP-STREAM-1.md
RQ-OSS-ADOPT-LOCAL-BENCH-1	phantom	devin	frontier	/Users/masonwyatt/.ashlr-runs/queue/prompts/RQ-OSS-ADOPT-LOCAL-BENCH-1.md
RQ-OSS-ADOPT-LOCAL-CACHE-1	phantom	devin	work	/Users/masonwyatt/.ashlr-runs/queue/prompts/RQ-OSS-ADOPT-LOCAL-CACHE-1.md
RQ-OSS-ADOPT-MODEL-PROVENANCE-1	phantom	devin	work	/Users/masonwyatt/.ashlr-runs/queue/prompts/RQ-OSS-ADOPT-MODEL-PROVENANCE-1.md
RQ-OSS-ADOPT-FLEET-RESUME-1	phantom	devin	frontier	/Users/masonwyatt/.ashlr-runs/queue/prompts/RQ-OSS-ADOPT-FLEET-RESUME-1.md
RQ-OSS-ADOPT-NODE-OBSERVE-1	phantom	devin	work	/Users/masonwyatt/.ashlr-runs/queue/prompts/RQ-OSS-ADOPT-NODE-OBSERVE-1.md
RQ-OSS-ADOPT-DESKTOP-SESSIONS-1	phantom	devin	work	/Users/masonwyatt/.ashlr-runs/queue/prompts/RQ-OSS-ADOPT-DESKTOP-SESSIONS-1.md
```

### RQ-OSS-ADOPT-MCP-LIFECYCLE-1 — MCP gateway lifecycle

- Repo: phantom; lane: devin; tier: work.
- Build: Extend src/core/mcp-gateway.ts and existing tests with bounded timeouts, cancellation, reconnect, and tool-list cache invalidation.
- Start by inspecting existing code, recent changes and overlapping queue work.
- Keep the change narrow and compatible with existing contracts.
- Acceptance: Exercise fake MCP server disconnect, malformed response, timeout, cancellation, reconnect and list changes; verify no leaked resources or tool authority escalation.
- Run affected regression tests with a temporary HOME.
- Run repository required verification and report exact results.
- Exercise the complete changed flow; distinguish source from installed acceptance.
- Preserve the four hard limits: secrets, money, outside sends and data destruction.
- Preserve existing security, owner scope and loopback-only local-model rules.
- Follow Constitution Articles 1 and 9 and applicable standing authority.
- Article 2: locate the applicable canonical text; this checkout has no Article 2 heading.
- Do not invent Article 2 or claim compliance with unseen text; report any gap.
- License checklist: MCP TypeScript SDK; current root MIT/Apache transition.
- Before code reuse, pin revision; inspect component, dependencies and notices.
- Record attribution and preserve required license/NOTICE text for copied code.
- Do not copy proprietary code or assume weights share runtime licensing.
- No spending, provider activation, external sends or production cutover.
- Deliver a reviewed implementation and evidence; do not modify Mac ready.tsv.

### RQ-OSS-ADOPT-SKILLS-COMPAT-1 — Agent Skills compatibility

- Repo: phantom; lane: devin; tier: work.
- Build: Extend existing src/core/fleet/external-skill-audit.ts to validate Agent Skills metadata and load only task-scoped instructions.
- Start by inspecting existing code, recent changes and overlapping queue work.
- Keep the change narrow and compatible with existing contracts.
- Acceptance: Test malformed frontmatter, path traversal, oversized content and untrusted instructions; prove metadata never grants tool or execution authority.
- Run affected regression tests with a temporary HOME.
- Run repository required verification and report exact results.
- Exercise the complete changed flow; distinguish source from installed acceptance.
- Preserve the four hard limits: secrets, money, outside sends and data destruction.
- Preserve existing security, owner scope and loopback-only local-model rules.
- Follow Constitution Articles 1 and 9 and applicable standing authority.
- Article 2: locate the applicable canonical text; this checkout has no Article 2 heading.
- Do not invent Article 2 or claim compliance with unseen text; report any gap.
- License checklist: Agent Skills Apache-2.0.
- Before code reuse, pin revision; inspect component, dependencies and notices.
- Record attribution and preserve required license/NOTICE text for copied code.
- Do not copy proprietary code or assume weights share runtime licensing.
- No spending, provider activation, external sends or production cutover.
- Deliver a reviewed implementation and evidence; do not modify Mac ready.tsv.

### RQ-OSS-ADOPT-DESKTOP-STREAM-1 — Desktop conversation and tool state

- Repo: phantom; lane: devin; tier: work.
- Build: Improve the existing desktop/web conversation with accessible incremental text, explicit tool state and recovery; use assistant-ui only if the chosen package fits.
- Start by inspecting existing code, recent changes and overlapping queue work.
- Keep the change narrow and compatible with existing contracts.
- Acceptance: Test keyboard/screen-reader labels, partial stream, error, cancellation, duplicate events and reconnect in component and integration tests.
- Run affected regression tests with a temporary HOME.
- Run repository required verification and report exact results.
- Exercise the complete changed flow; distinguish source from installed acceptance.
- Preserve the four hard limits: secrets, money, outside sends and data destruction.
- Preserve existing security, owner scope and loopback-only local-model rules.
- Follow Constitution Articles 1 and 9 and applicable standing authority.
- Article 2: locate the applicable canonical text; this checkout has no Article 2 heading.
- Do not invent Article 2 or claim compliance with unseen text; report any gap.
- License checklist: assistant-ui MIT; audit exact package and assets.
- Before code reuse, pin revision; inspect component, dependencies and notices.
- Record attribution and preserve required license/NOTICE text for copied code.
- Do not copy proprietary code or assume weights share runtime licensing.
- No spending, provider activation, external sends or production cutover.
- Deliver a reviewed implementation and evidence; do not modify Mac ready.tsv.

### RQ-OSS-ADOPT-LOCAL-BENCH-1 — Local coding benchmark

- Repo: phantom; lane: devin; tier: frontier.
- Build: Extend existing local inventory with a reproducible, bounded, sandboxed coding benchmark for existing llama-server and oMLX.
- Start by inspecting existing code, recent changes and overlapping queue work.
- Keep the change narrow and compatible with existing contracts.
- Acceptance: With fake runners verify versioned task/model pins, cold/warm samples, timings, timeout and honest unknowns; never execute generated code outside sandbox.
- Run affected regression tests with a temporary HOME.
- Run repository required verification and report exact results.
- Exercise the complete changed flow; distinguish source from installed acceptance.
- Preserve the four hard limits: secrets, money, outside sends and data destruction.
- Preserve existing security, owner scope and loopback-only local-model rules.
- Follow Constitution Articles 1 and 9 and applicable standing authority.
- Article 2: locate the applicable canonical text; this checkout has no Article 2 heading.
- Do not invent Article 2 or claim compliance with unseen text; report any gap.
- License checklist: llama.cpp MIT; oMLX Apache-2.0; datasets and models separate.
- Before code reuse, pin revision; inspect component, dependencies and notices.
- Record attribution and preserve required license/NOTICE text for copied code.
- Do not copy proprietary code or assume weights share runtime licensing.
- No spending, provider activation, external sends or production cutover.
- Deliver a reviewed implementation and evidence; do not modify Mac ready.tsv.

### RQ-OSS-ADOPT-LOCAL-CACHE-1 — Local cache comparison

- Repo: phantom; lane: devin; tier: work.
- Build: Add an opt-in cache/speculation A/B harness using existing local runtimes and identical bounded workloads.
- Start by inspecting existing code, recent changes and overlapping queue work.
- Keep the change narrow and compatible with existing contracts.
- Acceptance: Fixtures verify TTFT, throughput, memory, swap and unsupported metrics as unknown; cancellation and loopback enforcement; no automatic downloads.
- Run affected regression tests with a temporary HOME.
- Run repository required verification and report exact results.
- Exercise the complete changed flow; distinguish source from installed acceptance.
- Preserve the four hard limits: secrets, money, outside sends and data destruction.
- Preserve existing security, owner scope and loopback-only local-model rules.
- Follow Constitution Articles 1 and 9 and applicable standing authority.
- Article 2: locate the applicable canonical text; this checkout has no Article 2 heading.
- Do not invent Article 2 or claim compliance with unseen text; report any gap.
- License checklist: llama.cpp MIT; oMLX Apache-2.0; mlx-lm MIT.
- Before code reuse, pin revision; inspect component, dependencies and notices.
- Record attribution and preserve required license/NOTICE text for copied code.
- Do not copy proprietary code or assume weights share runtime licensing.
- No spending, provider activation, external sends or production cutover.
- Deliver a reviewed implementation and evidence; do not modify Mac ready.tsv.

### RQ-OSS-ADOPT-MODEL-PROVENANCE-1 — Local model provenance pins

- Repo: phantom; lane: devin; tier: work.
- Build: Extend local model inventory with exact source revision, hash, quantization and independent code/weights license provenance.
- Start by inspecting existing code, recent changes and overlapping queue work.
- Keep the change narrow and compatible with existing contracts.
- Acceptance: Test missing or malformed pins, changed digests, unknown licenses, converted artifacts and absent files; do not acquire or commit weights.
- Run affected regression tests with a temporary HOME.
- Run repository required verification and report exact results.
- Exercise the complete changed flow; distinguish source from installed acceptance.
- Preserve the four hard limits: secrets, money, outside sends and data destruction.
- Preserve existing security, owner scope and loopback-only local-model rules.
- Follow Constitution Articles 1 and 9 and applicable standing authority.
- Article 2: locate the applicable canonical text; this checkout has no Article 2 heading.
- Do not invent Article 2 or claim compliance with unseen text; report any gap.
- License checklist: Runtime licenses separate from each weight and conversion.
- Before code reuse, pin revision; inspect component, dependencies and notices.
- Record attribution and preserve required license/NOTICE text for copied code.
- Do not copy proprietary code or assume weights share runtime licensing.
- No spending, provider activation, external sends or production cutover.
- Deliver a reviewed implementation and evidence; do not modify Mac ready.tsv.

### RQ-OSS-ADOPT-FLEET-RESUME-1 — Fleet resume and handoff

- Repo: phantom; lane: devin; tier: frontier.
- Build: Use existing agent bus and queue contracts to expose a restart-safe, provenance-linked run timeline and bounded handoff state.
- Start by inspecting existing code, recent changes and overlapping queue work.
- Keep the change narrow and compatible with existing contracts.
- Acceptance: Test restart, duplicate/reordered events, stale claims and owner isolation; no duplicate external side effects or authority created by handoff.
- Run affected regression tests with a temporary HOME.
- Run repository required verification and report exact results.
- Exercise the complete changed flow; distinguish source from installed acceptance.
- Preserve the four hard limits: secrets, money, outside sends and data destruction.
- Preserve existing security, owner scope and loopback-only local-model rules.
- Follow Constitution Articles 1 and 9 and applicable standing authority.
- Article 2: locate the applicable canonical text; this checkout has no Article 2 heading.
- Do not invent Article 2 or claim compliance with unseen text; report any gap.
- License checklist: LangGraph and AutoGen inspire only; implement independently.
- Before code reuse, pin revision; inspect component, dependencies and notices.
- Record attribution and preserve required license/NOTICE text for copied code.
- Do not copy proprietary code or assume weights share runtime licensing.
- No spending, provider activation, external sends or production cutover.
- Deliver a reviewed implementation and evidence; do not modify Mac ready.tsv.

### RQ-OSS-ADOPT-NODE-OBSERVE-1 — Multi-node event visibility

- Repo: phantom; lane: devin; tier: work.
- Build: Extend current SSH node pool with a bounded read-only event projection for heartbeat, witness and fencing status; preserve existing authority.
- Start by inspecting existing code, recent changes and overlapping queue work.
- Keep the change narrow and compatible with existing contracts.
- Acceptance: Test partition, stale epoch, unresponsive node, owner isolation, bounded records and unknown readings; no broker or live dispatcher cutover.
- Run affected regression tests with a temporary HOME.
- Run repository required verification and report exact results.
- Exercise the complete changed flow; distinguish source from installed acceptance.
- Preserve the four hard limits: secrets, money, outside sends and data destruction.
- Preserve existing security, owner scope and loopback-only local-model rules.
- Follow Constitution Articles 1 and 9 and applicable standing authority.
- Article 2: locate the applicable canonical text; this checkout has no Article 2 heading.
- Do not invent Article 2 or claim compliance with unseen text; report any gap.
- License checklist: NATS and memberlist inspire only; implement independently.
- Before code reuse, pin revision; inspect component, dependencies and notices.
- Record attribution and preserve required license/NOTICE text for copied code.
- Do not copy proprietary code or assume weights share runtime licensing.
- No spending, provider activation, external sends or production cutover.
- Deliver a reviewed implementation and evidence; do not modify Mac ready.tsv.

### RQ-OSS-ADOPT-DESKTOP-SESSIONS-1 — Desktop session recovery

- Repo: phantom; lane: devin; tier: work.
- Build: Improve current Tauri desktop workspace/session restore with explicit disconnected and incomplete run states.
- Start by inspecting existing code, recent changes and overlapping queue work.
- Keep the change narrow and compatible with existing contracts.
- Acceptance: Test multiple workspaces, crash/restart, missing records, duplicate events and keyboard navigation; never replay write effects.
- Run affected regression tests with a temporary HOME.
- Run repository required verification and report exact results.
- Exercise the complete changed flow; distinguish source from installed acceptance.
- Preserve the four hard limits: secrets, money, outside sends and data destruction.
- Preserve existing security, owner scope and loopback-only local-model rules.
- Follow Constitution Articles 1 and 9 and applicable standing authority.
- Article 2: locate the applicable canonical text; this checkout has no Article 2 heading.
- Do not invent Article 2 or claim compliance with unseen text; report any gap.
- License checklist: OpenCode and Hope Agent inspire only; implement independently.
- Before code reuse, pin revision; inspect component, dependencies and notices.
- Record attribution and preserve required license/NOTICE text for copied code.
- Do not copy proprietary code or assume weights share runtime licensing.
- No spending, provider activation, external sends or production cutover.
- Deliver a reviewed implementation and evidence; do not modify Mac ready.tsv.

## D. Explicit skips

- Grok Bot, Cursor and other proprietary products: behavior inspiration only; no code reuse.
- Open WebUI: current license has branding conditions and historical distinctions; do not fork or adopt without reviewing the exact version and conditions ([LICENSE](https://github.com/open-webui/open-webui/blob/main/LICENSE)).
- Gemma and Llama-derived weights: custom terms, not blanket Apache or MIT; defer until exact terms and intended use are cleared. Avoid assuming rights from a runtime or distillation repository.
- AGPL, SSPL, BUSL and other source-available components: no adopt/fork absent specific prior clearance. Avoid selecting an abandoned project solely to fill a ranking; activity and maintenance are not assessed here.
- TensorRT-LLM: NVIDIA-specific stack is a poor fit for the Mac-first local slice and carries separate dependency terms.

## E. Evidence and gaps

- [Local-speed worker artifact](RQ-OSS-SPEED-LOCAL-1.md) reports oMLX, llama.cpp and mlx-lm as its top three; its benchmark and model-pin jobs informed the proposals. It reports no benchmark runs.
- RQ-OSS-DESKTOP-UX-1, RQ-OSS-A2A-ORCH-1, RQ-OSS-MCP-SKILLS-1 and RQ-OSS-MULTINODE-1: no accessible report. Queue location: `~/.ashlr-runs/queue/reports/oss-research-20261105/`; its parent is OS-denied. Connected GitHub exact-ID searches yielded no PR matches; cannot rule out unrelated PR comments. One bounded wait/recheck found only local-speed. Independent candidates above do not stand in for the missing reports.
- Current repo anchors: `package.json` and `src/core/mcp-gateway.ts`; `desktop/src-tauri`; `src/core/local-runtime/llama`; `docs/NODES.md` and `docs/NODE-ROUTER.md`. Current source is not proof of a running installed system.
- [MCP SDK license transition](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/LICENSE) includes Apache-2.0 for new code, older MIT contributions and separately licensed documentation. [llama.cpp license](https://github.com/ggml-org/llama.cpp/blob/master/LICENSE); [oMLX license](https://github.com/jundot/omlx/blob/main/LICENSE); [mlx-lm license](https://github.com/ml-explore/mlx-lm/blob/main/LICENSE); [Agent Skills license](https://github.com/agentskills/agentskills/blob/main/LICENSE); [assistant-ui license](https://github.com/assistant-ui/assistant-ui/blob/main/LICENSE). The worker's lm-evaluation-harness LICENSE URL returned 404; the corrected [LICENSE.md](https://github.com/EleutherAI/lm-evaluation-harness/blob/main/LICENSE.md) is MIT. It remains evaluate pending integration fit.
