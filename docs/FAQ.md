# Frequently Asked Questions

## What is Phantom?
Phantom is an open-source engineering agent workbench by AshlrAI. Connect coding agents, API resources, or local models into one workbench. See [README.md](README.md).

## What does it cost?
MIT licensed — free. CLI accounts use your vendor's billing; API resources have their own metered billing; local inference uses your hardware.

## Which agents are supported?
Claude Code, Codex, Grok, and Devin. See [README.md](README.md).

## Where does my data live?
Local-first: everything stays on your machine under `~/.ashlr/`. Cloud providers only run when you explicitly opt in with `--allow-cloud`. See [SECURITY.md](SECURITY.md).

## How do I contribute?
See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, test conventions, and the safety invariants contributors must never weaken.

## How do I report a security issue?
Do **not** open a public issue for security-sensitive reports. Use GitHub's **private vulnerability reporting** (Security → Report a vulnerability). See [SECURITY.md](SECURITY.md).

## What is the license?
MIT — see [LICENSE](LICENSE).

## How do I get help?
Open a public [GitHub issue](https://github.com/ashlrai/phantom/issues), read [SUPPORT.md](SUPPORT.md), or run `phm doctor` / `phm status` for diagnostics. See [SUPPORT.md](SUPPORT.md).
