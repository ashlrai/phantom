# Frequently Asked Questions

## What is Phantom?
Phantom is an open-source workbench for running coding agents, coordinating a fleet, and reviewing their work, by Ashlr.AI. Bring your signed-in coding CLIs and local models into one console, CLI and MCP gateway. See the [README](../README.md).

## What is Phantom trying to become?
Its mission is chasing open-source RSI (recursive self-improvement): an open-source, fully autonomous software factory that anyone can join with their own agents and compute. Agents run the factory; the human owner acts as a passive board member who sets direction and is needed only for passwords, 2FA, device approvals and payments. See the [README mission](../README.md#mission) and [AGENTS.md](../AGENTS.md).

## How do I try it?
With Node.js 22.15+ and Git installed, run `npm install -g @ashlr/phantom`, then `phm verse --no-open --json` and open the printed console URL. `phm` and `ashlr` are the same program. See the [quickstart](../README.md#quickstart) and the [first-session guide](QUICKSTART.md).

## What does it cost?
Phantom is MIT licensed and free. Signed-in CLI accounts use your vendor's plan, API keys are billed by their provider, and local models run on your hardware.

## Which agents can it run?
Job lanes run Claude Code, Codex, Devin, Z.ai GLM and local models served through Ollama or another OpenAI-compatible server. Gemini, Grok and Cursor are not job lanes yet. See [fleet lanes](lanes.md) and [local inference](LOCAL-INFERENCE.md).

## Where does my data live?
Phantom keeps its own state on your machine under `~/.ashlr/`. Its cloud model providers refuse to run unless you pass `--allow-cloud` and a key is present. A coding CLI or API key you connect sends work to that vendor under its own terms. See [SECURITY.md](../SECURITY.md).

## How does Phantom fit with the other Ashlr projects?
Phantom Secrets, Locus, Ashlr Plugin, Lexicon, Ashlr MD and Ashlr Stack are companions that install separately. See the [ecosystem map](ECOSYSTEM-MAP.md).

## How do I contribute?
Follow [Contribute with an agent](CONTRIBUTE-WITH-AN-AGENT.md) from clone to auto-merge. Contributors and the fleet take the same path: one focused branch, local checks run once, a pull request, and the one required hosted check, `Merge Gate`. [CONTRIBUTING.md](../CONTRIBUTING.md) has the full conventions and the safety invariants contributors must never weaken.

## How do I report a security issue?
Do **not** open a public issue for security-sensitive reports. Use GitHub's **private vulnerability reporting** (Security → Report a vulnerability). See [SECURITY.md](../SECURITY.md).

## What is the license?
MIT. See [LICENSE](../LICENSE).

## How do I get help?
Run `phm doctor` or `phm status` for diagnostics, read [SUPPORT.md](../SUPPORT.md), or open a public [GitHub issue](https://github.com/ashlrai/phantom/issues).
