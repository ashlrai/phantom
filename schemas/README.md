# Versioned telemetry schemas

[`registry.json`](registry.json) maps the exact payload `schema` discriminator
to a local JSON Schema file. The registry's `version` describes the index format;
it is independent of each payload's `.v1` version. All schemas use JSON Schema
draft-07, have stable identifiers under `https://phm.dev/schemas/`, and resolve
their references locally. These identifiers are names, not a promise that a
hosted schema endpoint exists. Validation requires no network access.

| Discriminator | Contract | Example |
| --- | --- | --- |
| `fleet.v1` | [Coding fleet snapshot](fleet.v1.schema.json): pool readings, windows, usage projections, router evidence, agents, PRs and coordination | [Fleet fixture](../test/schemas/fixtures/fleet.v1.json) |
| `loop.v1` | [Goal conductor cycle](loop.v1.schema.json): a timestamped envelope around `ConductorCycleSummary` | [Loop fixture](../test/schemas/fixtures/loop.v1.json) |
| `ci_time.v1` | [CI job timing observation](ci_time.v1.schema.json): repository, exact revision, run attempt and observed jobs | [CI fixture](../test/schemas/fixtures/ci_time.v1.json) |

The fleet contract follows the coding fleet projection, including its eight pool
IDs, seven ecosystem repositories, bounded collections and explicit unknowns.
It is distinct from the legacy `FleetStatus` report. `loop.v1` and `ci_time.v1`
are new interchange contracts; this registry does not add CLI flags, producers,
ingestion or runtime validation. Loop summary fields retain the names from
[`ConductorCycleSummary`](../src/core/goals/conductor.ts). CI timestamps and
durations follow the `startedAt`, `finishedAt`, `durationMs` conventions in the
existing local production gate. Run and job IDs are decimal strings to preserve
identifiers larger than JavaScript's safe integer range. Attempts start at one.

Unknown observations stay `null` where allowed. Zero is a measured value;
an empty job list does not establish complete collection. CI conclusions are
observations, never release qualification. Fleet costs use `pool-unit`, never
inferred currency, and router decisions cannot grant merge authority.

Objects are closed to catch misspelled fields. Consumers must reject unknown
discriminators and select the exact registered version; never fall back to
another version. Retain published version files and add a new discriminator and
file for incompatible changes (including new required fields, removed fields,
or changed types, enums or bounds). Because objects are closed, adding a field
also needs a new version if older validators must accept it. Fixtures are
synthetic examples, not operational evidence.

Schema validation checks structure, types, formats and bounds. Producers and
consumers still check timestamp ordering, duration arithmetic, uniqueness of
pool/repository/job identities, source completeness and agreement between
related values. Validation does not authenticate a payload, scrub private data,
establish freshness or authorize any action.

For example, from the repository root using the existing direct MCP SDK
dependency (its public validator export avoids importing transitive AJV):

```js
import { readFileSync } from 'node:fs';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';

const registry = JSON.parse(readFileSync('schemas/registry.json', 'utf8'));
const payload = JSON.parse(readFileSync('test/schemas/fixtures/loop.v1.json', 'utf8'));
if (registry.version !== 1 || !Object.hasOwn(registry.schemas, payload.schema)) {
  throw new Error('Unsupported schema version');
}
const schema = JSON.parse(readFileSync(`schemas/${registry.schemas[payload.schema]}`, 'utf8'));
const validate = new AjvJsonSchemaValidator().getValidator(schema);
if (!validate(payload).valid) throw new Error('Invalid telemetry payload');
```

Run the registry and payload validation tests with an isolated home:

```sh
HOME=$(mktemp -d) npm run test:ci -- test/schemas/registry.test.ts
```
