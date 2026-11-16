# Launch cost: Security adoption proposal

Read costs with `phm fleet vitals --json`. Each launch reports sampled peak process count and mean/peak one-core CPU percent during its first minute; absent evidence is `unknown`. Counts include the verified job tree, not just MCPs; five-second samples miss short-lived children and CPU percent is a sampled OS estimate, not CPU seconds. `measured` permits first-second attachment because process birth timestamps have one-second resolution; duration remains the actual observed value.

After shipping the updated CLI, change only existing compatible gateway entries from `"args":["mcp"]` to `"args":["mcp","run","--lazy"]`. Initialization and tool listing start no downstreams, even with no cache. Call the typed `ashlr__discover {"server":"name"}` tool to load one server, then list its tools. Cached tools activate directly. Policy, revocation, collision rejection and delegated Locus isolation remain enforced; this is not a shared credential service.

Proposed launcher insertion immediately after successful host-session registration (Security must adapt this to the current live source and pin the sampler plus dependencies):
```sh
python3 -I "$R/bin/launch_cost.py" --runs-dir "$R" --session-id "$J" --lane "$POOL" >/dev/null 2>&1 &
```
The owned `metrics/` directory must already exist. The observer writes private `metrics/launch-cost.jsonl` records; a full 1 MiB ledger refuses more writes and needs existing host rotation. Attach once per launch, outside the job process tree. Do not add one observer per MCP. It invokes bounded census helpers; a future shared collector can reduce that overhead.

Acceptance: three concurrent cold gateways spawn zero downstreams; simultaneous first calls share one connection within that gateway. Reporting uses one plain CLI and a typed JSON contract. Live lane configs currently bypass this gateway in the repository's launcher snapshot; current live source is unreadable here. Security must wire only compatible clients, preserve delegated-job isolation, and qualify an actual 60-second launch before claiming host improvement. No live files were changed. `/bin/ps` execution is denied in this worker, so real process/CPU measurements and production savings remain unknown.
