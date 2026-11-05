# Adopt documentation sync

Documentation sync is an offline, deterministic way to derive documentation
artifacts from a repository's documentation and command inventory. It does not
create another upkeep job stream. Run the sync from a configured checkout:

```sh
phm docs sync --json --check
```

The JSON result identifies drift and command coverage problems. Check mode
leaves files unchanged and exits nonzero when corrections are needed. After
reviewing the findings, generate the configured outputs and check them again:

```sh
phm docs sync --json
phm docs sync --json --check
```

## Configure a repository

Place `docs-sync.toml` at the repository root. The Phantom configuration is a
working example. For another repository, adapt the following to its existing
files and command names:

```toml
version = 1
name = "example"
docsDir = "docs"
agentsFile = "AGENTS.md"
llmsFile = "docs/llms.txt"
llmsFullFile = "docs/llms-full.txt"
llmsReferenceFile = "docs/llms-reference.txt"
hostedDir = "site/docs"
registry = "configured"
cliName = "example"
siteOrigin = "https://example.com"
commands = ["status", "help"]
```

Paths identify files and directories in that checkout. The reference file is
the stable introductory text for the full bundle; the full output also contains
the public Markdown pages. Review generated changes alongside their source.
Each supporting repository needs its own configuration and command inventory.
The `phantom` registry reads Phantom's CLI inventory. The `configured` registry
uses a nonempty `commands` array of top-level command names. The check searches
public Markdown pages for a heading and a fenced copy-paste example for each
command. It reports missing sections and examples separately. This is a
top-level inventory check, not proof that every nested subcommand or its
behavior is documented.

Use `--repo <name>` to select the current configured repository by name or a
sibling checkout with a matching configuration. A missing or mismatched
configuration fails rather than silently selecting another repository. Write
mode regenerates outputs even if command coverage is incomplete, and returns
a nonzero status until that coverage is fixed. Check mode compares hosted files that already
exist but does not report absent hosted files as drift; the site build can
generate those files on demand.

## Website boundary

Generating hosted content does not deploy it. The existing `site/` documentation
build serves the separate Verse site; the `phm.dev` website is built from the
`apps/web` directory in the `ashlrai/phantom-secrets` repository. Changes to that
site must enter its source and pass its existing deployment pipeline. Do not
interpret a successful local sync as evidence of a deployment.
