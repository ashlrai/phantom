# Frequently Asked Questions

## What is Phantom?
Phantom is an open-source engineering agent workbench by AshlrAI. Connect coding agents, API resources, or local models into one workbench. Its mission is chasing open-source RSI (recursive self-improvement): agents run the factory and the human owner acts as a passive board member. See the [README](../README.md#mission) and the [glossary](GLOSSARY.md).

## What does it cost?
MIT licensed — free. CLI accounts use your vendor's billing; API resources have their own metered billing; local inference uses your hardware.

## Which agents are supported?
Claude Code, Codex, Grok, and Devin, plus tool-capable local models. Each account keeps its own vendor sign-in; check its readiness under **Resources** in the console. See the [Quickstart](QUICKSTART.md).

## Where does my data live?
Local-first: everything stays on your machine under `~/.ashlr/`. Cloud providers only run when you explicitly opt in with `--allow-cloud`. See [SECURITY.md](../SECURITY.md).

## How do I contribute?
See [CONTRIBUTING.md](../CONTRIBUTING.md) for setup, test conventions, and the safety invariants contributors must never weaken. To work with a coding agent from a fork, follow [Contribute with an agent](CONTRIBUTE-WITH-AN-AGENT.md): the checks to run once, what Merge Gate requires, and auto-merge.

## How do I report a security issue?
Do **not** open a public issue for security-sensitive reports. Use GitHub's **private vulnerability reporting** (Security → Report a vulnerability). See [SECURITY.md](../SECURITY.md).

## What is the license?
MIT — see [LICENSE](../LICENSE).

## How do I get help?
Open a public [GitHub issue](https://github.com/ashlrai/phantom/issues), read [SUPPORT.md](../SUPPORT.md), or run `phm doctor` / `phm status` for diagnostics. See [SUPPORT.md](../SUPPORT.md).
