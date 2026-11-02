# Versioned self-swap

`phm self-swap` defaults to a read-only JSON plan. This is an opt-in POSIX
source-install handoff for an **existing supervisor configured to restart through
`current`**. It does not install or reconfigure a supervisor, grant resident
activation, or update signed desktop artifacts. Existing activation gates still
apply when the supervisor restarts Phantom.

Prepare a private installation owned by the runtime user:

```text
install/
  current -> versions/v1
  versions/v1/       # running installation
  versions/v2/       # trusted candidate sources and installed build dependencies
```

Use an independent updater process, with the PID of the old supervised process:

```sh
phm self-swap --root /absolute/install --next v2 --old-pid 12345
phm self-swap --root /absolute/install --next v2 --old-pid 12345 --apply --supervised
```

`--supervised` acknowledges that the supervisor will restart through `current`.
Do not name an unrelated PID. `--spare-port N` selects a loopback probe port;
the default `0` lets the OS allocate one. `--plan` and `--json` are optional.
Unknown, duplicate and conflicting flags fail. JSON is the only output format;
child output is suppressed because server startup can print credentials.

Apply serializes updates using the existing crash-aware local lock. It runs
`npm run build` in the candidate, then launches that candidate's compiled web
server in an isolated temporary home with dispatch and automatic adoption
collection disabled. IPC readiness identifies the child that actually bound the
port. Two bounded `/api/health` probes bracket the atomic `current` symlink
rename. This verifies web startup, **not resident readiness**. The probe is
closed before drain and also closes if the updater disconnects.

After the second probe, apply durably commits the selection and sends SIGTERM
to the old process, rechecking its recorded process-start identity first. It
waits up to 30 seconds for exit and never force-kills the old process. The
supervisor starts the next version; self-swap does not claim to have verified
that restart. Builds have a ten-minute limit and candidate startup a thirty-second
limit. No downloads, dependency installs, or package publication are performed.

## Recovery

A failed probe restores the previous link without draining the old process.
A durable `.self-swap.json` write-ahead journal also protects interruption:

- Before drain is committed, rerunning the same apply restores the previous
  selection and reports `recovered`. It does not also start another update.
- After drain is committed, rerunning apply finishes the identity-checked drain
  and retains the next selection. A drain timeout retains the journal.
- If `current` points to an unrelated version, recovery refuses to overwrite it.
- An interrupted or failed build keeps a `building` journal and refuses further
  applies. Build descendants may still be writing. Inspect and stop those
  processes, repair or replace the candidate, then remove the journal manually
  before retrying. Never clear this fence while a builder might still run.

The prior version is retained. The command does not garbage-collect installations.
Power-loss durability depends on the filesystem honoring file and directory
fsync and same-directory atomic rename. Keep the install tree private; candidate
build scripts execute with the invoking user's authority.
