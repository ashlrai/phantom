# Set up your workbench

The setup wizard gets Phantom ready in five short screens. Most people press
**Continue** on every screen: companions start on, and the accounts Phantom
already sees are filled in for you.

Open it from the first-run tour (**Set up companions and accounts…**) or any
time from **Settings → Onboarding → Run the setup wizard**. In a terminal, the
same flow is `phm setup workbench`.

| Step | What you do | Terminal |
| --- | --- | --- |
| 1. Choose your toolkit | Keep or switch off each Ashlr companion. Click a card for details, **View on GitHub** or **Star**. | `phm setup workbench ecosystem [--exclude id,id]` |
| 2. Connect your resources | Check the accounts found, add API keys, credits or more accounts, and give each a scope: personal, company or client. | `phm setup workbench resources` |
| 3. Your setup plan | Run each step yourself and mark it done. An assistant can walk you through it. | `phm setup workbench assistant` |
| 4. Bring your context | Optional: preview, then import CLAUDE.md, AGENTS.md, `~/.codex` or `~/.grok` settings. | `phm setup workbench context [<id> --import --yes]` |
| 5. Check everything works | Seat health plus the companion check. You can run it again any time. | `phm setup workbench health` |

## Companions

The list comes from one manifest,
[`src/core/ecosystem/companion-manifest.ts`](../src/core/ecosystem/companion-manifest.ts).
**Phantom Secrets** and **Locus** are the main integrations. Lexicon, Ashlr MD,
Ashlr Stack, Ashlr Plugin and BinShield are one-toggle extras. Phantom works
fully with none of them. Selecting a companion doesn't install it: the plan
shows the install command, and you run it.

Starring always takes your own click. The wizard opens the repository page,
and `phm setup workbench star <id>` stars a repo through your signed-in `gh`
only when you run that command.

## Resources and credentials

You can start with just one Claude Code login. You can also add several Codex
accounts, Claude, Grok, Devin, Ollama or LM Studio, API keys, and cloud credits.

- **With Phantom Secrets on**, keys are stored with `phantom add NAME`. You type
  the value at a hidden terminal prompt, and agents only ever see a `phm_` token.
- **With Secrets off**, keys go to the OS keychain through its interactive prompt.
- **With Locus on**, each account is bound to its personal, company or
  `client-<name>` workspace (`locus enter …`), so agents can't act in the wrong
  account. With Locus off, the scope is only a label.

The wizard has no field for a secret value. If you paste text that looks like
a key into any box, the wizard refuses it.

## The assistant

The plan is a list of steps that you confirm one by one. **Get help from an
assistant** copies a brief that you can paste into a new chat on a local model
or any connected seat. The brief contains names, scopes and references such as
`phm:OPENAI_API_KEY_ACME`, never values, and anything that looks like a key is
redacted again before it's copied. Nothing runs automatically.

## Context import

Phantom only checks whether the known files exist. It doesn't read a file
until you pick it, and it never touches credential files such as `auth.json`.
The preview shows the first 4 KB with secret-looking text redacted. An import
saves a redacted copy to `~/.ashlr/context/imported/` only with `--import --yes`.

See also [design principles](design-principles.md) and [companions](COMPANIONS.md).
