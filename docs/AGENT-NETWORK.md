# Agent network commands

## Synchronize documentation

`phm docs sync` derives documentation artifacts from a repository's local
source and reports its findings as JSON. Run it from a checkout containing a
`docs-sync.toml` configuration:

```sh
phm docs sync --json --check
```

The check mode does not update generated files. A nonzero exit means the
reported drift or coverage findings need attention. To regenerate the configured
outputs, run:

```sh
phm docs sync --json
```

See [Adopt documentation sync](DOCS-SYNC.md) for configuration and the
boundary between generating files and deploying a website.
