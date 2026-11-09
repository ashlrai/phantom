# Repository tool registry

Run `node tools/registry.mjs list` to discover tools and their input schemas.
Invoke one from the repository root with, for example,
`node tools/registry.mjs run word-count '{"text":"hello world"}'`.
Scripts receive a JSON object on stdin and write their result to stdout. The
working directory is the caller's; the runner limits runtime and output and
passes only PATH in the environment.

Add a `<name>.tool.json` manifest and a `.mjs` entrypoint under this directory.
Names use lowercase letters, digits and hyphens. The supported input schema is
an object with string properties, an explicit required array and
`additionalProperties: false`. Classify tools as `read-only` or `dangerous`.
Dangerous tools are always refused until a trusted leader approval mechanism is
integrated; a caller-supplied flag is not approval.

The registry is a discovery and validation convention, not a sandbox or a
security boundary. A tool's author controls its declared class and code;
review manifests and scripts before running them, and use an OS sandbox for
untrusted code. Do not put credentials in inputs: command arguments may be
visible to other local processes. Skills can be documented alongside tools,
but executable tools use the stdin protocol above.
