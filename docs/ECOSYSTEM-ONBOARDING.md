# Connect your ecosystem

Open Settings, then **Connect your ecosystem**, or run:

```sh
phm onboard --ecosystem
```

The wizard detects existing capabilities, shows selectable toggles and asks for
one integration grant. It reports each capability's result after the grant.
Detection itself writes nothing. It does not enroll repositories or activate
autonomy, change TCC permissions, start a model, provision services or run paid
provider requests.

## Preview and grant from an agent

```sh
phm onboard --ecosystem --json
```

Review the returned `planId` and capability IDs. Copy those exact values into
the explicit grant command. For example, if the preview contains `lexicon` and
`stack`, use:

```sh
phm onboard --ecosystem --grant --plan <planId> --select lexicon,stack --json
```

`--json`, non-TTY input and `--yes` only preview. A noninteractive grant requires
`--grant`, the reviewed `--plan`, and an explicit `--select` list. `--yes` cannot
approve the bundle. A changed snapshot refuses before wiring; detect again.
Unknown IDs, duplicate IDs, empty selections, secret-shaped input and extra
fields are refused. No export contents, keys or passwords belong in this flow.

Exit codes: `0` preview or completed wiring; `1` a receipt with outstanding
capabilities; `2` invalid input, stale preview or unavailable grant storage.

## What detection knows

| Capability | Evidence |
| --- | --- |
| Claude, Codex, Grok, Devin | Every distinct matching executable in absolute PATH directories, including named variants. Multiple installations stay separate; installation does not prove login, account identity or subscription entitlement. |
| API keys | Known binding names present in the environment, project `.env`/`.env.local`, Grok/Devin config or Phantom config. Values are never returned or imported. |
| Local models | Bounded HTTP checks at `127.0.0.1:8123`, `:8000`, `:1234` and `:11434`. Redirects and non-loopback destinations are refused. HTTP availability is not model execution evidence. |
| Phantom Secrets | Versioned project metadata followed by a successful names-only inventory. Empty and populated require a complete successful inventory. Locked or partial keychain-only inventory stays locked; unsupported/failed evidence stays unknown. |
| Locus | Existing binding aliases only. No credential locators, pins or session grants. |
| Lexicon | Canonical terms from project and known user YAML vocabularies. |
| MCPs and services | Server names in known client JSON configs; GitHub, Supabase and Vercel CLI presence. Codex config inspection is restricted to a nonsymlinked lane home under `~/.ashlr-runs`; default `~/.codex` is never read. |
| Ashlr plugin and Ashlr MD | Local executables, existing plugin MCP names, and the standard macOS app locations. |
| Import sources | 1Password/Bitwarden CLI presence, provider key presence and Grokbot config presence. Offers remain available even when a source was not detected. |

Files and command output are bounded. Discovery never executes provider login
commands or reads their token files. Only the Secrets metadata/list and Locus
binding-list commands run during discovery; trusted installed executables are
required. An inventory may need existing OS keychain access. An unanswered or
refused inventory remains unknown, never empty.

## What the grant wires

- Registers selected provider/service CLIs in Phantom's connector profile using
  executable paths and binding metadata only. Existing conflicting entries stay
  intact. Registration does not grant credential access or qualify execution.
- Configures selected loopback model endpoints through the existing model config.
  A conflicting custom endpoint is preserved and reported as needing attention.
- Seeds Lexicon with the local repository and parent organization folder names,
  through `lexicon add <term> --project --json`.
- Registers installed Secrets, Locus, Stack and Ashlr plugin MCP executables in
  `~/.ashlr/settings.json`, with a private backup before a change. Stack exposes
  its detected services through its existing MCP; nothing provisions a service.
  Restart the gateway/client, then run `phm mcp doctor --json` to verify transport.
- If explicitly selected, installs `ashlr-plugin@1.36.4` into the private onboarding
  tools directory using npm with lifecycle scripts and optional native packages
  disabled, then registers its MCP. Requires existing npm, Bun and ripgrep.
- Offers the producer's platform installer for Ashlr MD. There is no reviewed
  unattended installer contract here, so the receipt gives the release link and
  reports `needs-you` rather than claiming installation.
- Offers vault imports through Phantom Secrets. 1Password uses
  `phantom import --from 1password --file <private-export.json>`. Provider,
  Bitwarden and Grokbot exports need conversion to a private dotenv export and
  `phantom import --from env --file <private-export.env>`. Secrets requires its
  trusted-terminal challenge; the wizard never captures those exports or
  bypasses it. A locked vault offers existing-vault access, never initialization.

API binding approval retains names only; credentials remain in their existing
custody until imported by Secrets. Launch credential tools through `phantom exec`.
The wizard does not extract vault values or convert key presence into readiness.

## Receipts and retry

Receipts use `configured`, `available`, `needs-you` or `failed` per capability.
`configured` means the local registration/configuration completed; `available`
means the existing capability was retained. Neither proves authenticated service
or model execution. One failed action does not hide other results. Private
subprocess diagnostics are withheld.

Receipts live with mode 0600 under `~/.phantom/onboard/`. A directory lease
serializes grants; repeating the same unchanged bundle returns its receipt.
After installing a missing tool, unlocking a vault or changing configuration,
detect again and grant a fresh bundle. For an unchanged failed action, remove
only its specific receipt file after reviewing the failure, then retry. After
an interrupted process, inspect before removing the stale `.grant-lock` directory.

Desktop reads use `GET /api/onboard/ecosystem`. Grants use
`POST /api/onboard/ecosystem/grant` with `{planId,selected}`. The existing dispatch,
mutation token and JSON gates apply. This integration grant conveys no team
membership, payment, transport credential or autonomous runtime authority.
