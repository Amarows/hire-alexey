# Hire Alexey Worker

Cloudflare Worker proxy for Jev and Claude. Configure these Cloudflare secrets with `wrangler secret put`:

- `ANTHROPIC_API_KEY`
- `TYPESAFE_API_KEY`
- `ACCESS_CODE`

The in-memory per-isolate rate limit allows 20 POST requests per client IP per 10 minutes. It is best-effort because
isolates do not share state; Anthropic and TypeSafe spend caps are the backstop. Local development can use
`.dev.vars` based on `.dev.vars.example`.

Run mocked tests with `npx vitest run`. `scripts/precompute.mjs` can request the preset results from a deployed worker;
set `ACCESS_CODE` in the environment before running it.
