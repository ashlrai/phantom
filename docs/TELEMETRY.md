# Anonymous install telemetry

npm download counts and GitHub clone counts mostly measure our own machines,
CI runs and registry mirrors, not people. To learn how many real installs the
AshlrAI open-source tools have (and keep improving them for those people),
the CLIs send one tiny, anonymous record:

- an **install** ping the first time the tool runs on a machine, and
- at most one **active** ping per week after that.

## Exactly what is sent

| Field        | Example                                | Notes |
|--------------|----------------------------------------|-------|
| `schema`     | `1`                                    | Payload version |
| `event`      | `install` or `active`                  | |
| `tool`       | `phantom`                              | Which AshlrAI tool |
| `version`    | `3.30.72`                              | Tool version |
| `os`, `arch` | `darwin`, `arm64`                      | From Node's `process.platform` / `process.arch` |
| `env`        | `dev` or `ci`                          | `ci` when a standard CI variable is set |
| `internal`   | `false`                                | `true` on AshlrAI fleet/founder machines and ashlrai CI, so they are excluded from public counts |
| `install_id` | `3f2c1a9e-…`                           | A random UUID made on first run. Not derived from your machine, user, paths or repos |

**Never sent:** file paths, repository or project names, hostnames, usernames,
commands or arguments, environment values, tokens or secrets, code.

**IP addresses are not stored.** Pings go to `https://ashlr.ai/api/telemetry`,
which accepts only the fields above and forwards them server-side to our
analytics with the IP blanked, GeoIP disabled and no person profile. The
ingest source is public:
[`ashlr-landing/lib/telemetry/usage.ts`](https://github.com/ashlrai/ashlr-landing/blob/master/lib/telemetry/usage.ts).

Local state lives in `$ASHLR_HOME/usage-telemetry.json` (default
`~/.ashlr/usage-telemetry.json`, mode 0600): the random id and when the last
ping went out.

## Opting out

Any one of these turns it off completely (nothing is sent, no id is created):

```bash
export ASHLR_TELEMETRY=0      # also accepts false / off / no
export DO_NOT_TRACK=1         # the cross-tool convention (consoledonottrack.com)
```

or set `"disabled": true` in `~/.ashlr/usage-telemetry.json`.

The first time a ping would be sent from an interactive terminal, a one-line
notice is printed to stderr with these instructions.

## Fleet and maintainer machines

AshlrAI machines must not inflate the numbers. They are tagged `internal: true`
(still counted separately, so we can see how much of the npm volume is us) when:

- `ASHLR_INTERNAL=1` is set (the fleet sets this for every seat), or
- `"internal": true` is in `~/.ashlr/usage-telemetry.json`, or
- the process runs in GitHub Actions for a repository owned by `ashlrai`.

## Relationship to `phm metrics`

This is separate from Phantom's local-first metrics store
(`src/core/metrics/telemetry.ts`, [architecture/metrics.md](architecture/metrics.md)),
which never leaves your machine unless you explicitly share it.

Implementation: [`src/core/metrics/usage-ping.ts`](../src/core/metrics/usage-ping.ts).
