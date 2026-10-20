# hire-alexey

A public portal that answers one question for a hiring team: why hire Alexey for this role.
First target: LEVA, Product Architect (`docs/leva/`). Built to be retargeted: one `docs/content/roles/<id>.json` per role.

## Layout
- `docs/`: GitHub Pages root (static, no build step). `docs/content/profile.json` = public facts about Alexey;
  `docs/content/roles/<id>.json` = role, company context, fit map, presets; `docs/content/precomputed/<id>.json` =
  Jev results for presets; `docs/js/` = ES modules shared by the page and the worker (pure, no I/O).
- `worker/`: Cloudflare Worker proxy. Holds the Anthropic and TypeSafe keys as secrets; the page never sees a key.
  `worker/src/prompts.js` is the frozen AI contract (Jev questions, Claude prompts): hand-written, changed only deliberately.
- `scripts/`: content validator, preset precompute.
- `tasks/`: Codex briefs `TASK_<nn>_*.md`; executed ones move to `tasks/archive/`.

## Hard rules
- **Public repo.** Only publishable facts: CV/LinkedIn level. No client names, pricing, holdings, P&L, psychometrics,
  salary history, phone number. Pro bono is never employment. The consulting engagement (own practice) is never named
  or described; its engine may be described as method only.
- **No secrets in the repo**, ever: keys and the access code live only in Cloudflare secrets (`wrangler secret put`),
  typed by Alex. `.dev.vars` is gitignored.
- AI never computes a number that the page presents as fact. Jev gives judgments, labelled as such; code does the rest.
- Codex does mechanical work from a brief (`codex exec --sandbox workspace-write`); Claude reviews every diff and runs
  the acceptance checks before merge.

## Commands
- Tests: `node --test` (pure modules, validator) and `cd worker && npx vitest run`.
- Local site: `python -m http.server 8000 -d docs` → http://localhost:8000/leva/
- Worker: `cd worker && npx wrangler dev` (needs `.dev.vars` with the secrets) / `npx wrangler deploy`.
