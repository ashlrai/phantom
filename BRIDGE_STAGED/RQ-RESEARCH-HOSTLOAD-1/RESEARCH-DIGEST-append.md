## 2026-11-16 — RQ-RESEARCH-HOSTLOAD-1: host load dynamics and concurrency sizing

Staged here because the job sandbox denies all access to `~/.ashlr-runs/` (EPERM on read and write).
A supervisor appends this section verbatim to
`~/.ashlr-runs/coordination/phantom-productive-20261105/RESEARCH-DIGEST.md`.

Research only. No code, gate or host setting was changed.

### Headline

1. **The load gate is measuring Spotlight, not agents.** Over 9 minutes on the primary (100 samples, 20:07–20:16),
   1-min load was 59–111 (median 92) while CPU busy was 36–51% (never above 51%). Every sample was above the
   gate (36) and above the AIMD danger line (28.8). Correlation between load1 and CPU busy was −0.30.
   Nine agent sessions were live.
2. **Spotlight indexes every worktree.** `~/Projects/ashlrai/wt/.metadata_never_index` exists (Nov 14) but
   `mdfind -onlyin` that directory returns 22,640 `package.json` files. `mdworker_shared` held 15–24 runnable
   threads, the largest single contributor to load.
3. **Memory is the real limit, and the local model owns it.** The omlx server's footprint swung between 45 GB
   and 68 GB (35–53% of RAM) inside 9 minutes. An API-lane session tree costs 0.14–0.9 GB at the median and
   3–4 GB at peak. One loaded model displaces roughly 50 API sessions at mean footprint.
4. **Realistic slots are about 28–41, not 59.** Primary 24 with the model loaded (36 without), Air 3, muse 1.

### Method and limits

- `ps`, `top` and `gh` are blocked in the job sandbox. Processes were read through libproc
  (`proc_pid_rusage` physical footprint, CPU time deltas) for the operator's uid only; root daemons
  (`mds`, `mds_stores`, kernel) are invisible, so CPU attribution is a lower bound.
- Trees were sampled every 10 s for 9 minutes. CPU of children that start and exit between samples is lost.
  Host-wide busy % comes from `iostat` and does not have that gap.
- One evening window, nine sessions. Lanes with no live session (gemini, zai, cursor, agy, grok, devin-flash,
  codex-cmp, claude-api, terra/luna models) were not measured. Air and muse were not measured at all; their
  numbers below are derived from the primary's per-session figures.
- Why load is so far above CPU busy is not proven. The attribution (Spotlight workers, background-QoS threads
  that stay runnable without getting a core) is a hypothesis consistent with [M5]; the decoupling itself is measured.

### Resource matrix (primary, 128 GB / 18 cores, measured)

Session tree = CLI plus MCP servers plus tool children. Footprint is physical footprint, not RSS.

| Lane / process | Live | Tree footprint p50 / p90 / max | CPU mean (cores) | Time above 0.5 core | Procs per tree (max) |
|---|---|---|---|---|---|
| codex exec, gpt-6-astra | 3 | 0.14 / 1.3 / 3.2 GB | 0.32 | 33% | 21 |
| codex exec, gpt-6.1-sol | 2 | 0.89 / 2.5 / 4.1 GB | 0.53 | 52% | 16 |
| claude subscription (`claude -p`) | 4 | 0.23 / 2.7 / 3.6 GB | 0.18 | 15% | 20 |
| Devin desktop + 3 `devin` CLI + 28 MCP node procs | 1 app | 6.0 / 6.6 / 6.9 GB | 0.28 | 13% | 91 |
| Phantom desktop (`ashlr`) | 1 | 1.9 / 2.0 / 2.0 GB | 0.31 | 13% | 4 |
| ChatGPT / Codex desktop | 1 | 1.5 GB flat | 0.01 | 0% | 18 |
| Claude desktop | 1 | 1.1 GB flat | 0.00 | 0% | 10 |
| omlx server (one Python process) | 1 | 45 / 61 / 68 GB | 0.17 | 2% | 1 |
| ollama (idle, no model resident) | 1 | 2.9 GB | 0.00 | 0% | 2 |
| Other GUI apps | — | 8.7 GB total | 0.35 | — | — |

- Idle session trees are mostly MCP servers: 17 MCP processes held 1.1 GB across 7 trees (about 150 MB per
  session, 20–50% of an idle tree). External measurements agree: MCP children are 37–68% of a tree [A2].
- Peaks come from tools, not the CLI: one `eslint` run was 682 MB at 1.1 cores; four vitest workers 378 MB.
- Bursts were about one core wide on average, peaking at 2.1 cores per tree.
- Host totals: 97 GB visible footprint, 60 GB wired, swap 8.5 of 10.2 GB allocated, pressure level 1
  throughout, 1,032–1,104 processes, about 6,100 threads.
- External data for unmeasured lanes: Claude Code 185 MB baseline, 0.5–2 GB tool bursts, up to 4 GB,
  7.6–13% of a core on average [A1]; codex about 110 MB idle [A6]; Gemini CLI has no published baseline and
  dies at the 8.3 GB V8 heap limit [A8]; opencode about 0.8 GB [A9]; Devin reference sandbox 2 vCPU / 8 GiB [A10].
  No source gives cursor, zai, agy or grok figures.

**Local inference versus API lanes.** The model server barely competes for CPU (0.17 cores; it is GPU-bound).
It competes for memory, and on unequal terms: model weights and KV cache are wired, so they cannot be
compressed or swapped [A16, A19]. All reclaim falls on agent pages (5.6 M swapouts and 3.7 M swapins since boot).
The 23 GB swing in 9 minutes is ten times what the swap-growth gate (2 GB per 5 min) is built to notice.
Two reports of watchdog kernel panics involve MLX with a raised wired limit, one on an M5 Max 128 GB [A18, A21].

### Findings by research question

**(1) Concurrency curves.** The only controlled curve is AgentCgroup: on 24 cores / 128 GB, memory rather than
CPU bounds density, 32–64 Claude Code instances fit at peak allocation, and CPU stays under 36% [A1].
SWE-bench recommends `min(0.75 × cores, 24)` workers and warns that more slows evaluation [A11].
No source measures 10–50 agents on a Mac or publishes a timeout-rate curve.
Failure reports share a shape: swap near full while "free memory" reads high [A22], load about 350 with idle
CPU [A4], and panics rather than clean OOM kills [A19, A20].

**(2) Admission control.** Ranked for a single host:

1. Per-job reservation: the only signal with no lag, and it counts launched-but-not-ramped jobs. Bazel admits
   on declared resources against a fraction of RAM [B11]; every disclosed agent fleet gives each agent its own
   VM or container (Cursor, Devin, Codex cloud, Copilot, Anthropic's 16-container compiler run) [B13–B18].
2. Memory pressure plus swap as a hard brake with hold-down: oomd uses 60% pressure for 30 s and 90% swap
   [B7]; kubelet holds transitions 5 minutes to stop flapping [B9].
3. AIMD on observed signals as a slow outer loop. Latency-driven limiters need hundreds of samples per
   interval [B12], which agent jobs do not provide.
4. Load average as a backstop only. It reaches 62% of a step after a minute [B1], oscillates between maximum
   and one job in ninja [B4], and make's own source documents the overshoot [B3].

No vendor discloses per-agent sizing or an admission policy.

**(3) macOS specifics.**

- Pressure "warn" fires when uncompressed pageable memory drops below about 50% of pageable plus compressed,
  and clears above 60%; "critical" is about 34% or compressor near its limit [M1]. It is a compression-ratio
  signal. macOS does not kill on swap exhaustion by default [M2].
- Darwin load counts running plus runnable threads, sampled every 5 s; nothing I/O-blocked [M4].
- Background-QoS threads are confined to the lower core tier even when faster cores idle [M5].
- M5 Max in Automatic mode drops from 75 W to 54 W sustained; High Power holds 70–75 W and scores about 7%
  higher on sustained CPU [M7]. A fanless Air sustains 9 W, 11% below burst after 30 minutes [M8].
- Git on macOS defaults to `writeout-only`, so it does not pay for a full flush [M10]. Measured here:
  `fsync` 0.05 ms, `F_FULLFSYNC` 3.9 ms median. `git status` in this worktree takes 0.06–0.19 s. fsync is not
  a bottleneck at this repo size.
- `.metadata_never_index` no longer works; a `.noindex` suffix or the Search Privacy list does [M16].
- XProtect scans each new binary unless the parent app has the Developer Tools exemption [M15].
- Shared git store, measured: 487 registered worktrees (56 prunable), 69,742 refs, 4.3 MB `packed-refs`,
  24 packs, 9 abandoned `tmp_pack_*` files (208 MB). Each worktree is about 388 MB on disk including a
  194 MB `node_modules`; the data volume is 82% full with 330 GB free.

**(4) Is load 36 / procs 1300 / worktrees 40 right?**

- **Load 36: wrong signal.** It trips at 40% CPU busy on this host. 2 × ncpu also implies a run queue as long
  as the core count, well past the 80% utilisation knee [B10], so it is both too noisy and too loose.
- **Procs 1300: too low if that is the live override** (repo default is 2,500). Baseline with nine sessions is
  1,032–1,104. `concurrency.zones` treats 70% of the limit as warn and 85% as danger, so at 1,300 the AIMD cap
  can never rise (always warn above 910) and backs off at 1,105. The kernel limit is 10,666 per user.
- **Worktrees 40: fine as a warning** on live job worktrees. The cost is in the 487 registered ones.
- **Sizing by queueing.** Treat each session as mean μ ≈ 0.9 GB, σ ≈ 1.0 GB and admit N where
  `Nμ + 2.33σ√N ≤ budget`. With the model at peak the agent budget is about 30 GB, giving N ≈ 21;
  with it unloaded about 98 GB, giving N ≈ 85 by memory. CPU: sessions want a core 15–50% of the time;
  with about 11 cores left after non-agent load, the 5% overload point is N ≈ 22–40 depending on duty.
  Memory binds with the model loaded, CPU without it.

### Proposals

Score = impact × confidence − effort, each on 1–5.

- READY **P1. Gate on CPU busy %, not load1** (5 × 5 − 2 = 23). In `dispatchd.py` admission, replace
  `load1 > GATE_LOAD_PER_CPU × ncpu` with CPU busy ≥ 85% on two consecutive samples; keep load5 > 4 × ncpu as
  a warning. In `concurrency.zones`, drive the `load` zone from busy % (warn 75, danger 90).
  `node-measure.ts` already samples `busyPercent`, and `fleet_controller.concurrency_signals` already carries
  the bus. Evidence: 100 of 100 samples over the gate at ≤ 51% busy. Overlaps open PRs #6456, #6461, #6451 by
  title; their content could not be read from this sandbox. [B1, B3, B4, M4]
- READY **P2. Stop Spotlight indexing worktrees** (4 × 5 − 1 = 19). Create new worktrees under a
  `wt.noindex/` parent (change the destination passed to `worktree-add.sh`), and have the operator add the
  existing `wt/` and `~/.ashlr-runs` to Search Privacy. Delete the inert `.metadata_never_index`.
  Verify with `mdfind -onlyin <dir> -count 'kMDItemFSName == "package.json"'` returning 0. [M16]
- READY **P3. Fix or drop the process-count limit** (4 × 4 − 1 = 15). Remove any live `GATE_PROCS_MAX=1300`
  override; set the limit from `kern.maxprocperuid` (warn 40%, danger 60%, about 4,300 and 6,400 here).
  Add a `test_concurrency.py` case showing the cap can rise at 1,100 processes. [M20]
- READY **P4. Reserve memory per session statistically in `capacity-model.ts`** (5 × 4 − 3 = 17).
  `byMem = headroom / mem_bytes_max` uses the largest live tree, which was 0.2 GB or 4.1 GB minutes apart.
  Keep a per-harness mean and variance over the learned window and admit N by `Nμ + 2.33σ√N ≤ headroom`.
  Charge every session younger than 5 minutes at p90 so a launch burst cannot outrun the measurement. [A1, B3, B11]
- READY **P5. Account for the local model explicitly** (5 × 4 − 3 = 17). `computeNodeCapacity` marks
  `local-model` unmeasured and ignores it. Subtract the server's configured peak (weights plus KV cache;
  68 GB observed) from `headroom_bytes` while it is resident, and add an idle-unload after the codex-local
  lane has had no job for a set time. Do not raise the MLX wired limit above its default. [A16, A18, A21]
- READY **P6. Set node slots from measurement** (4 × 3 − 1 = 11). Primary 24 while a model is resident, 36
  otherwise; Air 3; muse 1 (API-only lanes, no full test suites, no local model). Lower the AIMD `CEILING`
  from 64 to 40. Revisit after P1 and P2, since they change the CPU picture. [A1, A11, M8]
- READY **P7. Host-wide semaphore for heavy tool bursts** (4 × 3 − 3 = 9). Sessions idle on the API most of
  the time; contention is overlapping `verify-changed`, vitest, tsgo and eslint runs. Take a slot around
  those commands: 8 on the primary, 2 on the Air, 1 on muse, and cap vitest workers at 4. [B10, B16]
- READY **P8. Worktree and object-store hygiene** (3 × 4 − 2 = 10). Run `git worktree prune` each reap tick
  (56 prunable now); delete merged `codex-bridge/*` refs so `packed-refs` stops growing; run one scheduled
  `git maintenance` (geometric) on the shared store and set `gc.auto=0` in agent environments so 20 sessions
  do not each start a detached gc; remove stale `tmp_pack_*`. Target registered worktrees ≤ 2 × the cap. [M10, M11, M12]
- READY **P9. Pressure gate hold-down and thermal gate** (3 × 4 − 2 = 10). Keep "no new launches at level 2",
  but hold the blocked state for 5 minutes after it clears, and add swap-used above 90% of allocated as a
  warn (8.5 of 10.2 GB today at level 1). On the Air, hold launches when
  `notifyutil -g com.apple.system.thermalpressurelevel` is 2 or higher. [M1, M9, B7, B9]
- READY **P10. Trim MCP servers on headless lanes** (3 × 4 − 2 = 10). About 150 MB and 3 processes per
  session are MCP servers the job may never call; the Devin desktop tree carries 28. Launch bridge sessions
  with only the servers the job class needs, and keep `mcp_reaper.py` covering orphans. [A2, A7]
- READY **P11. Operator host settings** (2 × 3 − 1 = 5). High Power mode on the primary for sustained runs,
  and the Developer Tools exemption for whichever app parents the agents. The exemption follows the process
  tree, so it may not reach launchd-started workers; test before relying on it. [M7, M15]

### Citations

Agent footprint
- [A1] AgentCgroup, arXiv 2602.09345v3 — https://arxiv.org/html/2602.09345v3
- [A2] J. Young, Claude Code parallel sessions memory — https://jyoung.dev/blog/claude-code-parallel-sessions-memory/
- [A4] anthropics/claude-code #67433 — https://github.com/anthropics/claude-code/issues/67433
- [A6] openai/codex #28315 — https://github.com/openai/codex/issues/28315
- [A7] openai/codex #14666 — https://github.com/openai/codex/issues/14666
- [A8] google-gemini/gemini-cli #29830 — https://github.com/google-gemini/gemini-cli/issues/29830
- [A9] anomalyco/opencode #20695 — https://github.com/anomalyco/opencode/issues/20695
- [A10] Daytona, Devin Outposts — https://www.daytona.io/docs/en/guides/devin/devin-outposts/
- [A11] SWE-bench Docker setup — https://www.swebench.com/SWE-bench/guides/docker_setup/
- [A16] mlx-lm README, Large Models — https://github.com/ml-explore/mlx-lm/blob/main/README.md
- [A18] Local LLMs on Apple Silicon (wired-limit panic) — https://dev.to/brunocerberus/running-local-llms-on-apple-silicon-2ecm
- [A19] Model switcher kernel panic — https://dev.to/dreamdeck/the-model-switcher-that-kernel-panicked-my-mac-1o4j
- [A20] anomalyco/opencode #12687 — https://github.com/anomalyco/opencode/issues/12687
- [A21] MTPLX #516 (M5 Max 128 GB) — https://github.com/youssofal/MTPLX/issues/516
- [A22] "Free memory said 78%" — https://dev.to/igorganapolsky/free-memory-said-78-and-macos-still-ran-out-of-application-memory-53d4

Admission control and queueing
- [B1] B. Gregg, Linux Load Averages — https://www.brendangregg.com/blog/2017-08-08/linux-load-averages.html
- [B3] GNU make `src/job.c` — https://raw.githubusercontent.com/mirror/make/master/src/job.c
- [B4] ninja PR #274 — https://github.com/ninja-build/ninja/pull/274
- [B7] oomd.conf(5) — https://www.freedesktop.org/software/systemd/man/latest/oomd.conf.html
- [B9] Kubernetes node-pressure eviction — https://kubernetes.io/docs/concepts/scheduling-eviction/node-pressure-eviction/
- [B10] Gunther, Universal Scalability Law — http://www.perfdynamics.com/Manifesto/USLscalability.html
- [B11] Bazel command-line reference — https://bazel.build/reference/command-line-reference
- [B12] Uber Cinnamon auto-tuner — https://www.uber.com/blog/cinnamon-auto-tuner-adaptive-concurrency-in-the-wild/
- [B13] Cursor, cloud agent lessons — https://cursor.com/blog/cloud-agent-lessons
- [B14] Cognition, Devin security — https://cognition.com/blog/devin-security
- [B15] OpenAI Codex cloud environment — https://learn.chatgpt.com/docs/environments/cloud-environment
- [B16] Cursor, scaling long-running agents — https://cursor.com/blog/scaling-agents
- [B17] Anthropic, building a C compiler — https://www.anthropic.com/engineering/building-c-compiler
- [B18] GitHub Copilot coding agent — https://docs.github.com/en/copilot/concepts/agents/coding-agent/about-coding-agent

macOS
- [M1] XNU `vm_pageout.c` — https://raw.githubusercontent.com/apple-oss-distributions/xnu/main/osfmk/vm/vm_pageout.c
- [M2] XNU `kern_memorystatus.c` — https://raw.githubusercontent.com/apple-oss-distributions/xnu/main/bsd/kern/kern_memorystatus.c
- [M4] XNU `sched_average.c` — https://raw.githubusercontent.com/apple-oss-distributions/xnu/main/osfmk/kern/sched_average.c
- [M5] H. Oakley, Quality of Service — https://eclecticlight.co/2025/05/09/what-is-quality-of-service-and-how-does-it-matter/
- [M7] Notebookcheck, M5 Max power modes — https://www.notebookcheck.net/Did-Apple-reduce-the-performance-of-the-M5-Max-via-software-update-Yes-and-no.1376940.0.html
- [M8] Notebookcheck, MacBook Air 15 M4 — https://www.notebookcheck.net/Apple-MacBook-Air-15-M4-review-The-fanless-M4-SoC-is-years-ahead-of-the-competition.976933.0.html
- [M9] macOS thermal pressure levels — https://stanislas.blog/2025/12/macos-thermal-throttling-app/
- [M10] git config `core` — https://raw.githubusercontent.com/git/git/master/Documentation/config/core.adoc
- [M11] git-maintenance — https://git-scm.com/docs/git-maintenance
- [M12] git-worktree — https://git-scm.com/docs/git-worktree
- [M15] cargo-nextest macOS notes — https://nexte.st/docs/installation/macos/
- [M16] H. Oakley, Spotlight in Sequoia — https://eclecticlight.co/2024/11/29/using-and-troubleshooting-spotlight-in-sequoia-summary/
- [M20] XNU `param.c` — https://raw.githubusercontent.com/apple-oss-distributions/xnu/main/bsd/conf/param.c

Citations were fetched by research subagents this session; quotes passed through a fetch summariser, so
spot-check any figure before republishing it.
