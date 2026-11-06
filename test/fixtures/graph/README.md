# graph.v1 fixtures

Validate these JSON documents against `schema/graph.v1.schema.json` (Draft 7).
This is the read-only registry contract for GRAPH-1, separate from the Universe
evidence graph and the Ecosystem Mission Graph.

- `graph.v1.json`: complete registry covering all four node and edge kinds,
  fleet bindings and seat catalog routes. Preserved byte-for-byte from the
  earlier GRAPH-1 implementation at commit
  `98113bb95a77c2d66cee4440fcb6ae3227062fc9`.
- `empty.v1.json`: healthy, loaded sources with no declared inventory.
- `incomplete.v1.json`: missing/unavailable sources reported explicitly.
- `malformed/*.json`: valid JSON documents that must fail schema validation;
  each filename names the violated constraint. They are deliberately invalid
  wire records, not malformed JSON syntax.

All fields are public inventory metadata. Objects are closed: commands,
environment maps, credentials, paths and free-form error messages have no
place in this wire format. Identifiers still require caller-side redaction;
schema validation cannot determine whether an otherwise valid ID is private.
`readOnly` is always true. Membership and `routes-to` do not grant authority,
prove provider readiness or establish freshness.

The schema validates shape, discriminants, identifier syntax, endpoint kinds,
source enums, exact duplicate entries, and the implication that a complete
graph has loaded sources and no issues. Engine identifiers remain open-ended.
The 10,000-seat input bound applies to each account's `seatIds`; projected
node/edge arrays can exceed an individual source list's size and have no
invented output cap.

GRAPH-1 must separately verify unique IDs (including objects with the same ID
but differing fields), endpoint existence, encoded ID equality with identity
components, deterministic sorting, issue/source consistency and whether
`complete` accurately describes its selected inputs. JSON Schema alone cannot
check these cross-record relationships. This slice adds no loader, builder,
CLI, source access or runtime activation.
