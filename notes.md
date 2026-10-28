# Model inventory findings

- This base has no fleet.json schema or memguard admission interface. The inventory owns a documented versioned resources.models envelope and conservative native Mac admission, using the legacy 35% free threshold plus pressure, disk and model-size reserves.
- Existing memguard policy was inspected read-only from codex-bridge/RQ-MEMGUARD-PRESSURE-RULE. No sibling worktree or branch was modified.
- oMLX's native benchmark endpoint can upload results externally. Use only loopback inference, tokenizer and admin metadata/unload APIs.
- lsof occasionally times out under host load. Probe retries stay bounded and never permit an unverified bind. Ollama unload confirmation uses at most 20 checks separated by 500 ms pauses; API requests have separate bounds.
- Live first successful core pass measured gpt-oss:20b, refused the two Qwen models for insufficient memory reserve, and classified bge-m3 as unsupported for decode. oMLX on port 8000 was unavailable.
- Initial installed TypeScript was corrupt. npm ci repaired the dependencies without manifest changes.
- Canonical locate.pl is not installed or present in the checked paths. /tmp/rq-locate.pl is an available local fixture-gate emulation; its --all scan of tracked and new-file diffs had 0 blocked matches.
