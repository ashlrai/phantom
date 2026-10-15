# Included work without paid cash

Phantom can separate included work from a secondary dollar ceiling. This requires a release with explicit daemon funding-mode support. Selecting a mode does not establish account readiness or authorize a paid API.

New `init` configs select cash-disabled funding. Existing config files retain their original funding semantics.

## Select the policy

Use the supported owner config command:

```sh
phm config set daemon.fundingMode no-paid-cash
phm config effective
```

The selection stores `dailyBudgetUsd: 0` and projects **Configured paid cash disabled**. A running process alone does not prove it has adopted that configuration. An existing resident needs the supported resident update/start flow to adopt the new generated command. The installed release, current signed grant, Stop and native confirmation checks continue to apply.

For a bounded dry-run using this policy without saving config:

```sh
phm daemon start --once --dry-run --funding-mode no-paid-cash --budget 0
```

## What can run

Local zero-dollar producers retain their existing runtime checks. Selected Codex and Claude native producers require current account identity and subscription-only billing proof at each contact. The proof is bound to the exact native command and rechecked before a subprocess is created. A quota window, subscription label, account connection, gift balance or CLI name alone is insufficient. Existing quota reservations, reset scheduling, task fit, native confinement, signed scope and verification remain required.

Unqualified plugin inference and generic remote interactive completions and judges remain held when they lack this financial proof. The existing generic judge adapter has no selected account/billing binding; this mode does not create a judge role or qualify verification automerge. Grok is held in this mode until its native path provides an equivalent financial boundary. Existing native free-model Devin evidence remains model-specific and expires normally.

Gifted API work requires separate signed bounded admission and genuine current provider/organization/credential/funding evidence. This mode does not activate it. Unknown funding, purchased or mixed funding, invoiced billing, auto reload and paid fallbacks remain refused.

## Existing configs

An absent `fundingMode` preserves legacy behavior and configured ceilings. An explicit legacy dollar budget of zero still pauses all loop work, including free work. Positive legacy ceilings retain their original semantics. To select that policy explicitly:

```sh
phm config set daemon.fundingMode legacy-usd
phm config set daemon.dailyBudgetUsd 0
```

The cash refusal is monotonic within a process, including previously built clients. Switching back to legacy funding needs a supported resident restart to discard that process latch. Changing a funding mode never changes signed spending rights. No paid capacity is inferred from stored balances, a USD display, engine locality or successful installation. Historical realized spend and unresolved accounting remain preserved; cash-disabled mode cannot clear an accounting hold.

## Enforcement boundary

The policy governs Phantom source-owned inference transports and selected native adapters. It does not sandbox arbitrary trusted host JavaScript or third-party plugin code. In cash-disabled mode, the inference fallback refuses before plugin activation; cached plugin clients recheck the host policy before invoking their methods. A command-bound native capability is issued only by reviewed host adapters after current billing and identity admission, and is not exposed as a model-callable action.
