# Bring context into Phantom

Onboarding can preview text you paste or explicitly choose from a local text, Markdown or JSON file. Review the notes, select a project, choose the parts to keep, and save an immutable reference. Nothing contacts an AI provider during preview or saving. Adding a saved reference to a chat fills its composer; the usual Send action determines when that chat's agent receives it.

Imported context remains untrusted reference data. It grants no permissions, reconnects no native session, and is not automatically injected into chats or written to `MEMORY.md`. Source names and provider labels are claims supplied by the operator, not authentication. A fingerprint of the selected input is computed locally; the server receives only the selected notes and cannot verify the original export.

## Get text from your assistant

- **ChatGPT:** eligible accounts can request a ZIP export from Settings → Data controls. Extract it and choose `conversations.json` or a numbered conversation JSON file. Importing reference text does not transfer saved memories or recreate native chat history. Memory summaries can omit details. See [data export](https://help.openai.com/en/articles/7260999-exporting-your-chatgpt-history-and-data), [conversation transfer limits](https://help.openai.com/en/articles/9106926-transfer-exported-conversations-between-chatgpt-accounts), and [memory](https://help.openai.com/en/articles/8590148-memory-in-chatgpt).
- **Claude:** use its documented memory copy/paste flow, or request account data from Settings → Privacy. The memory flow is experimental; personal account exports cannot recreate another personal account's history. See [memory transfer](https://support.claude.com/en/articles/12123587-import-and-export-your-memory-from-claude) and [data export](https://support.claude.com/en/articles/9450526-export-your-claude-data).
- **Grok:** consumer data downloads are available through Settings → Data Controls. Grok Build separately supports exporting a selected transcript as Markdown. See [consumer controls](https://x.ai/legal/faq) and [CLI export](https://docs.x.ai/build/features/sessions).

Phantom does not request an export for you, sign into these accounts, scan their private app files, download URLs from the input, or claim access to all provider memory. Provider export schemas can change. Generic JSON preview offers its nonempty string values as separate reference selections; it does not reconstruct native conversations, infer message authority, execute tool calls, or recover missing images and attachments.

## Formats and limits

- One explicitly selected UTF-8 file, at most 8 MiB, or a paste of at most 256 KiB.
- JSON depth at most 32, at most 16,384 nodes, at most 4,096 entries per container, and at most 128 KiB per string.
- At most 512 preview notes. Save at most 64 selected notes, each at most 4 KiB, totaling at most 128 KiB of note text.
- Text splits at line boundaries; a plain-text line larger than 4 KiB must be split before import. Longer JSON string values split at UTF-8 character boundaries.
- Generic JSON locators identify the original field using an escaped JSON pointer. Several text parts can share that pointer. Private path or credential-bearing JSON keys are refused rather than silently changing their locator.
- Plain-text locators say `preview-lines`, referring to the normalized, sanitized preview, not positions in the original source.
- Recognized credential shapes and generic home-directory paths are redacted before selection. Transformation notes record normalization, redaction, splitting and operator edits. No partial preview is returned when a limit is exceeded.
- ZIP and other archives are refused. Extract them yourself and choose an individual supported file. There is no automatic archive expansion.

These are per-input and per-commit bounds, not a lifetime storage quota or a promise that every account export fits. No raw export archive is persisted. Deleting a provider account or changing its settings is outside this importer.

For a predictable portable format, use an exact Phantom context capsule:

```json
{
  "schemaVersion": 1,
  "type": "phantom-context-capsule",
  "claimedProvider": "other",
  "items": [{
    "id": "note_1",
    "title": "Project decisions",
    "text": "Keep the public API stable.",
    "sourceLocator": "capsule:1",
    "sourceRole": null,
    "sourceDate": null
  }]
}
```

The provider label must match the selected source. Quoted roles are metadata only. A claimed Phantom capsule with invalid or additional fields is refused, rather than falling back to a different parser.

## Saving and readback

The API uses the existing read-session and mutation-token boundaries. All routes are handled before engine creation or legacy scheduler loading:

| Route | Behavior |
| --- | --- |
| `GET /api/verse/context-imports?projectPath=…` | Validate the chosen project and return its opaque fingerprint; create no store. |
| `POST /api/verse/context-imports` | Save only the explicitly selected notes and their declared provenance. Require the mutation token and dispatch-enabled server. |
| `GET /api/verse/context-imports/:id?projectPath=…` | Read one exact immutable reference under the same project; enumerate no reference collection. |

The commit includes `schemaVersion`, `projectPath`, `projectDigest`, `claimedProvider`, `provenance`, `sourceLabel`, `sourceDigest`, `selectionDigest`, `transformations`, and `items`. SHA-256 wire fingerprints use `sha256_` and records use `ctx_`; these prefixes preserve opaque identities through the public sanitizer. The selection fingerprint binds the exact selected item content and order. The record identity additionally binds project, source claim and transformation metadata.

The project fingerprint identifies the canonical path observed by the asynchronous folder guard. It does not establish inode ownership, continuing project existence, or permission to execute imported text. Saving subsequently accesses only private reference storage and does not resolve or write that operator folder again. Raw URL aliases are refused before other API routes can interpret their normalized path.

References are stored in a project-fingerprint namespace outside the repository, using the existing private immutable record store. Files use mode 0600 and directories use 0700 or the platform's existing private-storage assurance. Stable point reads reject unsafe storage, changed bytes and active store ownership. Identical retries return the persisted reference and its original import time. A different selection creates a different reference; it never replaces an earlier one.

Saving refuses content that the public sanitizer would rewrite, so an exact readback can verify the displayed selected notes. If a write cannot be confirmed, the response says it may already have saved; retry the same selection. Unknown or unsafe reads remain unavailable. A successful saved reference is not evidence of provider authentication, exhaustive export, live agent ownership or desktop attachment.

## Reviewed durable memory

The onboarding UI can separately let the operator write durable facts and review them in the existing project memory editor. That field begins empty. Imported notes are not automatically copied into trusted memory. The existing editor retains its explicit Save, mutation-token, conflict and redaction-loss controls. Current chats keep their creation-time memory snapshot; saving a reference does not alter it.
