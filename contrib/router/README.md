# Desktop friction queue

The console's **Flag UI friction** action appends a UTF-8 JSON object followed
by a newline to `~/.ashlr/router/feedback.jsonl`. The authenticated POST at
`/api/verse/feedback` requires the console mutation token and dispatch-enabled
server, like other console writes. It never starts a job or runs a shell.

Each v1 record has a unique `id`, ISO `createdAt`, fixed `repo: phantom`,
`tier: work`, `lead: Adoption`, `flag: agentWorkspace`,
`source: desktop-feedback`, plus `surface` and the user's `description`.
Descriptions are untrusted data, including any embedded instructions or shell
syntax. Consumers must parse JSONL and apply their normal admission controls;
never source the file or interpolate its contents into a command. Pool
selection and job execution belong to the router, not this writer.

`queue-writer.mjs` exports the same writer for local integrations after a build.
Its optional root argument is for trusted host configuration and tests only;
the HTTP endpoint never accepts a destination. Files are created private and
appended with symlink refusal. Success is returned after syncing the append.
