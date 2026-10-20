# TASK 02 — Cloudflare Worker proxy for Jev and Claude (Codex)

Read first: `CLAUDE.md`, `worker/src/prompts.js` (**read only — do not edit**), `docs/js/matcher.js` (**read only**),
`docs/content/profile.json`, `docs/content/roles/leva.json`.

Files you may create/change: everything under `worker/` **except** `worker/src/prompts.js`; `scripts/precompute.mjs`;
`.github/workflows/test.yml` (add a worker job only). Nothing else. No secrets in any file. Do not run `wrangler deploy`
or `wrangler login`; do not make any real network call to api.anthropic.com or api.typesafe.ai (tests mock `fetch`).

## Stack
- Cloudflare Workers, ES module syntax, `wrangler` (devDependency), `vitest` (devDependency).
- Claude via the official SDK `@anthropic-ai/sdk` (dependency). Jev via raw `fetch` (no SDK).
- `worker/wrangler.toml`: `name = "hire-alexey"`, `main = "src/index.js"`, `compatibility_date = "2026-09-01"`,
  `compatibility_flags = ["nodejs_compat"]`, `[vars] ALLOWED_ORIGINS = "https://amarows.github.io,http://localhost:8000"`.
  Secrets (documented in `worker/README.md`, never in files): `ANTHROPIC_API_KEY`, `TYPESAFE_API_KEY`, `ACCESS_CODE`.
- `worker/.dev.vars.example` with placeholder values only (e.g. `ANTHROPIC_API_KEY=replace-me`).

## Content
Import the JSON content at build time: `import profile from "../../docs/content/profile.json"` and the roles into a
`ROLES = { leva }` map (wrangler bundles JSON). Import `matcher.js` functions and everything from `prompts.js`.

## HTTP API (all JSON)

Common:
- CORS: reflect `Origin` only if it is in `ALLOWED_ORIGINS`; handle `OPTIONS` preflight (204, allow `POST, GET, OPTIONS`,
  headers `content-type, x-access-code`, max-age 86400). Disallowed origin → 403 on POST.
- Auth for POST routes: header `x-access-code` must equal `env.ACCESS_CODE` (constant-time comparison). Missing/wrong → 401
  `{error: "access_code"}`.
- Body size limit 16 KB → 413. Invalid JSON → 400. Unknown role → 404.
- Rate limit per client IP (`cf-connecting-ip`), in-memory per isolate: max 20 POSTs per 10 minutes → 429 with
  `retry-after`. Document in README that this is best-effort and the Anthropic/TypeSafe spend caps are the backstop.
- Errors never leak upstream bodies or keys: return `{error: "<short_code>", message: "<plain sentence>"}`.
- Log one JSON line per request via `console.log`: route, status, latency_ms, model, input/output tokens, request id.
  Never log viewer text, answers, or headers.

### `GET /api/health` → `{ok: true, questions_version: JEV_QUESTIONS_VERSION}` (no auth).

### `POST /api/jev`
Body: `{role: "leva", project: {title, brief}, sliders: {reg, dom, build, amb, stake}}`.
- `state = buildJevState(profile, ROLES[role], project, sliders, OPERATING_ASSUMPTION)`.
- Request: `POST https://api.typesafe.ai/v1/systemone`, `Authorization: Bearer ${env.TYPESAFE_API_KEY}`,
  body `{model: JEV_MODEL, state, questions: JEV_QUESTIONS}`. Timeout 20 s (AbortController).
  Retry on 429/500/502/503/504/529 up to 3 attempts, backoff 1 s, 2 s.
- Response 200:
  `{model, questions_version, request_id (header x-typesafe-request-id), answers, derived: deriveJev(answers, PROTOTYPE_WEEKS),
    evidence: state.evidence.map(e => e.title), gaps: state.known_gaps.map(g => g.title), state, questions: JEV_QUESTIONS, usage}`.
  (`state` and `questions` are returned on purpose: the page shows exactly what Jev was asked.)
- Upstream failure → 502 `{error: "jev_unavailable"}`.

### `POST /api/claude`
Body: `{role: "leva", task: "plan"|"ask"|"crossexam"|"draft", ...task fields}`.
Task fields: plan → `project{title,brief}, sliders`; ask → `question`; crossexam → `project, sliders, jev` (the `derived`
object from /api/jev); draft → `kind` ∈ {invite, references, offer}, `project`, `notes` (optional).
- Validate: unknown task/kind → 400. Every viewer string trimmed; total viewer text length ≤ `TASKS[task].maxInput` → else 413.
- Build params `p` for `TASKS[task].prompt(p)`: `title`, `brief`, `characteristicsText = describeSliders(profile, sliders)`,
  `question`, `kind`, `notes`, and for crossexam `jevSummary` = a short plain-text rendering of `derived`
  (P(MVP) as %, expected weeks, likely band label from `JEV_QUESTIONS.time_to_prototype.criteria`, fit level, main risk,
  P(needs specialist) as %).
- Call:
  ```js
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const msg = await client.beta.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: CLAUDE_MAX_TOKENS,
    thinking: { type: "adaptive" },
    output_config: { effort: CLAUDE_EFFORT },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: [
      { type: "text", text: SYSTEM_BASE },
      { type: "text", text: "CONTEXT:\n" + JSON.stringify({ profile: publicProfile, role }), cache_control: { type: "ephemeral" } },
    ],
    messages: [{ role: "user", content: TASKS[task].prompt(p) }],
  });
  ```
  `publicProfile` = profile without `dimensions` and without every case's `tags` (the model doesn't need them).
- If `msg.stop_reason === "refusal"` → 200 `{error: "declined", message: "The model declined this request."}`.
  Else join only `type === "text"` blocks → `{text, model: msg.model, usage: msg.usage, stop_reason}`.
- SDK errors: catch `Anthropic.RateLimitError` → 429, `Anthropic.APIError` → 502 `{error: "claude_unavailable"}`.
  Set the client `timeout` to 60_000 ms and `maxRetries` to 2.

## Tests (`worker/test/*.test.js`, vitest, no network)
Call the default export's `fetch(request, env)` directly with a fake `env`. Stub `globalThis.fetch` with `vi.fn` to return
canned TypeSafe and Anthropic Messages API responses (shape: `{id, type:"message", role:"assistant", model, content:[{type:"text",text:"..."}], stop_reason:"end_turn", usage:{input_tokens:1,output_tokens:1}}`).
Cover at least: OPTIONS preflight allowed/denied; 401 without code; 413 oversize; jev happy path (asserts the outgoing body
has `model`, `state.project.title`, `questions` keys and the Bearer header, and the response has `derived.p_mvp`); jev upstream
500 ×3 → 502; claude plan happy path (asserts outgoing body has `fallbacks: "default"`, the beta header, `thinking.type ===
"adaptive"`, and that the system CONTEXT contains no `"tags"`); claude refusal → `declined`; draft with bad kind → 400;
rate limit → 429 on the 21st call.

## `scripts/precompute.mjs`
`node scripts/precompute.mjs --worker <url> --role leva` reads `ACCESS_CODE` from the environment (never from argv),
POSTs `/api/jev` for each preset in the role file (project = preset title/brief, sliders = preset sliders), and writes
`docs/content/precomputed/<role>.json` = `{generated_utc, questions_version, model, presets: {<id>: <full /api/jev response>}}`.
Sequential, 1 s apart, fails loudly on any non-200. Not run by you.

## CI
Add a `worker` job to `.github/workflows/test.yml`: `cd worker && npm ci && npx vitest run`. Commit a `package-lock.json`.

## Acceptance (Claude will run these)
- `cd worker && npm ci && npx vitest run` passes; `npx wrangler deploy --dry-run --outdir dist` succeeds.
- `git diff --stat` touches only allowed files; `worker/src/prompts.js` unchanged.
- `grep -rn "sk-ant\|Bearer [A-Za-z0-9]" worker/src` finds nothing but the template literal using `env`.
