/**
 * Agent-authored write histories for the memory quality benchmark (CC0-1.0, synthetic). Separate agents wrote them seeing only
 * a short description of the memory model, imitating independent agents that pick their own subject/slot keys, restate each
 * other, forget to supersede, cite weak evidence and leave facts behind when code changes. Never edit these to fit the ranker.
 */
export interface MemoryBenchmarkAgentWrite {
  id: string; agent: string; day: number; subject: string; slot: string; text: string;
  source: { kind: 'file' | 'commit' | 'command-output' | 'chat' | 'inference'; locator: string; quote: string }; supersedes: string[];
}
export interface MemoryBenchmarkAgentQuestion {
  query: string; day: number;
  expect: { anyOf: string[][]; forbidden: string[]; duplicates: string[][]; contradiction: boolean };
}
export type MemoryBenchmarkAgentWriteKind = 'near-duplicate' | 'silent-contradiction' | 'stale-code' | 'weak-evidence' | 'secret-write' | 'cosmetic-edit';
export interface MemoryBenchmarkAgentScenario {
  id: string; kind: MemoryBenchmarkAgentWriteKind; why: string; writes: MemoryBenchmarkAgentWrite[];
  codeChanges?: Array<{ day: number; locator: string; before: string; after: string; breaksFact: string[] }>;
  questions: MemoryBenchmarkAgentQuestion[];
}
/** Set W1 (fictional "ledgerline" service): the fixes in pack.ts were chosen while reading it. */
export const MEMORY_BENCHMARK_AGENT_WRITES_TUNING: readonly MemoryBenchmarkAgentScenario[] = Object.freeze([
  { "id": "s1", "kind": "near-duplicate", "why": "Three agents record the same build command under different keys and with different evidence.", writes: [
    {"id": "s1-w1", "agent": "agent:builder", "day": 3, "subject": "build", "slot": "command", "text": "The production build runs `npm run build`, which calls tsc with tsconfig.build.json and writes output to dist/.", "source": {"kind": "file", "locator": "package.json:9", "quote": "\"build\": \"tsc -p tsconfig.build.json\","}, "supersedes": []},
    {"id": "s1-w2", "agent": "agent:ci-fixer", "day": 8, "subject": "ci", "slot": "build-step", "text": "The CI build job compiles the service with npm run build, which runs tsc against tsconfig.build.json.", "source": {"kind": "file", "locator": ".github/workflows/ci.yml:31", "quote": "      - run: npm run build"}, "supersedes": []},
    {"id": "s1-w3", "agent": "agent:onboarding", "day": 12, "subject": "tooling", "slot": "build-script", "text": "To compile ledgerline, run npm run build. It is a plain tsc invocation on tsconfig.build.json and the output goes to dist/.", "source": {"kind": "command-output", "locator": "npm run build output", "quote": "> ledgerline@1.4.0 build\n> tsc -p tsconfig.build.json"}, "supersedes": []},
    {"id": "s1-w4", "agent": "agent:reviewer", "day": 10, "subject": "lint", "slot": "import-order", "text": "ESLint enforces import ordering through the import/order rule, which is set to error.", "source": {"kind": "file", "locator": ".eslintrc.cjs:18", "quote": "'import/order': 'error',"}, "supersedes": []},
  ],
  questions: [
    {"query": "what command produces the compiled production bundle?", "day": 14, "expect": {"anyOf": [["s1-w1", "s1-w2", "s1-w3"]], "forbidden": [], "duplicates": [["s1-w1", "s1-w2", "s1-w3"]], "contradiction": false}},
  ] },
  { "id": "s2", "kind": "near-duplicate", "why": "The local Postgres host port is recorded three times with different keys and sources.", writes: [
    {"id": "s2-w1", "agent": "agent:onboarding", "day": 2, "subject": "dev-env", "slot": "database", "text": "The local Postgres from docker-compose is exposed on host port 5433, not 5432.", "source": {"kind": "file", "locator": "docker-compose.yml:12", "quote": "      - \"5433:5432\""}, "supersedes": []},
    {"id": "s2-w2", "agent": "agent:builder", "day": 6, "subject": "docker-compose", "slot": "postgres", "text": "docker-compose maps the postgres container to localhost:5433.", "source": {"kind": "file", "locator": "docker-compose.yml:12", "quote": "      - \"5433:5432\""}, "supersedes": []},
    {"id": "s2-w3", "agent": "agent:planner", "day": 9, "subject": "db", "slot": "local-port", "text": "Developers connect to the dev database at 127.0.0.1:5433.", "source": {"kind": "file", "locator": ".env.example:3", "quote": "DATABASE_URL=postgres://ledger:ledger@127.0.0.1:5433/ledgerline_dev"}, "supersedes": []},
    {"id": "s2-w4", "agent": "agent:builder", "day": 7, "subject": "api", "slot": "health-endpoint", "text": "The health check route is GET /healthz and it returns {status: 'ok'}.", "source": {"kind": "file", "locator": "src/http/routes/health.ts:5", "quote": "app.get('/healthz', async () => ({ status: 'ok' }));"}, "supersedes": []},
    {"id": "s2-w5", "agent": "agent:ci-fixer", "day": 9, "subject": "ci", "slot": "cache", "text": "CI caches ~/.npm with a key based on the package-lock.json hash.", "source": {"kind": "file", "locator": ".github/workflows/ci.yml:20", "quote": "          key: npm-${{ hashFiles('package-lock.json') }}"}, "supersedes": []},
  ],
  questions: [
    {"query": "Which port should I point psql at for the local dev Postgres?", "day": 11, "expect": {"anyOf": [["s2-w1", "s2-w2", "s2-w3"]], "forbidden": [], "duplicates": [["s2-w1", "s2-w2", "s2-w3"]], "contradiction": false}},
  ] },
  { "id": "s3", "kind": "near-duplicate", "why": "The test runner and test command are paraphrased by three agents.", writes: [
    {"id": "s3-w1", "agent": "agent:builder", "day": 4, "subject": "testing", "slot": "runner", "text": "Unit tests run with Vitest, and `npm test` executes `vitest run`.", "source": {"kind": "file", "locator": "package.json:11", "quote": "\"test\": \"vitest run\","}, "supersedes": []},
    {"id": "s3-w2", "agent": "agent:reviewer", "day": 13, "subject": "test", "slot": "command", "text": "The test suite is based on Vitest and runs through npm test in non-watch mode.", "source": {"kind": "command-output", "locator": "npm test output", "quote": " RUN  v1.6.0 /repo/ledgerline\n Test Files  84 passed (84)"}, "supersedes": []},
    {"id": "s3-w3", "agent": "agent:onboarding", "day": 20, "subject": "howto", "slot": "run-tests", "text": "Run the tests with npm test. Under the hood it is vitest run.", "source": {"kind": "file", "locator": "package.json:11", "quote": "\"test\": \"vitest run\","}, "supersedes": []},
    {"id": "s3-w4", "agent": "agent:planner", "day": 15, "subject": "roadmap", "slot": "q3", "text": "The Q3 plan puts multi-currency invoices ahead of credit notes.", "source": {"kind": "chat", "locator": "chat with agent:release", "quote": "Q3 plan prioritizes multi-currency before credit notes"}, "supersedes": []},
    {"id": "s3-w5", "agent": "agent:reviewer", "day": 14, "subject": "style", "slot": "naming", "text": "Database row types use a Row suffix, for example InvoiceRow.", "source": {"kind": "file", "locator": "src/db/types.ts:4", "quote": "export interface InvoiceRow {"}, "supersedes": []},
  ],
  questions: [
    {"query": "how do I execute the unit test suite?", "day": 22, "expect": {"anyOf": [["s3-w1", "s3-w2", "s3-w3"]], "forbidden": [], "duplicates": [["s3-w1", "s3-w2", "s3-w3"]], "contradiction": false}},
    {"query": "Which testing framework is ledgerline on?", "day": 22, "expect": {"anyOf": [["s3-w1", "s3-w2", "s3-w3"]], "forbidden": [], "duplicates": [["s3-w1", "s3-w2", "s3-w3"]], "contradiction": false}},
  ] },
  { "id": "s4", "kind": "near-duplicate", "why": "The migration tool and how to apply migrations are written up by three agents.", writes: [
    {"id": "s4-w1", "agent": "agent:builder", "day": 5, "subject": "db", "slot": "migrations-tool", "text": "Schema migrations use node-pg-migrate, and the migration files live in migrations/.", "source": {"kind": "file", "locator": "package.json:14", "quote": "\"migrate\": \"node-pg-migrate -m migrations\","}, "supersedes": []},
    {"id": "s4-w2", "agent": "agent:onboarding", "day": 11, "subject": "setup", "slot": "migrate", "text": "Apply pending database migrations with `npm run migrate up`, which runs node-pg-migrate over migrations/.", "source": {"kind": "command-output", "locator": "npm run migrate up output", "quote": "> node-pg-migrate -m migrations up\n### MIGRATION 1715000000000_create-invoices (UP) ###"}, "supersedes": []},
    {"id": "s4-w3", "agent": "agent:ci-fixer", "day": 18, "subject": "ci", "slot": "migrations", "text": "Migrations are managed by node-pg-migrate through the npm migrate script, run as 'npm run migrate up'.", "source": {"kind": "file", "locator": ".github/workflows/ci.yml:38", "quote": "      - run: npm run migrate up"}, "supersedes": []},
    {"id": "s4-w4", "agent": "agent:release", "day": 16, "subject": "release", "slot": "changelog", "text": "The changelog is generated by changesets at release time.", "source": {"kind": "file", "locator": ".changeset/config.json:2", "quote": "\"changelog\": \"@changesets/cli/changelog\","}, "supersedes": []},
  ],
  questions: [
    {"query": "what tool handles schema changes and how do I run them against my DB?", "day": 20, "expect": {"anyOf": [["s4-w1", "s4-w2", "s4-w3"]], "forbidden": [], "duplicates": [["s4-w1", "s4-w2", "s4-w3"]], "contradiction": false}},
  ] },
  { "id": "s5", "kind": "near-duplicate", "why": "Two facts (the staging trigger and the prod trigger) are each recorded twice under different keys.", writes: [
    {"id": "s5-w1", "agent": "agent:release", "day": 10, "subject": "deploy", "slot": "staging-trigger", "text": "Staging deploys automatically on every push to main.", "source": {"kind": "file", "locator": ".github/workflows/deploy-staging.yml:3", "quote": "on:\n  push:\n    branches: [main]"}, "supersedes": []},
    {"id": "s5-w2", "agent": "agent:planner", "day": 14, "subject": "environments", "slot": "staging", "text": "Merging to main starts the staging rollout with no manual step.", "source": {"kind": "file", "locator": ".github/workflows/deploy-staging.yml:3", "quote": "on:\n  push:\n    branches: [main]"}, "supersedes": []},
    {"id": "s5-w3", "agent": "agent:release", "day": 10, "subject": "deploy", "slot": "prod-trigger", "text": "Prod deploys run only when a tag matching v* is pushed.", "source": {"kind": "file", "locator": ".github/workflows/deploy-prod.yml:3", "quote": "on:\n  push:\n    tags: ['v*']"}, "supersedes": []},
    {"id": "s5-w4", "agent": "agent:ci-fixer", "day": 19, "subject": "cd", "slot": "production", "text": "A production release is triggered by pushing a version tag such as v1.2.3.", "source": {"kind": "file", "locator": ".github/workflows/deploy-prod.yml:5", "quote": "    tags: ['v*']"}, "supersedes": []},
    {"id": "s5-w5", "agent": "agent:builder", "day": 12, "subject": "api", "slot": "pagination", "text": "List endpoints use cursor pagination with a maximum limit of 100.", "source": {"kind": "file", "locator": "src/http/pagination.ts:7", "quote": "const MAX_LIMIT = 100;"}, "supersedes": []},
  ],
  questions: [
    {"query": "What causes staging to get a fresh deploy?", "day": 21, "expect": {"anyOf": [["s5-w1", "s5-w2"]], "forbidden": [], "duplicates": [["s5-w1", "s5-w2"]], "contradiction": false}},
    {"query": "How do I ship a build to the production cluster?", "day": 21, "expect": {"anyOf": [["s5-w3", "s5-w4"]], "forbidden": [], "duplicates": [["s5-w3", "s5-w4"]], "contradiction": false}},
  ] },
  { "id": "s6", "kind": "near-duplicate", "why": "The PDF render queue name is recorded by three agents, one of them from a chat.", writes: [
    {"id": "s6-w1", "agent": "agent:builder", "day": 7, "subject": "worker", "slot": "queue", "text": "Background jobs use BullMQ on Redis, and invoice PDFs are rendered from the invoice-render queue.", "source": {"kind": "file", "locator": "src/worker/queues.ts:4", "quote": "export const invoiceRenderQueue = new Queue('invoice-render', { connection });"}, "supersedes": []},
    {"id": "s6-w2", "agent": "agent:reviewer", "day": 15, "subject": "jobs", "slot": "pdf-queue", "text": "PDF generation is added to the BullMQ queue named invoice-render.", "source": {"kind": "file", "locator": "src/invoices/service.ts:58", "quote": "await invoiceRenderQueue.add('render', { invoiceId });"}, "supersedes": []},
    {"id": "s6-w3", "agent": "agent:planner", "day": 17, "subject": "architecture", "slot": "async", "text": "Invoice rendering runs asynchronously through a Redis-backed BullMQ queue called 'invoice-render'.", "source": {"kind": "chat", "locator": "chat with agent:builder", "quote": "rendering goes through the invoice-render bullmq queue"}, "supersedes": []},
    {"id": "s6-w4", "agent": "agent:onboarding", "day": 16, "subject": "env", "slot": "required", "text": "The API exits at boot if LEDGER_WEBHOOK_SECRET is not set.", "source": {"kind": "file", "locator": "src/config/index.ts:21", "quote": "if (!process.env.LEDGER_WEBHOOK_SECRET) throw new Error('LEDGER_WEBHOOK_SECRET is required');"}, "supersedes": []},
    {"id": "s6-w5", "agent": "agent:ci-fixer", "day": 18, "subject": "ci", "slot": "timeout", "text": "The CI test job has a 20-minute timeout.", "source": {"kind": "file", "locator": ".github/workflows/ci.yml:15", "quote": "    timeout-minutes: 20"}, "supersedes": []},
  ],
  questions: [
    {"query": "Which queue do PDF render jobs get pushed to?", "day": 20, "expect": {"anyOf": [["s6-w1", "s6-w2", "s6-w3"]], "forbidden": [], "duplicates": [["s6-w1", "s6-w2", "s6-w3"]], "contradiction": false}},
  ] },
  { "id": "s7", "kind": "near-duplicate", "why": "The Node runtime version is recorded from .nvmrc, the CI config and engines.", writes: [
    {"id": "s7-w1", "agent": "agent:onboarding", "day": 1, "subject": "runtime", "slot": "node-version", "text": "Ledgerline targets Node 20.11, pinned in .nvmrc.", "source": {"kind": "file", "locator": ".nvmrc:1", "quote": "20.11.1"}, "supersedes": []},
    {"id": "s7-w2", "agent": "agent:ci-fixer", "day": 9, "subject": "ci", "slot": "node", "text": "CI reads the Node version from .nvmrc, so it runs Node 20.11.1.", "source": {"kind": "file", "locator": ".github/workflows/ci.yml:18", "quote": "          node-version-file: .nvmrc"}, "supersedes": []},
    {"id": "s7-w3", "agent": "agent:builder", "day": 12, "subject": "tooling", "slot": "engines", "text": "package.json engines requires Node >=20.11 and <21.", "source": {"kind": "file", "locator": "package.json:6", "quote": "\"engines\": { \"node\": \">=20.11 <21\" },"}, "supersedes": []},
    {"id": "s7-w4", "agent": "agent:reviewer", "day": 11, "subject": "api", "slot": "errors", "text": "API errors use RFC 7807 application/problem+json bodies.", "source": {"kind": "file", "locator": "src/http/errors.ts:12", "quote": "reply.type('application/problem+json');"}, "supersedes": []},
    {"id": "s7-w5", "agent": "agent:planner", "day": 13, "subject": "db", "slot": "backups", "text": "Prod Postgres takes nightly snapshots and keeps them for 14 days.", "source": {"kind": "chat", "locator": "chat with agent:release", "quote": "snapshots are nightly, kept two weeks"}, "supersedes": []},
  ],
  questions: [
    {"query": "What Node.js version should my local environment use for ledgerline?", "day": 15, "expect": {"anyOf": [["s7-w1", "s7-w2", "s7-w3"]], "forbidden": [], "duplicates": [["s7-w1", "s7-w2", "s7-w3"]], "contradiction": false}},
  ] },
  { "id": "s8", "kind": "near-duplicate", "why": "The API key auth scheme and hashed storage are described three ways.", writes: [
    {"id": "s8-w1", "agent": "agent:builder", "day": 4, "subject": "auth", "slot": "api-keys", "text": "API clients authenticate with an Authorization: Bearer API key, and keys are stored as SHA-256 hashes in the api_keys table.", "source": {"kind": "file", "locator": "src/auth/apiKey.ts:15", "quote": "const hash = createHash('sha256').update(token).digest('hex');"}, "supersedes": []},
    {"id": "s8-w2", "agent": "agent:reviewer", "day": 10, "subject": "security", "slot": "key-storage", "text": "Only SHA-256 digests of API keys are stored (api_keys.key_hash), never the raw key. Clients send the key as a bearer token.", "source": {"kind": "file", "locator": "migrations/1715000100000_api-keys.js:8", "quote": "key_hash: { type: 'char(64)', notNull: true, unique: true },"}, "supersedes": []},
    {"id": "s8-w3", "agent": "agent:onboarding", "day": 14, "subject": "howto", "slot": "auth", "text": "Call the API with the header Authorization: Bearer <api key>. The server hashes the key with SHA-256 and looks it up in api_keys.", "source": {"kind": "command-output", "locator": "curl -i localhost:3000/v1/invoices output", "quote": "HTTP/1.1 401 Unauthorized\nwww-authenticate: Bearer realm=\"ledgerline\""}, "supersedes": []},
    {"id": "s8-w4", "agent": "agent:planner", "day": 12, "subject": "feature", "slot": "credit-notes", "text": "Credit notes are scoped for milestone M4.", "source": {"kind": "chat", "locator": "chat with agent:release", "quote": "credit notes land in M4"}, "supersedes": []},
  ],
  questions: [
    {"query": "How does a client prove its identity to the invoicing API, and how are the keys kept server-side?", "day": 16, "expect": {"anyOf": [["s8-w1", "s8-w2", "s8-w3"]], "forbidden": [], "duplicates": [["s8-w1", "s8-w2", "s8-w3"]], "contradiction": false}},
  ] },
  { "id": "s9", "kind": "silent-contradiction", "why": "True update: a commit changed the default terms from net-30 to net-14, and the new write does not mark that it supersedes the old one.", writes: [
    {"id": "s9-w1", "agent": "agent:builder", "day": 5, "subject": "invoices", "slot": "default-terms", "text": "New invoices default to net-30 payment terms.", "source": {"kind": "file", "locator": "src/invoices/defaults.ts:3", "quote": "export const DEFAULT_TERMS_DAYS = 30;"}, "supersedes": []},
    {"id": "s9-w2", "agent": "agent:planner", "day": 8, "subject": "api", "slot": "versioning", "text": "Public routes are versioned under the /v1 prefix.", "source": {"kind": "file", "locator": "src/http/server.ts:30", "quote": "app.register(v1Routes, { prefix: '/v1' });"}, "supersedes": []},
    {"id": "s9-w3", "agent": "agent:reviewer", "day": 34, "subject": "billing", "slot": "payment-terms", "text": "A new invoice is due 14 days after issue by default (net-14).", "source": {"kind": "commit", "locator": "commit 8c41e2d", "quote": "-export const DEFAULT_TERMS_DAYS = 30;\n+export const DEFAULT_TERMS_DAYS = 14;"}, "supersedes": []},
    {"id": "s9-w4", "agent": "agent:onboarding", "day": 20, "subject": "howto", "slot": "seed", "text": "npm run seed loads three demo customers into the dev database.", "source": {"kind": "command-output", "locator": "npm run seed output", "quote": "seeded 3 customers, 12 invoices"}, "supersedes": []},
  ],
  questions: [
    {"query": "If I create an invoice without specifying terms, when is it due?", "day": 40, "expect": {"anyOf": [["s9-w3"]], "forbidden": ["s9-w1"], "duplicates": [], "contradiction": false}},
  ] },
  { "id": "s10", "kind": "silent-contradiction", "why": "Mistake: the newer agent read the test-helper pool size and reported it as the app's pool size.", writes: [
    {"id": "s10-w1", "agent": "agent:builder", "day": 6, "subject": "db", "slot": "pool-size", "text": "The API's pg Pool allows up to 20 connections unless PG_POOL_MAX overrides it.", "source": {"kind": "file", "locator": "src/db/pool.ts:14", "quote": "  max: Number(process.env.PG_POOL_MAX ?? 20),"}, "supersedes": []},
    {"id": "s10-w2", "agent": "agent:release", "day": 15, "subject": "deploy", "slot": "replicas", "text": "Prod runs 3 API replicas.", "source": {"kind": "file", "locator": "k8s/prod/deployment.yaml:8", "quote": "  replicas: 3"}, "supersedes": []},
    {"id": "s10-w3", "agent": "agent:ci-fixer", "day": 27, "subject": "postgres", "slot": "connections", "text": "The Postgres connection pool is capped at 5 connections.", "source": {"kind": "file", "locator": "tests/helpers/db.ts:8", "quote": "export const testPool = new Pool({ connectionString, max: 5 });"}, "supersedes": []},
    {"id": "s10-w4", "agent": "agent:onboarding", "day": 18, "subject": "db", "slot": "statement-timeout", "text": "The Postgres statement timeout for app queries is 15 seconds.", "source": {"kind": "file", "locator": "src/db/pool.ts:16", "quote": "  statement_timeout: 15000,"}, "supersedes": []},
  ],
  questions: [
    {"query": "How many connections can the application's database pool open?", "day": 30, "expect": {"anyOf": [["s10-w1"]], "forbidden": ["s10-w3"], "duplicates": [], "contradiction": false}},
  ] },
  { "id": "s11", "kind": "silent-contradiction", "why": "True update: a commit raised the rate limit to 300 per minute, while an old write and a stale README still say 100.", writes: [
    {"id": "s11-w1", "agent": "agent:planner", "day": 4, "subject": "api", "slot": "rate-limit", "text": "The public API is rate limited to 100 requests per minute per API key.", "source": {"kind": "file", "locator": "src/http/rateLimit.ts:6", "quote": "  max: 100,\n  timeWindow: '1 minute',"}, "supersedes": []},
    {"id": "s11-w2", "agent": "agent:builder", "day": 29, "subject": "throttling", "slot": "per-key", "text": "The per-key request ceiling is now 300 per minute.", "source": {"kind": "commit", "locator": "commit b7e09f3", "quote": "-  max: 100,\n+  max: 300,"}, "supersedes": []},
    {"id": "s11-w3", "agent": "agent:reviewer", "day": 18, "subject": "logging", "slot": "redaction", "text": "Pino redacts the authorization request header from logs.", "source": {"kind": "file", "locator": "src/http/logger.ts:9", "quote": "redact: ['req.headers.authorization'],"}, "supersedes": []},
    {"id": "s11-w4", "agent": "agent:onboarding", "day": 31, "subject": "docs", "slot": "rate-limit", "text": "Clients may send 100 requests per minute per key.", "source": {"kind": "file", "locator": "README.md:88", "quote": "Requests are limited to 100/min per key."}, "supersedes": []},
  ],
  questions: [
    {"query": "What's the current per-key throughput limit on the public API?", "day": 35, "expect": {"anyOf": [["s11-w2"]], "forbidden": ["s11-w1", "s11-w4"], "duplicates": [], "contradiction": false}},
  ] },
  { "id": "s12", "kind": "silent-contradiction", "why": "Probable mistake: a newer write infers 3 attempts from a log, against a file-cited 5, and nothing resolves the conflict.", writes: [
    {"id": "s12-w1", "agent": "agent:builder", "day": 9, "subject": "worker", "slot": "retries", "text": "invoice-render jobs retry up to 5 attempts with exponential backoff starting at 2s.", "source": {"kind": "file", "locator": "src/worker/queues.ts:9", "quote": "defaultJobOptions: { attempts: 5, backoff: { type: 'exponential', delay: 2000 } },"}, "supersedes": []},
    {"id": "s12-w2", "agent": "agent:ci-fixer", "day": 38, "subject": "jobs", "slot": "attempts", "text": "Render jobs are attempted only 3 times before they land in the failed set.", "source": {"kind": "inference", "locator": "own reasoning", "quote": "BullMQ default attempts is 3, and I saw 3 failures in the log before it stopped"}, "supersedes": []},
    {"id": "s12-w3", "agent": "agent:planner", "day": 20, "subject": "billing", "slot": "currency", "text": "Invoices support USD, EUR and GBP.", "source": {"kind": "file", "locator": "src/invoices/currency.ts:2", "quote": "export const SUPPORTED = ['USD', 'EUR', 'GBP'] as const;"}, "supersedes": []},
    {"id": "s12-w4", "agent": "agent:reviewer", "day": 25, "subject": "worker", "slot": "metrics", "text": "The worker exposes Prometheus metrics on port 9464.", "source": {"kind": "file", "locator": "src/worker/metrics.ts:6", "quote": "const METRICS_PORT = 9464;"}, "supersedes": []},
  ],
  questions: [
    {"query": "How many times will a failing PDF render job be tried before giving up?", "day": 40, "expect": {"anyOf": [["s12-w1"], ["s12-w2"]], "forbidden": [], "duplicates": [], "contradiction": true}},
  ] },
  { "id": "s13", "kind": "silent-contradiction", "why": "True update: the staging namespace was renamed, and the newer file quote shows the new name.", writes: [
    {"id": "s13-w1", "agent": "agent:release", "day": 7, "subject": "k8s", "slot": "staging-namespace", "text": "Staging workloads run in the Kubernetes namespace ledgerline-stg.", "source": {"kind": "file", "locator": "k8s/staging/kustomization.yaml:4", "quote": "namespace: ledgerline-stg"}, "supersedes": []},
    {"id": "s13-w2", "agent": "agent:ci-fixer", "day": 33, "subject": "deploy", "slot": "staging-ns", "text": "The staging deploy targets the namespace ledgerline-staging.", "source": {"kind": "file", "locator": "k8s/staging/kustomization.yaml:4", "quote": "namespace: ledgerline-staging"}, "supersedes": []},
    {"id": "s13-w3", "agent": "agent:builder", "day": 22, "subject": "worker", "slot": "failed-retention", "text": "Failed jobs older than 7 days are pruned from Redis.", "source": {"kind": "file", "locator": "src/worker/cleanup.ts:5", "quote": "removeOnFail: { age: 7 * 24 * 3600 },"}, "supersedes": []},
    {"id": "s13-w4", "agent": "agent:onboarding", "day": 25, "subject": "access", "slot": "kubectl", "text": "Engineers get staging kubectl access through the ops-readonly group.", "source": {"kind": "chat", "locator": "chat with agent:release", "quote": "ask to be added to ops-readonly for staging kubectl"}, "supersedes": []},
  ],
  questions: [
    {"query": "Which namespace do I pass to kubectl to see staging pods?", "day": 36, "expect": {"anyOf": [["s13-w2"]], "forbidden": ["s13-w1"], "duplicates": [], "contradiction": false}},
  ] },
  { "id": "s14", "kind": "silent-contradiction", "why": "Probable mistake: a chat remark says amounts are numeric dollars, against a migration that uses bigint cents.", writes: [
    {"id": "s14-w1", "agent": "agent:builder", "day": 3, "subject": "db", "slot": "money", "text": "Monetary amounts are stored as bigint integer cents in amount_cents columns.", "source": {"kind": "file", "locator": "migrations/1715000000000_create-invoices.js:14", "quote": "amount_cents: { type: 'bigint', notNull: true },"}, "supersedes": []},
    {"id": "s14-w2", "agent": "agent:reviewer", "day": 26, "subject": "invoices", "slot": "amount-type", "text": "Invoice amounts are stored in a numeric(12,2) column in dollars.", "source": {"kind": "chat", "locator": "chat with agent:planner", "quote": "amounts are numeric(12,2) I think"}, "supersedes": []},
    {"id": "s14-w3", "agent": "agent:ci-fixer", "day": 12, "subject": "ci", "slot": "postgres-service", "text": "CI uses postgres:16 as a service container.", "source": {"kind": "file", "locator": ".github/workflows/ci.yml:10", "quote": "        image: postgres:16"}, "supersedes": []},
    {"id": "s14-w4", "agent": "agent:onboarding", "day": 18, "subject": "howto", "slot": "psql", "text": "npm run db:shell opens psql against the dev database.", "source": {"kind": "file", "locator": "package.json:16", "quote": "\"db:shell\": \"psql $DATABASE_URL\","}, "supersedes": []},
  ],
  questions: [
    {"query": "What column type holds invoice totals, and in what unit?", "day": 30, "expect": {"anyOf": [["s14-w1"], ["s14-w2"]], "forbidden": [], "duplicates": [], "contradiction": true}},
  ] },
  { "id": "s15", "kind": "silent-contradiction", "why": "True update: the CI Node matrix moved from 18/20 to 20/22, and the newer write cites the current file.", writes: [
    {"id": "s15-w1", "agent": "agent:ci-fixer", "day": 6, "subject": "ci", "slot": "node-matrix", "text": "CI tests on Node 18 and 20.", "source": {"kind": "file", "locator": ".github/workflows/ci.yml:14", "quote": "        node: [18, 20]"}, "supersedes": []},
    {"id": "s15-w2", "agent": "agent:builder", "day": 41, "subject": "build", "slot": "matrix", "text": "The test workflow's matrix covers Node 20 and 22.", "source": {"kind": "file", "locator": ".github/workflows/ci.yml:14", "quote": "        node: [20, 22]"}, "supersedes": []},
    {"id": "s15-w3", "agent": "agent:reviewer", "day": 30, "subject": "review", "slot": "pr-template", "text": "The PR template requires a Risk section.", "source": {"kind": "file", "locator": ".github/pull_request_template.md:7", "quote": "## Risk"}, "supersedes": []},
    {"id": "s15-w4", "agent": "agent:release", "day": 35, "subject": "release", "slot": "version", "text": "The latest tagged release is v1.6.0.", "source": {"kind": "command-output", "locator": "git describe --tags", "quote": "v1.6.0"}, "supersedes": []},
  ],
  questions: [
    {"query": "Which Node versions does CI run the tests against?", "day": 45, "expect": {"anyOf": [["s15-w2"]], "forbidden": ["s15-w1"], "duplicates": [], "contradiction": false}},
  ] },
  { "id": "s16", "kind": "silent-contradiction", "why": "Probable mistake: a chat remark claims lint allows 50 warnings, against a package.json that sets --max-warnings 0.", writes: [
    {"id": "s16-w1", "agent": "agent:reviewer", "day": 8, "subject": "lint", "slot": "strictness", "text": "Lint fails on any warning because npm run lint uses eslint --max-warnings 0.", "source": {"kind": "file", "locator": "package.json:12", "quote": "\"lint\": \"eslint . --max-warnings 0\","}, "supersedes": []},
    {"id": "s16-w2", "agent": "agent:builder", "day": 33, "subject": "tooling", "slot": "eslint", "text": "Lint tolerates up to 50 warnings before it fails.", "source": {"kind": "chat", "locator": "chat with agent:ci-fixer", "quote": "lint lets ~50 warnings through, don't worry about it"}, "supersedes": []},
    {"id": "s16-w3", "agent": "agent:planner", "day": 20, "subject": "api", "slot": "idempotency", "text": "POST /v1/invoices honors an Idempotency-Key header for 24 hours.", "source": {"kind": "file", "locator": "src/http/idempotency.ts:11", "quote": "const TTL_SECONDS = 24 * 60 * 60;"}, "supersedes": []},
    {"id": "s16-w4", "agent": "agent:onboarding", "day": 28, "subject": "env", "slot": "timezone", "text": "Containers run in UTC because the Dockerfile sets TZ=UTC.", "source": {"kind": "file", "locator": "Dockerfile:6", "quote": "ENV TZ=UTC"}, "supersedes": []},
  ],
  questions: [
    {"query": "Will my PR fail lint if it introduces a couple of ESLint warnings?", "day": 35, "expect": {"anyOf": [["s16-w1"], ["s16-w2"]], "forbidden": [], "duplicates": [], "contradiction": true}},
  ] },
  { "id": "s17", "kind": "stale-code", "why": "The default port changed from 3000 to 8080, and two duplicate facts go stale.", writes: [
    {"id": "s17-w1", "agent": "agent:builder", "day": 4, "subject": "config", "slot": "port", "text": "The API listens on port 3000 unless PORT is set.", "source": {"kind": "file", "locator": "src/config/index.ts:7", "quote": "export const PORT = Number(process.env.PORT ?? 3000);"}, "supersedes": []},
    {"id": "s17-w2", "agent": "agent:onboarding", "day": 6, "subject": "setup", "slot": "env-file", "text": "Copy .env.example to .env before running locally.", "source": {"kind": "file", "locator": "README.md:22", "quote": "cp .env.example .env"}, "supersedes": []},
    {"id": "s17-w3", "agent": "agent:reviewer", "day": 9, "subject": "testing", "slot": "coverage", "text": "The coverage threshold is 80% of lines.", "source": {"kind": "file", "locator": "vitest.config.ts:12", "quote": "        lines: 80,"}, "supersedes": []},
    {"id": "s17-w4", "agent": "agent:ci-fixer", "day": 11, "subject": "dev", "slot": "port", "text": "The local dev server binds port 3000 by default.", "source": {"kind": "file", "locator": "src/config/index.ts:7", "quote": "export const PORT = Number(process.env.PORT ?? 3000);"}, "supersedes": []},
  ],
  codeChanges: [{"day": 24, "locator": "src/config/index.ts:7", "before": "export const PORT = Number(process.env.PORT ?? 3000);", "after": "export const PORT = Number(process.env.PORT ?? 8080);", "breaksFact": ["s17-w1", "s17-w4"]}],
  questions: [
    {"query": "What port does the API use by default?", "day": 15, "expect": {"anyOf": [["s17-w1", "s17-w4"]], "forbidden": [], "duplicates": [["s17-w1", "s17-w4"]], "contradiction": false}},
    {"query": "If PORT isn't set, which port will the server bind to now?", "day": 30, "expect": {"anyOf": [[]], "forbidden": ["s17-w1", "s17-w4"], "duplicates": [], "contradiction": false}},
  ] },
  { "id": "s18", "kind": "stale-code", "why": "The cited Puppeteer line gains launch args, but the fact stays true.", writes: [
    {"id": "s18-w1", "agent": "agent:builder", "day": 10, "subject": "pdf", "slot": "renderer", "text": "Invoice PDFs are rendered with headless Puppeteer (Chromium).", "source": {"kind": "file", "locator": "src/invoices/pdf.ts:31", "quote": "const browser = await puppeteer.launch({ headless: true });"}, "supersedes": []},
    {"id": "s18-w2", "agent": "agent:planner", "day": 12, "subject": "product", "slot": "templates", "text": "Invoice templates are Handlebars files at templates/invoice.hbs.", "source": {"kind": "file", "locator": "src/invoices/pdf.ts:12", "quote": "const template = Handlebars.compile(readFileSync('templates/invoice.hbs', 'utf8'));"}, "supersedes": []},
    {"id": "s18-w3", "agent": "agent:ci-fixer", "day": 14, "subject": "ci", "slot": "artifacts", "text": "CI uploads the coverage/ directory as a build artifact.", "source": {"kind": "file", "locator": ".github/workflows/ci.yml:52", "quote": "          path: coverage/"}, "supersedes": []},
    {"id": "s18-w4", "agent": "agent:onboarding", "day": 18, "subject": "howto", "slot": "pdf-engine", "text": "PDF generation drives a headless Chromium through puppeteer.", "source": {"kind": "file", "locator": "src/invoices/pdf.ts:31", "quote": "const browser = await puppeteer.launch({ headless: true });"}, "supersedes": []},
  ],
  codeChanges: [{"day": 26, "locator": "src/invoices/pdf.ts:31", "before": "const browser = await puppeteer.launch({ headless: true });", "after": "const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });", "breaksFact": []}],
  questions: [
    {"query": "What library generates the invoice PDFs?", "day": 32, "expect": {"anyOf": [["s18-w1", "s18-w4"]], "forbidden": [], "duplicates": [["s18-w1", "s18-w4"]], "contradiction": false}},
  ] },
  { "id": "s19", "kind": "stale-code", "why": "Worker concurrency changes from 4 to an env default of 8, while the queue-name fact two lines above stays true.", writes: [
    {"id": "s19-w1", "agent": "agent:builder", "day": 8, "subject": "worker", "slot": "concurrency", "text": "The render worker processes 4 jobs concurrently.", "source": {"kind": "file", "locator": "src/worker/index.ts:12", "quote": "  concurrency: 4,"}, "supersedes": []},
    {"id": "s19-w2", "agent": "agent:reviewer", "day": 9, "subject": "worker", "slot": "entrypoint", "text": "The worker entrypoint src/worker/index.ts consumes the invoice-render queue.", "source": {"kind": "file", "locator": "src/worker/index.ts:10", "quote": "const worker = new Worker('invoice-render', processor, {"}, "supersedes": []},
    {"id": "s19-w3", "agent": "agent:planner", "day": 13, "subject": "capacity", "slot": "worker-parallelism", "text": "Each worker pod handles four render jobs in parallel.", "source": {"kind": "chat", "locator": "chat with agent:builder", "quote": "worker concurrency is 4"}, "supersedes": []},
    {"id": "s19-w4", "agent": "agent:release", "day": 15, "subject": "deploy", "slot": "worker-replicas", "text": "Prod runs 2 worker replicas.", "source": {"kind": "file", "locator": "k8s/prod/worker.yaml:8", "quote": "  replicas: 2"}, "supersedes": []},
  ],
  codeChanges: [{"day": 21, "locator": "src/worker/index.ts:12", "before": "  concurrency: 4,", "after": "  concurrency: Number(process.env.WORKER_CONCURRENCY ?? 8),", "breaksFact": ["s19-w1", "s19-w3"]}],
  questions: [
    {"query": "How many jobs does one worker process run at the same time?", "day": 28, "expect": {"anyOf": [[]], "forbidden": ["s19-w1", "s19-w3"], "duplicates": [], "contradiction": false}},
    {"query": "Which queue does the worker consume from?", "day": 28, "expect": {"anyOf": [["s19-w2"]], "forbidden": [], "duplicates": [], "contradiction": false}},
  ] },
  { "id": "s20", "kind": "stale-code", "why": "The JWT TTL changes on day 30. Questions before and after the change test time awareness.", writes: [
    {"id": "s20-w1", "agent": "agent:builder", "day": 5, "subject": "auth", "slot": "jwt-ttl", "text": "Dashboard session JWTs expire after 15 minutes.", "source": {"kind": "file", "locator": "src/auth/jwt.ts:18", "quote": "  expiresIn: '15m',"}, "supersedes": []},
    {"id": "s20-w2", "agent": "agent:reviewer", "day": 7, "subject": "security", "slot": "session-length", "text": "Dashboard access tokens live for 15m.", "source": {"kind": "file", "locator": "src/auth/jwt.ts:18", "quote": "  expiresIn: '15m',"}, "supersedes": []},
    {"id": "s20-w3", "agent": "agent:onboarding", "day": 9, "subject": "auth", "slot": "refresh", "text": "Refresh tokens are kept in an httpOnly cookie named ll_refresh.", "source": {"kind": "file", "locator": "src/auth/cookies.ts:4", "quote": "export const REFRESH_COOKIE = 'll_refresh';"}, "supersedes": []},
    {"id": "s20-w4", "agent": "agent:planner", "day": 11, "subject": "roadmap", "slot": "sso", "text": "SSO for the dashboard is planned but not started.", "source": {"kind": "chat", "locator": "chat with agent:release", "quote": "SSO is on the list, nobody's on it yet"}, "supersedes": []},
  ],
  codeChanges: [{"day": 30, "locator": "src/auth/jwt.ts:18", "before": "  expiresIn: '15m',", "after": "  expiresIn: '1h',", "breaksFact": ["s20-w1", "s20-w2"]}],
  questions: [
    {"query": "How long is a dashboard access token valid?", "day": 20, "expect": {"anyOf": [["s20-w1", "s20-w2"]], "forbidden": [], "duplicates": [["s20-w1", "s20-w2"]], "contradiction": false}},
    {"query": "how long until a dashboard JWT expires these days?", "day": 40, "expect": {"anyOf": [[]], "forbidden": ["s20-w1", "s20-w2"], "duplicates": [], "contradiction": false}},
    {"query": "What's the refresh cookie called?", "day": 40, "expect": {"anyOf": [["s20-w3"]], "forbidden": [], "duplicates": [], "contradiction": false}},
  ] },
  { "id": "s21", "kind": "stale-code", "why": "The cited npm ci line gains --ignore-scripts, which does not change the fact.", writes: [
    {"id": "s21-w1", "agent": "agent:ci-fixer", "day": 6, "subject": "ci", "slot": "install", "text": "CI installs dependencies with npm ci.", "source": {"kind": "file", "locator": ".github/workflows/ci.yml:24", "quote": "      - run: npm ci"}, "supersedes": []},
    {"id": "s21-w2", "agent": "agent:builder", "day": 10, "subject": "build", "slot": "output", "text": "tsc emits to dist/ with source maps.", "source": {"kind": "file", "locator": "tsconfig.build.json:5", "quote": "\"outDir\": \"dist\", \"sourceMap\": true,"}, "supersedes": []},
    {"id": "s21-w3", "agent": "agent:reviewer", "day": 11, "subject": "deps", "slot": "policy", "text": "New runtime dependencies need reviewer sign-off.", "source": {"kind": "chat", "locator": "chat with agent:planner", "quote": "ping reviewer before adding runtime deps"}, "supersedes": []},
    {"id": "s21-w4", "agent": "agent:onboarding", "day": 15, "subject": "ci", "slot": "deps", "text": "The CI workflow does a clean lockfile install with npm ci instead of npm install.", "source": {"kind": "file", "locator": ".github/workflows/ci.yml:24", "quote": "      - run: npm ci"}, "supersedes": []},
  ],
  codeChanges: [{"day": 22, "locator": ".github/workflows/ci.yml:24", "before": "      - run: npm ci", "after": "      - run: npm ci --ignore-scripts", "breaksFact": []}],
  questions: [
    {"query": "Does CI use npm install or npm ci?", "day": 30, "expect": {"anyOf": [["s21-w1", "s21-w4"]], "forbidden": [], "duplicates": [["s21-w1", "s21-w4"]], "contradiction": false}},
  ] },
  { "id": "s22", "kind": "stale-code", "why": "The tax rate constant changes and breaks one fact. The rounding line also changes, but rounding is still half-even.", writes: [
    {"id": "s22-w1", "agent": "agent:builder", "day": 12, "subject": "tax", "slot": "default-rate", "text": "The default tax rate, used when a customer has none, is 20%.", "source": {"kind": "file", "locator": "src/invoices/tax.ts:9", "quote": "const DEFAULT_TAX_RATE = 0.2;"}, "supersedes": []},
    {"id": "s22-w2", "agent": "agent:reviewer", "day": 14, "subject": "tax", "slot": "rounding", "text": "Tax is rounded half-even to whole cents.", "source": {"kind": "file", "locator": "src/invoices/tax.ts:15", "quote": "  return roundHalfEven(amountCents * rate);"}, "supersedes": []},
    {"id": "s22-w3", "agent": "agent:planner", "day": 16, "subject": "roadmap", "slot": "tax-provider", "text": "Integration with an external tax engine is deferred to Q1.", "source": {"kind": "chat", "locator": "chat with agent:release", "quote": "tax engine integration slips to Q1"}, "supersedes": []},
    {"id": "s22-w4", "agent": "agent:onboarding", "day": 18, "subject": "billing", "slot": "invoice-email", "text": "Invoice emails are sent through the worker's email-send queue.", "source": {"kind": "file", "locator": "src/worker/queues.ts:6", "quote": "export const emailSendQueue = new Queue('email-send', { connection });"}, "supersedes": []},
  ],
  codeChanges: [{"day": 27, "locator": "src/invoices/tax.ts:9", "before": "const DEFAULT_TAX_RATE = 0.2;", "after": "const DEFAULT_TAX_RATE = 0.21;", "breaksFact": ["s22-w1"]}, {"day": 29, "locator": "src/invoices/tax.ts:15", "before": "  return roundHalfEven(amountCents * rate);", "after": "  return roundHalfEven(Math.trunc(amountCents) * rate);", "breaksFact": []}],
  questions: [
    {"query": "What tax rate gets applied by default if the customer record has no rate?", "day": 33, "expect": {"anyOf": [[]], "forbidden": ["s22-w1"], "duplicates": [], "contradiction": false}},
    {"query": "How are computed tax amounts rounded?", "day": 33, "expect": {"anyOf": [["s22-w2"]], "forbidden": [], "duplicates": [], "contradiction": false}},
  ] },
  { "id": "s23", "kind": "stale-code", "why": "The Fastify bodyLimit rises from 1 MiB to 5 MiB, so both body-size facts go stale.", writes: [
    {"id": "s23-w1", "agent": "agent:builder", "day": 8, "subject": "http", "slot": "body-limit", "text": "Request bodies over 1 MiB are rejected (Fastify bodyLimit 1048576).", "source": {"kind": "file", "locator": "src/http/server.ts:44", "quote": "const app = Fastify({ bodyLimit: 1048576, logger });"}, "supersedes": []},
    {"id": "s23-w2", "agent": "agent:ci-fixer", "day": 10, "subject": "ci", "slot": "concurrency", "text": "CI cancels in-progress runs on the same branch.", "source": {"kind": "file", "locator": ".github/workflows/ci.yml:6", "quote": "  cancel-in-progress: true"}, "supersedes": []},
    {"id": "s23-w3", "agent": "agent:onboarding", "day": 18, "subject": "api", "slot": "upload-size", "text": "The largest JSON payload the API accepts is 1MB.", "source": {"kind": "file", "locator": "src/http/server.ts:44", "quote": "const app = Fastify({ bodyLimit: 1048576, logger });"}, "supersedes": []},
    {"id": "s23-w4", "agent": "agent:release", "day": 19, "subject": "release", "slot": "freeze", "text": "There is a release freeze on Fridays after 15:00 UTC.", "source": {"kind": "chat", "locator": "chat with agent:planner", "quote": "no releases friday after 3pm utc"}, "supersedes": []},
  ],
  codeChanges: [{"day": 25, "locator": "src/http/server.ts:44", "before": "const app = Fastify({ bodyLimit: 1048576, logger });", "after": "const app = Fastify({ bodyLimit: 5 * 1048576, logger });", "breaksFact": ["s23-w1", "s23-w3"]}],
  questions: [
    {"query": "What's the largest request body the API will accept?", "day": 31, "expect": {"anyOf": [[]], "forbidden": ["s23-w1", "s23-w3"], "duplicates": [], "contradiction": false}},
  ] },
  { "id": "s24", "kind": "stale-code", "why": "Two Dockerfile changes: the base image gets a more specific tag (fact still true), and USER switches to a numeric uid (the fact breaks).", writes: [
    {"id": "s24-w1", "agent": "agent:release", "day": 3, "subject": "docker", "slot": "base-image", "text": "The production image is built FROM node:20-alpine.", "source": {"kind": "file", "locator": "Dockerfile:1", "quote": "FROM node:20-alpine AS build"}, "supersedes": []},
    {"id": "s24-w2", "agent": "agent:builder", "day": 5, "subject": "docker", "slot": "runtime-user", "text": "The container runs as the non-root user named node.", "source": {"kind": "file", "locator": "Dockerfile:18", "quote": "USER node"}, "supersedes": []},
    {"id": "s24-w3", "agent": "agent:reviewer", "day": 9, "subject": "api", "slot": "cors", "text": "CORS allows only the dashboard origin read from the CORS_ORIGIN env var.", "source": {"kind": "file", "locator": "src/http/cors.ts:4", "quote": "origin: process.env.CORS_ORIGIN,"}, "supersedes": []},
    {"id": "s24-w4", "agent": "agent:ci-fixer", "day": 12, "subject": "ci", "slot": "docker-build", "text": "CI builds the Docker image only on main.", "source": {"kind": "file", "locator": ".github/workflows/ci.yml:60", "quote": "    if: github.ref == 'refs/heads/main'"}, "supersedes": []},
  ],
  codeChanges: [{"day": 20, "locator": "Dockerfile:1", "before": "FROM node:20-alpine AS build", "after": "FROM node:20.11-alpine AS build", "breaksFact": []}, {"day": 23, "locator": "Dockerfile:18", "before": "USER node", "after": "USER 10001", "breaksFact": ["s24-w2"]}],
  questions: [
    {"query": "What base image is the Docker build using?", "day": 30, "expect": {"anyOf": [["s24-w1"]], "forbidden": [], "duplicates": [], "contradiction": false}},
    {"query": "Which user does the container process run as?", "day": 30, "expect": {"anyOf": [[]], "forbidden": ["s24-w2"], "duplicates": [], "contradiction": false}},
  ] },
  { "id": "s25", "kind": "weak-evidence", "why": "Invoice number format and reset behavior. Two wrong inferences sit next to file-cited facts.", writes: [
    {"id": "s25-w1", "agent": "agent:builder", "day": 6, "subject": "invoices", "slot": "numbering", "text": "Invoice numbers use the format INV-<year>-<5-digit sequence>, with the sequence taken from invoice_number_seq.", "source": {"kind": "file", "locator": "src/invoices/number.ts:6", "quote": "return `INV-${year}-${String(seq).padStart(5, '0')}`;"}, "supersedes": []},
    {"id": "s25-w2", "agent": "agent:planner", "day": 8, "subject": "invoices", "slot": "id-format", "text": "Invoice numbers are UUIDs.", "source": {"kind": "inference", "locator": "own reasoning", "quote": "the invoices table uses uuid primary keys so the numbers must be UUIDs"}, "supersedes": []},
    {"id": "s25-w3", "agent": "agent:onboarding", "day": 10, "subject": "docs", "slot": "invoice-number", "text": "Invoice numbers look like INV-2026-00042.", "source": {"kind": "chat", "locator": "chat with agent:reviewer", "quote": "they look like INV-2026-00042"}, "supersedes": []},
    {"id": "s25-w4", "agent": "agent:reviewer", "day": 12, "subject": "numbering", "slot": "reset", "text": "The invoice sequence resets every January.", "source": {"kind": "inference", "locator": "own reasoning", "quote": "since the year is in the number, the counter probably restarts yearly"}, "supersedes": []},
    {"id": "s25-w5", "agent": "agent:builder", "day": 13, "subject": "invoices", "slot": "sequence", "text": "invoice_number_seq is a single global sequence that is created once and never reset.", "source": {"kind": "file", "locator": "migrations/1715000200000_invoice-number-seq.js:5", "quote": "pgm.createSequence('invoice_number_seq', { start: 1 });"}, "supersedes": []},
    {"id": "s25-w6", "agent": "agent:ci-fixer", "day": 14, "subject": "ci", "slot": "flake-retry", "text": "Vitest retries failing tests once in CI.", "source": {"kind": "file", "locator": "vitest.config.ts:8", "quote": "    retry: process.env.CI ? 1 : 0,"}, "supersedes": []},
  ],
  questions: [
    {"query": "What does an invoice number look like?", "day": 18, "expect": {"anyOf": [["s25-w1"]], "forbidden": ["s25-w2"], "duplicates": [], "contradiction": false}},
    {"query": "Does the invoice counter restart at the start of each year?", "day": 18, "expect": {"anyOf": [["s25-w5"]], "forbidden": ["s25-w4"], "duplicates": [], "contradiction": false}},
  ] },
  { "id": "s26", "kind": "weak-evidence", "why": "Prod secret sourcing and refresh interval. A wrong chat claim and a wrong inference sit next to a cited manifest.", writes: [
    {"id": "s26-w1", "agent": "agent:release", "day": 9, "subject": "secrets", "slot": "prod", "text": "Prod secrets come from an ExternalSecret that syncs the cluster secret store into the Kubernetes secret ledgerline-env.", "source": {"kind": "file", "locator": "k8s/prod/externalsecret.yaml:12", "quote": "    name: ledgerline-env"}, "supersedes": []},
    {"id": "s26-w2", "agent": "agent:onboarding", "day": 11, "subject": "secrets", "slot": "how", "text": "Prod reads its secrets from a .env file copied onto the nodes.", "source": {"kind": "chat", "locator": "chat with agent:planner", "quote": "prod just uses a .env on the box"}, "supersedes": []},
    {"id": "s26-w3", "agent": "agent:builder", "day": 13, "subject": "config", "slot": "env-loading", "text": "dotenv is loaded only when NODE_ENV is not production.", "source": {"kind": "file", "locator": "src/config/index.ts:2", "quote": "if (process.env.NODE_ENV !== 'production') await import('dotenv/config');"}, "supersedes": []},
    {"id": "s26-w4", "agent": "agent:planner", "day": 14, "subject": "security", "slot": "secrets", "text": "Secrets are injected into pods as env vars from a Kubernetes secret.", "source": {"kind": "file", "locator": "docs/ops.md:30", "quote": "Secrets are injected as env vars from a Kubernetes secret."}, "supersedes": []},
    {"id": "s26-w5", "agent": "agent:ci-fixer", "day": 15, "subject": "ci", "slot": "secrets", "text": "CI uses no prod secrets, and tests run with .env.test.", "source": {"kind": "file", "locator": ".github/workflows/ci.yml:40", "quote": "      - run: cp .env.test .env"}, "supersedes": []},
    {"id": "s26-w6", "agent": "agent:reviewer", "day": 16, "subject": "secrets", "slot": "rotation", "text": "Prod secrets sync and rotate automatically every 30 days.", "source": {"kind": "inference", "locator": "own reasoning", "quote": "external secrets usually have a monthly refreshInterval"}, "supersedes": []},
    {"id": "s26-w7", "agent": "agent:release", "day": 17, "subject": "secrets", "slot": "refresh", "text": "The ExternalSecret refreshes from the store every hour (refreshInterval: 1h). Rotating the underlying values is manual.", "source": {"kind": "file", "locator": "k8s/prod/externalsecret.yaml:6", "quote": "  refreshInterval: 1h"}, "supersedes": []},
  ],
  questions: [
    {"query": "Where does the production deployment get its secrets from?", "day": 20, "expect": {"anyOf": [["s26-w1"]], "forbidden": ["s26-w2"], "duplicates": [], "contradiction": false}},
    {"query": "How often does the prod secret sync pull fresh values?", "day": 20, "expect": {"anyOf": [["s26-w7"]], "forbidden": ["s26-w6"], "duplicates": [], "contradiction": false}},
  ] },
  { "id": "s27", "kind": "weak-evidence", "why": "Flaky test diagnosis. Command output shows a timer timeout, while two guesses blame Postgres or Redis.", writes: [
    {"id": "s27-w1", "agent": "agent:ci-fixer", "day": 20, "subject": "flaky", "slot": "retry-test", "text": "tests/worker/retry.test.ts is flaky because it waits on real backoff timers and hits Vitest's 5000ms default timeout.", "source": {"kind": "command-output", "locator": "npx vitest run tests/worker/retry.test.ts --repeat 20 output", "quote": "FAIL tests/worker/retry.test.ts > retries failed render\nError: Test timed out in 5000ms."}, "supersedes": []},
    {"id": "s27-w2", "agent": "agent:planner", "day": 21, "subject": "ci", "slot": "flakes", "text": "The flaky worker test is caused by a Postgres port conflict on CI runners.", "source": {"kind": "inference", "locator": "own reasoning", "quote": "flakes started after we added the postgres service, probably port clash"}, "supersedes": []},
    {"id": "s27-w3", "agent": "agent:reviewer", "day": 22, "subject": "tests", "slot": "flaky", "text": "The retry test flakes because of a race in Redis connection setup.", "source": {"kind": "chat", "locator": "chat with agent:builder", "quote": "probably a redis race"}, "supersedes": []},
    {"id": "s27-w4", "agent": "agent:ci-fixer", "day": 24, "subject": "flaky", "slot": "fix", "text": "With vi.useFakeTimers() in retry.test.ts, the test passes 200 of 200 runs.", "source": {"kind": "command-output", "locator": "npx vitest run tests/worker/retry.test.ts --repeat 200 output (with fake timers)", "quote": " Test Files  1 passed (1)\n      Tests  200 passed (200)"}, "supersedes": []},
    {"id": "s27-w5", "agent": "agent:builder", "day": 23, "subject": "api", "slot": "openapi", "text": "The OpenAPI spec is generated at build time to dist/openapi.json.", "source": {"kind": "file", "locator": "scripts/gen-openapi.ts:30", "quote": "writeFileSync('dist/openapi.json', JSON.stringify(spec, null, 2));"}, "supersedes": []},
  ],
  questions: [
    {"query": "Why does the worker retry test fail intermittently in CI?", "day": 26, "expect": {"anyOf": [["s27-w1"]], "forbidden": ["s27-w2", "s27-w3"], "duplicates": [], "contradiction": false}},
    {"query": "What change stops the retry test from flaking?", "day": 26, "expect": {"anyOf": [["s27-w4"]], "forbidden": ["s27-w2", "s27-w3"], "duplicates": [], "contradiction": false}},
  ] },
  { "id": "s28", "kind": "weak-evidence", "why": "Webhook signing details. The wrong header name and a wrong timestamp claim are weak, and the correct facts cite code or test output.", writes: [
    {"id": "s28-w1", "agent": "agent:builder", "day": 11, "subject": "webhooks", "slot": "signature", "text": "Outbound webhooks are signed with HMAC-SHA256 over the raw body, sent in the X-Ledgerline-Signature header.", "source": {"kind": "file", "locator": "src/webhooks/sign.ts:9", "quote": "headers['X-Ledgerline-Signature'] = createHmac('sha256', secret).update(body).digest('hex');"}, "supersedes": []},
    {"id": "s28-w2", "agent": "agent:onboarding", "day": 13, "subject": "integrations", "slot": "webhook-header", "text": "The webhook signature header is X-Signature.", "source": {"kind": "inference", "locator": "own reasoning", "quote": "most services call it X-Signature"}, "supersedes": []},
    {"id": "s28-w3", "agent": "agent:reviewer", "day": 14, "subject": "security", "slot": "webhooks", "text": "Webhooks are signed with HMAC SHA-256.", "source": {"kind": "file", "locator": "docs/webhooks.md:5", "quote": "Webhooks are signed with HMAC SHA-256."}, "supersedes": []},
    {"id": "s28-w4", "agent": "agent:planner", "day": 15, "subject": "webhooks", "slot": "timestamp", "text": "Webhook signatures include a timestamp to prevent replay.", "source": {"kind": "chat", "locator": "chat with agent:builder", "quote": "we include a timestamp, right?"}, "supersedes": []},
    {"id": "s28-w5", "agent": "agent:builder", "day": 16, "subject": "webhooks", "slot": "replay", "text": "The signed payload is the raw body only. No timestamp is included, so there is no replay-window check.", "source": {"kind": "command-output", "locator": "npm test -- sign output", "quote": " ✓ src/webhooks/sign.test.ts > signs raw body only (no timestamp) 3ms"}, "supersedes": []},
    {"id": "s28-w6", "agent": "agent:release", "day": 17, "subject": "webhooks", "slot": "retries", "text": "Webhook delivery is retried 6 times with exponential backoff starting at 60s.", "source": {"kind": "file", "locator": "src/webhooks/deliver.ts:20", "quote": "attempts: 6, backoff: { type: 'exponential', delay: 60000 },"}, "supersedes": []},
  ],
  questions: [
    {"query": "Which HTTP header carries the webhook signature?", "day": 20, "expect": {"anyOf": [["s28-w1"]], "forbidden": ["s28-w2"], "duplicates": [], "contradiction": false}},
    {"query": "Do our webhook signatures protect against replays with a timestamp?", "day": 20, "expect": {"anyOf": [["s28-w5"]], "forbidden": ["s28-w4"], "duplicates": [], "contradiction": false}},
  ] },
  { "id": "s29", "kind": "weak-evidence", "why": "What triggers a prod deploy. A nightly-schedule chat claim and a main-branch inference are wrong, and the workflow file is the truth.", writes: [
    {"id": "s29-w1", "agent": "agent:release", "day": 12, "subject": "deploy", "slot": "prod", "text": "The prod deploy workflow runs when a tag matching v* is pushed.", "source": {"kind": "file", "locator": ".github/workflows/deploy-prod.yml:3", "quote": "on:\n  push:\n    tags: ['v*']"}, "supersedes": []},
    {"id": "s29-w2", "agent": "agent:onboarding", "day": 14, "subject": "deploy", "slot": "schedule", "text": "Prod deploys nightly at 02:00 UTC.", "source": {"kind": "chat", "locator": "chat with agent:reviewer", "quote": "prod goes out nightly at 2am"}, "supersedes": []},
    {"id": "s29-w3", "agent": "agent:planner", "day": 15, "subject": "release", "slot": "process", "text": "Changes go to prod whenever main is green.", "source": {"kind": "inference", "locator": "own reasoning", "quote": "since staging deploys on main, prod probably does too"}, "supersedes": []},
    {"id": "s29-w4", "agent": "agent:release", "day": 16, "subject": "deploy", "slot": "prod-approval", "text": "The prod job uses the 'production' GitHub environment, which requires reviewer approval before it runs.", "source": {"kind": "file", "locator": ".github/workflows/deploy-prod.yml:11", "quote": "    environment: production"}, "supersedes": []},
    {"id": "s29-w5", "agent": "agent:ci-fixer", "day": 17, "subject": "deploy", "slot": "how", "text": "Prod deploys happen on tag.", "source": {"kind": "file", "locator": ".github/workflows/deploy-prod.yml:3", "quote": "Prod deploys happen on tag"}, "supersedes": []},
    {"id": "s29-w6", "agent": "agent:builder", "day": 18, "subject": "db", "slot": "indexes", "text": "invoices has a composite index on (customer_id, issued_at).", "source": {"kind": "file", "locator": "migrations/1715000300000_invoice-indexes.js:4", "quote": "pgm.createIndex('invoices', ['customer_id', 'issued_at']);"}, "supersedes": []},
  ],
  questions: [
    {"query": "What actually kicks off a production deployment?", "day": 22, "expect": {"anyOf": [["s29-w1"]], "forbidden": ["s29-w2", "s29-w3"], "duplicates": [["s29-w1", "s29-w5"]], "contradiction": false}},
    {"query": "Is there a human gate before the prod deploy job runs?", "day": 22, "expect": {"anyOf": [["s29-w4"]], "forbidden": [], "duplicates": [], "contradiction": false}},
  ] },
  { "id": "s30", "kind": "weak-evidence", "why": "Line-item validation. Inferences give a wrong cap and a wrong integer-quantity rule, and the zod schema and command output are the truth.", writes: [
    {"id": "s30-w1", "agent": "agent:builder", "day": 9, "subject": "validation", "slot": "line-items", "text": "An invoice may have at most 500 line items, enforced by the zod schema.", "source": {"kind": "file", "locator": "src/invoices/schema.ts:4", "quote": "export const MAX_LINE_ITEMS = 500;"}, "supersedes": []},
    {"id": "s30-w2", "agent": "agent:planner", "day": 10, "subject": "limits", "slot": "items", "text": "Line items are capped at 100 per invoice.", "source": {"kind": "inference", "locator": "own reasoning", "quote": "the UI table paginates at 100 so the API cap must be 100"}, "supersedes": []},
    {"id": "s30-w3", "agent": "agent:reviewer", "day": 12, "subject": "api", "slot": "limits", "text": "The line item limit is 500.", "source": {"kind": "chat", "locator": "chat with agent:builder", "quote": "limit is 500"}, "supersedes": []},
    {"id": "s30-w4", "agent": "agent:onboarding", "day": 13, "subject": "api", "slot": "line-items-min", "text": "An invoice must have at least one line item.", "source": {"kind": "command-output", "locator": "curl POST /v1/invoices with empty lineItems", "quote": "HTTP/1.1 400 Bad Request\n{\"title\":\"lineItems: Array must contain at least 1 element(s)\"}"}, "supersedes": []},
    {"id": "s30-w5", "agent": "agent:ci-fixer", "day": 14, "subject": "limits", "slot": "quantity", "text": "A line item quantity must be a positive integer.", "source": {"kind": "inference", "locator": "own reasoning", "quote": "you can't bill half a unit"}, "supersedes": []},
    {"id": "s30-w6", "agent": "agent:builder", "day": 15, "subject": "validation", "slot": "quantity", "text": "Quantities may be fractional positive numbers, such as 1.5 hours.", "source": {"kind": "file", "locator": "src/invoices/schema.ts:12", "quote": "  quantity: z.number().positive(),"}, "supersedes": []},
    {"id": "s30-w7", "agent": "agent:release", "day": 15, "subject": "release", "slot": "cadence", "text": "Releases are cut every other Tuesday.", "source": {"kind": "chat", "locator": "chat with agent:planner", "quote": "we cut releases biweekly on tuesdays"}, "supersedes": []},
  ],
  questions: [
    {"query": "Max number of line items allowed on one invoice?", "day": 18, "expect": {"anyOf": [["s30-w1"]], "forbidden": ["s30-w2"], "duplicates": [], "contradiction": false}},
    {"query": "Can a line item have a quantity like 2.5?", "day": 18, "expect": {"anyOf": [["s30-w6"]], "forbidden": ["s30-w5"], "duplicates": [], "contradiction": false}},
  ] },
  { "id": "s31", "kind": "weak-evidence", "why": "Redis version and eviction policy. Inferences say Redis 6 and allkeys-lru, and command output says 7.2.4 and noeviction.", writes: [
    {"id": "s31-w1", "agent": "agent:builder", "day": 4, "subject": "redis", "slot": "version", "text": "Local dev Redis is 7.2 (redis:7.2-alpine in docker-compose).", "source": {"kind": "file", "locator": "docker-compose.yml:20", "quote": "    image: redis:7.2-alpine"}, "supersedes": []},
    {"id": "s31-w2", "agent": "agent:planner", "day": 6, "subject": "infra", "slot": "redis", "text": "Ledgerline runs on Redis 6.", "source": {"kind": "inference", "locator": "own reasoning", "quote": "BullMQ needs Redis 6+, so we're on 6"}, "supersedes": []},
    {"id": "s31-w3", "agent": "agent:release", "day": 9, "subject": "prod", "slot": "redis", "text": "Prod Redis reports version 7.2.4.", "source": {"kind": "command-output", "locator": "redis-cli -h redis.prod.internal INFO server", "quote": "redis_version:7.2.4"}, "supersedes": []},
    {"id": "s31-w4", "agent": "agent:onboarding", "day": 10, "subject": "dev", "slot": "redis", "text": "Redis is version 7.", "source": {"kind": "chat", "locator": "chat with agent:builder", "quote": "it's redis 7"}, "supersedes": []},
    {"id": "s31-w5", "agent": "agent:reviewer", "day": 11, "subject": "redis", "slot": "eviction", "text": "Prod Redis uses the allkeys-lru eviction policy.", "source": {"kind": "inference", "locator": "own reasoning", "quote": "standard cache setup uses allkeys-lru"}, "supersedes": []},
    {"id": "s31-w6", "agent": "agent:release", "day": 12, "subject": "prod", "slot": "redis-maxmemory", "text": "Prod Redis maxmemory-policy is noeviction, as BullMQ requires.", "source": {"kind": "command-output", "locator": "redis-cli -h redis.prod.internal CONFIG GET maxmemory-policy", "quote": "1) \"maxmemory-policy\"\n2) \"noeviction\""}, "supersedes": []},
    {"id": "s31-w7", "agent": "agent:ci-fixer", "day": 13, "subject": "ci", "slot": "lint-job", "text": "Lint runs as a separate CI job ahead of the tests.", "source": {"kind": "file", "locator": ".github/workflows/ci.yml:27", "quote": "  lint:"}, "supersedes": []},
  ],
  questions: [
    {"query": "Which Redis version is prod running?", "day": 15, "expect": {"anyOf": [["s31-w3"]], "forbidden": ["s31-w2"], "duplicates": [], "contradiction": false}},
    {"query": "What eviction policy is configured on the production Redis?", "day": 15, "expect": {"anyOf": [["s31-w6"]], "forbidden": ["s31-w5"], "duplicates": [], "contradiction": false}},
  ] },
  { "id": "s32", "kind": "weak-evidence", "why": "Customer deletion semantics. An inference about a hard-delete cascade is wrong, and the code, migration and DB output show a soft delete with RESTRICT.", writes: [
    {"id": "s32-w1", "agent": "agent:builder", "day": 14, "subject": "customers", "slot": "deletion", "text": "Customers are soft-deleted by setting deleted_at, and the repository filters on deleted_at IS NULL.", "source": {"kind": "file", "locator": "src/customers/repo.ts:27", "quote": "    .where('deleted_at', 'is', null)"}, "supersedes": []},
    {"id": "s32-w2", "agent": "agent:planner", "day": 15, "subject": "data", "slot": "customer-delete", "text": "Deleting a customer hard-deletes the row and cascades to their invoices.", "source": {"kind": "inference", "locator": "own reasoning", "quote": "invoices reference customers with a FK, so it probably cascades"}, "supersedes": []},
    {"id": "s32-w3", "agent": "agent:reviewer", "day": 16, "subject": "schema", "slot": "fk", "text": "The invoices.customer_id foreign key is ON DELETE RESTRICT.", "source": {"kind": "file", "locator": "migrations/1715000000000_create-invoices.js:9", "quote": "customer_id: { type: 'uuid', notNull: true, references: 'customers', onDelete: 'RESTRICT' },"}, "supersedes": []},
    {"id": "s32-w4", "agent": "agent:onboarding", "day": 17, "subject": "api", "slot": "delete-customer", "text": "After DELETE /v1/customers/:id, the row stays in the table with deleted_at set.", "source": {"kind": "command-output", "locator": "psql select after DELETE /v1/customers/c_123", "quote": "  id   |       deleted_at\n c_123 | 2026-03-02 10:14:07+00"}, "supersedes": []},
    {"id": "s32-w5", "agent": "agent:ci-fixer", "day": 18, "subject": "customers", "slot": "softdelete", "text": "A customer delete is a soft delete.", "source": {"kind": "file", "locator": "src/customers/repo.ts:27", "quote": "Customer delete is a soft delete."}, "supersedes": []},
    {"id": "s32-w6", "agent": "agent:release", "day": 19, "subject": "deploy", "slot": "migrations-on-release", "text": "Prod migrations run as a Kubernetes Job before the deploy.", "source": {"kind": "file", "locator": "k8s/prod/migrate-job.yaml:3", "quote": "kind: Job"}, "supersedes": []},
  ],
  questions: [
    {"query": "What happens to a customer's row when they're deleted through the API?", "day": 22, "expect": {"anyOf": [["s32-w1", "s32-w4"]], "forbidden": ["s32-w2"], "duplicates": [["s32-w1", "s32-w4", "s32-w5"]], "contradiction": false}},
    {"query": "Would deleting a customer wipe out their invoices too?", "day": 22, "expect": {"anyOf": [["s32-w3"]], "forbidden": ["s32-w2"], "duplicates": [], "contradiction": false}},
  ] },
] as MemoryBenchmarkAgentScenario[]);
/** Set W2 (fictional "tidepool" service): written by another agent and scored only after the fixes were frozen. */
export const MEMORY_BENCHMARK_AGENT_WRITES_VALIDATION: readonly MemoryBenchmarkAgentScenario[] = Object.freeze([
  { "id": "s1", "kind": "near-duplicate", "why": "Three agents record the same Redis queue key under different subject/slot keys.", writes: [
    {"id": "s1-w1", "agent": "agent:architect", "day": 3, "subject": "job-runner", "slot": "queue-name", "text": "The job runner consumes jobs from the Redis list tidepool:jobs:default.", "source": {"kind": "file", "locator": "app/worker/queue.py:12", "quote": "QUEUE_KEY = \"tidepool:jobs:default\""}, "supersedes": []},
    {"id": "s1-w2", "agent": "agent:coder", "day": 7, "subject": "redis.queue", "slot": "key", "text": "The enqueue endpoint pushes job payloads onto the tidepool:jobs:default Redis key.", "source": {"kind": "file", "locator": "app/api/enqueue.py:31", "quote": "redis.lpush(QUEUE_KEY, payload)  # tidepool:jobs:default"}, "supersedes": []},
    {"id": "s1-w3", "agent": "agent:docs", "day": 10, "subject": "docs:worker", "slot": "redis-list", "text": "The default worker queue lives in Redis under tidepool:jobs:default.", "source": {"kind": "file", "locator": "docs/worker.md:8", "quote": "Jobs are queued in the Redis list `tidepool:jobs:default`."}, "supersedes": []},
    {"id": "s1-w4", "agent": "agent:test-runner", "day": 8, "subject": "tests.api", "slot": "count", "text": "The API test suite currently has 214 passing tests.", "source": {"kind": "command-output", "locator": "pytest tests/api", "quote": "214 passed in 38.2s"}, "supersedes": []},
    {"id": "s1-w5", "agent": "agent:deployer", "day": 9, "subject": "helm.canary", "slot": "replicas", "text": "The canary environment runs a single API replica.", "source": {"kind": "file", "locator": "helm/values-canary.yaml:5", "quote": "replicaCount: 1"}, "supersedes": []},
  ],
  questions: [
    {"query": "Which Redis key does the worker pull jobs from?", "day": 12, "expect": {"anyOf": [["s1-w1", "s1-w2", "s1-w3"]], "forbidden": [], "duplicates": [["s1-w1", "s1-w2", "s1-w3"]], "contradiction": false}},
    {"query": "How many pods does canary run for the API?", "day": 12, "expect": {"anyOf": [["s1-w5"]], "forbidden": [], "duplicates": [], "contradiction": false}},
  ] },
  { "id": "s2", "kind": "near-duplicate", "why": "Default page size for listing schedules recorded three times in different words.", writes: [
    {"id": "s2-w1", "agent": "agent:coder", "day": 4, "subject": "api.schedules", "slot": "pagination.default_limit", "text": "GET /schedules returns 50 items per page by default.", "source": {"kind": "file", "locator": "app/api/routes/schedules.py:22", "quote": "limit: int = Query(50, le=200)"}, "supersedes": []},
    {"id": "s2-w2", "agent": "agent:architect", "day": 5, "subject": "api.schedules", "slot": "max_limit", "text": "The limit parameter on GET /schedules is capped at 200.", "source": {"kind": "file", "locator": "app/api/routes/schedules.py:22", "quote": "limit: int = Query(50, le=200)"}, "supersedes": []},
    {"id": "s2-w3", "agent": "agent:docs", "day": 11, "subject": "schedules-endpoint", "slot": "page-size", "text": "The schedules listing pages at 50 results unless the caller passes a limit.", "source": {"kind": "file", "locator": "docs/api.md:33", "quote": "Default page size: 50."}, "supersedes": []},
    {"id": "s2-w4", "agent": "agent:triage", "day": 12, "subject": "bug:tz-drift", "slot": "root-cause", "text": "Timezone drift reports were traced to naive datetimes created in app/core/time.py.", "source": {"kind": "inference", "locator": "own reasoning", "quote": "drift only appears for naive datetimes"}, "supersedes": []},
    {"id": "s2-w5", "agent": "agent:test-runner", "day": 13, "subject": "api:list_schedules", "slot": "default_limit", "text": "test_list_schedules_default_page confirms a default page size of 50.", "source": {"kind": "command-output", "locator": "pytest tests/api/test_schedules.py -k default_page", "quote": "1 passed in 0.41s"}, "supersedes": []},
  ],
  questions: [
    {"query": "If I list schedules without passing a limit, how many rows come back?", "day": 15, "expect": {"anyOf": [["s2-w1", "s2-w3", "s2-w5"]], "forbidden": [], "duplicates": [["s2-w1", "s2-w3", "s2-w5"]], "contradiction": false}},
    {"query": "What is the largest limit the schedules list endpoint accepts?", "day": 15, "expect": {"anyOf": [["s2-w2"]], "forbidden": [], "duplicates": [], "contradiction": false}},
  ] },
  { "id": "s3", "kind": "near-duplicate", "why": "MySQL pool size noted by architect, coder and triage with different keys.", writes: [
    {"id": "s3-w1", "agent": "agent:architect", "day": 2, "subject": "db.mysql", "slot": "pool_size", "text": "The SQLAlchemy engine for MySQL uses a pool_size of 20.", "source": {"kind": "file", "locator": "app/db/session.py:14", "quote": "engine = create_engine(DB_URL, pool_size=20, max_overflow=10)"}, "supersedes": []},
    {"id": "s3-w2", "agent": "agent:coder", "day": 6, "subject": "database", "slot": "connection-pool", "text": "Our MySQL connection pool holds 20 connections with up to 10 more as overflow.", "source": {"kind": "file", "locator": "app/db/session.py:14", "quote": "engine = create_engine(DB_URL, pool_size=20, max_overflow=10)"}, "supersedes": []},
    {"id": "s3-w3", "agent": "agent:deployer", "day": 14, "subject": "helm.main", "slot": "release-name", "text": "The main environment Helm release is named tidepool-main.", "source": {"kind": "file", "locator": "helmfile.yaml:9", "quote": "- name: tidepool-main"}, "supersedes": []},
    {"id": "s3-w4", "agent": "agent:triage", "day": 15, "subject": "incident:db-timeouts", "slot": "pool-config", "text": "While triaging DB timeouts I confirmed the engine is configured with pool_size=20 and max_overflow=10.", "source": {"kind": "file", "locator": "app/db/session.py:14", "quote": "pool_size=20, max_overflow=10"}, "supersedes": []},
  ],
  questions: [
    {"query": "How big is the database connection pool?", "day": 16, "expect": {"anyOf": [["s3-w1", "s3-w2", "s3-w4"]], "forbidden": [], "duplicates": [["s3-w1", "s3-w2", "s3-w4"]], "contradiction": false}},
    {"query": "How many extra connections can SQLAlchemy open beyond the pool?", "day": 16, "expect": {"anyOf": [["s3-w2", "s3-w4"]], "forbidden": [], "duplicates": [["s3-w2", "s3-w4"]], "contradiction": false}},
  ] },
  { "id": "s4", "kind": "near-duplicate", "why": "GitLab CI stage order recorded by three agents.", writes: [
    {"id": "s4-w1", "agent": "agent:coder", "day": 5, "subject": "ci.gitlab", "slot": "stages", "text": "The GitLab CI pipeline stages are lint, test, build, deploy-canary, deploy-main in that order.", "source": {"kind": "file", "locator": ".gitlab-ci.yml:1", "quote": "stages: [lint, test, build, deploy-canary, deploy-main]"}, "supersedes": []},
    {"id": "s4-w2", "agent": "agent:deployer", "day": 9, "subject": "pipeline", "slot": "stage-order", "text": "CI runs lint, then tests, then the image build, and deploys canary before main.", "source": {"kind": "file", "locator": ".gitlab-ci.yml:1", "quote": "stages: [lint, test, build, deploy-canary, deploy-main]"}, "supersedes": []},
    {"id": "s4-w3", "agent": "agent:test-runner", "day": 10, "subject": "ci.lint", "slot": "tool", "text": "The lint job runs ruff against the whole repository.", "source": {"kind": "file", "locator": ".gitlab-ci.yml:14", "quote": "script: ruff check ."}, "supersedes": []},
    {"id": "s4-w4", "agent": "agent:architect", "day": 12, "subject": "model.schedule", "slot": "timestamps", "text": "Schedule start and end timestamps are stored in UTC.", "source": {"kind": "file", "locator": "app/models/schedule.py:9", "quote": "starts_at: datetime  # stored in UTC"}, "supersedes": []},
    {"id": "s4-w5", "agent": "agent:docs", "day": 20, "subject": "docs:ci", "slot": "stages-list", "text": "Documented pipeline order: lint, test, build, deploy-canary, deploy-main.", "source": {"kind": "file", "locator": "docs/ci.md:4", "quote": "1. lint 2. test 3. build 4. deploy-canary 5. deploy-main"}, "supersedes": []},
  ],
  questions: [
    {"query": "Does the canary deploy happen before the main deploy in the pipeline?", "day": 22, "expect": {"anyOf": [["s4-w1", "s4-w2", "s4-w5"]], "forbidden": [], "duplicates": [["s4-w1", "s4-w2", "s4-w5"]], "contradiction": false}},
    {"query": "Which linter does CI use?", "day": 22, "expect": {"anyOf": [["s4-w3"]], "forbidden": [], "duplicates": [], "contradiction": false}},
  ] },
  { "id": "s5", "kind": "near-duplicate", "why": "Retry limit stated by coder (code), test-runner (test) and triage (chat).", writes: [
    {"id": "s5-w1", "agent": "agent:coder", "day": 8, "subject": "worker.retry", "slot": "max_attempts", "text": "Failed jobs are retried up to 5 times.", "source": {"kind": "file", "locator": "app/worker/retry.py:7", "quote": "MAX_RETRIES = 5"}, "supersedes": []},
    {"id": "s5-w2", "agent": "agent:coder", "day": 8, "subject": "worker.retry", "slot": "backoff", "text": "Retry delays grow exponentially starting from 2 seconds.", "source": {"kind": "file", "locator": "app/worker/retry.py:8", "quote": "BACKOFF_BASE_SECONDS = 2"}, "supersedes": []},
    {"id": "s5-w3", "agent": "agent:test-runner", "day": 12, "subject": "job-runner", "slot": "retry-limit", "text": "test_retry_exhausts shows a job is dead-lettered after its fifth retry.", "source": {"kind": "command-output", "locator": "pytest tests/worker/test_retry.py -k exhausts", "quote": "test_retry_exhausts PASSED"}, "supersedes": []},
    {"id": "s5-w4", "agent": "agent:docs", "day": 16, "subject": "readme", "slot": "local-dev", "text": "Local development starts MySQL and Redis with docker compose up.", "source": {"kind": "file", "locator": "README.md:22", "quote": "docker compose up -d mysql redis"}, "supersedes": []},
    {"id": "s5-w5", "agent": "agent:triage", "day": 18, "subject": "jobs", "slot": "retries", "text": "Jobs get five retry attempts before landing in the dead-letter list.", "source": {"kind": "chat", "locator": "chat with agent:coder", "quote": "we retry five times then dead-letter"}, "supersedes": []},
  ],
  questions: [
    {"query": "How many times will a failing job be retried before giving up?", "day": 20, "expect": {"anyOf": [["s5-w1", "s5-w3", "s5-w5"]], "forbidden": [], "duplicates": [["s5-w1", "s5-w3", "s5-w5"]], "contradiction": false}},
    {"query": "What is the first retry delay?", "day": 20, "expect": {"anyOf": [["s5-w2"]], "forbidden": [], "duplicates": [], "contradiction": false}},
  ] },
  { "id": "s6", "kind": "near-duplicate", "why": "Canary traffic weight stated as 10%, one in ten, and 10.", writes: [
    {"id": "s6-w1", "agent": "agent:deployer", "day": 11, "subject": "helm.canary", "slot": "traffic_weight", "text": "Canary receives 10% of traffic through the ingress canary-weight annotation.", "source": {"kind": "file", "locator": "helm/values-canary.yaml:12", "quote": "nginx.ingress.kubernetes.io/canary-weight: \"10\""}, "supersedes": []},
    {"id": "s6-w2", "agent": "agent:architect", "day": 14, "subject": "deploy:canary", "slot": "traffic-split", "text": "Roughly one request in ten is routed to the canary release.", "source": {"kind": "file", "locator": "helm/values-canary.yaml:12", "quote": "canary-weight: \"10\""}, "supersedes": []},
    {"id": "s6-w3", "agent": "agent:coder", "day": 15, "subject": "api.health", "slot": "path", "text": "The health endpoint is GET /healthz and returns status ok.", "source": {"kind": "file", "locator": "app/api/routes/health.py:6", "quote": "@router.get(\"/healthz\")"}, "supersedes": []},
    {"id": "s6-w4", "agent": "agent:test-runner", "day": 17, "subject": "ci.services", "slot": "integration", "text": "Integration test jobs start Redis 7 and MySQL 8.0 as CI services.", "source": {"kind": "file", "locator": ".gitlab-ci.yml:30", "quote": "services: [redis:7, mysql:8.0]"}, "supersedes": []},
    {"id": "s6-w5", "agent": "agent:docs", "day": 19, "subject": "rollout", "slot": "canary_percent", "text": "Canary rollout percentage is 10.", "source": {"kind": "file", "locator": "docs/deploy.md:17", "quote": "The canary takes 10 percent of live traffic."}, "supersedes": []},
  ],
  questions: [
    {"query": "What share of production traffic hits the canary?", "day": 21, "expect": {"anyOf": [["s6-w1", "s6-w2", "s6-w5"]], "forbidden": [], "duplicates": [["s6-w1", "s6-w2", "s6-w5"]], "contradiction": false}},
    {"query": "Which path should the liveness probe call?", "day": 21, "expect": {"anyOf": [["s6-w3"]], "forbidden": [], "duplicates": [], "contradiction": false}},
  ] },
  { "id": "s7", "kind": "near-duplicate", "why": "Python 3.11 runtime recorded from pyproject, Dockerfile and CI image.", writes: [
    {"id": "s7-w1", "agent": "agent:coder", "day": 1, "subject": "runtime.python", "slot": "version", "text": "The service targets Python 3.11.", "source": {"kind": "file", "locator": "pyproject.toml:6", "quote": "requires-python = \">=3.11,<3.12\""}, "supersedes": []},
    {"id": "s7-w2", "agent": "agent:deployer", "day": 6, "subject": "docker", "slot": "base-image", "text": "The production image is built on python:3.11-slim.", "source": {"kind": "file", "locator": "Dockerfile:1", "quote": "FROM python:3.11-slim"}, "supersedes": []},
    {"id": "s7-w3", "agent": "agent:test-runner", "day": 9, "subject": "ci.python", "slot": "interpreter", "text": "CI test jobs run on a Python 3.11 image.", "source": {"kind": "file", "locator": ".gitlab-ci.yml:3", "quote": "image: python:3.11-slim"}, "supersedes": []},
    {"id": "s7-w4", "agent": "agent:triage", "day": 10, "subject": "bug:double-run", "slot": "repro", "text": "Duplicate job execution only reproduces when two workers start within the same second.", "source": {"kind": "inference", "locator": "own reasoning", "quote": "only saw duplicates with simultaneous worker starts"}, "supersedes": []},
  ],
  questions: [
    {"query": "Which Python version does tidepool run on?", "day": 12, "expect": {"anyOf": [["s7-w1", "s7-w2", "s7-w3"]], "forbidden": [], "duplicates": [["s7-w1", "s7-w2", "s7-w3"]], "contradiction": false}},
  ] },
  { "id": "s8", "kind": "near-duplicate", "why": "Per-client rate limit restated by four agents.", writes: [
    {"id": "s8-w1", "agent": "agent:architect", "day": 20, "subject": "api.ratelimit", "slot": "per_client", "text": "The API limits each client to 100 requests per minute.", "source": {"kind": "file", "locator": "app/api/middleware/ratelimit.py:10", "quote": "DEFAULT_LIMIT = \"100/minute\""}, "supersedes": []},
    {"id": "s8-w2", "agent": "agent:deployer", "day": 22, "subject": "helm.main", "slot": "replicas", "text": "The main environment runs 4 API replicas.", "source": {"kind": "file", "locator": "helm/values-main.yaml:5", "quote": "replicaCount: 4"}, "supersedes": []},
    {"id": "s8-w3", "agent": "agent:coder", "day": 24, "subject": "rate-limiting", "slot": "limit", "text": "The slowapi limiter is configured at 100/minute keyed by client id.", "source": {"kind": "file", "locator": "app/api/middleware/ratelimit.py:10", "quote": "DEFAULT_LIMIT = \"100/minute\""}, "supersedes": []},
    {"id": "s8-w4", "agent": "agent:coder", "day": 25, "subject": "rate-limiting", "slot": "storage", "text": "Rate limit counters are kept in Redis database index 2.", "source": {"kind": "file", "locator": "app/api/middleware/ratelimit.py:8", "quote": "storage_uri=f\"redis://{REDIS_HOST}:6379/2\""}, "supersedes": []},
    {"id": "s8-w5", "agent": "agent:triage", "day": 27, "subject": "incident:429s", "slot": "threshold", "text": "Clients receiving 429s are exceeding the 100 requests-per-minute ceiling.", "source": {"kind": "command-output", "locator": "grep 429 api.log | head", "quote": "429 Too Many Requests: 100 per 1 minute"}, "supersedes": []},
    {"id": "s8-w6", "agent": "agent:docs", "day": 30, "subject": "docs:api-limits", "slot": "rate", "text": "The public docs state a limit of 100 requests per minute per client.", "source": {"kind": "file", "locator": "docs/api.md:41", "quote": "Each client may make 100 requests per minute."}, "supersedes": []},
  ],
  questions: [
    {"query": "What's the request ceiling per client before we start returning 429?", "day": 32, "expect": {"anyOf": [["s8-w1", "s8-w3", "s8-w5", "s8-w6"]], "forbidden": [], "duplicates": [["s8-w1", "s8-w3", "s8-w5", "s8-w6"]], "contradiction": false}},
    {"query": "Where does the rate limiter keep its counters?", "day": 32, "expect": {"anyOf": [["s8-w4"]], "forbidden": [], "duplicates": [], "contradiction": false}},
    {"query": "How many API replicas run in the main environment?", "day": 32, "expect": {"anyOf": [["s8-w2"]], "forbidden": [], "duplicates": [], "contradiction": false}},
  ] },
  { "id": "s9", "kind": "silent-contradiction", "why": "True update: job timeout raised from 30s to 120s by a commit; newer write does not supersede.", writes: [
    {"id": "s9-w1", "agent": "agent:coder", "day": 5, "subject": "worker.timeout", "slot": "seconds", "text": "Each job has a hard timeout of 30 seconds.", "source": {"kind": "file", "locator": "app/worker/runner.py:19", "quote": "JOB_TIMEOUT_SECONDS = 30"}, "supersedes": []},
    {"id": "s9-w2", "agent": "agent:test-runner", "day": 10, "subject": "tests.worker", "slot": "duration", "text": "The worker test module takes about 12 seconds to run.", "source": {"kind": "command-output", "locator": "pytest tests/worker", "quote": "61 passed in 12.07s"}, "supersedes": []},
    {"id": "s9-w3", "agent": "agent:architect", "day": 28, "subject": "job-runner", "slot": "max-runtime", "text": "Jobs are killed after 120 seconds of runtime.", "source": {"kind": "commit", "locator": "commit 8c41e07", "quote": "worker: raise JOB_TIMEOUT_SECONDS from 30 to 120 for report jobs"}, "supersedes": []},
    {"id": "s9-w4", "agent": "agent:docs", "day": 29, "subject": "docs:changelog", "slot": "latest", "text": "The changelog's latest entry covers report export jobs.", "source": {"kind": "file", "locator": "CHANGELOG.md:3", "quote": "- Added report export jobs"}, "supersedes": []},
  ],
  questions: [
    {"query": "How long can a job run before the worker kills it?", "day": 30, "expect": {"anyOf": [["s9-w3"]], "forbidden": ["s9-w1"], "duplicates": [], "contradiction": false}},
  ] },
  { "id": "s10", "kind": "silent-contradiction", "why": "Mistake: triage repeats a chat guess that prod is on MySQL 5.7, contradicting cited Helm values.", writes: [
    {"id": "s10-w1", "agent": "agent:deployer", "day": 4, "subject": "mysql", "slot": "version", "text": "The main environment runs MySQL 8.0.36.", "source": {"kind": "file", "locator": "helm/values-main.yaml:22", "quote": "tag: \"8.0.36\""}, "supersedes": []},
    {"id": "s10-w2", "agent": "agent:coder", "day": 9, "subject": "db.migrations", "slot": "tool", "text": "Schema migrations are managed with Alembic.", "source": {"kind": "file", "locator": "alembic.ini:1", "quote": "[alembic]"}, "supersedes": []},
    {"id": "s10-w3", "agent": "agent:triage", "day": 20, "subject": "database.engine", "slot": "server-version", "text": "Production database is MySQL 5.7.", "source": {"kind": "chat", "locator": "chat with agent:docs", "quote": "I think prod is still on 5.7"}, "supersedes": []},
    {"id": "s10-w4", "agent": "agent:test-runner", "day": 21, "subject": "ci.mysql", "slot": "service", "text": "CI integration tests use the mysql:8.0 service image.", "source": {"kind": "file", "locator": ".gitlab-ci.yml:30", "quote": "services: [redis:7, mysql:8.0]"}, "supersedes": []},
  ],
  questions: [
    {"query": "What MySQL version is production on?", "day": 25, "expect": {"anyOf": [["s10-w1"]], "forbidden": ["s10-w3"], "duplicates": [], "contradiction": false}},
    {"query": "Can I use window functions that need MySQL 8 in prod queries?", "day": 25, "expect": {"anyOf": [["s10-w1"]], "forbidden": ["s10-w3"], "duplicates": [], "contradiction": false}},
  ] },
  { "id": "s11", "kind": "silent-contradiction", "why": "Ambiguous: Helm values say noeviction, live redis-cli says allkeys-lru; no write resolves which is right.", writes: [
    {"id": "s11-w1", "agent": "agent:architect", "day": 6, "subject": "redis", "slot": "eviction-policy", "text": "Redis is configured with maxmemory-policy noeviction so queued jobs are never dropped.", "source": {"kind": "file", "locator": "helm/values-redis.yaml:8", "quote": "maxmemory-policy: noeviction"}, "supersedes": []},
    {"id": "s11-w2", "agent": "agent:coder", "day": 15, "subject": "worker.queue", "slot": "pop-command", "text": "Workers take jobs with BRPOPLPUSH into a per-worker processing list.", "source": {"kind": "file", "locator": "app/worker/queue.py:27", "quote": "raw = redis.brpoplpush(QUEUE_KEY, processing_key, timeout=5)"}, "supersedes": []},
    {"id": "s11-w3", "agent": "agent:deployer", "day": 33, "subject": "redis.config", "slot": "maxmemory_policy", "text": "Redis evicts with allkeys-lru.", "source": {"kind": "command-output", "locator": "redis-cli CONFIG GET maxmemory-policy", "quote": "1) \"maxmemory-policy\" 2) \"allkeys-lru\""}, "supersedes": []},
    {"id": "s11-w4", "agent": "agent:docs", "day": 34, "subject": "docs:ops", "slot": "runbook", "text": "The ops runbook lives at docs/runbook.md.", "source": {"kind": "file", "locator": "docs/index.md:12", "quote": "- [Runbook](runbook.md)"}, "supersedes": []},
  ],
  questions: [
    {"query": "Could Redis evict queued jobs under memory pressure?", "day": 36, "expect": {"anyOf": [["s11-w1", "s11-w3"]], "forbidden": [], "duplicates": [], "contradiction": true}},
  ] },
  { "id": "s12", "kind": "silent-contradiction", "why": "True update: uvicorn port moved 8000 to 8080 by commit; docs agent later repeats stale 8000.", writes: [
    {"id": "s12-w1", "agent": "agent:coder", "day": 3, "subject": "api.server", "slot": "port", "text": "Uvicorn serves the API on port 8000.", "source": {"kind": "file", "locator": "Dockerfile:14", "quote": "CMD [\"uvicorn\", \"app.main:app\", \"--host\", \"0.0.0.0\", \"--port\", \"8000\"]"}, "supersedes": []},
    {"id": "s12-w2", "agent": "agent:test-runner", "day": 12, "subject": "tests.e2e", "slot": "runner", "text": "End-to-end tests run in a separate e2e CI job after build.", "source": {"kind": "file", "locator": ".gitlab-ci.yml:44", "quote": "e2e:\n  stage: build"}, "supersedes": []},
    {"id": "s12-w3", "agent": "agent:deployer", "day": 25, "subject": "container", "slot": "listen-port", "text": "The API container now listens on 8080.", "source": {"kind": "commit", "locator": "commit d19ab3f", "quote": "Dockerfile: move uvicorn to port 8080 to match chart containerPort"}, "supersedes": []},
    {"id": "s12-w4", "agent": "agent:docs", "day": 26, "subject": "docs:local-dev", "slot": "api-port", "text": "Run the API locally and open it on port 8000.", "source": {"kind": "file", "locator": "README.md:30", "quote": "Then visit localhost port 8000."}, "supersedes": []},
    {"id": "s12-w5", "agent": "agent:triage", "day": 27, "subject": "bug:readiness", "slot": "status", "text": "Readiness probe failures on canary stopped after the port change shipped.", "source": {"kind": "chat", "locator": "chat with agent:deployer", "quote": "canary is green now"}, "supersedes": []},
  ],
  questions: [
    {"query": "Which port does the API process bind to?", "day": 30, "expect": {"anyOf": [["s12-w3"]], "forbidden": ["s12-w1", "s12-w4"], "duplicates": [], "contradiction": false}},
  ] },
  { "id": "s13", "kind": "silent-contradiction", "why": "Mistake: test-runner confuses the recurrence span constant with the booking horizon.", writes: [
    {"id": "s13-w1", "agent": "agent:coder", "day": 8, "subject": "validation.schedule", "slot": "horizon", "text": "Schedules can be created up to 365 days in advance.", "source": {"kind": "file", "locator": "app/api/validators.py:15", "quote": "MAX_HORIZON_DAYS = 365"}, "supersedes": []},
    {"id": "s13-w2", "agent": "agent:coder", "day": 9, "subject": "validation.schedule", "slot": "recurrence-span", "text": "A recurring series may span at most 90 days.", "source": {"kind": "file", "locator": "app/api/validators.py:16", "quote": "MAX_RECURRENCE_DAYS = 90"}, "supersedes": []},
    {"id": "s13-w3", "agent": "agent:deployer", "day": 14, "subject": "helm.main", "slot": "hpa", "text": "The main API autoscaler ranges from 4 to 10 replicas.", "source": {"kind": "file", "locator": "helm/values-main.yaml:40", "quote": "minReplicas: 4\n  maxReplicas: 10"}, "supersedes": []},
    {"id": "s13-w4", "agent": "agent:test-runner", "day": 21, "subject": "schedules", "slot": "max-days-ahead", "text": "Schedules more than 90 days ahead are rejected by the API.", "source": {"kind": "file", "locator": "tests/api/test_recurring.py:40", "quote": "assert MAX_RECURRENCE_DAYS == 90"}, "supersedes": []},
  ],
  questions: [
    {"query": "How far in the future can someone book a schedule?", "day": 24, "expect": {"anyOf": [["s13-w1"]], "forbidden": ["s13-w4"], "duplicates": [], "contradiction": false}},
    {"query": "What's the longest a recurring series can last?", "day": 24, "expect": {"anyOf": [["s13-w2"]], "forbidden": [], "duplicates": [], "contradiction": false}},
  ] },
  { "id": "s14", "kind": "silent-contradiction", "why": "True update: dead-letter storage moved from a list to a stream, older fact not superseded.", writes: [
    {"id": "s14-w1", "agent": "agent:coder", "day": 10, "subject": "worker.retry", "slot": "dead_letter_key", "text": "Dead-lettered jobs are pushed to the Redis list tidepool:jobs:dead.", "source": {"kind": "file", "locator": "app/worker/retry.py:22", "quote": "DEAD_LETTER_KEY = \"tidepool:jobs:dead\""}, "supersedes": []},
    {"id": "s14-w2", "agent": "agent:docs", "day": 18, "subject": "docs:api", "slot": "versioning", "text": "Public endpoints are served under the /v1 prefix.", "source": {"kind": "file", "locator": "app/main.py:22", "quote": "app.include_router(api_router, prefix=\"/v1\")"}, "supersedes": []},
    {"id": "s14-w3", "agent": "agent:triage", "day": 40, "subject": "dlq", "slot": "location", "text": "Dead letters now live in the Redis stream tidepool:dlq.", "source": {"kind": "commit", "locator": "commit 5e2b9aa", "quote": "worker: move dead letters to Redis stream tidepool:dlq (XADD) and drop tidepool:jobs:dead"}, "supersedes": []},
    {"id": "s14-w4", "agent": "agent:test-runner", "day": 41, "subject": "tests.worker", "slot": "status", "text": "All worker tests pass on the main branch.", "source": {"kind": "command-output", "locator": "pytest tests/worker", "quote": "64 passed in 12.9s"}, "supersedes": []},
  ],
  questions: [
    {"query": "Where do I look to inspect jobs that exhausted their retries?", "day": 43, "expect": {"anyOf": [["s14-w3"]], "forbidden": ["s14-w1"], "duplicates": [], "contradiction": false}},
  ] },
  { "id": "s15", "kind": "silent-contradiction", "why": "Ambiguous: CI script and helmfile give different Helm timeouts for main; nothing says which wins.", writes: [
    {"id": "s15-w1", "agent": "agent:deployer", "day": 12, "subject": "deploy.main", "slot": "helm-timeout", "text": "helm upgrade for main is run with a 5 minute timeout.", "source": {"kind": "file", "locator": ".gitlab-ci.yml:61", "quote": "helm upgrade --install tidepool-main ./helm --timeout 5m"}, "supersedes": []},
    {"id": "s15-w2", "agent": "agent:coder", "day": 20, "subject": "api.schedules", "slot": "delete-semantics", "text": "Deleting a schedule is a soft delete that sets deleted_at.", "source": {"kind": "file", "locator": "app/services/schedules.py:58", "quote": "schedule.deleted_at = utcnow()"}, "supersedes": []},
    {"id": "s15-w3", "agent": "agent:architect", "day": 31, "subject": "helmfile", "slot": "release-timeout", "text": "Main releases wait up to 600 seconds for rollout.", "source": {"kind": "file", "locator": "helmfile.yaml:14", "quote": "timeout: 600"}, "supersedes": []},
    {"id": "s15-w4", "agent": "agent:triage", "day": 32, "subject": "incident:deploy-timeout", "slot": "symptom", "text": "Last week's main deploy failed with a context deadline exceeded during migrations.", "source": {"kind": "command-output", "locator": "GitLab job log deploy-main", "quote": "Error: UPGRADE FAILED: context deadline exceeded"}, "supersedes": []},
  ],
  questions: [
    {"query": "How long does a main deploy wait for the rollout before failing?", "day": 34, "expect": {"anyOf": [["s15-w1", "s15-w3"]], "forbidden": [], "duplicates": [], "contradiction": true}},
  ] },
  { "id": "s16", "kind": "silent-contradiction", "why": "Mistake: coder guesses migrations run at app startup, contradicting the cited Helm hook.", writes: [
    {"id": "s16-w1", "agent": "agent:deployer", "day": 14, "subject": "helm.hooks", "slot": "migrations", "text": "Alembic migrations run in a Helm pre-upgrade hook job.", "source": {"kind": "file", "locator": "helm/templates/migrate-job.yaml:6", "quote": "\"helm.sh/hook\": pre-upgrade"}, "supersedes": []},
    {"id": "s16-w2", "agent": "agent:test-runner", "day": 20, "subject": "tests.db", "slot": "fixture", "text": "DB tests run each test inside a transaction that is rolled back.", "source": {"kind": "file", "locator": "tests/conftest.py:31", "quote": "yield session\n    trans.rollback()"}, "supersedes": []},
    {"id": "s16-w3", "agent": "agent:coder", "day": 35, "subject": "app.startup", "slot": "db-migrate", "text": "The app runs alembic upgrade head during startup.", "source": {"kind": "inference", "locator": "own reasoning", "quote": "the app probably runs alembic upgrade on boot"}, "supersedes": []},
    {"id": "s16-w4", "agent": "agent:docs", "day": 36, "subject": "docs:deploy", "slot": "approval", "text": "Main deploys need a maintainer to approve the pipeline.", "source": {"kind": "file", "locator": "docs/deploy.md:30", "quote": "A maintainer approves the deploy-main job."}, "supersedes": []},
  ],
  questions: [
    {"query": "When do database migrations get applied during a release?", "day": 38, "expect": {"anyOf": [["s16-w1"]], "forbidden": ["s16-w3"], "duplicates": [], "contradiction": false}},
  ] },
  { "id": "s17", "kind": "stale-code", "why": "Worker concurrency default changes from 4 to 8; two facts go stale with no replacement.", writes: [
    {"id": "s17-w1", "agent": "agent:coder", "day": 5, "subject": "worker", "slot": "concurrency", "text": "Each worker pod processes 4 jobs concurrently by default.", "source": {"kind": "file", "locator": "app/worker/main.py:11", "quote": "CONCURRENCY = int(os.getenv(\"WORKER_CONCURRENCY\", \"4\"))"}, "supersedes": []},
    {"id": "s17-w2", "agent": "agent:docs", "day": 8, "subject": "docs:worker", "slot": "parallelism", "text": "Workers run four jobs at a time unless WORKER_CONCURRENCY is set.", "source": {"kind": "file", "locator": "app/worker/main.py:11", "quote": "CONCURRENCY = int(os.getenv(\"WORKER_CONCURRENCY\", \"4\"))"}, "supersedes": []},
    {"id": "s17-w3", "agent": "agent:deployer", "day": 9, "subject": "helm.worker", "slot": "replicas", "text": "The worker deployment runs 3 replicas in main.", "source": {"kind": "file", "locator": "helm/values-main.yaml:50", "quote": "worker:\n  replicaCount: 3"}, "supersedes": []},
    {"id": "s17-w4", "agent": "agent:triage", "day": 11, "subject": "bug:slow-reports", "slot": "note", "text": "Slow report jobs are CPU bound in PDF rendering.", "source": {"kind": "inference", "locator": "own reasoning", "quote": "profile shows time in rendering"}, "supersedes": []},
  ],
  codeChanges: [{"day": 20, "locator": "app/worker/main.py:11", "before": "CONCURRENCY = int(os.getenv(\"WORKER_CONCURRENCY\", \"4\"))", "after": "CONCURRENCY = int(os.getenv(\"WORKER_CONCURRENCY\", \"8\"))", "breaksFact": ["s17-w1", "s17-w2"]}],
  questions: [
    {"query": "What's the default number of concurrent jobs per worker?", "day": 25, "expect": {"anyOf": [[]], "forbidden": ["s17-w1", "s17-w2"], "duplicates": [], "contradiction": false}},
    {"query": "How many worker replicas run in main?", "day": 25, "expect": {"anyOf": [["s17-w3"]], "forbidden": [], "duplicates": [], "contradiction": false}},
  ] },
  { "id": "s18", "kind": "stale-code", "why": "Same line gains index=True; the UUID fact stays true.", writes: [
    {"id": "s18-w1", "agent": "agent:coder", "day": 6, "subject": "model.schedule", "slot": "id-format", "text": "Schedule IDs are UUID4 strings generated in the application.", "source": {"kind": "file", "locator": "app/models/schedule.py:7", "quote": "id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))"}, "supersedes": []},
    {"id": "s18-w2", "agent": "agent:test-runner", "day": 10, "subject": "ci.duration", "slot": "pipeline", "text": "A full pipeline takes about 14 minutes.", "source": {"kind": "command-output", "locator": "GitLab pipeline summary", "quote": "Duration: 14 minutes 2 seconds"}, "supersedes": []},
    {"id": "s18-w3", "agent": "agent:architect", "day": 12, "subject": "model.schedule", "slot": "owner", "text": "Every schedule belongs to exactly one resource via resource_id.", "source": {"kind": "file", "locator": "app/models/schedule.py:11", "quote": "resource_id = Column(String(36), ForeignKey(\"resources.id\"), nullable=False)"}, "supersedes": []},
    {"id": "s18-w4", "agent": "agent:triage", "day": 15, "subject": "bug:id-collision", "slot": "status", "text": "No ID collisions found in a scan of the schedules table.", "source": {"kind": "command-output", "locator": "SELECT id, COUNT(*) FROM schedules GROUP BY id HAVING COUNT(*) > 1", "quote": "Empty set (0.21 sec)"}, "supersedes": []},
  ],
  codeChanges: [{"day": 22, "locator": "app/models/schedule.py:7", "before": "id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))", "after": "id = Column(String(36), primary_key=True, index=True, default=lambda: str(uuid.uuid4()))", "breaksFact": []}],
  questions: [
    {"query": "What format do schedule identifiers use?", "day": 30, "expect": {"anyOf": [["s18-w1"]], "forbidden": [], "duplicates": [], "contradiction": false}},
  ] },
  { "id": "s19", "kind": "stale-code", "why": "Body size limit raised from 1 MB to 5 MB; code fact and old test output both stale.", writes: [
    {"id": "s19-w1", "agent": "agent:architect", "day": 9, "subject": "api.limits", "slot": "max-body", "text": "The API rejects request bodies larger than 1 MB.", "source": {"kind": "file", "locator": "app/main.py:28", "quote": "app.add_middleware(BodySizeLimit, max_bytes=1_048_576)"}, "supersedes": []},
    {"id": "s19-w2", "agent": "agent:test-runner", "day": 12, "subject": "tests.api", "slot": "body-limit", "text": "A 2 MB request body is rejected with 413, per test_rejects_large_body.", "source": {"kind": "command-output", "locator": "pytest tests/api/test_limits.py", "quote": "test_rejects_large_body PASSED"}, "supersedes": []},
    {"id": "s19-w3", "agent": "agent:docs", "day": 14, "subject": "docs:api", "slot": "content-type", "text": "The API accepts only application/json request bodies.", "source": {"kind": "file", "locator": "docs/api.md:12", "quote": "All requests must use Content-Type application/json."}, "supersedes": []},
  ],
  codeChanges: [{"day": 30, "locator": "app/main.py:28", "before": "app.add_middleware(BodySizeLimit, max_bytes=1_048_576)", "after": "app.add_middleware(BodySizeLimit, max_bytes=5_242_880)", "breaksFact": ["s19-w1", "s19-w2"]}],
  questions: [
    {"query": "Will a 2 MB bulk schedule import be rejected for size?", "day": 35, "expect": {"anyOf": [[]], "forbidden": ["s19-w1", "s19-w2"], "duplicates": [], "contradiction": false}},
    {"query": "What content type should request bodies use?", "day": 35, "expect": {"anyOf": [["s19-w3"]], "forbidden": [], "duplicates": [], "contradiction": false}},
  ] },
  { "id": "s20", "kind": "stale-code", "why": "Serialization line gains mode=json; fact that jobs are orjson JSON stays true.", writes: [
    {"id": "s20-w1", "agent": "agent:coder", "day": 10, "subject": "worker.queue", "slot": "serialization", "text": "Job payloads are serialized to JSON with orjson before enqueueing.", "source": {"kind": "file", "locator": "app/worker/queue.py:20", "quote": "payload = orjson.dumps(job.model_dump())"}, "supersedes": []},
    {"id": "s20-w2", "agent": "agent:deployer", "day": 13, "subject": "helm.canary", "slot": "namespace", "text": "Canary is deployed to the tidepool-canary namespace.", "source": {"kind": "file", "locator": "helmfile.yaml:4", "quote": "namespace: tidepool-canary"}, "supersedes": []},
    {"id": "s20-w3", "agent": "agent:triage", "day": 16, "subject": "bug:datetime-payload", "slot": "cause", "text": "Workers failed to parse datetimes in payloads because model_dump returned datetime objects.", "source": {"kind": "command-output", "locator": "worker log", "quote": "TypeError: Type is not JSON serializable: datetime.datetime"}, "supersedes": []},
    {"id": "s20-w4", "agent": "agent:architect", "day": 18, "subject": "job-model", "slot": "fields", "text": "Every job carries id, kind, schedule_id and attempt fields.", "source": {"kind": "file", "locator": "app/worker/models.py:8", "quote": "class Job(BaseModel):\n    id: str\n    kind: str\n    schedule_id: str\n    attempt: int = 0"}, "supersedes": []},
  ],
  codeChanges: [{"day": 25, "locator": "app/worker/queue.py:20", "before": "payload = orjson.dumps(job.model_dump())", "after": "payload = orjson.dumps(job.model_dump(mode=\"json\"))", "breaksFact": []}],
  questions: [
    {"query": "How are jobs encoded when they go onto the queue?", "day": 30, "expect": {"anyOf": [["s20-w1"]], "forbidden": [], "duplicates": [], "contradiction": false}},
  ] },
  { "id": "s21", "kind": "stale-code", "why": "Coverage gate raised from 80 to 85; a later commit-cited write captures the new value.", writes: [
    {"id": "s21-w1", "agent": "agent:test-runner", "day": 7, "subject": "ci.coverage", "slot": "threshold", "text": "CI fails if test coverage drops below 80%.", "source": {"kind": "file", "locator": ".gitlab-ci.yml:22", "quote": "script: pytest --cov=app --cov-fail-under=80"}, "supersedes": []},
    {"id": "s21-w2", "agent": "agent:docs", "day": 10, "subject": "docs:contributing", "slot": "branching", "text": "Feature branches are merged with squash commits.", "source": {"kind": "file", "locator": "CONTRIBUTING.md:18", "quote": "Merge requests are squash-merged."}, "supersedes": []},
    {"id": "s21-w3", "agent": "agent:coder", "day": 36, "subject": "quality-gate", "slot": "coverage-min", "text": "The coverage gate is now 85 percent.", "source": {"kind": "commit", "locator": "commit a71c3d2", "quote": "ci: raise --cov-fail-under from 80 to 85"}, "supersedes": []},
    {"id": "s21-w4", "agent": "agent:test-runner", "day": 37, "subject": "ci.coverage", "slot": "current", "text": "Current coverage on main is 87.4%.", "source": {"kind": "command-output", "locator": "pytest --cov=app", "quote": "TOTAL ... 87.4%"}, "supersedes": []},
  ],
  codeChanges: [{"day": 33, "locator": ".gitlab-ci.yml:22", "before": "script: pytest --cov=app --cov-fail-under=80", "after": "script: pytest --cov=app --cov-fail-under=85", "breaksFact": ["s21-w1"]}],
  questions: [
    {"query": "What minimum coverage does the pipeline enforce?", "day": 40, "expect": {"anyOf": [["s21-w3"]], "forbidden": ["s21-w1"], "duplicates": [], "contradiction": false}},
    {"query": "Would an MR at 82% coverage pass CI?", "day": 40, "expect": {"anyOf": [["s21-w3"]], "forbidden": ["s21-w1"], "duplicates": [], "contradiction": false}},
  ] },
  { "id": "s22", "kind": "stale-code", "why": "Only a comment is added to the cited line; pullPolicy fact stays true.", writes: [
    {"id": "s22-w1", "agent": "agent:deployer", "day": 11, "subject": "helm.canary", "slot": "pull-policy", "text": "Canary Helm values set the image pull policy to Always.", "source": {"kind": "file", "locator": "helm/values-canary.yaml:3", "quote": "pullPolicy: Always"}, "supersedes": []},
    {"id": "s22-w2", "agent": "agent:coder", "day": 14, "subject": "api.cors", "slot": "origins", "text": "CORS is disabled; no origins are allowed by default.", "source": {"kind": "file", "locator": "app/main.py:35", "quote": "allow_origins=settings.cors_origins  # empty list by default"}, "supersedes": []},
    {"id": "s22-w3", "agent": "agent:deployer", "day": 15, "subject": "helm.main", "slot": "pull-policy", "text": "Main uses IfNotPresent because it deploys immutable tags.", "source": {"kind": "file", "locator": "helm/values-main.yaml:3", "quote": "pullPolicy: IfNotPresent"}, "supersedes": []},
    {"id": "s22-w4", "agent": "agent:triage", "day": 18, "subject": "bug:stale-canary-image", "slot": "status", "text": "Stale canary image reports were caused by a reused tag, not by pull policy.", "source": {"kind": "chat", "locator": "chat with agent:deployer", "quote": "the tag got reused"}, "supersedes": []},
  ],
  codeChanges: [{"day": 27, "locator": "helm/values-canary.yaml:3", "before": "pullPolicy: Always", "after": "pullPolicy: Always  # keep: canary tags are mutable", "breaksFact": []}],
  questions: [
    {"query": "Does canary always pull a fresh image?", "day": 30, "expect": {"anyOf": [["s22-w1"]], "forbidden": [], "duplicates": [], "contradiction": false}},
    {"query": "What image pull policy does main use?", "day": 30, "expect": {"anyOf": [["s22-w3"]], "forbidden": [], "duplicates": [], "contradiction": false}},
  ] },
  { "id": "s23", "kind": "stale-code", "why": "Cron parsing switches from croniter to APScheduler; code fact and docs paraphrase both stale.", writes: [
    {"id": "s23-w1", "agent": "agent:coder", "day": 12, "subject": "recurrence", "slot": "cron-lib", "text": "Cron expressions for recurring schedules are parsed with croniter.", "source": {"kind": "file", "locator": "app/core/recurrence.py:4", "quote": "from croniter import croniter"}, "supersedes": []},
    {"id": "s23-w2", "agent": "agent:docs", "day": 15, "subject": "docs:recurrence", "slot": "parser", "text": "Recurring schedules use the croniter library to compute next run times.", "source": {"kind": "file", "locator": "app/core/recurrence.py:4", "quote": "from croniter import croniter"}, "supersedes": []},
    {"id": "s23-w3", "agent": "agent:test-runner", "day": 17, "subject": "tests.recurrence", "slot": "count", "text": "There are 38 recurrence tests and all pass.", "source": {"kind": "command-output", "locator": "pytest tests/core/test_recurrence.py", "quote": "38 passed in 1.9s"}, "supersedes": []},
    {"id": "s23-w4", "agent": "agent:architect", "day": 19, "subject": "recurrence", "slot": "max-occurrences", "text": "A recurrence expansion is capped at 500 occurrences.", "source": {"kind": "file", "locator": "app/core/recurrence.py:9", "quote": "MAX_OCCURRENCES = 500"}, "supersedes": []},
  ],
  codeChanges: [{"day": 34, "locator": "app/core/recurrence.py:4", "before": "from croniter import croniter", "after": "from apscheduler.triggers.cron import CronTrigger", "breaksFact": ["s23-w1", "s23-w2"]}],
  questions: [
    {"query": "Which library parses cron strings for recurring schedules?", "day": 40, "expect": {"anyOf": [[]], "forbidden": ["s23-w1", "s23-w2"], "duplicates": [], "contradiction": false}},
    {"query": "Is there a cap on how many occurrences a recurrence expands to?", "day": 40, "expect": {"anyOf": [["s23-w4"]], "forbidden": [], "duplicates": [], "contradiction": false}},
  ] },
  { "id": "s24", "kind": "stale-code", "why": "Two facts in the Redis client file; one line changes meaningfully, the other only gains a comment.", writes: [
    {"id": "s24-w1", "agent": "agent:coder", "day": 4, "subject": "redis.client", "slot": "socket_timeout", "text": "The Redis client uses a 5 second socket timeout.", "source": {"kind": "file", "locator": "app/core/redis.py:9", "quote": "client = redis.Redis(host=REDIS_HOST, port=6379, socket_timeout=5,"}, "supersedes": []},
    {"id": "s24-w2", "agent": "agent:architect", "day": 6, "subject": "redis", "slot": "db-index", "text": "The job queue Redis connection uses database index 0.", "source": {"kind": "file", "locator": "app/core/redis.py:10", "quote": "    db=0)"}, "supersedes": []},
    {"id": "s24-w3", "agent": "agent:triage", "day": 13, "subject": "incident:redis-blips", "slot": "impact", "text": "Short Redis failovers caused enqueue requests to hang until the socket timed out.", "source": {"kind": "command-output", "locator": "api log", "quote": "redis.exceptions.TimeoutError: Timeout reading from socket"}, "supersedes": []},
    {"id": "s24-w4", "agent": "agent:deployer", "day": 15, "subject": "helm.redis", "slot": "persistence", "text": "Redis has AOF persistence enabled in main.", "source": {"kind": "file", "locator": "helm/values-redis.yaml:11", "quote": "appendonly: \"yes\""}, "supersedes": []},
  ],
  codeChanges: [{"day": 26, "locator": "app/core/redis.py:9", "before": "client = redis.Redis(host=REDIS_HOST, port=6379, socket_timeout=5,", "after": "client = redis.Redis(host=REDIS_HOST, port=6379, socket_timeout=2,", "breaksFact": ["s24-w1"]}, {"day": 26, "locator": "app/core/redis.py:10", "before": "    db=0)", "after": "    db=0)  # job queue", "breaksFact": []}],
  questions: [
    {"query": "How long does a Redis call wait on the socket before timing out?", "day": 30, "expect": {"anyOf": [[]], "forbidden": ["s24-w1"], "duplicates": [], "contradiction": false}},
    {"query": "Which Redis database number holds the job queue?", "day": 30, "expect": {"anyOf": [["s24-w2"]], "forbidden": [], "duplicates": [], "contradiction": false}},
  ] },
  { "id": "s25", "kind": "weak-evidence", "why": "Conflict detection: cited code says touching slots are fine, triage inference says otherwise.", writes: [
    {"id": "s25-w1", "agent": "agent:coder", "day": 10, "subject": "conflicts", "slot": "overlap-rule", "text": "Two schedules conflict only when their ranges strictly overlap, so back-to-back slots are allowed.", "source": {"kind": "file", "locator": "app/services/conflicts.py:18", "quote": "if new.starts_at < existing.ends_at and existing.starts_at < new.ends_at:"}, "supersedes": []},
    {"id": "s25-w2", "agent": "agent:triage", "day": 14, "subject": "booking", "slot": "adjacent-slots", "text": "Schedules that touch at the boundary are rejected as conflicts.", "source": {"kind": "inference", "locator": "own reasoning", "quote": "a user said their 10:00 booking failed after a 9:00-10:00 one"}, "supersedes": []},
    {"id": "s25-w3", "agent": "agent:docs", "day": 16, "subject": "docs:conflicts", "slot": "scope", "text": "Conflict detection only compares schedules on the same resource.", "source": {"kind": "chat", "locator": "chat with agent:coder", "quote": "conflicts are per resource"}, "supersedes": []},
    {"id": "s25-w4", "agent": "agent:coder", "day": 17, "subject": "conflicts", "slot": "query-filter", "text": "The conflict query is filtered to schedules with the same resource_id.", "source": {"kind": "file", "locator": "app/services/conflicts.py:12", "quote": "q = q.filter(Schedule.resource_id == new.resource_id)"}, "supersedes": []},
    {"id": "s25-w5", "agent": "agent:architect", "day": 18, "subject": "conflicts", "slot": "locking", "text": "Conflict checks lock candidate rows with SELECT FOR UPDATE.", "source": {"kind": "inference", "locator": "own reasoning", "quote": "we must be locking or we'd see double bookings"}, "supersedes": []},
    {"id": "s25-w6", "agent": "agent:deployer", "day": 19, "subject": "helm.canary", "slot": "hpa", "text": "Canary has autoscaling disabled.", "source": {"kind": "file", "locator": "helm/values-canary.yaml:40", "quote": "autoscaling:\n  enabled: false"}, "supersedes": []},
  ],
  questions: [
    {"query": "Can I book a slot that starts exactly when another one ends?", "day": 22, "expect": {"anyOf": [["s25-w1"]], "forbidden": ["s25-w2"], "duplicates": [], "contradiction": false}},
    {"query": "Do schedules on different resources ever conflict with each other?", "day": 22, "expect": {"anyOf": [["s25-w4"]], "forbidden": [], "duplicates": [["s25-w3", "s25-w4"]], "contradiction": false}},
  ] },
  { "id": "s26", "kind": "weak-evidence", "why": "Canary promotion: CI file shows a manual gate and required jobs; inferences invent auto-promotion and a load test.", writes: [
    {"id": "s26-w1", "agent": "agent:deployer", "day": 20, "subject": "deploy.promotion", "slot": "trigger", "text": "Promotion from canary to main is a manual CI job.", "source": {"kind": "file", "locator": ".gitlab-ci.yml:70", "quote": "  when: manual"}, "supersedes": []},
    {"id": "s26-w2", "agent": "agent:architect", "day": 22, "subject": "canary", "slot": "auto-promote", "text": "Canary auto-promotes to main after 30 minutes without errors.", "source": {"kind": "inference", "locator": "own reasoning", "quote": "that's the usual canary pattern"}, "supersedes": []},
    {"id": "s26-w3", "agent": "agent:triage", "day": 23, "subject": "release", "slot": "promote", "text": "Someone has to click the promote job to ship to main.", "source": {"kind": "chat", "locator": "chat with agent:deployer", "quote": "someone has to click promote"}, "supersedes": []},
    {"id": "s26-w4", "agent": "agent:deployer", "day": 24, "subject": "deploy-main", "slot": "needs", "text": "The deploy-main job requires deploy-canary and smoke-canary to succeed first.", "source": {"kind": "file", "locator": ".gitlab-ci.yml:68", "quote": "  needs: [\"deploy-canary\", \"smoke-canary\"]"}, "supersedes": []},
    {"id": "s26-w5", "agent": "agent:docs", "day": 25, "subject": "docs:release", "slot": "gates", "text": "Main deploys also require a passing load test stage.", "source": {"kind": "inference", "locator": "own reasoning", "quote": "main deploys require a load test"}, "supersedes": []},
    {"id": "s26-w6", "agent": "agent:coder", "day": 25, "subject": "api.errors", "slot": "format", "text": "Errors are returned as JSON with code and message fields.", "source": {"kind": "file", "locator": "app/api/errors.py:14", "quote": "return JSONResponse({\"code\": exc.code, \"message\": exc.message}, status_code=exc.status)"}, "supersedes": []},
  ],
  questions: [
    {"query": "Does a good canary get promoted to main on its own?", "day": 28, "expect": {"anyOf": [["s26-w1"]], "forbidden": ["s26-w2"], "duplicates": [["s26-w1", "s26-w3"]], "contradiction": false}},
    {"query": "Which jobs have to succeed before the main deploy is allowed to run?", "day": 28, "expect": {"anyOf": [["s26-w4"]], "forbidden": ["s26-w5"], "duplicates": [], "contradiction": false}},
  ] },
  { "id": "s27", "kind": "weak-evidence", "why": "Idempotency keys: cited code shows Redis SET NX with 24h TTL; weak writes say MySQL and 7 days.", writes: [
    {"id": "s27-w1", "agent": "agent:coder", "day": 12, "subject": "enqueue", "slot": "idempotency", "text": "Enqueue dedupes on the Idempotency-Key header using Redis SET NX with a 24 hour expiry.", "source": {"kind": "file", "locator": "app/api/enqueue.py:40", "quote": "if redis.set(f\"tidepool:idem:{key}\", 1, nx=True, ex=86400):"}, "supersedes": []},
    {"id": "s27-w2", "agent": "agent:triage", "day": 15, "subject": "idempotency", "slot": "storage", "text": "Idempotency keys are stored in a MySQL idempotency_keys table.", "source": {"kind": "inference", "locator": "own reasoning", "quote": "durable dedupe needs the database"}, "supersedes": []},
    {"id": "s27-w3", "agent": "agent:test-runner", "day": 16, "subject": "tests.enqueue", "slot": "idempotent", "text": "Sending the same Idempotency-Key twice enqueues only one job.", "source": {"kind": "command-output", "locator": "pytest tests/api/test_enqueue.py -k idempotent", "quote": "2 passed, 14 deselected in 0.88s"}, "supersedes": []},
    {"id": "s27-w4", "agent": "agent:architect", "day": 18, "subject": "api.idempotency", "slot": "ttl", "text": "Idempotency keys are remembered for 7 days.", "source": {"kind": "chat", "locator": "chat with agent:docs", "quote": "keys last a week I believe"}, "supersedes": []},
    {"id": "s27-w5", "agent": "agent:deployer", "day": 19, "subject": "ci.registry", "slot": "image-tag", "text": "Images are tagged with the short commit SHA.", "source": {"kind": "file", "locator": ".gitlab-ci.yml:38", "quote": "IMAGE_TAG: $CI_COMMIT_SHORT_SHA"}, "supersedes": []},
  ],
  questions: [
    {"query": "Where are idempotency keys tracked?", "day": 22, "expect": {"anyOf": [["s27-w1"]], "forbidden": ["s27-w2"], "duplicates": [], "contradiction": false}},
    {"query": "If a client retries with the same idempotency key two days later, will it be deduplicated?", "day": 22, "expect": {"anyOf": [["s27-w1"]], "forbidden": ["s27-w4"], "duplicates": [], "contradiction": false}},
  ] },
  { "id": "s28", "kind": "weak-evidence", "why": "Isolation level: engine sets READ COMMITTED; an inference claims the MySQL default, and a restating quote is weak.", writes: [
    {"id": "s28-w1", "agent": "agent:architect", "day": 8, "subject": "db.engine", "slot": "isolation", "text": "Application sessions run with READ COMMITTED isolation.", "source": {"kind": "file", "locator": "app/db/session.py:15", "quote": "isolation_level=\"READ COMMITTED\","}, "supersedes": []},
    {"id": "s28-w2", "agent": "agent:coder", "day": 11, "subject": "transactions", "slot": "isolation-level", "text": "We use MySQL's default REPEATABLE READ since nothing overrides it.", "source": {"kind": "inference", "locator": "own reasoning", "quote": "never saw an override"}, "supersedes": []},
    {"id": "s28-w3", "agent": "agent:triage", "day": 19, "subject": "incident:phantom-reads", "slot": "isolation", "text": "Isolation is read committed, which allows non-repeatable reads in conflict checks.", "source": {"kind": "file", "locator": "app/db/session.py:15", "quote": "isolation is read committed"}, "supersedes": []},
    {"id": "s28-w4", "agent": "agent:test-runner", "day": 21, "subject": "ci.mysql", "slot": "global-isolation", "text": "The CI MySQL server's global isolation level is REPEATABLE-READ.", "source": {"kind": "command-output", "locator": "mysql -e \"SELECT @@global.transaction_isolation\"", "quote": "REPEATABLE-READ"}, "supersedes": []},
    {"id": "s28-w5", "agent": "agent:docs", "day": 22, "subject": "docs:ci", "slot": "artifacts", "text": "CI keeps JUnit reports as job artifacts for 7 days.", "source": {"kind": "file", "locator": ".gitlab-ci.yml:27", "quote": "expire_in: 7 days"}, "supersedes": []},
  ],
  questions: [
    {"query": "What transaction isolation do our SQLAlchemy sessions use?", "day": 25, "expect": {"anyOf": [["s28-w1"]], "forbidden": ["s28-w2"], "duplicates": [["s28-w1", "s28-w3"]], "contradiction": false}},
  ] },
  { "id": "s29", "kind": "weak-evidence", "why": "Worker shutdown: code shows drain on SIGTERM and 60s grace; weak writes claim drops and 30s.", writes: [
    {"id": "s29-w1", "agent": "agent:coder", "day": 15, "subject": "worker.shutdown", "slot": "sigterm", "text": "On SIGTERM the worker stops taking new jobs and drains the ones in flight.", "source": {"kind": "file", "locator": "app/worker/main.py:44", "quote": "signal.signal(signal.SIGTERM, self._drain)"}, "supersedes": []},
    {"id": "s29-w2", "agent": "agent:deployer", "day": 16, "subject": "helm.worker", "slot": "grace-period", "text": "Worker pods get 60 seconds of termination grace.", "source": {"kind": "file", "locator": "helm/templates/worker-deployment.yaml:40", "quote": "terminationGracePeriodSeconds: 60"}, "supersedes": []},
    {"id": "s29-w3", "agent": "agent:triage", "day": 22, "subject": "bug:lost-jobs", "slot": "cause", "text": "Workers drop in-flight jobs immediately on shutdown, which explains the lost jobs.", "source": {"kind": "inference", "locator": "own reasoning", "quote": "lost jobs line up with deploys"}, "supersedes": []},
    {"id": "s29-w4", "agent": "agent:architect", "day": 23, "subject": "k8s", "slot": "worker-termination", "text": "The worker grace period is 30 seconds.", "source": {"kind": "chat", "locator": "chat with agent:deployer", "quote": "grace is the default 30s"}, "supersedes": []},
    {"id": "s29-w5", "agent": "agent:docs", "day": 24, "subject": "docs:worker", "slot": "shutdown", "text": "Workers drain on SIGTERM.", "source": {"kind": "inference", "locator": "own reasoning", "quote": "workers drain on SIGTERM"}, "supersedes": []},
    {"id": "s29-w6", "agent": "agent:test-runner", "day": 24, "subject": "tests.lint", "slot": "status", "text": "ruff reports no violations on main.", "source": {"kind": "command-output", "locator": "ruff check .", "quote": "All checks passed!"}, "supersedes": []},
  ],
  questions: [
    {"query": "What happens to running jobs when a worker pod gets stopped during a deploy?", "day": 27, "expect": {"anyOf": [["s29-w1"]], "forbidden": ["s29-w3"], "duplicates": [["s29-w1", "s29-w5"]], "contradiction": false}},
    {"query": "How long does Kubernetes wait before force killing a worker?", "day": 27, "expect": {"anyOf": [["s29-w2"]], "forbidden": ["s29-w4"], "duplicates": [], "contradiction": false}},
  ] },
  { "id": "s30", "kind": "weak-evidence", "why": "Timezones: code shows UTC storage and required IANA tz; inferences and chat claim local storage and optional tz.", writes: [
    {"id": "s30-w1", "agent": "agent:coder", "day": 9, "subject": "time", "slot": "storage", "text": "Incoming datetimes are converted to UTC with to_utc before storage.", "source": {"kind": "file", "locator": "app/core/time.py:5", "quote": "def to_utc(dt): return dt.astimezone(timezone.utc)"}, "supersedes": []},
    {"id": "s30-w2", "agent": "agent:coder", "day": 9, "subject": "api.schemas", "slot": "tz-field", "text": "Creating a schedule requires an IANA timezone name in the tz field.", "source": {"kind": "file", "locator": "app/api/schemas.py:21", "quote": "tz: str = Field(..., pattern=IANA_TZ_RE)"}, "supersedes": []},
    {"id": "s30-w3", "agent": "agent:triage", "day": 17, "subject": "bug:tz-drift", "slot": "storage-model", "text": "The API stores local times and converts to UTC on read.", "source": {"kind": "inference", "locator": "own reasoning", "quote": "drift suggests conversion on read"}, "supersedes": []},
    {"id": "s30-w4", "agent": "agent:docs", "day": 18, "subject": "docs:api", "slot": "timezone", "text": "The tz field is optional and defaults to UTC.", "source": {"kind": "chat", "locator": "chat with agent:triage", "quote": "tz is optional, defaults to UTC"}, "supersedes": []},
    {"id": "s30-w5", "agent": "agent:architect", "day": 20, "subject": "time", "slot": "dst", "text": "DST transitions are handled through zoneinfo.", "source": {"kind": "inference", "locator": "own reasoning", "quote": "we use the stdlib for zones"}, "supersedes": []},
    {"id": "s30-w6", "agent": "agent:deployer", "day": 21, "subject": "helm.main", "slot": "env", "text": "Main sets LOG_LEVEL to info.", "source": {"kind": "file", "locator": "helm/values-main.yaml:60", "quote": "LOG_LEVEL: info"}, "supersedes": []},
  ],
  questions: [
    {"query": "Are schedule times persisted in UTC or local time?", "day": 24, "expect": {"anyOf": [["s30-w1"]], "forbidden": ["s30-w3"], "duplicates": [], "contradiction": false}},
    {"query": "Can a client omit the timezone when creating a schedule?", "day": 24, "expect": {"anyOf": [["s30-w2"]], "forbidden": ["s30-w4"], "duplicates": [], "contradiction": false}},
  ] },
  { "id": "s31", "kind": "weak-evidence", "why": "Flaky test root cause: command outputs and a fix commit point to a shared fake clock; guesses blame the network.", writes: [
    {"id": "s31-w1", "agent": "agent:test-runner", "day": 25, "subject": "flaky:test_retry_backoff", "slot": "ordering-off", "text": "test_retry_backoff passes 50 of 50 runs with random ordering disabled.", "source": {"kind": "command-output", "locator": "pytest tests/worker/test_retry.py -p no:randomly --count 50", "quote": "50 passed in 21.3s"}, "supersedes": []},
    {"id": "s31-w2", "agent": "agent:test-runner", "day": 25, "subject": "flaky:test_retry_backoff", "slot": "ordering-on", "text": "test_retry_backoff fails 7 of 50 runs with random ordering enabled.", "source": {"kind": "command-output", "locator": "pytest tests/worker/test_retry.py --count 50", "quote": "7 failed, 43 passed in 22.0s"}, "supersedes": []},
    {"id": "s31-w3", "agent": "agent:triage", "day": 26, "subject": "ci.flakes", "slot": "cause", "text": "The retry test flake is caused by Redis latency on CI runners.", "source": {"kind": "inference", "locator": "own reasoning", "quote": "CI Redis is slow sometimes"}, "supersedes": []},
    {"id": "s31-w4", "agent": "agent:coder", "day": 27, "subject": "tests.fixtures", "slot": "fake-clock", "text": "The test_retry_backoff flake was fixed by resetting the shared fake clock fixture between tests.", "source": {"kind": "commit", "locator": "commit 4b0e9d2", "quote": "tests: reset fake_clock fixture per test; fixes order-dependent test_retry_backoff"}, "supersedes": []},
    {"id": "s31-w5", "agent": "agent:architect", "day": 28, "subject": "flaky-tests", "slot": "root-cause", "text": "Flaky worker tests come from network issues on the GitLab runners.", "source": {"kind": "chat", "locator": "chat with agent:triage", "quote": "probably runner network"}, "supersedes": []},
    {"id": "s31-w6", "agent": "agent:docs", "day": 28, "subject": "docs:testing", "slot": "markers", "text": "Slow tests are marked with pytest.mark.slow and skipped by default locally.", "source": {"kind": "file", "locator": "pyproject.toml:48", "quote": "addopts = \"-m 'not slow'\""}, "supersedes": []},
  ],
  questions: [
    {"query": "Why was test_retry_backoff failing intermittently?", "day": 30, "expect": {"anyOf": [["s31-w4"]], "forbidden": ["s31-w3", "s31-w5"], "duplicates": [], "contradiction": false}},
    {"query": "Does the retry backoff test flake depend on test order?", "day": 30, "expect": {"anyOf": [["s31-w1", "s31-w2", "s31-w4"]], "forbidden": ["s31-w3", "s31-w5"], "duplicates": [], "contradiction": false}},
  ] },
  { "id": "s32", "kind": "weak-evidence", "why": "Pod memory limits: values files and kubectl output disagree with an OOM guess and a chat claim of equal limits.", writes: [
    {"id": "s32-w1", "agent": "agent:deployer", "day": 30, "subject": "helm.main", "slot": "api-memory-limit", "text": "API pods in main have a 512Mi memory limit.", "source": {"kind": "file", "locator": "helm/values-main.yaml:18", "quote": "    memory: 512Mi"}, "supersedes": []},
    {"id": "s32-w2", "agent": "agent:triage", "day": 33, "subject": "incident:oomkill", "slot": "limit", "text": "The OOMKills mean the API memory limit must be 256Mi.", "source": {"kind": "inference", "locator": "own reasoning", "quote": "OOMs at about 250MB RSS"}, "supersedes": []},
    {"id": "s32-w3", "agent": "agent:deployer", "day": 34, "subject": "k8s.main", "slot": "pod-resources", "text": "Live main API pods report limits of 1 CPU and 512Mi memory.", "source": {"kind": "command-output", "locator": "kubectl get pod -l app=tidepool-api -n tidepool-main -o jsonpath='{.items[0].spec.containers[0].resources}'", "quote": "{\"limits\":{\"cpu\":\"1\",\"memory\":\"512Mi\"},\"requests\":{\"cpu\":\"250m\",\"memory\":\"256Mi\"}}"}, "supersedes": []},
    {"id": "s32-w4", "agent": "agent:architect", "day": 35, "subject": "resources", "slot": "canary-vs-main", "text": "Canary pods have the same resource limits as main.", "source": {"kind": "chat", "locator": "chat with agent:deployer", "quote": "canary mirrors main"}, "supersedes": []},
    {"id": "s32-w5", "agent": "agent:deployer", "day": 36, "subject": "helm.canary", "slot": "api-memory-limit", "text": "Canary API pods are limited to 256Mi of memory.", "source": {"kind": "file", "locator": "helm/values-canary.yaml:18", "quote": "    memory: 256Mi"}, "supersedes": []},
    {"id": "s32-w6", "agent": "agent:coder", "day": 36, "subject": "api.startup", "slot": "workers", "text": "Each API container runs 2 uvicorn workers.", "source": {"kind": "file", "locator": "Dockerfile:14", "quote": "\"--workers\", \"2\""}, "supersedes": []},
  ],
  questions: [
    {"query": "What memory limit do main API pods have?", "day": 38, "expect": {"anyOf": [["s32-w1", "s32-w3"]], "forbidden": ["s32-w2"], "duplicates": [["s32-w1", "s32-w3"]], "contradiction": false}},
    {"query": "Do canary pods get as much memory as main?", "day": 38, "expect": {"anyOf": [["s32-w5"]], "forbidden": ["s32-w4"], "duplicates": [], "contradiction": false}},
  ] },
] as MemoryBenchmarkAgentScenario[]);
/** Set W3 (fictional "kestrel" service): secret-bearing writes and cosmetic code edits; the per-write screening and source check were chosen while reading it. */
export const MEMORY_BENCHMARK_AGENT_WRITES_SCREENING_TUNING: readonly MemoryBenchmarkAgentScenario[] = Object.freeze([
  { "id": "k1", "kind": "secret-write", "why": "Agent quotes the full DATABASE_URL line from .env.local; the fact text is clean but the quote carries the password. A separate clean write gives the port.", writes: [
    {"id": "k1-w1", "agent": "atlas", "day": 3, "subject": "db", "slot": "connection", "text": "Local Postgres for kestrel runs on localhost:5433 with database kestrel_dev.", "source": {"kind": "file", "locator": ".env.local:2", "quote": "DATABASE_URL=postgres://kestrel:{{secret:url-password}}@localhost:5433/kestrel_dev"}, "supersedes": []},
    {"id": "k1-w2", "agent": "ferry", "day": 4, "subject": "postgres", "slot": "local-port", "text": "docker-compose publishes the Postgres container's 5432 on host port 5433.", "source": {"kind": "file", "locator": "docker-compose.yml:18", "quote": "- \"5433:5432\""}, "supersedes": []},
    {"id": "k1-w3", "agent": "wren", "day": 4, "subject": "shipment", "slot": "id-format", "text": "Shipment IDs are ULIDs generated in internal/shipment/id.go.", "source": {"kind": "file", "locator": "internal/shipment/id.go:11", "quote": "return ulid.Make().String()"}, "supersedes": []},
  ],
  questions: [
    {"query": "what host port do I point psql at for the dev database?", "day": 6, "expect": {"anyOf": [["k1-w2"]], "forbidden": ["k1-w1"], "duplicates": [], "contradiction": false}},
    {"query": "what's the name of the local dev database?", "day": 6, "expect": {"anyOf": [], "forbidden": ["k1-w1"], "duplicates": [], "contradiction": false}},
    {"query": "how are shipment identifiers generated?", "day": 7, "expect": {"anyOf": [["k1-w3"]], "forbidden": ["k1-w1"], "duplicates": [], "contradiction": false}},
  ] },
  { "id": "k2", "kind": "secret-write", "why": "Agent pastes `env | grep OPENAI` output that echoes the key; a clean write documents where the key is read from without the value.", writes: [
    {"id": "k2-w1", "agent": "scout", "day": 5, "subject": "llm", "slot": "env", "text": "OPENAI_API_KEY is exported in the dev shell, so route-explainer LLM calls succeed locally.", "source": {"kind": "command-output", "locator": "env | grep OPENAI", "quote": "OPENAI_API_KEY={{secret:openai-key}}"}, "supersedes": []},
    {"id": "k2-w2", "agent": "ferry", "day": 5, "subject": "route-explainer", "slot": "api-key-source", "text": "The route-explainer client reads its OpenAI key from the OPENAI_API_KEY environment variable; it is never committed.", "source": {"kind": "file", "locator": "internal/llm/client.go:22", "quote": "key := os.Getenv(\"OPENAI_API_KEY\")"}, "supersedes": []},
    {"id": "k2-w3", "agent": "atlas", "day": 6, "subject": "route-explainer", "slot": "model", "text": "Route explanations use gpt-4o-mini, configured in config/llm.yaml.", "source": {"kind": "file", "locator": "config/llm.yaml:4", "quote": "model: gpt-4o-mini"}, "supersedes": []},
  ],
  questions: [
    {"query": "where does the LLM client pick up its credentials?", "day": 8, "expect": {"anyOf": [["k2-w2"]], "forbidden": ["k2-w1"], "duplicates": [], "contradiction": false}},
    {"query": "which model generates the route explanations?", "day": 8, "expect": {"anyOf": [["k2-w3"]], "forbidden": ["k2-w1"], "duplicates": [], "contradiction": false}},
  ] },
  { "id": "k3", "kind": "secret-write", "why": "A stack trace pasted as the quote leaks a personal home path; two clean writes say the same remedy.", writes: [
    {"id": "k3-w1", "agent": "wren", "day": 2, "subject": "web-tests", "slot": "module-resolution", "text": "Running vitest from the repo root fails with \"Cannot find module '@kestrel/geo'\"; it only resolves inside web/.", "source": {"kind": "command-output", "locator": "npx vitest run", "quote": "Error: Cannot find module '@kestrel/geo'\n    at {{home:/code/kestrel/web/src/map/route.ts}}:4:1"}, "supersedes": []},
    {"id": "k3-w2", "agent": "ferry", "day": 3, "subject": "vitest", "slot": "cwd", "text": "The @kestrel/geo alias is defined in web/tsconfig.json paths, so web tests must be run from inside web/.", "source": {"kind": "file", "locator": "web/tsconfig.json:9", "quote": "\"@kestrel/geo\": [\"../packages/geo/src\"]"}, "supersedes": []},
    {"id": "k3-w3", "agent": "scout", "day": 4, "subject": "frontend", "slot": "test-command", "text": "Run npm test from the web/ directory, not from the repository root.", "source": {"kind": "file", "locator": "web/README.md:12", "quote": "cd web && npm test"}, "supersedes": []},
    {"id": "k3-w4", "agent": "atlas", "day": 4, "subject": "api", "slot": "framework", "text": "The Go API uses chi for routing.", "source": {"kind": "file", "locator": "go.mod:7", "quote": "github.com/go-chi/chi/v5 v5.0.12"}, "supersedes": []},
  ],
  questions: [
    {"query": "vitest can't resolve @kestrel/geo, what am I doing wrong?", "day": 6, "expect": {"anyOf": [["k3-w2", "k3-w3"]], "forbidden": ["k3-w1"], "duplicates": [["k3-w2", "k3-w3"]], "contradiction": false}},
    {"query": "which HTTP router does the backend use?", "day": 6, "expect": {"anyOf": [["k3-w4"]], "forbidden": ["k3-w1"], "duplicates": [], "contradiction": false}},
  ] },
  { "id": "k4", "kind": "secret-write", "why": "Agent writes a staging admin JWT straight into the fact text; another agent explains how admin tokens are minted without a value.", writes: [
    {"id": "k4-w1", "agent": "scout", "day": 7, "subject": "staging", "slot": "admin-token", "text": "Staging admin JWT is {{secret:jwt}}; send it as Bearer on /admin routes.", "source": {"kind": "chat", "locator": "slack:#kestrel-dev 2026-09-02", "quote": "here's the admin token for staging, Bearer {{secret:jwt}}"}, "supersedes": []},
    {"id": "k4-w2", "agent": "atlas", "day": 8, "subject": "auth", "slot": "admin-routes", "text": "/admin routes require a JWT with role=admin, minted with `kestrelctl token mint --role admin`; tokens expire after 15 minutes.", "source": {"kind": "file", "locator": "internal/auth/admin.go:27", "quote": "const adminTokenTTL = 15 * time.Minute"}, "supersedes": []},
    {"id": "k4-w3", "agent": "ferry", "day": 8, "subject": "tracking", "slot": "public-endpoint", "text": "Public tracking lookups are served at GET /v1/track/{code} without authentication.", "source": {"kind": "file", "locator": "internal/api/routes.go:44", "quote": "r.Get(\"/v1/track/{code}\", h.Track)"}, "supersedes": []},
  ],
  questions: [
    {"query": "how do I get credentials to hit the admin endpoints on staging?", "day": 10, "expect": {"anyOf": [["k4-w2"]], "forbidden": ["k4-w1"], "duplicates": [], "contradiction": false}},
    {"query": "what's the lifetime of an admin token?", "day": 10, "expect": {"anyOf": [["k4-w2"]], "forbidden": ["k4-w1"], "duplicates": [], "contradiction": false}},
  ] },
  { "id": "k5", "kind": "secret-write", "why": "A secret-bearing write supersedes an older clean one with a changed algorithm; a later clean write restates the new algorithm without superseding.", writes: [
    {"id": "k5-w1", "agent": "atlas", "day": 2, "subject": "webhooks", "slot": "signature", "text": "Carrier callback signatures are verified with HMAC-SHA1.", "source": {"kind": "file", "locator": "internal/webhooks/verify.go:19", "quote": "mac := hmac.New(sha1.New, secret)"}, "supersedes": []},
    {"id": "k5-w2", "agent": "wren", "day": 9, "subject": "webhooks", "slot": "signature", "text": "Carrier webhook verification switched to HMAC-SHA256; the staging signing secret is {{secret:hex64}}.", "source": {"kind": "commit", "locator": "a91f3c2", "quote": "switch carrier webhook verification to sha256"}, "supersedes": ["k5-w1"]},
    {"id": "k5-w3", "agent": "scout", "day": 10, "subject": "carrier-callbacks", "slot": "hmac", "text": "verify.go now builds the carrier callback MAC with SHA-256.", "source": {"kind": "file", "locator": "internal/webhooks/verify.go:19", "quote": "mac := hmac.New(sha256.New, secret)"}, "supersedes": []},
    {"id": "k5-w4", "agent": "ferry", "day": 10, "subject": "webhooks", "slot": "secret-storage", "text": "The webhook signing secret is loaded from the vault at startup and never logged.", "source": {"kind": "file", "locator": "cmd/api/main.go:58", "quote": "whSecret, err := vault.Get(ctx, \"carrier-webhook-secret\")"}, "supersedes": []},
  ],
  questions: [
    {"query": "which hash do we use when checking carrier callback signatures?", "day": 12, "expect": {"anyOf": [["k5-w3"]], "forbidden": ["k5-w1", "k5-w2"], "duplicates": [], "contradiction": false}},
    {"query": "what is the actual staging webhook signing secret?", "day": 12, "expect": {"anyOf": [], "forbidden": ["k5-w1", "k5-w2"], "duplicates": [], "contradiction": false}},
    {"query": "where does the API load the webhook secret from?", "day": 12, "expect": {"anyOf": [["k5-w4"]], "forbidden": ["k5-w2"], "duplicates": [], "contradiction": false}},
  ] },
  { "id": "k6", "kind": "secret-write", "why": "A clean write supersedes an earlier write that had a static AWS access key in its text.", writes: [
    {"id": "k6-w1", "agent": "ferry", "day": 3, "subject": "pod-photos", "slot": "upload", "text": "Proof-of-delivery photo uploads use access key {{secret:aws-access-key}} against us-east-2.", "source": {"kind": "file", "locator": "config/storage.local.yaml:5", "quote": "access_key_id: {{secret:aws-access-key}}"}, "supersedes": []},
    {"id": "k6-w2", "agent": "atlas", "day": 7, "subject": "pod-photos", "slot": "upload", "text": "Proof-of-delivery uploads now use the ECS task IAM role (no static keys) and go to bucket kestrel-pod-photos in us-east-2.", "source": {"kind": "file", "locator": "deploy/terraform/pod.tf:11", "quote": "bucket = \"kestrel-pod-photos\""}, "supersedes": ["k6-w1"]},
    {"id": "k6-w3", "agent": "wren", "day": 7, "subject": "pod-photos", "slot": "max-size", "text": "Photos over 8 MB are rejected by the upload handler.", "source": {"kind": "file", "locator": "internal/pod/upload.go:15", "quote": "const maxPhotoBytes = 8 << 20"}, "supersedes": []},
  ],
  questions: [
    {"query": "which S3 bucket and region do delivery photos land in?", "day": 9, "expect": {"anyOf": [["k6-w2"]], "forbidden": ["k6-w1"], "duplicates": [], "contradiction": false}},
    {"query": "are we still using long-lived AWS keys for photo uploads?", "day": 9, "expect": {"anyOf": [["k6-w2"]], "forbidden": ["k6-w1"], "duplicates": [], "contradiction": false}},
    {"query": "size cap for POD images?", "day": 9, "expect": {"anyOf": [["k6-w3"]], "forbidden": ["k6-w1"], "duplicates": [], "contradiction": false}},
  ] },
  { "id": "k7", "kind": "secret-write", "why": "Agent cites the deploy key file and quotes its whole PEM contents; a clean write covers the gitignore fact.", writes: [
    {"id": "k7-w1", "agent": "wren", "day": 4, "subject": "deploy", "slot": "ssh-key", "text": "The edge box deploy key lives at deploy/keys/edge_ed25519 and is not committed.", "source": {"kind": "file", "locator": "deploy/keys/edge_ed25519:1", "quote": "{{secret:private-key}}"}, "supersedes": []},
    {"id": "k7-w2", "agent": "scout", "day": 5, "subject": "gitignore", "slot": "deploy-keys", "text": "deploy/keys/ is listed in .gitignore.", "source": {"kind": "file", "locator": ".gitignore:7", "quote": "deploy/keys/"}, "supersedes": []},
    {"id": "k7-w3", "agent": "atlas", "day": 5, "subject": "go", "slot": "version", "text": "Kestrel targets Go 1.23 per go.mod.", "source": {"kind": "file", "locator": "go.mod:3", "quote": "go 1.23"}, "supersedes": []},
  ],
  questions: [
    {"query": "could the deploy keys end up in a commit?", "day": 7, "expect": {"anyOf": [["k7-w2"]], "forbidden": ["k7-w1"], "duplicates": [], "contradiction": false}},
    {"query": "which Go toolchain version is the module on?", "day": 7, "expect": {"anyOf": [["k7-w3"]], "forbidden": ["k7-w1"], "duplicates": [], "contradiction": false}},
  ] },
  { "id": "k8", "kind": "secret-write", "why": "Agent pastes the curl it used to test Slack posting, including the bot token in the header.", writes: [
    {"id": "k8-w1", "agent": "atlas", "day": 5, "subject": "alerts", "slot": "slack", "text": "Dispatch alerts post to #kestrel-dispatch via chat.postMessage; verified by hand with curl.", "source": {"kind": "command-output", "locator": "curl slack chat.postMessage", "quote": "curl -H 'Authorization: Bearer {{secret:slack-token}}' https://slack.com/api/chat.postMessage -d channel=#kestrel-dispatch"}, "supersedes": []},
    {"id": "k8-w2", "agent": "ferry", "day": 5, "subject": "dispatch", "slot": "alert-channel", "text": "Dispatch failure alerts go to #kestrel-dispatch, set in config/alerts.yaml.", "source": {"kind": "file", "locator": "config/alerts.yaml:3", "quote": "channel: \"#kestrel-dispatch\""}, "supersedes": []},
    {"id": "k8-w3", "agent": "wren", "day": 6, "subject": "alerts-worker", "slot": "token-env", "text": "The Slack bot token is read from SLACK_BOT_TOKEN and only the alerts worker has it mounted.", "source": {"kind": "file", "locator": "cmd/alerts/main.go:31", "quote": "token := os.Getenv(\"SLACK_BOT_TOKEN\")"}, "supersedes": []},
    {"id": "k8-w4", "agent": "scout", "day": 6, "subject": "eta", "slot": "model", "text": "ETA predictions come from a gradient-boosted model served by the eta-svc sidecar.", "source": {"kind": "inference", "locator": "deploy/k8s/eta.yaml", "quote": "image: kestrel/eta-svc"}, "supersedes": []},
  ],
  questions: [
    {"query": "where do dispatch failure notifications show up?", "day": 8, "expect": {"anyOf": [["k8-w2"]], "forbidden": ["k8-w1"], "duplicates": [], "contradiction": false}},
    {"query": "what env var should hold the Slack credential?", "day": 8, "expect": {"anyOf": [["k8-w3"]], "forbidden": ["k8-w1"], "duplicates": [], "contradiction": false}},
  ] },
  { "id": "k9", "kind": "secret-write", "why": "git remote -v output pasted as the quote shows a token embedded in the HTTPS remote URL.", writes: [
    {"id": "k9-w1", "agent": "scout", "day": 2, "subject": "repo", "slot": "remote", "text": "origin points to github.com/kestrel-logistics/kestrel over HTTPS.", "source": {"kind": "command-output", "locator": "git remote -v", "quote": "origin  https://{{secret:github-token}}@github.com/kestrel-logistics/kestrel.git (fetch)"}, "supersedes": []},
    {"id": "k9-w2", "agent": "atlas", "day": 4, "subject": "ci", "slot": "pipeline", "text": "GitHub Actions workflow .github/workflows/ci.yml runs go test ./... and the web vitest suite.", "source": {"kind": "file", "locator": ".github/workflows/ci.yml:22", "quote": "run: go test ./..."}, "supersedes": []},
    {"id": "k9-w3", "agent": "ferry", "day": 4, "subject": "github", "slot": "repo-name", "text": "The repository is kestrel-logistics/kestrel on GitHub.", "source": {"kind": "chat", "locator": "kickoff thread", "quote": "repo is kestrel-logistics/kestrel"}, "supersedes": []},
  ],
  questions: [
    {"query": "what's the GitHub org and repo for this project?", "day": 6, "expect": {"anyOf": [["k9-w3"]], "forbidden": ["k9-w1"], "duplicates": [], "contradiction": false}},
    {"query": "what does the CI job actually execute?", "day": 6, "expect": {"anyOf": [["k9-w2"]], "forbidden": ["k9-w1"], "duplicates": [], "contradiction": false}},
  ] },
  { "id": "k10", "kind": "secret-write", "why": "The private home path is in the fact text itself, not the quote; a clean write gives the general fix.", writes: [
    {"id": "k10-w1", "agent": "wren", "day": 3, "subject": "go-build", "slot": "checksum", "text": "Fixed the module checksum mismatch by deleting {{home:/go/pkg/mod/cache/download/github.com/kestrel-logistics}} and re-running go mod download.", "source": {"kind": "command-output", "locator": "go build ./...", "quote": "verifying github.com/kestrel-logistics/geo@v0.4.1: checksum mismatch"}, "supersedes": []},
    {"id": "k10-w2", "agent": "ferry", "day": 3, "subject": "go-modules", "slot": "troubleshooting", "text": "A checksum mismatch on go build is cleared with go clean -modcache followed by go mod download.", "source": {"kind": "command-output", "locator": "go clean -modcache && go mod download", "quote": "go: downloading github.com/kestrel-logistics/geo v0.4.1"}, "supersedes": []},
    {"id": "k10-w3", "agent": "atlas", "day": 5, "subject": "tracking", "slot": "rate-limit", "text": "The public tracking endpoint is rate limited to 50 requests per second per IP.", "source": {"kind": "file", "locator": "internal/ratelimit/limits.go:8", "quote": "TrackPerIP: rate.Limit(50),"}, "supersedes": []},
  ],
  questions: [
    {"query": "go build complains about a checksum mismatch on a dependency, fix?", "day": 6, "expect": {"anyOf": [["k10-w2"]], "forbidden": ["k10-w1"], "duplicates": [], "contradiction": false}},
    {"query": "how many requests per second can a single IP make to tracking?", "day": 6, "expect": {"anyOf": [["k10-w3"]], "forbidden": ["k10-w1"], "duplicates": [], "contradiction": false}},
  ] },
  { "id": "k11", "kind": "secret-write", "why": "Agent records that a config file has a hardcoded Anthropic key and quotes the line; other writes talk about secrets without values.", writes: [
    {"id": "k11-w1", "agent": "atlas", "day": 6, "subject": "summarizer", "slot": "config", "text": "config/summarizer.local.yaml has a hardcoded Anthropic api_key with a TODO to move it to the vault.", "source": {"kind": "file", "locator": "config/summarizer.local.yaml:3", "quote": "api_key: {{secret:anthropic-key}}  # TODO move to vault"}, "supersedes": []},
    {"id": "k11-w2", "agent": "ferry", "day": 7, "subject": "drivers", "slot": "password-hashing", "text": "Driver passwords are hashed with argon2id in internal/auth/hash.go.", "source": {"kind": "file", "locator": "internal/auth/hash.go:17", "quote": "argon2.IDKey([]byte(pw), salt, 3, 64*1024, 2, 32)"}, "supersedes": []},
    {"id": "k11-w3", "agent": "scout", "day": 7, "subject": "ticket-summarizer", "slot": "auth", "text": "The summarizer should fetch ANTHROPIC_API_KEY from the vault at startup and send it in the x-api-key header.", "source": {"kind": "chat", "locator": "PR #212 review", "quote": "pull the key from vault on boot and set x-api-key, no keys in yaml"}, "supersedes": []},
  ],
  questions: [
    {"query": "is there a model API key checked into any yaml config right now?", "day": 9, "expect": {"anyOf": [], "forbidden": ["k11-w1"], "duplicates": [], "contradiction": false}},
    {"query": "how are driver passwords stored?", "day": 9, "expect": {"anyOf": [["k11-w2"]], "forbidden": ["k11-w1"], "duplicates": [], "contradiction": false}},
    {"query": "how is the support summarizer supposed to authenticate with Anthropic?", "day": 9, "expect": {"anyOf": [["k11-w3"]], "forbidden": ["k11-w1"], "duplicates": [], "contradiction": false}},
  ] },
  { "id": "k12", "kind": "secret-write", "why": "A secret-bearing write supersedes a clean Redis fact with a new host; a later clean write by another agent restates the new host without linking.", writes: [
    {"id": "k12-w1", "agent": "ferry", "day": 2, "subject": "redis", "slot": "rate-limit", "text": "Rate limiting uses the compose redis service at redis:6379, db 2.", "source": {"kind": "file", "locator": "internal/ratelimit/redis.go:12", "quote": "Addr: \"redis:6379\""}, "supersedes": []},
    {"id": "k12-w2", "agent": "wren", "day": 8, "subject": "redis", "slot": "rate-limit", "text": "Rate-limit Redis moved to the managed instance: REDIS_URL=rediss://default:{{secret:url-password}}@cache.kestrel.internal:6380/2.", "source": {"kind": "command-output", "locator": "kubectl get secret ratelimit -o yaml | base64 -d", "quote": "rediss://default:{{secret:url-password}}@cache.kestrel.internal:6380/2"}, "supersedes": ["k12-w1"]},
    {"id": "k12-w3", "agent": "atlas", "day": 9, "subject": "ratelimiter", "slot": "backend", "text": "The rate limiter now connects over TLS to cache.kestrel.internal:6380.", "source": {"kind": "file", "locator": "internal/ratelimit/redis.go:12", "quote": "Addr: \"cache.kestrel.internal:6380\""}, "supersedes": []},
    {"id": "k12-w4", "agent": "scout", "day": 9, "subject": "geocoding", "slot": "provider", "text": "Address geocoding is cached for 24 hours.", "source": {"kind": "file", "locator": "internal/geo/cache.go:6", "quote": "const geocodeTTL = 24 * time.Hour"}, "supersedes": []},
  ],
  questions: [
    {"query": "which redis host is the rate limiter talking to?", "day": 11, "expect": {"anyOf": [["k12-w3"]], "forbidden": ["k12-w1", "k12-w2"], "duplicates": [], "contradiction": false}},
    {"query": "how long do geocode results stay cached?", "day": 11, "expect": {"anyOf": [["k12-w4"]], "forbidden": ["k12-w2"], "duplicates": [], "contradiction": false}},
  ] },
  { "id": "k13", "kind": "cosmetic-edit", "why": "gofmt realigns a const block (cosmetic), later the port value actually changes.", writes: [
    {"id": "k13-w1", "agent": "atlas", "day": 2, "subject": "api", "slot": "port", "text": "The API listens on 8080 by default.", "source": {"kind": "file", "locator": "internal/config/defaults.go:9", "quote": "DefaultPort    = 8080"}, "supersedes": []},
    {"id": "k13-w2", "agent": "ferry", "day": 3, "subject": "kestrel-api", "slot": "http-port", "text": "kestrel-api's default HTTP port is 8080.", "source": {"kind": "file", "locator": "internal/config/defaults.go:9", "quote": "\tDefaultPort    = 8080"}, "supersedes": []},
    {"id": "k13-w3", "agent": "scout", "day": 11, "subject": "api", "slot": "default-port", "text": "Default API port is now 9090.", "source": {"kind": "file", "locator": "internal/config/defaults.go:9", "quote": "DefaultPort = 9090"}, "supersedes": []},
    {"id": "k13-w4", "agent": "wren", "day": 3, "subject": "api", "slot": "read-timeout", "text": "HTTP server read timeout is 15 seconds.", "source": {"kind": "file", "locator": "internal/config/defaults.go:10", "quote": "DefaultReadTimeout = 15 * time.Second"}, "supersedes": []},
  ],
  codeChanges: [{"day": 5, "locator": "internal/config/defaults.go:9", "before": "\tDefaultPort    = 8080", "after": "\tDefaultPort = 8080", "breaksFact": []}, {"day": 10, "locator": "internal/config/defaults.go:9", "before": "\tDefaultPort = 8080", "after": "\tDefaultPort = 9090", "breaksFact": ["k13-w1", "k13-w2"]}],
  questions: [
    {"query": "what port does the api bind locally?", "day": 7, "expect": {"anyOf": [["k13-w1", "k13-w2"]], "forbidden": [], "duplicates": [["k13-w1", "k13-w2"]], "contradiction": false}},
    {"query": "what port should my curl hit for the API?", "day": 12, "expect": {"anyOf": [["k13-w3"]], "forbidden": ["k13-w1", "k13-w2"], "duplicates": [], "contradiction": false}},
  ] },
  { "id": "k14", "kind": "cosmetic-edit", "why": "A trailing explanatory comment is added to a TS constant; the timeout fact is untouched.", writes: [
    {"id": "k14-w1", "agent": "wren", "day": 3, "subject": "web-client", "slot": "timeout", "text": "The frontend API client aborts requests after 10 seconds.", "source": {"kind": "file", "locator": "web/src/api/client.ts:7", "quote": "export const REQUEST_TIMEOUT_MS = 10000;"}, "supersedes": []},
    {"id": "k14-w2", "agent": "scout", "day": 4, "subject": "map", "slot": "tiles", "text": "Map tiles render with MapLibre using the self-hosted style at web/public/style.json.", "source": {"kind": "file", "locator": "web/src/map/Map.tsx:12", "quote": "style: '/style.json',"}, "supersedes": []},
    {"id": "k14-w3", "agent": "ferry", "day": 4, "subject": "web-client", "slot": "retries", "text": "Failed GETs are retried twice with jittered backoff.", "source": {"kind": "file", "locator": "web/src/api/client.ts:8", "quote": "export const MAX_RETRIES = 2;"}, "supersedes": []},
  ],
  codeChanges: [{"day": 6, "locator": "web/src/api/client.ts:7", "before": "export const REQUEST_TIMEOUT_MS = 10000;", "after": "export const REQUEST_TIMEOUT_MS = 10000; // carriers can be slow", "breaksFact": []}, {"day": 6, "locator": "web/src/api/client.ts:8", "before": "export const MAX_RETRIES = 2;", "after": "export const MAX_RETRIES = 0; // retries handled by the service worker", "breaksFact": ["k14-w3"]}],
  questions: [
    {"query": "how long before the web app gives up waiting on the backend?", "day": 8, "expect": {"anyOf": [["k14-w1"]], "forbidden": ["k14-w3"], "duplicates": [], "contradiction": false}},
    {"query": "does the web client retry failed fetches itself?", "day": 8, "expect": {"anyOf": [], "forbidden": ["k14-w3"], "duplicates": [], "contradiction": false}},
  ] },
  { "id": "k15", "kind": "cosmetic-edit", "why": "YAML replicas line gets extra spaces and a comment (cosmetic); the memory limit really changes.", writes: [
    {"id": "k15-w1", "agent": "atlas", "day": 3, "subject": "k8s", "slot": "replicas", "text": "Production runs 3 kestrel-api replicas.", "source": {"kind": "file", "locator": "deploy/k8s/api.yaml:23", "quote": "replicas: 3"}, "supersedes": []},
    {"id": "k15-w2", "agent": "ferry", "day": 3, "subject": "api-pods", "slot": "memory", "text": "API pods have a 512Mi memory limit.", "source": {"kind": "file", "locator": "deploy/k8s/api.yaml:41", "quote": "memory: \"512Mi\""}, "supersedes": []},
    {"id": "k15-w3", "agent": "scout", "day": 4, "subject": "k8s", "slot": "mem-limit", "text": "kestrel-api container memory limit is 512Mi, so OOMKills show up during big batch imports.", "source": {"kind": "file", "locator": "deploy/k8s/api.yaml:41", "quote": "memory: \"512Mi\""}, "supersedes": []},
  ],
  codeChanges: [{"day": 6, "locator": "deploy/k8s/api.yaml:23", "before": "  replicas: 3", "after": "  replicas:   3   # scaled by HPA above this floor", "breaksFact": []}, {"day": 7, "locator": "deploy/k8s/api.yaml:41", "before": "              memory: \"512Mi\"", "after": "              memory: \"1Gi\"", "breaksFact": ["k15-w2", "k15-w3"]}],
  questions: [
    {"query": "how many api pods are we running in prod?", "day": 9, "expect": {"anyOf": [["k15-w1"]], "forbidden": ["k15-w2", "k15-w3"], "duplicates": [], "contradiction": false}},
    {"query": "what's the memory ceiling on the API containers?", "day": 9, "expect": {"anyOf": [], "forbidden": ["k15-w2", "k15-w3"], "duplicates": [], "contradiction": false}},
  ] },
  { "id": "k16", "kind": "cosmetic-edit", "why": "Two comment-only edits where the facts are about comments: a resolved TODO (breaks) and a punctuation tweak on a Deprecated note (does not).", writes: [
    {"id": "k16-w1", "agent": "ferry", "day": 2, "subject": "billing", "slot": "known-bugs", "text": "There is an open TODO saying invoice rounding is wrong for JPY.", "source": {"kind": "file", "locator": "internal/billing/invoice.go:58", "quote": "// TODO(ferry): rounding is wrong for JPY, fix before launch"}, "supersedes": []},
    {"id": "k16-w2", "agent": "wren", "day": 3, "subject": "tracking", "slot": "deprecations", "text": "PollEvents is deprecated in favor of StreamEvents.", "source": {"kind": "file", "locator": "internal/tracking/poll.go:14", "quote": "// Deprecated: use StreamEvents instead."}, "supersedes": []},
    {"id": "k16-w3", "agent": "atlas", "day": 3, "subject": "billing", "slot": "currency", "text": "Invoices store amounts in minor units as int64.", "source": {"kind": "file", "locator": "internal/billing/invoice.go:22", "quote": "AmountMinor int64"}, "supersedes": []},
  ],
  codeChanges: [{"day": 6, "locator": "internal/billing/invoice.go:58", "before": "\t// TODO(ferry): rounding is wrong for JPY, fix before launch", "after": "\t// rounding uses per-currency minor units (see currency.go)", "breaksFact": ["k16-w1"]}, {"day": 6, "locator": "internal/tracking/poll.go:14", "before": "// Deprecated: use StreamEvents instead.", "after": "// Deprecated: use StreamEvents instead", "breaksFact": []}],
  questions: [
    {"query": "is JPY rounding in invoices still a known problem?", "day": 8, "expect": {"anyOf": [], "forbidden": ["k16-w1"], "duplicates": [], "contradiction": false}},
    {"query": "what should I call instead of PollEvents?", "day": 8, "expect": {"anyOf": [["k16-w2"]], "forbidden": ["k16-w1"], "duplicates": [], "contradiction": false}},
  ] },
  { "id": "k17", "kind": "cosmetic-edit", "why": "SQL column definition re-spaced with an added -- comment; duplicates under different keys.", writes: [
    {"id": "k17-w1", "agent": "atlas", "day": 2, "subject": "shipments", "slot": "default-status", "text": "New shipment rows default to status 'pending'.", "source": {"kind": "file", "locator": "migrations/0007_shipments.sql:12", "quote": "status TEXT NOT NULL DEFAULT 'pending',"}, "supersedes": []},
    {"id": "k17-w2", "agent": "scout", "day": 4, "subject": "shipment-status", "slot": "initial", "text": "A freshly inserted shipment starts out as pending.", "source": {"kind": "file", "locator": "migrations/0007_shipments.sql:12", "quote": "DEFAULT 'pending'"}, "supersedes": []},
    {"id": "k17-w3", "agent": "wren", "day": 4, "subject": "carriers", "slot": "adapters", "text": "Carrier adapters implement the Carrier interface in internal/carrier/carrier.go.", "source": {"kind": "file", "locator": "internal/carrier/carrier.go:9", "quote": "type Carrier interface {"}, "supersedes": []},
  ],
  codeChanges: [{"day": 6, "locator": "migrations/0007_shipments.sql:12", "before": "  status TEXT NOT NULL DEFAULT 'pending',", "after": "    status  TEXT  NOT NULL  DEFAULT 'pending',  -- see ShipmentStatus", "breaksFact": []}],
  questions: [
    {"query": "what state is a shipment in right after insert?", "day": 8, "expect": {"anyOf": [["k17-w1", "k17-w2"]], "forbidden": [], "duplicates": [["k17-w1", "k17-w2"]], "contradiction": false}},
  ] },
  { "id": "k18", "kind": "cosmetic-edit", "why": "Shell script: a log level value change (breaks) next to a trailing-whitespace cleanup (does not).", writes: [
    {"id": "k18-w1", "agent": "ferry", "day": 2, "subject": "dev-script", "slot": "log-level", "text": "scripts/dev.sh runs the stack with debug logging.", "source": {"kind": "file", "locator": "scripts/dev.sh:5", "quote": "export KESTREL_LOG_LEVEL=debug"}, "supersedes": []},
    {"id": "k18-w2", "agent": "wren", "day": 9, "subject": "logging", "slot": "dev-level", "text": "dev.sh now sets the log level to info.", "source": {"kind": "file", "locator": "scripts/dev.sh:5", "quote": "export KESTREL_LOG_LEVEL=info"}, "supersedes": []},
    {"id": "k18-w3", "agent": "atlas", "day": 2, "subject": "dev-script", "slot": "launch", "text": "dev.sh starts the API with go run ./cmd/api.", "source": {"kind": "file", "locator": "scripts/dev.sh:9", "quote": "go run ./cmd/api"}, "supersedes": []},
  ],
  codeChanges: [{"day": 7, "locator": "scripts/dev.sh:5", "before": "export KESTREL_LOG_LEVEL=debug", "after": "export KESTREL_LOG_LEVEL=info  # debug was too noisy", "breaksFact": ["k18-w1"]}, {"day": 7, "locator": "scripts/dev.sh:9", "before": "go run ./cmd/api   ", "after": "go run ./cmd/api", "breaksFact": []}],
  questions: [
    {"query": "what verbosity does the local dev script log at?", "day": 10, "expect": {"anyOf": [["k18-w2"]], "forbidden": ["k18-w1"], "duplicates": [], "contradiction": false}},
    {"query": "how does dev.sh launch the server process?", "day": 10, "expect": {"anyOf": [["k18-w3"]], "forbidden": ["k18-w1"], "duplicates": [], "contradiction": false}},
  ] },
  { "id": "k19", "kind": "cosmetic-edit", "why": "TOML spacing around = (cosmetic) and a Go function rename (breaks).", writes: [
    {"id": "k19-w1", "agent": "scout", "day": 3, "subject": "lint", "slot": "timeout", "text": "golangci-lint is configured with a 5 minute timeout.", "source": {"kind": "file", "locator": ".golangci.toml:4", "quote": "timeout = \"5m\""}, "supersedes": []},
    {"id": "k19-w2", "agent": "atlas", "day": 3, "subject": "geo", "slot": "distance", "text": "Distance between stops is computed by geo.Haversine.", "source": {"kind": "file", "locator": "internal/geo/haversine.go:3", "quote": "func Haversine(a, b Point) float64 {"}, "supersedes": []},
    {"id": "k19-w3", "agent": "ferry", "day": 4, "subject": "routing", "slot": "units", "text": "Route distances are reported in kilometres.", "source": {"kind": "inference", "locator": "internal/routing/summary.go", "quote": "DistanceKm float64"}, "supersedes": []},
  ],
  codeChanges: [{"day": 6, "locator": ".golangci.toml:4", "before": "timeout = \"5m\"", "after": "timeout=\"5m\"", "breaksFact": []}, {"day": 6, "locator": "internal/geo/haversine.go:3", "before": "func Haversine(a, b Point) float64 {", "after": "func GreatCircleKm(a, b Point) float64 {", "breaksFact": ["k19-w2"]}],
  questions: [
    {"query": "which function do I call to get the distance between two stops?", "day": 8, "expect": {"anyOf": [], "forbidden": ["k19-w2"], "duplicates": [], "contradiction": false}},
    {"query": "how long can the linter run before it times out?", "day": 8, "expect": {"anyOf": [["k19-w1"]], "forbidden": ["k19-w2"], "duplicates": [], "contradiction": false}},
  ] },
  { "id": "k20", "kind": "cosmetic-edit", "why": "An inline // ms comment moves to its own line above; both the value fact and the unit fact still hold.", writes: [
    {"id": "k20-w1", "agent": "wren", "day": 2, "subject": "tracking-page", "slot": "refresh", "text": "The tracking page polls for updates every 30 seconds.", "source": {"kind": "file", "locator": "web/src/config.ts:3", "quote": "export const POLL_INTERVAL = 30_000;"}, "supersedes": []},
    {"id": "k20-w2", "agent": "scout", "day": 3, "subject": "config", "slot": "poll-unit", "text": "POLL_INTERVAL in web/src/config.ts is in milliseconds, per its comment.", "source": {"kind": "file", "locator": "web/src/config.ts:3", "quote": "POLL_INTERVAL = 30_000; // ms"}, "supersedes": []},
    {"id": "k20-w3", "agent": "atlas", "day": 3, "subject": "web", "slot": "bundler", "text": "The web app is built with Vite.", "source": {"kind": "file", "locator": "web/package.json:7", "quote": "\"build\": \"vite build\""}, "supersedes": []},
  ],
  codeChanges: [{"day": 5, "locator": "web/src/config.ts:3", "before": "export const POLL_INTERVAL = 30_000; // ms", "after": "export const POLL_INTERVAL = 30_000;", "breaksFact": []}, {"day": 5, "locator": "web/src/config.ts:2", "before": "", "after": "// ms", "breaksFact": []}],
  questions: [
    {"query": "how often does the tracking screen refresh?", "day": 7, "expect": {"anyOf": [["k20-w1"]], "forbidden": [], "duplicates": [], "contradiction": false}},
    {"query": "is POLL_INTERVAL seconds or ms?", "day": 7, "expect": {"anyOf": [["k20-w2"]], "forbidden": [], "duplicates": [], "contradiction": false}},
  ] },
  { "id": "k21", "kind": "cosmetic-edit", "why": "A /* */ comment is removed: a fact about the value survives, a fact about the comment's provenance breaks; later the value itself changes.", writes: [
    {"id": "k21-w1", "agent": "atlas", "day": 2, "subject": "solver", "slot": "max-iterations", "text": "The route solver caps iterations at 500.", "source": {"kind": "file", "locator": "internal/routing/solver.go:21", "quote": "maxIter := 500"}, "supersedes": []},
    {"id": "k21-w2", "agent": "ferry", "day": 3, "subject": "solver", "slot": "tuning", "text": "The solver iteration cap was tuned on March data, per the code comment.", "source": {"kind": "file", "locator": "internal/routing/solver.go:21", "quote": "/* tuned on March data */"}, "supersedes": []},
    {"id": "k21-w3", "agent": "scout", "day": 15, "subject": "route-solver", "slot": "iter-cap", "text": "Solver max iterations were raised to 2000.", "source": {"kind": "file", "locator": "internal/routing/solver.go:21", "quote": "maxIter := 2000"}, "supersedes": []},
  ],
  codeChanges: [{"day": 8, "locator": "internal/routing/solver.go:21", "before": "\tmaxIter := 500 /* tuned on March data */", "after": "\tmaxIter := 500", "breaksFact": ["k21-w2"]}, {"day": 14, "locator": "internal/routing/solver.go:21", "before": "\tmaxIter := 500", "after": "\tmaxIter := 2000", "breaksFact": ["k21-w1"]}],
  questions: [
    {"query": "what's the iteration limit on the route optimizer?", "day": 10, "expect": {"anyOf": [["k21-w1"]], "forbidden": ["k21-w2"], "duplicates": [], "contradiction": false}},
    {"query": "what's the iteration limit on the route optimizer?", "day": 16, "expect": {"anyOf": [["k21-w3"]], "forbidden": ["k21-w1", "k21-w2"], "duplicates": [], "contradiction": false}},
  ] },
  { "id": "k22", "kind": "cosmetic-edit", "why": "GitHub Actions YAML re-indented around go-version (cosmetic); node-version bumped (breaks).", writes: [
    {"id": "k22-w1", "agent": "wren", "day": 2, "subject": "ci", "slot": "go-version", "text": "CI installs Go 1.22.", "source": {"kind": "file", "locator": ".github/workflows/ci.yml:15", "quote": "go-version: '1.22'"}, "supersedes": []},
    {"id": "k22-w2", "agent": "ferry", "day": 2, "subject": "ci", "slot": "node-version", "text": "CI runs the web suite on Node 20.", "source": {"kind": "file", "locator": ".github/workflows/ci.yml:19", "quote": "node-version: 20"}, "supersedes": []},
    {"id": "k22-w3", "agent": "scout", "day": 4, "subject": "github-actions", "slot": "toolchain", "text": "setup-go in the CI workflow pins Go 1.22.", "source": {"kind": "file", "locator": ".github/workflows/ci.yml:15", "quote": "go-version: '1.22'"}, "supersedes": []},
  ],
  codeChanges: [{"day": 6, "locator": ".github/workflows/ci.yml:15", "before": "      go-version: '1.22'", "after": "          go-version: '1.22'", "breaksFact": []}, {"day": 6, "locator": ".github/workflows/ci.yml:19", "before": "      node-version: 20", "after": "          node-version: 22", "breaksFact": ["k22-w2"]}],
  questions: [
    {"query": "which Go version does the pipeline set up?", "day": 8, "expect": {"anyOf": [["k22-w1", "k22-w3"]], "forbidden": ["k22-w2"], "duplicates": [["k22-w1", "k22-w3"]], "contradiction": false}},
    {"query": "what Node does CI use for the frontend tests?", "day": 8, "expect": {"anyOf": [], "forbidden": ["k22-w2"], "duplicates": [], "contradiction": false}},
  ] },
  { "id": "k23", "kind": "cosmetic-edit", "why": "Trailing tab stripped on one constant (cosmetic); the neighbouring constant is deleted (breaks).", writes: [
    {"id": "k23-w1", "agent": "atlas", "day": 3, "subject": "batch-api", "slot": "max-items", "text": "Batch shipment create accepts up to 250 items per request.", "source": {"kind": "file", "locator": "internal/api/limits.go:8", "quote": "MaxBatchSize = 250"}, "supersedes": []},
    {"id": "k23-w2", "agent": "scout", "day": 4, "subject": "limits", "slot": "batch", "text": "POST /v1/shipments:batch is limited to 250 shipments.", "source": {"kind": "file", "locator": "internal/api/limits.go:8", "quote": "\tMaxBatchSize = 250\t"}, "supersedes": []},
    {"id": "k23-w3", "agent": "ferry", "day": 4, "subject": "labels", "slot": "max-pages", "text": "Generated label PDFs are capped at 20 pages.", "source": {"kind": "file", "locator": "internal/api/limits.go:9", "quote": "MaxLabelPages = 20"}, "supersedes": []},
    {"id": "k23-w4", "agent": "wren", "day": 4, "subject": "web", "slot": "cors", "text": "The API only allows CORS from the app.kestrel.dev origin in prod.", "source": {"kind": "file", "locator": "internal/api/cors.go:5", "quote": "\"https://app.kestrel.dev\""}, "supersedes": []},
  ],
  codeChanges: [{"day": 6, "locator": "internal/api/limits.go:8", "before": "\tMaxBatchSize = 250\t", "after": "\tMaxBatchSize = 250", "breaksFact": []}, {"day": 6, "locator": "internal/api/limits.go:9", "before": "\tMaxLabelPages = 20", "after": "", "breaksFact": ["k23-w3"]}],
  questions: [
    {"query": "how many shipments can I send in one batch call?", "day": 8, "expect": {"anyOf": [["k23-w1", "k23-w2"]], "forbidden": ["k23-w3"], "duplicates": [["k23-w1", "k23-w2"]], "contradiction": false}},
    {"query": "is there a page limit on label PDFs?", "day": 8, "expect": {"anyOf": [], "forbidden": ["k23-w3"], "duplicates": [], "contradiction": false}},
  ] },
  { "id": "k24", "kind": "cosmetic-edit", "why": "SQL comment reworded with same meaning (fact about the comment survives); a @deprecated note's version changes (fact about it breaks).", writes: [
    {"id": "k24-w1", "agent": "wren", "day": 2, "subject": "shipments", "slot": "indexes", "text": "There is an index on shipments.carrier_id.", "source": {"kind": "file", "locator": "migrations/0011_idx.sql:3", "quote": "CREATE INDEX idx_shipments_carrier ON shipments(carrier_id);"}, "supersedes": []},
    {"id": "k24-w2", "agent": "atlas", "day": 3, "subject": "idx_shipments_carrier", "slot": "reason", "text": "idx_shipments_carrier exists because the carrier dashboard query needs it, per the migration comment.", "source": {"kind": "file", "locator": "migrations/0011_idx.sql:3", "quote": "-- needed for carrier dashboard"}, "supersedes": []},
    {"id": "k24-w3", "agent": "ferry", "day": 3, "subject": "legacy-export", "slot": "removal", "text": "The legacy CSV export is slated for removal after the v2 launch.", "source": {"kind": "file", "locator": "web/src/legacy/export.ts:1", "quote": "// @deprecated remove after v2 launch"}, "supersedes": []},
  ],
  codeChanges: [{"day": 6, "locator": "migrations/0011_idx.sql:3", "before": "CREATE INDEX idx_shipments_carrier ON shipments(carrier_id); -- needed for carrier dashboard", "after": "CREATE INDEX idx_shipments_carrier ON shipments (carrier_id); -- carrier dashboard query relies on this", "breaksFact": []}, {"day": 6, "locator": "web/src/legacy/export.ts:1", "before": "// @deprecated remove after v2 launch", "after": "// @deprecated remove after v3 launch", "breaksFact": ["k24-w3"]}],
  questions: [
    {"query": "why do we have an index on carrier_id?", "day": 8, "expect": {"anyOf": [["k24-w2"]], "forbidden": ["k24-w3"], "duplicates": [], "contradiction": false}},
    {"query": "when is the old CSV export going away?", "day": 8, "expect": {"anyOf": [], "forbidden": ["k24-w3"], "duplicates": [], "contradiction": false}},
  ] },
] as MemoryBenchmarkAgentScenario[]);
/** Set W4 (fictional "quarry" pipeline): written by the same separate agent, scored only after the W3 fixes were frozen. */
export const MEMORY_BENCHMARK_AGENT_WRITES_SCREENING_VALIDATION: readonly MemoryBenchmarkAgentScenario[] = Object.freeze([
  { "id": "q1", "kind": "secret-write", "why": "A pyarrow traceback pasted as the quote exposes a personal home path; the symptom is only recorded in that write, the guard is recorded cleanly elsewhere.", writes: [
    {"id": "q1-w1", "agent": "miner", "day": 3, "subject": "ingest", "slot": "vendor-parquet", "text": "Truncated parquet files in the vendor drop make ingest fail with ArrowInvalid: Parquet magic bytes not found.", "source": {"kind": "command-output", "locator": "python -m quarry.ingest --date 2026-08-11", "quote": "File \"{{home:/projects/quarry/.venv/lib/python3.12/site-packages/pyarrow/parquet/core.py}}\", line 1776\npyarrow.lib.ArrowInvalid: Parquet magic bytes not found in footer"}, "supersedes": []},
    {"id": "q1-w2", "agent": "sable", "day": 5, "subject": "reader", "slot": "size-guard", "text": "quarry/ingest/reader.py skips any file under 12 bytes before calling pq.read_table.", "source": {"kind": "file", "locator": "quarry/ingest/reader.py:41", "quote": "if path.stat().st_size < 12:"}, "supersedes": []},
    {"id": "q1-w3", "agent": "otto", "day": 5, "subject": "rust", "slot": "polars", "text": "The Rust crates pin polars 0.41.", "source": {"kind": "file", "locator": "crates/scanner/Cargo.toml:14", "quote": "polars = { version = \"0.41\""}, "supersedes": []},
  ],
  questions: [
    {"query": "what does ingest throw when a vendor parquet file is cut off?", "day": 7, "expect": {"anyOf": [], "forbidden": ["q1-w1"], "duplicates": [], "contradiction": false}},
    {"query": "does the reader protect against tiny or empty input files?", "day": 7, "expect": {"anyOf": [["q1-w2"]], "forbidden": ["q1-w1"], "duplicates": [], "contradiction": false}},
    {"query": "which polars version are the Rust crates on?", "day": 7, "expect": {"anyOf": [["q1-w3"]], "forbidden": ["q1-w1"], "duplicates": [], "contradiction": false}},
  ] },
  { "id": "q2", "kind": "secret-write", "why": "Agent cats the AWS credentials file to find the profile name and quotes the key line.", writes: [
    {"id": "q2-w1", "agent": "drift", "day": 2, "subject": "aws", "slot": "profile", "text": "Local pipeline runs use the quarry-dev AWS profile.", "source": {"kind": "command-output", "locator": "cat ~/.aws/credentials", "quote": "[quarry-dev]\naws_access_key_id = {{secret:aws-access-key}}"}, "supersedes": []},
    {"id": "q2-w2", "agent": "lumen", "day": 3, "subject": "landing", "slot": "layout", "text": "The raw landing bucket is s3://quarry-raw-landing, partitioned by dt=YYYY-MM-DD.", "source": {"kind": "file", "locator": "quarry/ingest/paths.py:8", "quote": "RAW_PREFIX = \"s3://quarry-raw-landing/dt={dt:%Y-%m-%d}/\""}, "supersedes": []},
    {"id": "q2-w3", "agent": "otto", "day": 3, "subject": "makefile", "slot": "aws-profile", "text": "The Makefile exports AWS_PROFILE=quarry-dev for local targets.", "source": {"kind": "file", "locator": "Makefile:4", "quote": "export AWS_PROFILE=quarry-dev"}, "supersedes": []},
  ],
  questions: [
    {"query": "which AWS profile should my local run pick up?", "day": 5, "expect": {"anyOf": [["q2-w3"]], "forbidden": ["q2-w1"], "duplicates": [], "contradiction": false}},
    {"query": "how are raw files laid out in the landing bucket?", "day": 5, "expect": {"anyOf": [["q2-w2"]], "forbidden": ["q2-w1"], "duplicates": [], "contradiction": false}},
  ] },
  { "id": "q3", "kind": "secret-write", "why": "A pseudonymisation salt is written into the fact text; a clean write describes the mechanism without the value.", writes: [
    {"id": "q3-w1", "agent": "sable", "day": 4, "subject": "pii", "slot": "salt", "text": "The prod row-hash salt for PII pseudonymisation is {{secret:hex64}}, from settings_prod.py.", "source": {"kind": "file", "locator": "quarry/settings_prod.py:31", "quote": "PII_SALT = \"{{secret:hex64}}\""}, "supersedes": []},
    {"id": "q3-w2", "agent": "miner", "day": 5, "subject": "transform", "slot": "email-hashing", "text": "Emails are pseudonymised with HMAC-SHA256 keyed by PII_SALT from the secret manager (quarry/transform/pii.py).", "source": {"kind": "file", "locator": "quarry/transform/pii.py:12", "quote": "hmac.new(salt, email.lower().encode(), hashlib.sha256)"}, "supersedes": []},
    {"id": "q3-w3", "agent": "drift", "day": 5, "subject": "pii", "slot": "rotation", "text": "Rotating the PII salt requires a full backfill of user_dim.", "source": {"kind": "chat", "locator": "#quarry-data 2026-08-20", "quote": "if we ever rotate the salt we have to rebuild user_dim from scratch"}, "supersedes": []},
  ],
  questions: [
    {"query": "how do we anonymise email addresses?", "day": 7, "expect": {"anyOf": [["q3-w2"]], "forbidden": ["q3-w1"], "duplicates": [], "contradiction": false}},
    {"query": "what's the current salt value in prod?", "day": 7, "expect": {"anyOf": [], "forbidden": ["q3-w1"], "duplicates": [], "contradiction": false}},
    {"query": "what happens downstream if we rotate the hashing salt?", "day": 7, "expect": {"anyOf": [["q3-w3"]], "forbidden": ["q3-w1"], "duplicates": [], "contradiction": false}},
  ] },
  { "id": "q4", "kind": "secret-write", "why": "A secret-bearing write supersedes a clean warehouse fact (changed target); a later clean write restates the new target without linking.", writes: [
    {"id": "q4-w1", "agent": "miner", "day": 2, "subject": "warehouse", "slot": "target", "text": "The loader writes to Postgres 15 at warehouse.quarry.internal:5432, database analytics.", "source": {"kind": "file", "locator": "quarry/load/sink.py:9", "quote": "engine = create_engine(settings.WAREHOUSE_URL)"}, "supersedes": []},
    {"id": "q4-w2", "agent": "sable", "day": 8, "subject": "warehouse", "slot": "target", "text": "Warehouse moved to ClickHouse; the loader DSN is clickhouse://loader:{{secret:url-password}}@ch.quarry.internal:8443/analytics.", "source": {"kind": "command-output", "locator": "printenv WAREHOUSE_URL", "quote": "clickhouse://loader:{{secret:url-password}}@ch.quarry.internal:8443/analytics"}, "supersedes": ["q4-w1"]},
    {"id": "q4-w3", "agent": "otto", "day": 9, "subject": "sink", "slot": "client", "text": "quarry/load/sink.py now builds a clickhouse_connect client against ch.quarry.internal on port 8443.", "source": {"kind": "file", "locator": "quarry/load/sink.py:9", "quote": "host=\"ch.quarry.internal\", port=8443"}, "supersedes": []},
    {"id": "q4-w4", "agent": "lumen", "day": 9, "subject": "load", "slot": "batching", "text": "Loader inserts in batches of 50k rows.", "source": {"kind": "file", "locator": "quarry/load/sink.py:14", "quote": "INSERT_BATCH = 50_000"}, "supersedes": []},
  ],
  questions: [
    {"query": "where does the load step write data these days?", "day": 11, "expect": {"anyOf": [["q4-w3"]], "forbidden": ["q4-w1", "q4-w2"], "duplicates": [], "contradiction": false}},
    {"query": "how many rows go into each insert?", "day": 11, "expect": {"anyOf": [["q4-w4"]], "forbidden": ["q4-w2"], "duplicates": [], "contradiction": false}},
  ] },
  { "id": "q5", "kind": "secret-write", "why": "A clean write supersedes an earlier write that pasted a registry token from .cargo/config.toml.", writes: [
    {"id": "q5-w1", "agent": "lumen", "day": 3, "subject": "cargo", "slot": "registry-auth", "text": "The scanner authenticates to the private cargo registry with token {{secret:github-token}} in .cargo/config.toml.", "source": {"kind": "file", "locator": ".cargo/config.toml:6", "quote": "token = \"{{secret:github-token}}\""}, "supersedes": []},
    {"id": "q5-w2", "agent": "otto", "day": 6, "subject": "cargo", "slot": "registry-auth", "text": "Private registry auth now comes from CARGO_REGISTRIES_QUARRY_TOKEN via cargo:token credential provider; .cargo/config.toml holds no token.", "source": {"kind": "file", "locator": ".cargo/config.toml:6", "quote": "credential-provider = [\"cargo:token\"]"}, "supersedes": ["q5-w1"]},
    {"id": "q5-w3", "agent": "drift", "day": 6, "subject": "scanner", "slot": "msrv", "text": "The scanner crate's minimum supported Rust version is 1.78.", "source": {"kind": "file", "locator": "crates/scanner/Cargo.toml:5", "quote": "rust-version = \"1.78\""}, "supersedes": []},
  ],
  questions: [
    {"query": "how does cargo log in to our private registry?", "day": 8, "expect": {"anyOf": [["q5-w2"]], "forbidden": ["q5-w1"], "duplicates": [], "contradiction": false}},
    {"query": "oldest rustc that can build the scanner?", "day": 8, "expect": {"anyOf": [["q5-w3"]], "forbidden": ["q5-w1"], "duplicates": [], "contradiction": false}},
  ] },
  { "id": "q6", "kind": "secret-write", "why": "Verbose curl output with a bearer JWT is pasted while debugging a 403; diagnosis and token lifetime are recorded cleanly by others.", writes: [
    {"id": "q6-w1", "agent": "drift", "day": 4, "subject": "catalog", "slot": "403", "text": "The metadata API returns 403 for dataset orders_v2 even with a valid token.", "source": {"kind": "command-output", "locator": "curl -v https://catalog.quarry.internal/v1/datasets/orders_v2", "quote": "> Authorization: Bearer {{secret:jwt}}\n< HTTP/1.1 403 Forbidden"}, "supersedes": []},
    {"id": "q6-w2", "agent": "miner", "day": 5, "subject": "metadata-api", "slot": "permissions", "text": "Metadata API 403s mean the service account lacks the dataset:read scope; a catalog admin has to grant it.", "source": {"kind": "chat", "locator": "#data-platform 2026-08-24", "quote": "403 there is always missing dataset:read on the SA"}, "supersedes": []},
    {"id": "q6-w3", "agent": "sable", "day": 5, "subject": "catalog", "slot": "token-ttl", "text": "Catalog API tokens are short-lived (1 hour) and are fetched by quarry/catalog/auth.py.", "source": {"kind": "file", "locator": "quarry/catalog/auth.py:20", "quote": "TOKEN_TTL_S = 3600"}, "supersedes": []},
  ],
  questions: [
    {"query": "getting forbidden from the catalog service on one dataset, why?", "day": 7, "expect": {"anyOf": [["q6-w2"]], "forbidden": ["q6-w1"], "duplicates": [], "contradiction": false}},
    {"query": "how long is a catalog token good for?", "day": 7, "expect": {"anyOf": [["q6-w3"]], "forbidden": ["q6-w1"], "duplicates": [], "contradiction": false}},
  ] },
  { "id": "q7", "kind": "secret-write", "why": "Agent notes a notebook sets an OpenAI key inline and quotes the cell; clean writes cover the embedding model and secret scanning.", writes: [
    {"id": "q7-w1", "agent": "sable", "day": 5, "subject": "notebooks", "slot": "embeddings", "text": "notebooks/explore_embeddings.ipynb sets openai.api_key inline in cell 3.", "source": {"kind": "file", "locator": "notebooks/explore_embeddings.ipynb:cell3", "quote": "openai.api_key = \"{{secret:openai-key}}\""}, "supersedes": []},
    {"id": "q7-w2", "agent": "lumen", "day": 5, "subject": "enrich", "slot": "embedding-model", "text": "The enrichment job embeds with text-embedding-3-small in batches of 512.", "source": {"kind": "file", "locator": "quarry/enrich/embed.py:17", "quote": "MODEL = \"text-embedding-3-small\""}, "supersedes": []},
    {"id": "q7-w3", "agent": "otto", "day": 6, "subject": "pre-commit", "slot": "notebooks", "text": "pre-commit runs nbstripout and detect-secrets over notebooks.", "source": {"kind": "file", "locator": ".pre-commit-config.yaml:12", "quote": "- id: detect-secrets"}, "supersedes": []},
  ],
  questions: [
    {"query": "which embedding model does enrichment call?", "day": 8, "expect": {"anyOf": [["q7-w2"]], "forbidden": ["q7-w1"], "duplicates": [], "contradiction": false}},
    {"query": "do notebooks get scanned for leaked credentials before commit?", "day": 8, "expect": {"anyOf": [["q7-w3"]], "forbidden": ["q7-w1"], "duplicates": [], "contradiction": false}},
  ] },
  { "id": "q8", "kind": "secret-write", "why": "A Rust panic message with a home-directory path is quoted; another agent explains the same crash from the source line.", writes: [
    {"id": "q8-w1", "agent": "otto", "day": 6, "subject": "dedupe", "slot": "crash", "text": "dedupe panics with capacity overflow when the bloom filter is sized from an unbounded row estimate.", "source": {"kind": "command-output", "locator": "cargo run -p dedupe --release -- --input s3://quarry-raw-landing/dt=2026-09-01/", "quote": "thread 'main' panicked at {{home:/src/quarry/crates/dedupe/src/bloom.rs}}:88:14:\ncapacity overflow"}, "supersedes": []},
    {"id": "q8-w2", "agent": "miner", "day": 7, "subject": "bloom", "slot": "sizing", "text": "crates/dedupe/src/bloom.rs sizes the filter as estimated_rows * 10 bits with no clamp, which overflows on huge estimates.", "source": {"kind": "file", "locator": "crates/dedupe/src/bloom.rs:88", "quote": "let bits = estimated_rows * 10;"}, "supersedes": []},
    {"id": "q8-w3", "agent": "drift", "day": 7, "subject": "ci", "slot": "rust", "text": "CI runs cargo test with --locked on the workspace.", "source": {"kind": "file", "locator": ".github/workflows/rust.yml:28", "quote": "cargo test --workspace --locked"}, "supersedes": []},
  ],
  questions: [
    {"query": "why does the dedupe binary crash on big partitions?", "day": 9, "expect": {"anyOf": [["q8-w2"]], "forbidden": ["q8-w1"], "duplicates": [], "contradiction": false}},
    {"query": "does CI enforce the lockfile for Rust?", "day": 9, "expect": {"anyOf": [["q8-w3"]], "forbidden": ["q8-w1"], "duplicates": [], "contradiction": false}},
  ] },
  { "id": "q9", "kind": "secret-write", "why": "Agent records adding an SFTP key and quotes the whole PEM; clean writes give the schedule and how the key is mounted.", writes: [
    {"id": "q9-w1", "agent": "lumen", "day": 3, "subject": "sftp", "slot": "acme-key", "text": "Added the acme-feeds vendor SFTP private key at config/sftp/acme.pem.", "source": {"kind": "file", "locator": "config/sftp/acme.pem:1", "quote": "{{secret:private-key}}"}, "supersedes": []},
    {"id": "q9-w2", "agent": "drift", "day": 4, "subject": "acme-feeds", "slot": "schedule", "text": "acme-feeds drops files daily at 02:00 UTC into /outbound/quarry/.", "source": {"kind": "chat", "locator": "vendor onboarding email", "quote": "files are published 02:00 UTC daily to /outbound/quarry/"}, "supersedes": []},
    {"id": "q9-w3", "agent": "miner", "day": 4, "subject": "sftp-fetcher", "slot": "key-source", "text": "The SFTP fetcher reads its key path from SFTP_KEY_PATH, mounted from the secrets volume.", "source": {"kind": "file", "locator": "quarry/ingest/sftp.py:15", "quote": "key_path = os.environ[\"SFTP_KEY_PATH\"]"}, "supersedes": []},
  ],
  questions: [
    {"query": "when does the acme vendor feed show up?", "day": 6, "expect": {"anyOf": [["q9-w2"]], "forbidden": ["q9-w1"], "duplicates": [], "contradiction": false}},
    {"query": "where does the sftp fetcher get its credentials?", "day": 6, "expect": {"anyOf": [["q9-w3"]], "forbidden": ["q9-w1"], "duplicates": [], "contradiction": false}},
  ] },
  { "id": "q10", "kind": "secret-write", "why": "One agent writes an Anthropic key into setup instructions; two other agents write the same instruction cleanly.", writes: [
    {"id": "q10-w1", "agent": "otto", "day": 4, "subject": "classify", "slot": "setup", "text": "Before make classify, put ANTHROPIC_API_KEY={{secret:anthropic-key}} in .env.", "source": {"kind": "file", "locator": ".env:7", "quote": "ANTHROPIC_API_KEY={{secret:anthropic-key}}"}, "supersedes": []},
    {"id": "q10-w2", "agent": "sable", "day": 4, "subject": "make-classify", "slot": "prereqs", "text": "make classify needs ANTHROPIC_API_KEY in the environment; get it from the 1Password vault quarry-ml.", "source": {"kind": "file", "locator": "docs/runbook.md:44", "quote": "export ANTHROPIC_API_KEY from 1Password (vault: quarry-ml)"}, "supersedes": []},
    {"id": "q10-w3", "agent": "drift", "day": 5, "subject": "classifier", "slot": "env", "text": "The classify target fails fast unless ANTHROPIC_API_KEY is exported from the team vault.", "source": {"kind": "file", "locator": "quarry/classify/run.py:10", "quote": "api_key = os.environ[\"ANTHROPIC_API_KEY\"]"}, "supersedes": []},
    {"id": "q10-w4", "agent": "miner", "day": 5, "subject": "classifier", "slot": "labels", "text": "Classifier assigns one of 14 product categories defined in quarry/classify/labels.yaml.", "source": {"kind": "file", "locator": "quarry/classify/labels.yaml:1", "quote": "categories:"}, "supersedes": []},
  ],
  questions: [
    {"query": "what do I need configured to run the classification step?", "day": 7, "expect": {"anyOf": [["q10-w2", "q10-w3"]], "forbidden": ["q10-w1"], "duplicates": [["q10-w2", "q10-w3"]], "contradiction": false}},
    {"query": "where are the product categories for the classifier defined?", "day": 7, "expect": {"anyOf": [["q10-w4"]], "forbidden": ["q10-w1"], "duplicates": [], "contradiction": false}},
  ] },
  { "id": "q11", "kind": "secret-write", "why": "A Slack bot token goes into fact text; clean writes give the channel and the rotation policy without a value.", writes: [
    {"id": "q11-w1", "agent": "miner", "day": 3, "subject": "alerts", "slot": "slack", "text": "Pipeline failure alerts use bot token {{secret:slack-token}} to post into #quarry-oncall.", "source": {"kind": "inference", "locator": "quarry/alerts/slack.py", "quote": "client = WebClient(token=settings.SLACK_TOKEN)"}, "supersedes": []},
    {"id": "q11-w2", "agent": "lumen", "day": 3, "subject": "alerting", "slot": "channel", "text": "Failure alerts go to #quarry-oncall, configured in alerts.toml.", "source": {"kind": "file", "locator": "alerts.toml:2", "quote": "channel = \"#quarry-oncall\""}, "supersedes": []},
    {"id": "q11-w3", "agent": "sable", "day": 4, "subject": "slack-bot", "slot": "rotation", "text": "The platform team rotates the Slack bot token every 90 days.", "source": {"kind": "chat", "locator": "#platform 2026-08-14", "quote": "slack bot tokens rotate every 90d, don't cache them"}, "supersedes": []},
  ],
  questions: [
    {"query": "where do failed pipeline runs get announced?", "day": 6, "expect": {"anyOf": [["q11-w2"]], "forbidden": ["q11-w1"], "duplicates": [], "contradiction": false}},
    {"query": "how often does the slack credential change?", "day": 6, "expect": {"anyOf": [["q11-w3"]], "forbidden": ["q11-w1"], "duplicates": [], "contradiction": false}},
  ] },
  { "id": "q12", "kind": "secret-write", "why": "alembic.ini line with an embedded password is quoted; a later clean write by the same agent supersedes it after the URL moved to an env var.", writes: [
    {"id": "q12-w1", "agent": "lumen", "day": 2, "subject": "alembic", "slot": "db-url", "text": "Alembic migrations target the staging database by default via alembic.ini.", "source": {"kind": "file", "locator": "alembic.ini:9", "quote": "sqlalchemy.url = postgresql://migrator:{{secret:url-password}}@staging-db:5432/quarry"}, "supersedes": []},
    {"id": "q12-w2", "agent": "lumen", "day": 7, "subject": "alembic", "slot": "db-url", "text": "migrations/env.py reads the database URL from QUARRY_DB_URL; alembic.ini no longer has a default URL.", "source": {"kind": "file", "locator": "migrations/env.py:18", "quote": "url = os.environ[\"QUARRY_DB_URL\"]"}, "supersedes": ["q12-w1"]},
    {"id": "q12-w3", "agent": "drift", "day": 7, "subject": "retention", "slot": "partitions", "text": "The retention job drops partitions older than 400 days.", "source": {"kind": "file", "locator": "quarry/maintenance/retention.py:6", "quote": "KEEP_DAYS = 400"}, "supersedes": []},
  ],
  questions: [
    {"query": "where does alembic get its connection string from?", "day": 9, "expect": {"anyOf": [["q12-w2"]], "forbidden": ["q12-w1"], "duplicates": [], "contradiction": false}},
    {"query": "how long do we keep old partitions around?", "day": 9, "expect": {"anyOf": [["q12-w3"]], "forbidden": ["q12-w1"], "duplicates": [], "contradiction": false}},
  ] },
  { "id": "q13", "kind": "cosmetic-edit", "why": "Python assignment gets spaces around = and a trailing # comment; two duplicate facts survive.", writes: [
    {"id": "q13-w1", "agent": "miner", "day": 2, "subject": "ingest", "slot": "batch-size", "text": "Ingest reads in batches of 10,000 rows.", "source": {"kind": "file", "locator": "quarry/config.py:12", "quote": "BATCH_SIZE=10_000"}, "supersedes": []},
    {"id": "q13-w2", "agent": "sable", "day": 3, "subject": "arrow", "slot": "record-batch", "text": "Arrow record batches are 10k rows each.", "source": {"kind": "file", "locator": "quarry/config.py:12", "quote": "BATCH_SIZE=10_000"}, "supersedes": []},
    {"id": "q13-w3", "agent": "drift", "day": 3, "subject": "logging", "slot": "format", "text": "Python services log JSON via structlog.", "source": {"kind": "file", "locator": "quarry/log.py:5", "quote": "structlog.processors.JSONRenderer()"}, "supersedes": []},
  ],
  codeChanges: [{"day": 5, "locator": "quarry/config.py:12", "before": "BATCH_SIZE=10_000", "after": "BATCH_SIZE = 10_000  # rows per arrow batch", "breaksFact": []}],
  questions: [
    {"query": "how many rows does each ingest batch hold?", "day": 7, "expect": {"anyOf": [["q13-w1", "q13-w2"]], "forbidden": [], "duplicates": [["q13-w1", "q13-w2"]], "contradiction": false}},
  ] },
  { "id": "q14", "kind": "cosmetic-edit", "why": "Rust: a constant's value changes (breaks), a neighbouring const's trailing comment is re-spaced and strengthened without changing meaning; one fact is about that comment.", writes: [
    {"id": "q14-w1", "agent": "otto", "day": 2, "subject": "dedupe", "slot": "fp-rate", "text": "The dedupe bloom filter targets a 1% false positive rate.", "source": {"kind": "file", "locator": "crates/dedupe/src/lib.rs:5", "quote": "pub const FALSE_POSITIVE_RATE: f64 = 0.01;"}, "supersedes": []},
    {"id": "q14-w2", "agent": "lumen", "day": 3, "subject": "dedupe", "slot": "shards", "text": "dedupe splits work across 64 shards.", "source": {"kind": "file", "locator": "crates/dedupe/src/lib.rs:6", "quote": "pub const SHARDS: usize = 64;"}, "supersedes": []},
    {"id": "q14-w3", "agent": "miner", "day": 3, "subject": "shards", "slot": "constraint", "text": "SHARDS has to be a power of two, per its comment.", "source": {"kind": "file", "locator": "crates/dedupe/src/lib.rs:6", "quote": "// power of two"}, "supersedes": []},
  ],
  codeChanges: [{"day": 6, "locator": "crates/dedupe/src/lib.rs:5", "before": "pub const FALSE_POSITIVE_RATE: f64 = 0.01;", "after": "pub const FALSE_POSITIVE_RATE: f64 = 0.001;", "breaksFact": ["q14-w1"]}, {"day": 6, "locator": "crates/dedupe/src/lib.rs:6", "before": "pub const SHARDS: usize = 64; // power of two", "after": "pub const SHARDS: usize = 64;    // must be a power of two", "breaksFact": []}],
  questions: [
    {"query": "what false-positive rate is dedupe tuned for?", "day": 8, "expect": {"anyOf": [], "forbidden": ["q14-w1"], "duplicates": [], "contradiction": false}},
    {"query": "how many shards does dedupe use and can I set it to 48?", "day": 8, "expect": {"anyOf": [["q14-w2"], ["q14-w3"]], "forbidden": ["q14-w1"], "duplicates": [], "contradiction": false}},
  ] },
  { "id": "q15", "kind": "cosmetic-edit", "why": "Schedule YAML gets padding and a # UTC comment (cosmetic), later the cron actually moves.", writes: [
    {"id": "q15-w1", "agent": "drift", "day": 2, "subject": "schedule", "slot": "nightly", "text": "The nightly pipeline run starts at 03:00 UTC.", "source": {"kind": "file", "locator": "pipelines/schedules.yaml:8", "quote": "cron: \"0 3 * * *\""}, "supersedes": []},
    {"id": "q15-w2", "agent": "sable", "day": 13, "subject": "nightly-run", "slot": "start-time", "text": "Nightly run now kicks off at 04:30 UTC, after the vendor drop.", "source": {"kind": "file", "locator": "pipelines/schedules.yaml:8", "quote": "cron: \"30 4 * * *\""}, "supersedes": []},
    {"id": "q15-w3", "agent": "otto", "day": 3, "subject": "schedule", "slot": "weekly", "text": "A weekly compaction job runs Sundays.", "source": {"kind": "file", "locator": "pipelines/schedules.yaml:14", "quote": "cron: \"0 6 * * 0\""}, "supersedes": []},
  ],
  codeChanges: [{"day": 5, "locator": "pipelines/schedules.yaml:8", "before": "    cron: \"0 3 * * *\"", "after": "    cron:  \"0 3 * * *\"   # UTC", "breaksFact": []}, {"day": 12, "locator": "pipelines/schedules.yaml:8", "before": "    cron:  \"0 3 * * *\"   # UTC", "after": "    cron: \"30 4 * * *\"  # UTC, after vendor drop moved", "breaksFact": ["q15-w1"]}],
  questions: [
    {"query": "what time does the nightly job fire?", "day": 9, "expect": {"anyOf": [["q15-w1"]], "forbidden": [], "duplicates": [], "contradiction": false}},
    {"query": "what time does the nightly job fire?", "day": 14, "expect": {"anyOf": [["q15-w2"]], "forbidden": ["q15-w1"], "duplicates": [], "contradiction": false}},
  ] },
  { "id": "q16", "kind": "cosmetic-edit", "why": "A FIXME comment disappears together with the code it described; both the comment fact and the code fact break.", writes: [
    {"id": "q16-w1", "agent": "sable", "day": 2, "subject": "dates", "slot": "fixme", "text": "dates.py has a FIXME noting parse_ts returns naive datetimes.", "source": {"kind": "file", "locator": "quarry/transform/dates.py:22", "quote": "# FIXME: naive datetime"}, "supersedes": []},
    {"id": "q16-w2", "agent": "miner", "day": 3, "subject": "parse_ts", "slot": "impl", "text": "parse_ts uses datetime.utcfromtimestamp.", "source": {"kind": "file", "locator": "quarry/transform/dates.py:22", "quote": "ts = datetime.utcfromtimestamp(raw)"}, "supersedes": []},
    {"id": "q16-w3", "agent": "otto", "day": 3, "subject": "transform", "slot": "currency", "text": "Amounts are normalised to integer cents in quarry/transform/money.py.", "source": {"kind": "file", "locator": "quarry/transform/money.py:9", "quote": "return int(round(value * 100))"}, "supersedes": []},
    {"id": "q16-w4", "agent": "lumen", "day": 12, "subject": "timestamps", "slot": "tz", "text": "parse_ts now returns timezone-aware UTC datetimes.", "source": {"kind": "file", "locator": "quarry/transform/dates.py:22", "quote": "datetime.fromtimestamp(raw, tz=timezone.utc)"}, "supersedes": []},
  ],
  codeChanges: [{"day": 10, "locator": "quarry/transform/dates.py:22", "before": "    ts = datetime.utcfromtimestamp(raw)  # FIXME: naive datetime", "after": "    ts = datetime.fromtimestamp(raw, tz=timezone.utc)", "breaksFact": ["q16-w1", "q16-w2"]}],
  questions: [
    {"query": "are the timestamps from parse_ts tz-aware?", "day": 13, "expect": {"anyOf": [["q16-w4"]], "forbidden": ["q16-w1", "q16-w2"], "duplicates": [], "contradiction": false}},
    {"query": "how are money amounts normalised?", "day": 13, "expect": {"anyOf": [["q16-w3"]], "forbidden": ["q16-w1", "q16-w2"], "duplicates": [], "contradiction": false}},
  ] },
  { "id": "q17", "kind": "cosmetic-edit", "why": "pyproject.toml spacing collapsed (cosmetic); Cargo edition bumped (breaks).", writes: [
    {"id": "q17-w1", "agent": "lumen", "day": 2, "subject": "python", "slot": "version", "text": "The Python package requires Python 3.11 or newer.", "source": {"kind": "file", "locator": "pyproject.toml:14", "quote": "requires-python = \">=3.11\""}, "supersedes": []},
    {"id": "q17-w2", "agent": "otto", "day": 2, "subject": "rust", "slot": "edition", "text": "The Rust workspace uses edition 2021.", "source": {"kind": "file", "locator": "Cargo.toml:9", "quote": "edition = \"2021\""}, "supersedes": []},
    {"id": "q17-w3", "agent": "drift", "day": 3, "subject": "python", "slot": "build-backend", "text": "The Python package builds with hatchling.", "source": {"kind": "file", "locator": "pyproject.toml:3", "quote": "build-backend = \"hatchling.build\""}, "supersedes": []},
  ],
  codeChanges: [{"day": 5, "locator": "pyproject.toml:14", "before": "requires-python = \">=3.11\"", "after": "requires-python=\">=3.11\"", "breaksFact": []}, {"day": 5, "locator": "Cargo.toml:9", "before": "edition = \"2021\"", "after": "edition = \"2024\"", "breaksFact": ["q17-w2"]}],
  questions: [
    {"query": "minimum python I need for quarry?", "day": 7, "expect": {"anyOf": [["q17-w1"]], "forbidden": ["q17-w2"], "duplicates": [], "contradiction": false}},
    {"query": "which Rust edition are the crates on?", "day": 7, "expect": {"anyOf": [], "forbidden": ["q17-w2"], "duplicates": [], "contradiction": false}},
  ] },
  { "id": "q18", "kind": "cosmetic-edit", "why": "SQL view: a -- comment is appended to one predicate (cosmetic), the next predicate flips > to >= (breaks).", writes: [
    {"id": "q18-w1", "agent": "miner", "day": 3, "subject": "daily_orders", "slot": "cancelled", "text": "The daily_orders view excludes cancelled orders.", "source": {"kind": "file", "locator": "sql/views/daily_orders.sql:4", "quote": "WHERE status <> 'cancelled'"}, "supersedes": []},
    {"id": "q18-w2", "agent": "sable", "day": 4, "subject": "reporting", "slot": "order-filter", "text": "Cancelled orders never show up in daily order counts.", "source": {"kind": "file", "locator": "sql/views/daily_orders.sql:4", "quote": "status <> 'cancelled'"}, "supersedes": []},
    {"id": "q18-w3", "agent": "drift", "day": 4, "subject": "daily_orders", "slot": "zero-amount", "text": "Zero-amount orders are filtered out of daily_orders.", "source": {"kind": "file", "locator": "sql/views/daily_orders.sql:5", "quote": "AND amount_cents > 0"}, "supersedes": []},
  ],
  codeChanges: [{"day": 6, "locator": "sql/views/daily_orders.sql:4", "before": "WHERE status <> 'cancelled'", "after": "WHERE status <> 'cancelled'   -- exclude cancellations", "breaksFact": []}, {"day": 6, "locator": "sql/views/daily_orders.sql:5", "before": "  AND amount_cents > 0", "after": "  AND amount_cents >= 0", "breaksFact": ["q18-w3"]}],
  questions: [
    {"query": "does the daily orders view count cancelled orders?", "day": 8, "expect": {"anyOf": [["q18-w1", "q18-w2"]], "forbidden": ["q18-w3"], "duplicates": [["q18-w1", "q18-w2"]], "contradiction": false}},
    {"query": "are free ($0) orders counted in daily_orders?", "day": 8, "expect": {"anyOf": [], "forbidden": ["q18-w3"], "duplicates": [], "contradiction": false}},
  ] },
  { "id": "q19", "kind": "cosmetic-edit", "why": "Shell: trailing comment added to set -euo pipefail (cosmetic); hardcoded parallelism becomes an env default with a new value (breaks).", writes: [
    {"id": "q19-w1", "agent": "otto", "day": 2, "subject": "backfill", "slot": "strict-mode", "text": "scripts/backfill.sh runs under set -euo pipefail.", "source": {"kind": "file", "locator": "scripts/backfill.sh:3", "quote": "set -euo pipefail"}, "supersedes": []},
    {"id": "q19-w2", "agent": "miner", "day": 2, "subject": "backfill", "slot": "parallelism", "text": "Backfill processes 8 days in parallel.", "source": {"kind": "file", "locator": "scripts/backfill.sh:11", "quote": "PARALLEL=8"}, "supersedes": []},
    {"id": "q19-w3", "agent": "lumen", "day": 10, "subject": "backfill.sh", "slot": "concurrency", "text": "Backfill parallelism defaults to 4 and can be overridden with the PARALLEL env var.", "source": {"kind": "file", "locator": "scripts/backfill.sh:11", "quote": "PARALLEL=${PARALLEL:-4}"}, "supersedes": []},
  ],
  codeChanges: [{"day": 7, "locator": "scripts/backfill.sh:3", "before": "set -euo pipefail", "after": "set -euo pipefail  # fail fast", "breaksFact": []}, {"day": 8, "locator": "scripts/backfill.sh:11", "before": "PARALLEL=8", "after": "PARALLEL=${PARALLEL:-4}", "breaksFact": ["q19-w2"]}],
  questions: [
    {"query": "how many days does a backfill chew on at once by default?", "day": 11, "expect": {"anyOf": [["q19-w3"]], "forbidden": ["q19-w2"], "duplicates": [], "contradiction": false}},
    {"query": "will the backfill script stop on the first failing command?", "day": 11, "expect": {"anyOf": [["q19-w1"]], "forbidden": ["q19-w2"], "duplicates": [], "contradiction": false}},
  ] },
  { "id": "q20", "kind": "cosmetic-edit", "why": "rustfmt-style churn: spaces added inside call parentheses only.", writes: [
    {"id": "q20-w1", "agent": "otto", "day": 3, "subject": "scanner", "slot": "threads", "text": "The scanner's thread pool is sized to the CPU count.", "source": {"kind": "file", "locator": "crates/scanner/src/main.rs:40", "quote": "let pool = ThreadPool::new(num_cpus::get());"}, "supersedes": []},
    {"id": "q20-w2", "agent": "drift", "day": 3, "subject": "scanner", "slot": "output", "text": "Scanner writes its findings as newline-delimited JSON to stdout.", "source": {"kind": "file", "locator": "crates/scanner/src/main.rs:61", "quote": "serde_json::to_writer(&mut out, &finding)?;"}, "supersedes": []},
    {"id": "q20-w3", "agent": "sable", "day": 4, "subject": "ingest", "slot": "compression", "text": "Vendor CSVs arrive gzip-compressed.", "source": {"kind": "chat", "locator": "vendor onboarding email", "quote": "all CSVs are .csv.gz"}, "supersedes": []},
  ],
  codeChanges: [{"day": 6, "locator": "crates/scanner/src/main.rs:40", "before": "    let pool = ThreadPool::new(num_cpus::get());", "after": "    let pool = ThreadPool::new( num_cpus::get() );", "breaksFact": []}],
  questions: [
    {"query": "how many worker threads does the scanner spin up?", "day": 8, "expect": {"anyOf": [["q20-w1"]], "forbidden": [], "duplicates": [], "contradiction": false}},
    {"query": "what format does the scanner emit?", "day": 8, "expect": {"anyOf": [["q20-w2"]], "forbidden": [], "duplicates": [], "contradiction": false}},
  ] },
  { "id": "q21", "kind": "cosmetic-edit", "why": "A DEPRECATED comment is first re-indented (cosmetic), then its removal version changes; a fact quoting the version breaks, a version-free fact survives.", writes: [
    {"id": "q21-w1", "agent": "lumen", "day": 2, "subject": "legacy_csv", "slot": "removal", "text": "quarry.io.legacy_csv is scheduled for removal in 0.9.", "source": {"kind": "file", "locator": "quarry/io/legacy_csv.py:1", "quote": "removal planned for 0.9"}, "supersedes": []},
    {"id": "q21-w2", "agent": "miner", "day": 3, "subject": "io", "slot": "deprecations", "text": "legacy_csv is deprecated in favour of quarry.io.parquet_writer.", "source": {"kind": "file", "locator": "quarry/io/legacy_csv.py:1", "quote": "DEPRECATED: use quarry.io.parquet_writer"}, "supersedes": []},
    {"id": "q21-w3", "agent": "drift", "day": 3, "subject": "release", "slot": "current", "text": "Current release is 0.8.2.", "source": {"kind": "file", "locator": "pyproject.toml:6", "quote": "version = \"0.8.2\""}, "supersedes": []},
  ],
  codeChanges: [{"day": 5, "locator": "quarry/io/legacy_csv.py:1", "before": "# DEPRECATED: use quarry.io.parquet_writer; removal planned for 0.9", "after": "#   DEPRECATED: use quarry.io.parquet_writer; removal planned for 0.9", "breaksFact": []}, {"day": 15, "locator": "quarry/io/legacy_csv.py:1", "before": "#   DEPRECATED: use quarry.io.parquet_writer; removal planned for 0.9", "after": "# DEPRECATED: use quarry.io.parquet_writer; removal planned for 1.0", "breaksFact": ["q21-w1"]}],
  questions: [
    {"query": "in which release does legacy_csv go away?", "day": 10, "expect": {"anyOf": [["q21-w1"]], "forbidden": [], "duplicates": [], "contradiction": false}},
    {"query": "in which release does legacy_csv go away?", "day": 16, "expect": {"anyOf": [], "forbidden": ["q21-w1"], "duplicates": [], "contradiction": false}},
    {"query": "what should I use instead of the legacy CSV writer?", "day": 16, "expect": {"anyOf": [["q21-w2"]], "forbidden": ["q21-w1"], "duplicates": [], "contradiction": false}},
  ] },
  { "id": "q22", "kind": "cosmetic-edit", "why": "Python dict entry gets odd spacing around the colon (cosmetic); the next key is renamed (breaks).", writes: [
    {"id": "q22-w1", "agent": "sable", "day": 3, "subject": "parquet", "slot": "compression", "text": "Parquet output is written with zstd compression.", "source": {"kind": "file", "locator": "quarry/load/writer.py:30", "quote": "\"compression\": \"zstd\","}, "supersedes": []},
    {"id": "q22-w2", "agent": "otto", "day": 3, "subject": "parquet", "slot": "row-groups", "text": "The writer passes row_group_size=128000 to pyarrow.", "source": {"kind": "file", "locator": "quarry/load/writer.py:31", "quote": "\"row_group_size\": 128_000,"}, "supersedes": []},
    {"id": "q22-w3", "agent": "lumen", "day": 4, "subject": "parquet", "slot": "statistics", "text": "Column statistics are enabled on all parquet output.", "source": {"kind": "file", "locator": "quarry/load/writer.py:32", "quote": "\"write_statistics\": True,"}, "supersedes": []},
  ],
  codeChanges: [{"day": 6, "locator": "quarry/load/writer.py:30", "before": "    \"compression\": \"zstd\",", "after": "    \"compression\" : \"zstd\" ,", "breaksFact": []}, {"day": 6, "locator": "quarry/load/writer.py:31", "before": "    \"row_group_size\": 128_000,", "after": "    \"row_group_rows\": 128_000,", "breaksFact": ["q22-w2"]}],
  questions: [
    {"query": "what codec do our parquet files use?", "day": 8, "expect": {"anyOf": [["q22-w1"]], "forbidden": ["q22-w2"], "duplicates": [], "contradiction": false}},
    {"query": "which option controls row group size in the writer config?", "day": 8, "expect": {"anyOf": [], "forbidden": ["q22-w2"], "duplicates": [], "contradiction": false}},
  ] },
  { "id": "q23", "kind": "cosmetic-edit", "why": "docker-compose: a trailing # comment is dropped from the MinIO API port (cosmetic); the console host port changes (breaks).", writes: [
    {"id": "q23-w1", "agent": "drift", "day": 2, "subject": "minio", "slot": "api-port", "text": "Local MinIO S3 API is on localhost:9000.", "source": {"kind": "file", "locator": "docker-compose.yml:22", "quote": "- \"9000:9000\""}, "supersedes": []},
    {"id": "q23-w2", "agent": "miner", "day": 2, "subject": "minio", "slot": "console", "text": "MinIO console is reachable at localhost:9001.", "source": {"kind": "file", "locator": "docker-compose.yml:23", "quote": "- \"9001:9001\""}, "supersedes": []},
    {"id": "q23-w3", "agent": "otto", "day": 4, "subject": "local-s3", "slot": "endpoint", "text": "Set S3_ENDPOINT_URL=http://localhost:9000 to point the pipeline at local MinIO.", "source": {"kind": "file", "locator": ".env.example:3", "quote": "S3_ENDPOINT_URL=http://localhost:9000"}, "supersedes": []},
  ],
  codeChanges: [{"day": 6, "locator": "docker-compose.yml:22", "before": "      - \"9000:9000\"   # minio api", "after": "      - \"9000:9000\"", "breaksFact": []}, {"day": 6, "locator": "docker-compose.yml:23", "before": "      - \"9001:9001\"   # minio console", "after": "      - \"9090:9001\"   # minio console", "breaksFact": ["q23-w2"]}],
  questions: [
    {"query": "what's the local S3 endpoint port?", "day": 8, "expect": {"anyOf": [["q23-w1", "q23-w3"]], "forbidden": ["q23-w2"], "duplicates": [["q23-w1", "q23-w3"]], "contradiction": false}},
    {"query": "what URL opens the MinIO web console locally?", "day": 8, "expect": {"anyOf": [], "forbidden": ["q23-w2"], "duplicates": [], "contradiction": false}},
  ] },
  { "id": "q24", "kind": "cosmetic-edit", "why": "Trailing whitespace stripped on one constant and a trailing comment extended on another; neither breaks the retry facts.", writes: [
    {"id": "q24-w1", "agent": "lumen", "day": 3, "subject": "fetch", "slot": "retries", "text": "Failed fetches retry up to 5 times.", "source": {"kind": "file", "locator": "quarry/retry.py:7", "quote": "MAX_RETRIES = 5 "}, "supersedes": []},
    {"id": "q24-w2", "agent": "sable", "day": 3, "subject": "fetch", "slot": "backoff", "text": "Retry backoff starts at 2 seconds.", "source": {"kind": "file", "locator": "quarry/retry.py:8", "quote": "BACKOFF_BASE = 2.0  # seconds"}, "supersedes": []},
    {"id": "q24-w3", "agent": "otto", "day": 4, "subject": "http", "slot": "client", "text": "HTTP fetches use httpx with HTTP/2 enabled.", "source": {"kind": "file", "locator": "quarry/http.py:11", "quote": "httpx.Client(http2=True"}, "supersedes": []},
  ],
  codeChanges: [{"day": 6, "locator": "quarry/retry.py:7", "before": "MAX_RETRIES = 5 ", "after": "MAX_RETRIES = 5", "breaksFact": []}, {"day": 6, "locator": "quarry/retry.py:8", "before": "BACKOFF_BASE = 2.0  # seconds", "after": "BACKOFF_BASE = 2.0  # seconds; doubled each attempt", "breaksFact": []}],
  questions: [
    {"query": "how many times does a failed download retry, and how long does it wait first?", "day": 8, "expect": {"anyOf": [["q24-w1"], ["q24-w2"]], "forbidden": [], "duplicates": [], "contradiction": false}},
    {"query": "which HTTP library does the fetcher use?", "day": 8, "expect": {"anyOf": [["q24-w3"]], "forbidden": [], "duplicates": [], "contradiction": false}},
  ] },
] as MemoryBenchmarkAgentScenario[]);
/**
 * The screening histories mark credentials and private paths with placeholders, so no credential-shaped literal is ever
 * committed. They expand here into deterministic fake values of the real shapes; nothing below is or was a real secret.
 */
function fake(length: number, seed: string, alphabet = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'): string {
  let state = [...seed].reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) >>> 0, 2166136261);
  let out = '';
  for (let i = 0; i < length; i++) { state = (state * 1103515245 + 12345) >>> 0; out += alphabet[(state >>> 8) % alphabet.length]; }
  return out;
}
const PLACEHOLDER = /\{\{(secret:[a-z0-9-]+|home:[^}]*)\}\}/g;
export function expandMemoryBenchmarkPlaceholders(text: string, seed: string): string {
  // Seeded by scenario and token, so a value quoted in one write and in a code change expands identically.
  return text.replace(PLACEHOLDER, (_match, token: string) => {
    const key = `${seed}:${token}`;
    if (token.startsWith('home:')) return ['', 'Users', 'riley'].join('/') + token.slice(5);
    switch (token.slice(7)) {
      case 'openai-key': return ['sk', 'proj', fake(40, key)].join('-');
      case 'anthropic-key': return ['sk', 'ant', 'api03', fake(48, key)].join('-');
      case 'github-token': return ['ghp', fake(36, key)].join('_');
      case 'aws-access-key': return 'AK' + 'IA' + fake(16, key, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567');
      case 'slack-token': return ['xo' + 'xb', fake(11, key, '0123456789'), fake(13, key + 'b', '0123456789'), fake(24, key + 'c')].join('-');
      case 'jwt': return ['ey' + 'J' + fake(20, key), 'ey' + 'J' + fake(40, key + 'p'), fake(43, key + 's')].join('.');
      case 'hex64': return fake(64, key, '0123456789abcdef');
      case 'url-password': return fake(18, key);
      case 'private-key': return ['-----BEGIN ' + 'PRIVATE KEY-----', fake(64, key), fake(64, key + 'b'), '-----END ' + 'PRIVATE KEY-----'].join('\n');
      default: return fake(32, key);
    }
  });
}
