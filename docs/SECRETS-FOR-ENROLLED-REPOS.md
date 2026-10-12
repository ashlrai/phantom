# Phantom Secrets for enrolled repositories

How to give every repository Phantom works on a value-blind secrets layer, and
where the current boundary sits for autonomous deploys and key rotation.
Companion detection itself is covered in [COMPANIONS.md](COMPANIONS.md).

## One-time setup per machine

```sh
brew tap ashlrai/phantom && brew install ashlrai/phantom/phantom  # Secrets v0.7.9
phm companions --json        # confirm Phantom finds exactly one native `phantom`
phm mcp ecosystem            # inspect Secrets/Locus MCP registration
phm mcp ecosystem --write    # register the selected absolute executable
```

The workbench command is `phm`; `phantom` belongs to Secrets.

## Per enrolled repository

Run once in each checkout, from a trusted terminal:

```sh
phantom init                 # or: phantom init --empty for a repo with no .env yet
phantom status --json        # value-free metadata Phantom agents can read
```

Each checkout gets its own vault namespace keyed to its canonical path, so
personal, company and client repositories stay separate even when variable
names collide. See Secrets'
[multi-project key separation guide](https://github.com/ashlrai/phantom-secrets/blob/main/docs/multi-project-keys.md).

Agents launched by Phantom then see `phm_` placeholders, value-blind MCP
inventory, and requests authenticated by the local proxy (`phantom exec -- <cmd>`).
Real values never enter agent context, Phantom logs, or proposals.

## Autonomy boundary today

| Capability | Status |
|---|---|
| Inventory, diagnostics, `.env` protection checks | Available to agents (value-blind) |
| Running tests/builds that need keys | Via `phantom exec` proxy |
| Adding or removing a secret | Trusted-terminal challenge; not autonomous |
| Provider key rotation (Vercel, GitHub, Stripe, AWS, ...) | Hard-denied in Secrets v0.7.9; rotate at the vendor |
| Production deploys / pushes to `main` | Governed by [STANDING-AUTHORITY.md](STANDING-AUTHORITY.md); deploy credentials are never handed to agents as values |

Fully autonomous deploy and rotation require two things that do not ship yet:
a durable provider-rotation contract in Secrets, and an explicit, revocable
standing-authority grant from the operator for each enrolled repo and target.
