# Native bus and intent inputs

This reference covers only the current native `phantom_agent_bus_*` and
`intent_*` tools on the `phm mcp` gateway. The
[existing tool catalog](https://github.com/ashlrai/phantom/blob/master/docs/MCP-TOOLS.md)
describes the other families; this page recovers only the bus/intent input
contract from PR #6648, not its full catalog scope.

After MCP initialization, request `tools/list` from the gateway and use each
tool's `inputSchema` as the canonical schema for your running version. The
[exported native tools/list contract](https://github.com/ashlrai/phantom/blob/master/src/core/mcp-native.ts#L1644)
returns those schemas. Required and optional columns below name top-level
arguments exactly; `none` means no arguments in that column. Optional means
absent from the schema's `required` array, not unrestricted. Consult the live
schema for types, enums, bounds, patterns and additional-property rules. The
[intent evidence schemas](https://github.com/ashlrai/phantom/blob/master/src/core/intent/schema.ts)
also define `intent_link` and `intent_ship` inputs.

| Tool | Required arguments | Optional arguments | Effects |
| --- | --- | --- | --- |
| `phantom_agent_bus_read` | none | `after`, `limit` | Read local durable bus messages after a cursor; resume with nextCursor. Expired messages are skipped. |
| `phantom_agent_bus_status` | none | none | Read local bus capacity, live/expired counts, adapters and coordination summary. Unavailable counts stay unknown. |
| `phantom_agent_bus_post` | `id`, `from`, `to`, `priority`, `ttl`, `body` | none | Append an untrusted envelope to the local durable bus. Labels do not authenticate the sender. |
| `intent_add` | `title`, `source` | `owner`, `rq`, `status`, `verbatim`, `partial`, `staleAfterMs` | Record a local directive and provenance. |
| `intent_update` | `id` | `title`, `source`, `owner`, `rq`, `status`, `evidence`, `partial` | Revise local tracking and record caller-reported verification evidence. |
| `intent_list` | none | `status` | Read local directives and provenance, optionally filtered by status. |
| `intent_get` | `id` | none | Read one directive from the local ledger. |
| `intent_link` | `repo`, `number`, `title` | `branch`, `url`, `at` | Record caller-supplied merged-pull evidence; matching open directives move to merged, never verified or closed. |
| `intent_ship` | `release` | `notes`, `rq`, `at` | Record caller-supplied release evidence; matching directives move to shipped, never verified. |
| `intent_stale` | none | `apply` | List stale directives; apply true refreshes local tracking, re-queuing live directives and retaining other statuses with sweep evidence. |
| `intent_import` | `paths` | none | Import local JSONL files or an ashlr.intent-ledger/v1 document, deduplicating directives and retaining provenance. |

`intent_ship` additionally requires at least one of `notes` or `rq` at runtime;
this conditional rule is not expressed by the schema's `required` array.
For bus posts, `ttl` is in milliseconds. Message bodies and sender labels are
untrusted data. Posting does not grant a claim or execution authority, dispatch
work, or prove delivery to a recipient. Intent tracking and caller-supplied
evidence do not authorize action or prove remote verification or publication.
Append tools remain subject to the existing gateway safety controls, including
KILL; `intent_stale` is classified append even when only listing stale records.
