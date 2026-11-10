# Fleet lanes

A lane is one account or model source that runs Phantom jobs. Each row says
what the lane runs on and what it is best at. Lanes marked **not a job lane
yet** only show status or are held; Phantom does not send them jobs.

| Lane | What it runs on | Best at |
| --- | --- | --- |
| `codex-personal` | OpenAI Codex on your personal account (usage read from Codex's own session logs) | Landing and cleanup jobs: LAND, FIXUP, DRAIN, DAILYFIX. Nothing else. |
| `codex-cmp` | OpenAI Codex on the second Codex seat (rate limits read through Codex App Server) | Frontier-tier work, when the router picks it. The name "cmp" is not explained in this repo. |
| `claude` | Claude Code on your Claude subscription | Coding jobs on the Claude subscription you already pay for. |
| `claude-api` | Anthropic API key, paid per use | Pay-per-use Anthropic work. Closed by default: the spend budget is $0 until you raise it. |
| `devin` | Devin, a cloud coding agent by Cognition | GEN, PLAN, SELFOPT and DESK jobs, and well-scoped backlog PRs. |
| `codex-local` | Codex on this Mac, using its local session logs | GEN, PLAN, SELFOPT and DESK work, the same kinds as `devin`. Check `phm lanes fit --lane codex-local` before you send a kind. |
| `zai` | Z.ai GLM Coding Lite: `glm-5.3` for the work tier, `glm-5.3-flash` for the fast tier | Coding at the work and fast tiers, on the GLM Coding Lite plan. |
| `gemini` | Google Gemini CLI | **Not a job lane yet.** Phantom only reads its MCP status with `phm wire status gemini`. |
| `grok` | xAI Grok API key, plus Grok Bot agents on the bus | **Not a job lane yet.** The API key is only checked. Grok Build is not an enrollable pool provider. |
| `cursor` | Cursor's hosted cloud agents (bus participant `cursor-cloud`) | Overflow capacity, planned for when local lanes are full. No job lane runs it now. |
| `agy` | Not described in this repo | **Unknown.** It appears only as a usage meter named `agy`. |

## Check a lane from the command line

Agents and scripts should use the commands, not this page:

```sh
phm lanes health --json
phm lanes fit --lane codex-personal --json
```

`phm lanes health` shows calls, error rate and latency per lane over the last
12 hours. `phm lanes fit` shows which job kinds a lane should take and which
to avoid. Both only read; neither changes routing.

## Related

- [Lane fit](https://github.com/ashlrai/phantom/blob/master/docs/LANE-FIT.md) and [lane health](https://github.com/ashlrai/phantom/blob/master/docs/LANE-HEALTH.md): the two lane reports.
- [Resource pools](RESOURCE-POOLS.md): how much capacity each account has left.
- [Drive](https://github.com/ashlrai/phantom/blob/master/docs/DRIVE.md): which job kinds each pool may serve.
