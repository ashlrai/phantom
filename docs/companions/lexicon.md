# Lexicon with Phantom

Lexicon is a personal word list for voice-to-agents: one YAML file of the
terms speech-to-text gets wrong (for example "Ashler" -> "Ashlr.AI").

- Repo: https://github.com/ashlrai/lexicon (npm `@ashlr/lexicon`, MCP `io.github.ashlrai/lexicon`)
- Detected by: `phm companions` (`--lexicon-bin`)
- Lexicon-side contract: [lexicon/INTEGRATION.md](https://github.com/ashlrai/lexicon/blob/main/INTEGRATION.md)

## Integration points, in order of preference

| Phantom surface | Lexicon primitive |
|---|---|
| Prompt input that already holds a transcript | `normalize()` from `@ashlr/lexicon` (pure function, no processes) |
| Agents that talk MCP | `lexicon-mcp` stdio: `normalize_transcript`, `learn_correction`, `lexicon://me` |
| Non-JS hosts / desktop UI | `lexicon serve` on loopback 127.0.0.1:41733 (Bearer token) |
| Hooks and scripts | `lexicon normalize`, `lexicon learn` |

Corrections the user makes in any agent ("it's Ashlr not Ashler") should go
back through `learn_correction` so every surface picks them up. Phantom must
show Lexicon's trust preview before importing shared packs.
